import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli/cli.ts'
import { browserCommand } from '../src/cli/open-browser.ts'
import type { ScanSummary } from '../src/server/router.ts'
import { encodeRootSegment } from '../src/server/root-segment.ts'
import { startFakeServer, type FakeServer } from './helpers/fake-http.ts'

const monolithFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'monolith')
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const SECRET = 'fixture-secret-token'
const QUIET_PERIOD_MS = 300
const LEFT_PAD_LOCKFILE = {
  name: 'app',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } },
    'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-x' },
  },
}

function captureIo() {
  const out: string[] = []
  const err: string[] = []
  const opened: string[] = []
  return {
    out,
    err,
    opened,
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      openBrowser: (url: string) => opened.push(url),
    },
  }
}

async function printed(out: string[], running: Promise<number>): Promise<void> {
  let finished = false
  running.then(() => (finished = true), () => (finished = true))
  while (out.length === 0) {
    assert.equal(finished, false, 'main finished before printing the URL')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, 'condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

function quietPeriod(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, QUIET_PERIOD_MS))
}

function servedUrl(out: string[]): URL {
  return new URL(out.join('').replace(/^deptrail: /, '').trim())
}

async function scanSummary(serverUrl: URL): Promise<ScanSummary> {
  const response = await fetch(new URL('/api/scan', serverUrl), { headers: { 'x-deptrail-token': serverUrl.searchParams.get('token') ?? '' } })
  return (await response.json()) as ScanSummary
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('deptrail CLI', () => {
  let home: string
  let env: Record<string, string | undefined>

  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'deptrail-cli-'))
    env = { HOME: home, DEPTRAIL_CACHE_DIR: path.join(home, 'cache'), COREPACK_ENABLE_NETWORK: '0' }
  })

  after(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('prints the normalized scan as JSON and returns 0 with --json', async () => {
    const { out, io } = captureIo()
    const code = await main([monolithFixture, '--json'], env, io)
    assert.equal(code, 0)
    const printed = out.join('')
    const scan = JSON.parse(printed)
    assert.deepEqual(scan.roots.map((root: { id: string }) => root.id).sort(), ['legacy/admin', 'npm-package', 'scripts/release', 'services/api'])
    assert.equal(printed.includes(SECRET), false)
  })

  it('never prints registry URLs from .npmrc with --json, only whether a root has auth', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'deptrail-cli-npmrc-'))
    try {
      await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'credentialed', version: '1.0.0' }))
      await writeFile(
        path.join(repo, '.npmrc'),
        ['registry="https://deploy:quoted-registry-secret@registry.example.test/"', '@fury:registry=https://npm-proxy.fury.io/path-token-secret/user/'].join('\n'),
      )
      const { out, io } = captureIo()
      assert.equal(await main([repo, '--json'], env, io), 0)
      const printed = out.join('')
      assert.equal(printed.includes('quoted-registry-secret'), false)
      assert.equal(printed.includes('path-token-secret'), false)
      const [root] = JSON.parse(printed).roots
      assert.equal(typeof root.hasAuth, 'boolean')
      assert.equal('config' in root, false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('returns 2 for a missing path and for a file path', async () => {
    const missing = captureIo()
    assert.equal(await main([path.join(home, 'absent'), '--json'], env, missing.io), 2)
    assert.match(missing.err.join(''), /Not a directory/)
    const filePath = path.join(home, 'file.txt')
    await writeFile(filePath, 'x')
    assert.equal(await main([filePath, '--json'], env, captureIo().io), 2)
  })

  it('returns 2 for an invalid port or unknown flag', async () => {
    assert.equal(await main([monolithFixture, '--port', 'abc'], env, captureIo().io), 2)
    assert.equal(await main([monolithFixture, '--bogus'], env, captureIo().io), 2)
  })

  it('reports a busy explicit port and returns 1', async () => {
    const blocker: Server = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busyPort = (blocker.address() as AddressInfo).port
    try {
      const { err, io } = captureIo()
      const code = await main([monolithFixture, '--port', String(busyPort), '--no-open', '--offline'], env, io)
      assert.equal(code, 1)
      assert.equal(err.join(''), `Port ${busyPort} is in use\n`)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('serves until SIGTERM, prints the tokenized URL and honours --no-open', async () => {
    const { out, opened, io } = captureIo()
    const running = main([monolithFixture, '--no-open', '--offline'], env, io)
    await printed(out, running)
    const match = /^deptrail: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64})\n$/.exec(out.join(''))
    assert.ok(match)
    assert.equal(opened.length, 0)
    const unauthenticated = await fetch(new URL('/api/scan', match[1]))
    assert.equal(unauthenticated.status, 401)
    process.emit('SIGTERM')
    assert.equal(await running, 0)
  })

  it('kills a running resolve and removes its staged temp directory on shutdown', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-cli-resolve-'))
    const repo = path.join(sandbox, 'repo')
    const fakeBin = path.join(sandbox, 'bin')
    const installMarker = path.join(sandbox, 'install-started.txt')
    await mkdir(repo)
    await mkdir(fakeBin)
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'slow', version: '1.0.0', packageManager: 'pnpm@10.0.0' }))
    await writeFile(path.join(fakeBin, 'pnpm'), `#!/bin/sh\necho "$$ $(pwd)" > "${installMarker}"\nexec sleep 30\n`, { mode: 0o755 })
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`
    try {
      const { out, io } = captureIo()
      const running = main([repo, '--no-open', '--offline'], env, io)
      await printed(out, running)
      const serverUrl = new URL(out.join('').replace(/^deptrail: /, '').trim())
      const token = serverUrl.searchParams.get('token') ?? ''
      const accepted = await fetch(new URL(`/api/roots/${encodeRootSegment('.')}/resolve`, serverUrl), {
        method: 'POST',
        headers: { 'x-deptrail-token': token, origin: serverUrl.origin },
      })
      assert.equal(accepted.status, 202)
      await eventually(() => pathExists(installMarker))
      const [pidText, stagedDir] = (await readFile(installMarker, 'utf8')).trim().split(' ')
      assert.equal(await pathExists(path.join(stagedDir, 'package.json')), true)
      process.emit('SIGTERM')
      assert.equal(await running, 0)
      assert.equal(await pathExists(stagedDir), false)
      await eventually(async () => !isProcessAlive(Number(pidText)))
    } finally {
      process.env.PATH = originalPath
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('starts without branches outside a git repository', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'deptrail-cli-no-git-'))
    try {
      await writeFile(path.join(outside, 'package.json'), '{"name":"plain"}')
      const { out, io } = captureIo()
      const running = main([outside, '--no-open', '--offline'], env, io)
      try {
        await printed(out, running)
        const serverUrl = servedUrl(out)
        const response = await fetch(new URL('/api/git', serverUrl), { headers: { 'x-deptrail-token': serverUrl.searchParams.get('token') ?? '' } })
        assert.deepEqual(await response.json(), { available: false, reason: 'This directory is not in a git repository', quiet: true })
      } finally {
        process.emit('SIGTERM')
        assert.equal(await running, 0)
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('offers branches inside a git repository', async () => {
    const { out, io } = captureIo()
    const running = main([monolithFixture, '--no-open', '--offline'], env, io)
    try {
      await printed(out, running)
      const serverUrl = servedUrl(out)
      const headers = { 'x-deptrail-token': serverUrl.searchParams.get('token') ?? '' }
      const info = (await (await fetch(new URL('/api/git', serverUrl), { headers })).json()) as { available: boolean; head?: { commit: string } }
      assert.equal(info.available, true)
      const opened = await fetch(new URL('/api/sources', serverUrl), {
        method: 'POST',
        headers: { ...headers, origin: serverUrl.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'HEAD' }),
      })
      assert.equal(opened.status, 200)
      const { key } = (await opened.json()) as { key: string }
      assert.equal(key, info.head?.commit)
      const scan = await fetch(new URL(`/api/commits/${key}/scan`, serverUrl), { headers })
      assert.equal(scan.status, 200)
      assert.ok(((await scan.json()) as ScanSummary).roots.some((root) => root.id === 'npm-package'))
    } finally {
      process.emit('SIGTERM')
      assert.equal(await running, 0)
    }
  })

  it('keeps environment values out of registry URLs that a branch configures', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'deptrail-cli-branch-npmrc-'))
    const registry = await startFakeServer(() => ({ status: 404 }))
    const osv = await startFakeServer(() => ({ body: { results: [] } }))
    const probe = 'probe-value-7f3a91'
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    const userNpmrc = path.join(home, 'branch-user.npmrc')
    const { out, io } = captureIo()
    let running: Promise<number> | undefined
    try {
      await writeFile(userNpmrc, `registry=${registry.url}/user/\n`)
      await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }))
      await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify(LEFT_PAD_LOCKFILE))
      git('init', '-q')
      git('symbolic-ref', 'HEAD', 'refs/heads/main')
      git('add', '-A')
      git('commit', '-q', '-m', 'main')
      git('checkout', '-q', '-b', 'contrib')
      await writeFile(path.join(repo, '.npmrc'), `registry=${registry.url}/leak/\${DEPTRAIL_LEAK_PROBE}/\n`)
      git('add', '-A')
      git('commit', '-q', '-m', 'contrib')
      git('checkout', '-q', 'main')
      const branchEnv = { ...env, DEPTRAIL_CACHE_DIR: path.join(home, 'branch-npmrc-cache'), DEPTRAIL_OSV_URL: osv.url, DEPTRAIL_LEAK_PROBE: probe, npm_config_userconfig: userNpmrc }
      running = main([repo, '--no-open'], branchEnv, io)
      await printed(out, running)
      const serverUrl = servedUrl(out)
      const headers = { 'x-deptrail-token': serverUrl.searchParams.get('token') ?? '' }
      const opened = await fetch(new URL('/api/sources', serverUrl), {
        method: 'POST',
        headers: { ...headers, origin: serverUrl.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'refs/heads/contrib' }),
      })
      assert.equal(opened.status, 200)
      await eventually(async () => registry.requests.filter((request) => request.path.includes('left-pad')).length >= 1)
      await quietPeriod()
      assert.deepEqual(
        registry.requests.filter((request) => request.path.includes(probe)),
        [],
      )
    } finally {
      process.emit('SIGTERM')
      if (running) assert.equal(await running, 0)
      await registry.close()
      await osv.close()
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('opens the browser by default', async () => {
    const { out, opened, io } = captureIo()
    const running = main([monolithFixture, '--offline'], env, io)
    await printed(out, running)
    assert.equal(opened.length, 1)
    process.emit('SIGTERM')
    await running
  })

  describe('enrichment', () => {
    type EnrichmentFakes = { registry: FakeServer; env: Record<string, string | undefined>; requestCount(): number }

    async function withEnrichmentFakes(cacheName: string, exercise: (fakes: EnrichmentFakes) => Promise<void>): Promise<void> {
      const registry = await startFakeServer(() => ({ status: 404 }))
      const osv = await startFakeServer((request) => {
        if (request.path !== '/v1/querybatch') return { status: 404 }
        const { queries } = JSON.parse(request.body) as { queries: unknown[] }
        return { body: { results: queries.map(() => ({})) } }
      })
      try {
        await exercise({
          registry,
          env: { ...env, DEPTRAIL_CACHE_DIR: path.join(home, cacheName), npm_config_registry: `${registry.url}/`, DEPTRAIL_OSV_URL: osv.url },
          requestCount: () => registry.requests.length + osv.requests.length,
        })
      } finally {
        await registry.close()
        await osv.close()
      }
    }

    it('sends nothing with --offline and reports enrichment as offline', () =>
      withEnrichmentFakes('offline-cache', async (fakes) => {
        const { out, io } = captureIo()
        const running = main([monolithFixture, '--no-open', '--offline'], fakes.env, io)
        await printed(out, running)
        const serverUrl = servedUrl(out)
        await eventually(async () => (await scanSummary(serverUrl)).roots.every((root) => root.status !== 'scanning'))
        assert.equal((await scanSummary(serverUrl)).enrichment.state, 'offline')
        await quietPeriod()
        process.emit('SIGTERM')
        assert.equal(await running, 0)
        assert.equal(fakes.requestCount(), 0)
      }))

    it('fetches registry metadata with the deptrail user agent without --offline', () =>
      withEnrichmentFakes('online-cache', async (fakes) => {
        const { out, io } = captureIo()
        const running = main([monolithFixture, '--no-open'], fakes.env, io)
        await printed(out, running)
        await eventually(async () => fakes.registry.requests.length > 0)
        assert.notEqual((await scanSummary(servedUrl(out))).enrichment.state, 'offline')
        process.emit('SIGTERM')
        assert.equal(await running, 0)
        const sent = fakes.registry.requests
        const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version: string }
        assert.ok(sent.length > 0)
        assert.ok(sent.every((request) => request.headers['user-agent'] === `deptrail/${version} node/${process.version}`))
        assert.equal(JSON.stringify(sent).includes(SECRET), false)
      }))

    it('sends nothing and prints no enrichment with --json', () =>
      withEnrichmentFakes('json-cache', async (fakes) => {
        const { out, io } = captureIo()
        assert.equal(await main([monolithFixture, '--json'], fakes.env, io), 0)
        await quietPeriod()
        const scan = JSON.parse(out.join(''))
        assert.equal('enrichment' in scan, false)
        assert.equal(fakes.requestCount(), 0)
      }))
  })

  it('reports actions as unavailable for every root with --offline', async () => {
    const { out, io } = captureIo()
    const running = main([monolithFixture, '--no-open', '--offline'], env, io)
    await printed(out, running)
    const serverUrl = servedUrl(out)
    await eventually(async () => (await scanSummary(serverUrl)).roots.every((root) => root.status !== 'scanning'))
    const roots = (await scanSummary(serverUrl)).roots
    assert.equal(roots.find((root) => root.id === 'npm-package')?.actions.reason, 'Actions are unavailable with --offline')
    assert.ok(roots.every((root) => !root.actions.available))
    process.emit('SIGTERM')
    assert.equal(await running, 0)
  })

  it('picks the browser command by platform', () => {
    assert.equal(browserCommand('darwin', 'u').command, 'open')
    assert.equal(browserCommand('linux', 'u').command, 'xdg-open')
    assert.deepEqual(browserCommand('win32', 'u'), { command: 'cmd', args: ['/c', 'start', '""', 'u'] })
  })
})
