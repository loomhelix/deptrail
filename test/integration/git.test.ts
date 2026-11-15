import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandRunner } from '../../src/adapters/command-runner.ts'
import { offlineEnrichment } from '../../src/enrich/enrichment-service.ts'
import { findRoots } from '../../src/discovery/find-roots.ts'
import { killGitProcesses } from '../../src/git/git-process.ts'
import { isGitRepository, openGitRepository, type GitRepository } from '../../src/git/git-repository.ts'
import { serializeRootGraph } from '../../src/graph/serialize.ts'
import { buildRoot } from '../../src/scan/build-root.ts'
import { startScanSession } from '../../src/scan/scan-session.ts'
import { createSourceRegistry } from '../../src/scan/source-registry.ts'
import { createBranches } from '../../src/server/branches.ts'
import { startServer, type RunningServer } from '../../src/server/server.ts'
import { createFsReader, type FileReader } from '../../src/sources/file-reader.ts'
import { createGitReader } from '../../src/sources/git-reader.ts'

const MONOLITH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'monolith')
const FIXTURE_GIT_CONFIG = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
const NPM_LOCKFILE = 'npm-package/pnpm-lock.yaml'

const throwingRunner: CommandRunner = async () => {
  throw new Error('runner must not be called')
}

type History = { initial: string; feature: string; main: string; orphan: string; tag: string }

function withoutGitVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
}

describe('reading branches from a real git repository', () => {
  let sandbox: string
  let repo: string
  let fixtureEnv: Record<string, string>
  let history: History
  const repositories: GitRepository[] = []

  function fixtureGit(args: string[], cwd = repo): string {
    return execFileSync('git', [...FIXTURE_GIT_CONFIG, ...args], { cwd, env: fixtureEnv, encoding: 'utf8' }).trim()
  }

  async function repository(cwd = repo): Promise<GitRepository> {
    const opened = await openGitRepository({ cwd, env: process.env, redact: (text) => text })
    assert.ok(isGitRepository(opened), isGitRepository(opened) ? '' : opened.unavailable)
    repositories.push(opened)
    return opened
  }

  async function extract(commit: string): Promise<string> {
    const dir = await mkdtemp(path.join(sandbox, 'archive-'))
    await new Promise<void>((resolve, reject) => {
      const archive = spawn('git', ['archive', commit], { cwd: repo, env: fixtureEnv })
      const tar = spawn('tar', ['-x', '-C', dir])
      archive.stdout.pipe(tar.stdin)
      archive.on('error', reject)
      tar.on('error', reject)
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))))
    })
    return dir
  }

  async function filesUnder(dir: string, skip: string): Promise<string[]> {
    const found: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue
      const absolute = path.join(entry.parentPath, entry.name)
      if (absolute.startsWith(skip)) continue
      found.push(absolute)
    }
    return found.sort()
  }

  async function snapshot(): Promise<string> {
    const gitDir = path.join(repo, '.git')
    const fileHashes = await Promise.all(
      (await filesUnder(gitDir, path.join(gitDir, 'objects'))).map(async (file) => `${path.relative(gitDir, file)} ${createHash('sha256').update(await readFile(file)).digest('hex')}`),
    )
    return [
      fixtureGit(['--no-optional-locks', 'status', '--porcelain', '-uall']),
      fixtureGit(['rev-parse', 'HEAD']),
      fixtureGit(['for-each-ref']),
      fixtureGit(['worktree', 'list', '--porcelain']),
      fixtureGit(['stash', 'list']),
      ...fileHashes,
    ].join('\n')
  }

  async function buildAll(reader: FileReader): Promise<unknown[]> {
    const roots = await findRoots(reader)
    return Promise.all(roots.map(async (root) => serializeRootGraph(await buildRoot(root, { reader, runner: throwingRunner, allowResolve: false, allowInstalled: false }))))
  }

  before(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-git-'))
    repo = path.join(sandbox, 'repo')
    const home = path.join(sandbox, 'home')
    await mkdir(home)
    fixtureEnv = { ...withoutGitVariables(process.env), HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    await cp(MONOLITH, repo, { recursive: true })
    await mkdir(path.join(repo, 'tools', 'cache'), { recursive: true })
    await writeFile(path.join(repo, 'tools', 'package.json'), '{"name":"tools"}')
    await writeFile(path.join(repo, 'tools', '.gitignore'), 'cache/\n')
    await writeFile(path.join(repo, 'tools', 'cache', 'package.json'), '{"name":"cache"}')
    await symlink('npm-package', path.join(repo, 'link-to-npm-package'))
    fixtureGit(['init', '-q'])
    fixtureGit(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    fixtureGit(['add', '-A'])
    fixtureGit(['commit', '-q', '-m', 'initial'])
    const initial = fixtureGit(['rev-parse', 'HEAD'])
    fixtureGit(['tag', '-a', 'v1', '-m', 'v1'])
    fixtureGit(['checkout', '-q', '-b', 'feature'])
    const lockfile = await readFile(path.join(repo, NPM_LOCKFILE), 'utf8')
    await writeFile(path.join(repo, NPM_LOCKFILE), lockfile.replaceAll('5.7.2', '5.7.3'))
    fixtureGit(['rm', '-rq', 'scripts/release'])
    fixtureGit(['commit', '-qam', 'feature'])
    const feature = fixtureGit(['rev-parse', 'HEAD'])
    fixtureGit(['checkout', '-q', 'main'])
    await writeFile(path.join(repo, 'services', 'api', 'notes.txt'), 'main moved on\n')
    fixtureGit(['add', 'services/api/notes.txt'])
    fixtureGit(['update-index', '--add', '--cacheinfo', `160000,${initial},vendor/sub`])
    fixtureGit(['commit', '-q', '-m', 'main'])
    const main = fixtureGit(['rev-parse', 'HEAD'])
    fixtureGit(['update-ref', 'refs/remotes/origin/main', main])
    fixtureGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const emptyTree = execFileSync('git', ['mktree'], { cwd: repo, env: fixtureEnv, input: '', encoding: 'utf8' }).trim()
    const orphan = fixtureGit(['commit-tree', emptyTree, '-m', 'orphan'])
    fixtureGit(['update-ref', 'refs/heads/orphan', orphan])
    await writeFile(path.join(repo, 'untracked.txt'), 'local\n')
    await writeFile(path.join(repo, 'npm-package', 'package.json'), `${await readFile(path.join(repo, 'npm-package', 'package.json'), 'utf8')}\n`)
    history = { initial, feature, main, orphan, tag: fixtureGit(['rev-parse', 'v1']) }
  })

  after(async () => {
    for (const opened of repositories) opened.close()
    killGitProcesses()
    await rm(sandbox, { recursive: true, force: true })
  })

  it('reads every commit like a checkout', async () => {
    const git = await repository()
    for (const commit of [history.main, history.feature, history.initial]) {
      const fromGit = await buildAll(createGitReader(await git.tree(commit), (blobId) => git.readBlob(blobId)))
      const fromCheckout = await buildAll(createFsReader(await extract(commit)))
      assert.deepEqual(fromGit, fromCheckout, commit)
      assert.ok(fromGit.length > 0)
    }
    const featureRoots = await findRoots(createGitReader(await git.tree(history.feature), (blobId) => git.readBlob(blobId)))
    assert.equal(featureRoots.some((root) => root.path === 'scripts/release'), false)
    const mainRoots = await findRoots(createGitReader(await git.tree(history.main), (blobId) => git.readBlob(blobId)))
    assert.equal(mainRoots.some((root) => root.path === 'scripts/release'), true)
    assert.equal(mainRoots.some((root) => root.path === 'tools/cache'), false)
  })

  it('lists refs with the default branch', async () => {
    const git = await repository()
    const listing = await git.refs()
    assert.equal(listing.defaultBranch, 'refs/remotes/origin/main')
    const byName = new Map(listing.refs.map((ref) => [ref.name, ref]))
    assert.equal(byName.get('refs/tags/v1')?.commit, history.initial)
    assert.equal(byName.get('refs/heads/feature')?.commit, history.feature)
    assert.equal(byName.get('refs/heads/orphan')?.commit, history.orphan)
    assert.equal(byName.has('refs/remotes/origin/HEAD'), false)
    assert.deepEqual(await git.head(), { commit: history.main, branch: 'refs/heads/main' })
  })

  it('finds the merge base and reports unrelated histories', async () => {
    const git = await repository()
    assert.equal(await git.mergeBase(history.main, history.feature), history.initial)
    assert.equal(await git.mergeBase(history.orphan, history.main), undefined)
  })

  it('scans a subdirectory prefix', async () => {
    const git = await repository(path.join(repo, 'npm-package'))
    assert.equal(git.prefix, 'npm-package/')
    const roots = await findRoots(createGitReader(await git.tree(history.main), (blobId) => git.readBlob(blobId)))
    assert.equal(roots[0]?.path, '.')
    assert.equal(roots[0]?.lockfile, 'pnpm-lock.yaml')
  })

  it('never changes the repository', async () => {
    const first = await snapshot()
    assert.equal(await snapshot(), first)
    const git = await repository()
    await git.head()
    await git.refs()
    for (const commit of Object.values(history)) {
      const reader = createGitReader(await git.tree(commit), (blobId) => git.readBlob(blobId))
      await findRoots(reader)
      await reader.readText(NPM_LOCKFILE)
    }
    await git.mergeBase(history.main, history.feature)
    await git.mergeBase(history.orphan, history.main)
    await exerciseServer(git)
    assert.equal(await snapshot(), first)
  })

  async function exerciseServer(git: GitRepository): Promise<void> {
    const staticDir = await mkdtemp(path.join(sandbox, 'static-'))
    await writeFile(path.join(staticDir, 'index.html'), '<html></html>')
    const sessionOptions = { repoPath: repo, runner: throwingRunner, cache: null, env: {}, userNpmrc: null }
    const working = await startScanSession({ ...sessionOptions, reader: createFsReader(repo) })
    await working.ready
    const sources = createSourceRegistry({
      working,
      openSession: async (commit) =>
        startScanSession({ ...sessionOptions, reader: createGitReader(await git.tree(commit), (blobId) => git.readBlob(blobId)), useInstalled: false }),
      onRootsChanged: () => {},
      limit: 10,
    })
    const server = await startServer({ session: working, enrichment: offlineEnrichment(), staticDir, branches: createBranches(git, sources) })
    try {
      assert.equal((await call(server, 'GET', '/api/git')).status, 200)
      const keys: string[] = []
      for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/tags/v1', 'refs/remotes/origin/main', 'refs/heads/orphan', 'HEAD']) {
        const reply = await call(server, 'POST', '/api/sources', { ref })
        assert.equal(reply.status, 200, ref)
        const { key } = JSON.parse(reply.text) as { key: string }
        await sources.commit(key)?.session.ready
        assert.equal((await call(server, 'GET', `/api/commits/${key}/scan`)).status, 200)
        keys.push(key)
      }
      const mergeBase = await call(server, 'POST', '/api/sources', { mergeBase: { base: 'work', target: history.feature } })
      assert.equal(mergeBase.status, 200)
      const { key: mergeBaseKey } = JSON.parse(mergeBase.text) as { key: string }
      assert.equal(mergeBaseKey, history.initial)
      await sources.commit(mergeBaseKey)?.session.ready
      for (const key of [...keys, mergeBaseKey]) {
        assert.equal((await call(server, 'GET', `/api/compare?base=work&target=${key}`)).status, 200)
      }
      assert.equal((await call(server, 'GET', `/api/compare?base=${mergeBaseKey}&target=${history.feature}`)).status, 200)
      assert.equal((await call(server, 'POST', '/api/sources', { mergeBase: { base: history.orphan, target: history.main } })).status, 409)
    } finally {
      await server.close()
    }
  }
})

type Reply = { status: number; text: string }

function call(server: RunningServer, method: string, pathname: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { 'x-deptrail-token': server.token }
  if (method !== 'GET') headers.origin = `http://127.0.0.1:${server.port}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: server.port, method, path: pathname, headers }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
