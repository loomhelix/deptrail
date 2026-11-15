import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandRunner } from '../src/adapters/command-runner.ts'
import { createActionService, type ActionService } from '../src/actions/action-service.ts'
import { createProcessRunner } from '../src/adapters/command-runner.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import { createEnrichmentService, offlineEnrichment, type EnrichmentService } from '../src/enrich/enrichment-service.ts'
import { createHttpClient } from '../src/enrich/http.ts'
import type { PackageInsight } from '../src/query/package-insight.ts'
import { startScanSession, type ScanSession } from '../src/scan/scan-session.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import type { DecorationsResponse, IssueGroupsResponse, IssueRowsResponse, ScanSummary } from '../src/server/router.ts'
import type { RootGraph, Scan } from '../src/model.ts'
import { encodeRootSegment } from '../src/server/root-segment.ts'
import { createFsReader } from '../src/sources/file-reader.ts'
import { createGitReader } from '../src/sources/git-reader.ts'
import type { GitRepository } from '../src/git/git-repository.ts'
import type { CompareResponse } from '../src/query/compare.ts'
import { createSourceRegistry, type SourceRegistry } from '../src/scan/source-registry.ts'
import { COMMIT_RESOLVE_REASON, createBranches } from '../src/server/branches.ts'
import { directoryTree } from './helpers/git-tree.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta, stubEnrichment } from './helpers/enrichment-view.ts'
import { startFakeServer } from './helpers/fake-http.ts'
import { installFakePackageManager, type FakeManager } from './helpers/fake-package-manager.ts'

const monolithFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'monolith')
const SECRET = 'fixture-secret-token'
const SENTINEL_FILE = 'sentinel.txt'
const SENTINEL_TEXT = 'outside-static-dir'

const throwingRunner: CommandRunner = async () => {
  throw new Error('runner must not be called')
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string }

function request(
  server: RunningServer,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port: server.port, method: options.method ?? 'GET', path: options.path, headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () =>
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    outgoing.on('error', reject)
    outgoing.end(options.body)
  })
}

describe('token-protected server', () => {
  let server: RunningServer
  let session: ScanSession
  let staticDir: string
  let outerDir: string
  let emptyStaticDir: string
  let emptyServer: RunningServer

  function authed(pathname: string, method = 'GET'): Promise<Reply> {
    const origin = { origin: `http://127.0.0.1:${server.port}` }
    return request(server, { method, path: pathname, headers: { 'x-deptrail-token': server.token, ...(method === 'POST' ? origin : {}) } })
  }

  before(async () => {
    outerDir = await mkdtemp(path.join(tmpdir(), 'deptrail-outer-'))
    staticDir = path.join(outerDir, 'static')
    await mkdir(staticDir)
    await writeFile(path.join(outerDir, SENTINEL_FILE), SENTINEL_TEXT)
    emptyStaticDir = await mkdtemp(path.join(tmpdir(), 'deptrail-empty-'))
    await writeFile(path.join(staticDir, 'index.html'), '<html>deptrail</html>')
    await writeFile(path.join(staticDir, 'app.js'), 'console.log(1)')
    session = await startScanSession({
      repoPath: monolithFixture,
      reader: createFsReader(monolithFixture),
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: null,
    })
    await session.ready
    server = await startServer({ session, staticDir })
    emptyServer = await startServer({ session, staticDir: emptyStaticDir })
  })

  after(async () => {
    await server.close()
    await emptyServer.close()
    await rm(outerDir, { recursive: true, force: true })
    await rm(emptyStaticDir, { recursive: true, force: true })
  })

  it('binds to 127.0.0.1 with a 64 hex character token', () => {
    assert.match(server.token, /^[0-9a-f]{64}$/)
    assert.equal(server.url, `http://127.0.0.1:${server.port}/?token=${server.token}`)
  })

  it('rejects requests without a token', async () => {
    assert.equal((await request(server, { path: '/api/scan' })).status, 401)
    assert.equal((await request(server, { path: '/' })).status, 401)
  })

  it('rejects a wrong token of any length', async () => {
    for (const wrong of ['x', server.token.replace(/.$/, '0x'), 'a'.repeat(64)]) {
      const reply = await request(server, { path: '/api/scan', headers: { 'x-deptrail-token': wrong } })
      assert.equal(reply.status, 401)
    }
    assert.equal((await request(server, { path: '/?token=nope' })).status, 401)
  })

  it('rejects a foreign Host header with 403 even with a valid token', async () => {
    const reply = await request(server, {
      path: '/api/scan',
      headers: { host: `evil.example:${server.port}`, 'x-deptrail-token': server.token },
    })
    assert.equal(reply.status, 403)
    const wrongPort = await request(server, {
      path: '/api/scan',
      headers: { host: '127.0.0.1:1', 'x-deptrail-token': server.token },
    })
    assert.equal(wrongPort.status, 403)
  })

  it('accepts the localhost Host header', async () => {
    const reply = await request(server, {
      path: '/api/scan',
      headers: { host: `localhost:${server.port}`, 'x-deptrail-token': server.token },
    })
    assert.equal(reply.status, 200)
  })

  it('sets the session cookie on GET /?token= and redirects keeping other params', async () => {
    const reply = await request(server, { path: `/?token=${server.token}&view=graph` })
    assert.equal(reply.status, 302)
    assert.equal(reply.headers['set-cookie']?.[0], `deptrail_token_${server.port}=${server.token}; HttpOnly; SameSite=Strict; Path=/`)
    assert.equal(reply.headers.location, '/?view=graph')
  })

  it('accepts the cookie on later requests', async () => {
    const reply = await request(server, { path: '/api/scan', headers: { cookie: `other=1; deptrail_token_${server.port}=${server.token}` } })
    assert.equal(reply.status, 200)
  })

  it('keeps two instances on different ports authorized with one shared cookie jar', async () => {
    const cookieJar: string[] = []
    for (const instance of [server, emptyServer]) {
      const reply = await request(instance, { path: `/?token=${instance.token}` })
      cookieJar.push(String(reply.headers['set-cookie']?.[0]).split(';')[0])
    }
    assert.notEqual(cookieJar[0].split('=')[0], cookieJar[1].split('=')[0])
    for (const instance of [server, emptyServer]) {
      const reply = await request(instance, { path: '/api/scan', headers: { cookie: cookieJar.join('; ') } })
      assert.equal(reply.status, 200)
    }
  })

  it('accepts only the cookie named after its own port', async () => {
    const foreignName = await request(server, { path: '/api/scan', headers: { cookie: `deptrail_token_${emptyServer.port}=${server.token}` } })
    assert.equal(foreignName.status, 401)
    const unscopedName = await request(server, { path: '/api/scan', headers: { cookie: `deptrail_token=${server.token}` } })
    assert.equal(unscopedName.status, 401)
  })

  it('lists every fixture root without leaking npmrc secrets', async () => {
    const reply = await authed('/api/scan')
    assert.equal(reply.status, 200)
    assert.equal(reply.headers['cache-control'], 'no-store')
    assert.equal(reply.headers['x-content-type-options'], 'nosniff')
    const summary = JSON.parse(reply.text) as ScanSummary
    assert.deepEqual(summary.roots.map((root) => root.id).sort(), ['legacy/admin', 'npm-package', 'scripts/release', 'services/api'])
    const npmPackage = summary.roots.find((root) => root.id === 'npm-package')!
    assert.equal(npmPackage.hasAuth, true)
    assert.ok(npmPackage.packageCount > 0)
    assert.ok(npmPackage.importers.length > 0)
    assert.equal(reply.text.includes(SECRET), false)
    assert.equal('config' in npmPackage, false)
    for (const secretBearing of ['/api/search?q=vue', '/api/duplicates', '/api/roots/npm-package/importers']) {
      assert.equal((await authed(secretBearing)).text.includes(SECRET), false)
    }
  })

  it('reports the dependency count of every fixture importer', async () => {
    const summary = JSON.parse((await authed('/api/scan')).text) as ScanSummary
    const npmPackage = summary.roots.find((root) => root.id === 'npm-package')!
    const countsByName = Object.fromEntries(npmPackage.importers.map((importer) => [importer.name, importer.dependencyCount]))
    assert.deepEqual(countsByName, { 'npm-package': 1, '@fixture/commerce-ui': 2, '@fixture/storefront': 2, '@fixture/build': 1 })
    for (const root of summary.roots) {
      const graph = session.root(root.id)!
      for (const importer of root.importers) {
        const expected = graph.importers.find((candidate) => candidate.id === importer.id)!.deps.length
        assert.equal(importer.dependencyCount, expected, `${root.id} ${importer.id}`)
      }
    }
  })

  it('round-trips a slash-containing root id and a scoped peer-suffixed node id on /dependents', async () => {
    const slashed = await authed(`/api/roots/${encodeURIComponent('legacy/admin')}/nodes/${encodeURIComponent('semver@6.3.1')}/dependents`)
    assert.equal(slashed.status, 200)
    assert.equal(JSON.parse(slashed.text).focus.id, 'semver@6.3.1')

    const peerSuffixedId = [...session.root('npm-package')!.packages.keys()].find((id) => id.startsWith('@vue/compiler-sfc@3.5.13('))!
    assert.ok(peerSuffixedId)
    const scoped = await authed(`/api/roots/npm-package/nodes/${encodeURIComponent(peerSuffixedId)}/dependents?depth=2`)
    assert.equal(scoped.status, 200)
    assert.equal(JSON.parse(scoped.text).focus.id, peerSuffixedId)
  })

  it('serves children and subgraph with defaults and rejects invalid parameters', async () => {
    const importerId = session.root('npm-package')!.importers[0]!.id
    const encodedImporter = encodeURIComponent(importerId)
    assert.equal((await authed(`/api/roots/npm-package/nodes/${encodedImporter}/children`)).status, 200)
    assert.equal((await authed(`/api/roots/npm-package/nodes/${encodedImporter}/subgraph?up=1&down=2&limit=50`)).status, 200)
    for (const bad of ['depth=-1', 'depth=abc', 'depth=1.5', 'kinds=prod,bogus']) {
      assert.equal((await authed(`/api/roots/npm-package/nodes/${encodedImporter}/children?${bad}`)).status, 400, bad)
    }
    for (const bad of ['limit=0', 'up=-1', 'down=x']) {
      assert.equal((await authed(`/api/roots/npm-package/nodes/${encodedImporter}/subgraph?${bad}`)).status, 400, bad)
    }
    assert.equal((await authed(`/api/roots/npm-package/nodes/${encodedImporter}/children?kinds=prod,dev`)).status, 200)
  })

  it('returns 404 for unknown roots, nodes and API paths', async () => {
    assert.equal((await authed('/api/roots/nope/nodes/x/children')).status, 404)
    assert.equal((await authed('/api/roots/nope/importers')).status, 404)
    const unknownNode = await authed('/api/roots/npm-package/nodes/missing%401.0.0/dependents')
    assert.equal(unknownNode.status, 404)
    assert.ok(JSON.parse(unknownNode.text).error)
    assert.equal((await authed('/api/unknown')).status, 404)
    assert.equal((await authed('/api/roots/nope/resolve', 'POST')).status, 404)
  })

  it('returns 405 for the wrong method on known API paths', async () => {
    assert.equal((await authed('/api/scan', 'POST')).status, 405)
    assert.equal((await authed('/api/rescan')).status, 405)
    assert.equal((await authed('/api/roots/npm-package/resolve')).status, 405)
  })

  it('answers 400 for malformed path encoding', async () => {
    assert.equal((await authed('/api/roots/%E0%A4%A/importers')).status, 400)
  })

  it('searches and reports duplicates', async () => {
    const found = JSON.parse((await authed('/api/search?q=semver')).text)
    assert.ok(found.length > 0)
    assert.equal((await authed('/api/duplicates?root=npm-package')).status, 200)
  })

  it('accepts resolve and rescan with 202 without awaiting them', async () => {
    assert.equal((await authed('/api/roots/scripts%2Frelease/resolve', 'POST')).status, 202)
    assert.equal((await authed('/api/rescan', 'POST')).status, 202)
    await session.ready
  })

  it('serves static files, falls back to index.html and blocks traversal', async () => {
    const index = await authed('/')
    assert.equal(index.status, 200)
    assert.match(String(index.headers['content-type']), /text\/html/)
    const script = await authed('/app.js')
    assert.match(String(script.headers['content-type']), /javascript/)
    assert.equal(script.text, 'console.log(1)')
    assert.equal((await authed('/some/client/route')).text, '<html>deptrail</html>')
    for (const traversalPath of [`/..%2F${SENTINEL_FILE}`, `/%2e%2e%2f${SENTINEL_FILE}`, `/..%2F..%2F${path.basename(outerDir)}%2F${SENTINEL_FILE}`]) {
      const traversal = await authed(traversalPath)
      assert.equal(traversal.text.includes(SENTINEL_TEXT), false, traversalPath)
    }
  })

  it('answers 503 when the UI is not built, still behind auth', async () => {
    assert.equal((await request(emptyServer, { path: '/' })).status, 401)
    const reply = await request(emptyServer, { path: '/', headers: { 'x-deptrail-token': emptyServer.token } })
    assert.equal(reply.status, 503)
    assert.equal(reply.text, 'UI is not built. Run pnpm build.')
  })

  it('does not route request-controlled action names to inherited properties', async () => {
    for (const action of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const reply = await authed(`/api/roots/npm-package/nodes/x/${action}`)
      assert.equal(reply.status, 404, action)
      assert.equal(reply.text.includes('config'), false, action)
    }
  })

  it('answers 401 and 403 on API paths as no-store JSON', async () => {
    const unauthorized = await request(server, { path: '/api/scan' })
    assert.equal(unauthorized.headers['cache-control'], 'no-store')
    assert.ok(JSON.parse(unauthorized.text).error)
    const forbidden = await request(server, { path: '/api/scan', headers: { host: 'evil.example', 'x-deptrail-token': server.token } })
    assert.equal(forbidden.status, 403)
    assert.ok(JSON.parse(forbidden.text).error)
  })

  it('requires a same-origin Origin header on POST', async () => {
    const headers = { 'x-deptrail-token': server.token }
    const missing = await request(server, { method: 'POST', path: '/api/rescan', headers })
    assert.equal(missing.status, 403)
    assert.ok(JSON.parse(missing.text).error)
    const foreign = await request(server, { method: 'POST', path: '/api/rescan', headers: { ...headers, origin: 'http://evil.example' } })
    assert.equal(foreign.status, 403)
    const sameOrigin = await request(server, { method: 'POST', path: '/api/rescan', headers: { ...headers, origin: `http://localhost:${server.port}` } })
    assert.equal(sameOrigin.status, 202)
    await session.ready
  })

  describe('hardening', () => {
    const FRAME_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }

    function assertFrameProtected(reply: Reply): void {
      assert.equal(reply.headers['x-frame-options'], FRAME_HEADERS['x-frame-options'])
      assert.equal(reply.headers['content-security-policy'], FRAME_HEADERS['content-security-policy'])
    }

    function sameOriginHeaders(extra: Record<string, string> = {}): Record<string, string> {
      return { 'x-deptrail-token': server.token, origin: `http://127.0.0.1:${server.port}`, ...extra }
    }

    it('sets frame protection headers on every kind of response', async () => {
      const token = { 'x-deptrail-token': server.token }
      assertFrameProtected(await request(server, { path: '/', headers: token }))
      assertFrameProtected(await request(server, { path: '/api/scan', headers: token }))
      assertFrameProtected(await request(server, { path: '/api/scan' }))
      assertFrameProtected(await request(server, { path: '/api/scan', headers: { host: 'evil.example', ...token } }))
      assertFrameProtected(await request(server, { path: '/missing.js', headers: token }))
      const redirect = await request(server, { path: `/?token=${server.token}` })
      assert.equal(redirect.status, 302)
      assertFrameProtected(redirect)
    })

    it('requires an Origin on every method other than GET and HEAD', async () => {
      for (const method of ['DELETE', 'PUT']) {
        const reply = await request(server, { method, path: '/api/scan', headers: { 'x-deptrail-token': server.token } })
        assert.equal(reply.status, 403)
        assert.equal(JSON.parse(reply.text).error, 'Forbidden origin')
      }
      const allowed = await request(server, { method: 'DELETE', path: '/api/scan', headers: sameOriginHeaders() })
      assert.equal(allowed.status, 405)
    })

    it('rejects a body that is not JSON with 415', async () => {
      const reply = await request(server, {
        method: 'POST',
        path: '/api/rescan',
        headers: sameOriginHeaders({ 'content-type': 'text/plain' }),
        body: 'x',
      })
      assert.equal(reply.status, 415)
      assert.equal(JSON.parse(reply.text).error, 'Content-Type must be application/json')
    })

    it('rejects a body over 64 KB with 413', async () => {
      const reply = await request(server, {
        method: 'POST',
        path: '/api/rescan',
        headers: sameOriginHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ filler: 'a'.repeat(70_000) }),
      })
      assert.equal(reply.status, 413)
      assert.equal(JSON.parse(reply.text).error, 'Request body is larger than 64 KB')
    })

    it('rejects a chunked body over 64 KB with 413', async () => {
      const reply = await request(server, {
        method: 'POST',
        path: '/api/rescan',
        headers: sameOriginHeaders({ 'content-type': 'application/json', 'transfer-encoding': 'chunked' }),
        body: JSON.stringify({ filler: 'a'.repeat(200_000) }),
      })
      assert.equal(reply.status, 413)
      assert.equal(JSON.parse(reply.text).error, 'Request body is larger than 64 KB')
    })

    it('rejects malformed JSON with 400', async () => {
      const reply = await request(server, {
        method: 'POST',
        path: '/api/rescan',
        headers: sameOriginHeaders({ 'content-type': 'application/json; charset=utf-8' }),
        body: '{bad',
      })
      assert.equal(reply.status, 400)
      assert.equal(JSON.parse(reply.text).error, 'Malformed JSON body')
      await session.ready
    })

    it('accepts a POST without a body', async () => {
      const reply = await request(server, { method: 'POST', path: '/api/rescan', headers: sameOriginHeaders() })
      assert.equal(reply.status, 202)
      await session.ready
    })
  })

  it('reaches a repository-root root through the tilde segment', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'deptrail-dotroot-'))
    const lockfile = {
      name: 'dotroot',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'dotroot', version: '1.0.0', dependencies: { left: '^1.0.0' } },
        'node_modules/left': { version: '1.0.0' },
      },
    }
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'dotroot', version: '1.0.0', dependencies: { left: '^1.0.0' } }))
    await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify(lockfile))
    const dotSession = await startScanSession({
      repoPath: repo,
      reader: createFsReader(repo),
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: null,
    })
    await dotSession.ready
    const dotServer = await startServer({ session: dotSession, staticDir })
    try {
      const call = (method: string, pathname: string): Promise<Reply> =>
        request(dotServer, {
          method,
          path: pathname,
          headers: { 'x-deptrail-token': dotServer.token, origin: `http://127.0.0.1:${dotServer.port}` },
        })
      const rootId = dotSession.scan.roots[0]!.id
      assert.equal(rootId, '.')
      const importers = await call('GET', `/api/roots/${encodeRootSegment(rootId)}/importers`)
      assert.equal(importers.status, 200)
      const importerId = JSON.parse(importers.text)[0].id as string
      const children = await call('GET', `/api/roots/~/nodes/${encodeURIComponent(importerId)}/children`)
      assert.equal(children.status, 200)
      assert.equal((await call('POST', '/api/roots/~/resolve')).status, 202)
      await dotSession.ready
    } finally {
      await dotServer.close()
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('server error log', () => {
  const CREDENTIAL_URL = 'https://deploy:hunter2@registry.example.test/'
  let staticDir: string

  function stubSession(overrides: Partial<ScanSession> = {}): ScanSession {
    const scan: Scan = { repoPath: '/repo', scannedAt: '2026-10-25T00:00:00.000Z', roots: [] }
    return { scan, index: new Map(), ready: Promise.resolve(), root: () => undefined, resolve: async () => {}, refreshRoot: async () => {}, rescan: async () => {}, ...overrides }
  }

  async function withServer(session: ScanSession, exercise: (server: RunningServer, logged: string[]) => Promise<void>): Promise<void> {
    const logged: string[] = []
    const server = await startServer({ session, staticDir, errorStream: { write: (text: string) => logged.push(text) } })
    try {
      await exercise(server, logged)
    } finally {
      await server.close()
    }
  }

  function authedRequest(server: RunningServer, method: string, pathname: string): Promise<Reply> {
    return request(server, { method, path: pathname, headers: { 'x-deptrail-token': server.token, origin: `http://127.0.0.1:${server.port}` } })
  }

  async function loggedEventually(logged: string[]): Promise<void> {
    const deadline = Date.now() + 2000
    while (logged.length === 0) {
      assert.ok(Date.now() < deadline, 'nothing was logged')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  before(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'deptrail-errlog-'))
  })

  after(async () => {
    await rm(staticDir, { recursive: true, force: true })
  })

  it('logs a failing API handler as one redacted line and answers 500', async () => {
    const session = stubSession()
    Object.defineProperty(session, 'scan', {
      get() {
        throw new Error(`index exploded at ${CREDENTIAL_URL}\nwith _authToken=abc123`)
      },
    })
    await withServer(session, async (server, logged) => {
      const reply = await authedRequest(server, 'GET', '/api/scan')
      assert.equal(reply.status, 500)
      assert.equal(reply.text.includes('exploded'), false)
      assert.deepEqual(logged, ['deptrail: GET /api/scan failed: index exploded at https://registry.example.test/ with _authToken=[redacted]\n'])
    })
  })

  it('logs a failure that escapes the request handler without the query string', async () => {
    const unserializable = { id: 'r', path: 'r', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [BigInt(1)] }
    const session = stubSession({ scan: { repoPath: '/repo', scannedAt: 'now', roots: [unserializable as unknown as RootGraph] } })
    await withServer(session, async (server, logged) => {
      const reply = await authedRequest(server, 'GET', '/api/scan?probe=1')
      assert.equal(reply.status, 500)
      assert.equal(logged.length, 1)
      assert.match(logged[0]!, /^deptrail: GET \/api\/scan failed: .*BigInt.*\n$/)
    })
  })

  it('logs detached rescan and resolve failures redacted', async () => {
    const root = { id: 'app' } as RootGraph
    const session = stubSession({
      root: () => root,
      rescan: async () => {
        throw new Error(`rescan broke on ${CREDENTIAL_URL}`)
      },
      resolve: async () => {
        throw new Error('resolve broke with Bearer secret-bearer')
      },
    })
    await withServer(session, async (server, logged) => {
      assert.equal((await authedRequest(server, 'POST', '/api/rescan')).status, 202)
      await loggedEventually(logged)
      assert.deepEqual(logged.splice(0), ['deptrail: rescan failed: rescan broke on https://registry.example.test/\n'])
      assert.equal((await authedRequest(server, 'POST', '/api/roots/app/resolve')).status, 202)
      await loggedEventually(logged)
      assert.deepEqual(logged, ['deptrail: resolve app failed: resolve broke with Bearer [redacted]\n'])
    })
  })
})

describe('enrichment API', () => {
  const SEMVER_ID = 'semver@5.7.2'
  const servers: RunningServer[] = []
  let session: ScanSession
  let staticDir: string

  function enrichedView() {
    return makeEnrichmentView({
      revision: 7,
      meta: {
        semver: makeMeta({ versions: ['5.7.2', '5.7.3', '6.3.1', '7.6.3', '7.7.0'], latest: '7.7.0' }),
        'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
        'read-pkg-up': makeMeta({ versions: ['7.0.1', '11.0.0'], latest: '11.0.0', deprecated: { '7.0.1': 'Renamed to read-package-up' } }),
      },
      vulns: { [SEMVER_ID]: ['GHSA-test-0001'], 'semver@6.3.1': ['GHSA-test-0002'] },
      advisories: {
        semver: [
          makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] }),
          makeAdvisory({ id: 'GHSA-test-0002', severity: 'moderate', events: [{ introduced: '6.0.0' }, { fixed: '6.3.2' }] }),
        ],
      },
    })
  }

  async function serve(options: { session?: ScanSession; enrichment?: EnrichmentService } = {}): Promise<RunningServer> {
    const server = await startServer({ session: options.session ?? session, staticDir, ...(options.enrichment ? { enrichment: options.enrichment } : {}) })
    servers.push(server)
    return server
  }

  function call(server: RunningServer, pathname: string, method = 'GET'): Promise<Reply> {
    return request(server, { method, path: pathname, headers: { 'x-deptrail-token': server.token, origin: `http://127.0.0.1:${server.port}` } })
  }

  async function json<T>(server: RunningServer, pathname: string): Promise<T> {
    const reply = await call(server, pathname)
    assert.equal(reply.status, 200, `${pathname}: ${reply.text}`)
    return JSON.parse(reply.text) as T
  }

  function withScanningRoot(base: ScanSession, rootId: string): ScanSession {
    const roots = base.scan.roots.map((root) => (root.id === rootId ? { ...root, status: 'scanning' as const } : root))
    return { ...base, scan: { ...base.scan, roots }, index: base.index, root: (id) => roots.find((root) => root.id === id) }
  }

  before(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'deptrail-enrichment-api-'))
    session = await startScanSession({
      repoPath: monolithFixture,
      reader: createFsReader(monolithFixture),
      runner: throwingRunner,
      cache: null,
      env: {},
      userNpmrc: null,
    })
    await session.ready
  })

  after(async () => {
    await Promise.all(servers.map((server) => server.close()))
    await rm(staticDir, { recursive: true, force: true })
  })

  it('adds the enrichment status and issue counts of ready roots to /api/scan', async () => {
    const server = await serve({ enrichment: stubEnrichment(enrichedView()) })
    const summary = await json<ScanSummary>(server, '/api/scan')
    assert.equal(summary.enrichment.state, 'done')
    assert.equal(summary.enrichment.revision, 7)
    const counts = Object.fromEntries(summary.roots.map((root) => [root.id, root.issueCounts]))
    assert.deepEqual(counts['npm-package'], { vulnerable: 1, worst: 'high', deprecated: 1, outdatedDirect: 2 })
    assert.deepEqual(counts['legacy/admin'], { vulnerable: 1, worst: 'moderate', deprecated: 0, outdatedDirect: 1 })
    assert.deepEqual(counts['services/api'], { vulnerable: 0, deprecated: 0, outdatedDirect: 0 })
  })

  it('reports enrichment as offline when the server gets no enrichment service', async () => {
    const server = await serve()
    const summary = await json<ScanSummary>(server, '/api/scan')
    assert.equal(summary.enrichment.state, 'offline')
    assert.deepEqual(summary.enrichment.problems, [])
  })

  it('reports a scanning root as running and gives it no issue counts', async () => {
    const server = await serve({ session: withScanningRoot(session, 'npm-package'), enrichment: stubEnrichment(enrichedView()) })
    const summary = await json<ScanSummary>(server, '/api/scan')
    assert.equal(summary.enrichment.state, 'running')
    const npmPackage = summary.roots.find((root) => root.id === 'npm-package')!
    assert.equal('issueCounts' in npmPackage, false)
    assert.ok(summary.roots.find((root) => root.id === 'legacy/admin')?.issueCounts)
  })

  it('serves the decorations of a ready root with the revision and rejects roots that are not ready', async () => {
    const server = await serve({ enrichment: stubEnrichment(enrichedView()) })
    const body = await json<DecorationsResponse>(server, '/api/roots/npm-package/decorations')
    assert.equal(body.revision, 7)
    assert.deepEqual(body.nodes[SEMVER_ID]?.vuln, { severity: 'high', count: 1 })
    assert.deepEqual(body.nodes['read-pkg-up@7.0.1']?.below, { count: 1, worst: 'high' })
    assert.equal(body.nodes['read-pkg-up@7.0.1']?.deprecated, true)
    assert.equal('importer:storefront' in body.nodes, true)
    assert.equal((await call(server, '/api/roots/npm-package/decorations?kinds=prod,bogus')).status, 400)
    assert.equal((await call(server, '/api/roots/nope/decorations')).status, 404)
    assert.equal((await call(server, '/api/roots/npm-package/decorations', 'POST')).status, 405)
    const scanning = await serve({ session: withScanningRoot(session, 'npm-package'), enrichment: stubEnrichment(enrichedView()) })
    const busy = await call(scanning, '/api/roots/npm-package/decorations')
    assert.equal(busy.status, 409)
    assert.equal(JSON.parse(busy.text).error, 'Root npm-package is scanning')
  })

  it('lists issues by package across the monolith or for one root', async () => {
    const server = await serve({ enrichment: stubEnrichment(enrichedView()) })
    const all = await json<IssueRowsResponse>(server, '/api/issues')
    assert.equal(all.revision, 7)
    const vulnerable = all.rows.filter((row) => row.kinds.includes('vulnerability')).map((row) => `${row.name}@${row.version}`)
    assert.deepEqual(vulnerable, [SEMVER_ID, 'semver@6.3.1'])
    const scoped = await json<IssueRowsResponse>(server, `/api/issues?root=${encodeURIComponent('legacy/admin')}&groupBy=package`)
    assert.deepEqual(scoped.rows.map((row) => `${row.name}@${row.version}`), ['semver@6.3.1'])
    assert.ok(scoped.rows.every((row) => row.locations.every((location) => location.rootId === 'legacy/admin')))
  })

  it('groups issues by direct dependency and validates groupBy and root', async () => {
    const server = await serve({ enrichment: stubEnrichment(enrichedView()) })
    const body = await json<IssueGroupsResponse>(server, '/api/issues?root=npm-package&groupBy=direct')
    assert.equal(body.revision, 7)
    const readPkgUp = body.groups.find((group) => group.direct === 'read-pkg-up@7.0.1')
    assert.deepEqual(readPkgUp?.issues.map((issue) => issue.nodeId), [SEMVER_ID])
    assert.equal('rows' in body, false)
    const invalid = await call(server, '/api/issues?groupBy=tree')
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.text).error, 'Invalid groupBy: expected package or direct')
    assert.equal((await call(server, '/api/issues?kinds=bogus')).status, 400)
    const unknown = await call(server, '/api/issues?root=nope')
    assert.equal(unknown.status, 404)
    assert.equal(JSON.parse(unknown.text).error, 'Unknown root nope')
    assert.equal((await call(server, '/api/issues', 'POST')).status, 405)
    const scanning = await serve({ session: withScanningRoot(session, 'npm-package'), enrichment: stubEnrichment(enrichedView()) })
    assert.equal((await call(scanning, '/api/issues?root=npm-package')).status, 409)
    const monolith = await json<IssueRowsResponse>(scanning, '/api/issues')
    assert.deepEqual(monolith.rows.map((row) => `${row.name}@${row.version}`), ['semver@6.3.1'])
  })

  it('serves the package insight with the severities of other monolith versions', async () => {
    const server = await serve({ enrichment: stubEnrichment(enrichedView()) })
    const insight = await json<PackageInsight>(server, `/api/roots/npm-package/nodes/${encodeURIComponent(SEMVER_ID)}/insight`)
    assert.equal(insight.revision, 7)
    assert.deepEqual(insight.vulnerabilities.items.map((item) => item.id), ['GHSA-test-0001'])
    assert.deepEqual(insight.versionSeverities, { '6.3.1': 'moderate' })
    assert.equal(insight.registry.latest, '7.7.0')
    const unknown = await call(server, `/api/roots/npm-package/nodes/${encodeURIComponent('missing@1.0.0')}/insight`)
    assert.equal(unknown.status, 404)
    assert.equal(JSON.parse(unknown.text).error, 'Unknown node missing@1.0.0')
    assert.equal((await call(server, `/api/roots/npm-package/nodes/${encodeURIComponent(SEMVER_ID)}/insight?kinds=bogus`)).status, 400)
  })

  it('accepts a refresh with 202 and refuses it with 409 while offline', async () => {
    const enrichment = stubEnrichment(enrichedView())
    const server = await serve({ enrichment })
    const accepted = await call(server, '/api/enrichment/refresh', 'POST')
    assert.equal(accepted.status, 202)
    assert.equal(enrichment.refreshCalls, 1)
    assert.equal((await call(server, '/api/enrichment/refresh')).status, 405)
    assert.equal(enrichment.refreshCalls, 1)
    const offlineStub = stubEnrichment(enrichedView(), { state: 'offline' })
    const offlineServer = await serve({ enrichment: offlineStub })
    const refused = await call(offlineServer, '/api/enrichment/refresh', 'POST')
    assert.equal(refused.status, 409)
    assert.equal(JSON.parse(refused.text).error, 'Package checks are disabled with --offline')
    assert.equal(offlineStub.refreshCalls, 0)
    const defaultServer = await serve({ enrichment: offlineEnrichment() })
    assert.equal((await call(defaultServer, '/api/enrichment/refresh', 'POST')).status, 409)
  })

  it('requires a same-origin Origin header on refresh', async () => {
    const enrichment = stubEnrichment(enrichedView())
    const server = await serve({ enrichment })
    const reply = await request(server, { method: 'POST', path: '/api/enrichment/refresh', headers: { 'x-deptrail-token': server.token } })
    assert.equal(reply.status, 403)
    assert.equal(enrichment.refreshCalls, 0)
  })

  it('reports problem origins without the path of the failing URL', async () => {
    const registry = await startFakeServer(() => ({ status: 403 }))
    const osv = await startFakeServer(() => ({ status: 400 }))
    const env = { npm_config_registry: `${registry.url}/path-token-secret/` }
    const abort = new AbortController()
    const enrichment = createEnrichmentService({
      reader: createFsReader(monolithFixture),
      env,
      userNpmrc: null,
      http: createHttpClient({ userAgent: 'deptrail-test', signal: abort.signal }),
      osvUrl: `${osv.url}/osv-path-secret`,
      cache: null,
      secrets: createSecretSet(),
      offline: false,
      abort,
    })
    try {
      const failingSession = await startScanSession({
        repoPath: monolithFixture,
        reader: createFsReader(monolithFixture),
        runner: throwingRunner,
        cache: null,
        env,
        userNpmrc: null,
        onRootPublished: (roots) => enrichment.track(roots),
      })
      await failingSession.ready
      await enrichment.settled()
      const server = await serve({ session: failingSession, enrichment })
      const reply = await call(server, '/api/scan')
      const { problems } = (JSON.parse(reply.text) as ScanSummary).enrichment
      assert.deepEqual(problems.map((problem) => problem.source).sort(), ['osv', 'registry'])
      assert.deepEqual(problems.map((problem) => problem.origin).sort(), [osv.url, registry.url].sort())
      assert.equal(reply.text.includes('path-token-secret'), false)
      assert.equal(reply.text.includes('osv-path-secret'), false)
      assert.ok(registry.requests.length > 0)
    } finally {
      enrichment.close()
      await registry.close()
      await osv.close()
    }
  })

  it('keeps npmrc secrets out of scan, decorations, issues and insight bodies', async () => {
    const server = await serve({ enrichment: stubEnrichment(enrichedView()) })
    for (const pathname of [
      '/api/scan',
      '/api/roots/npm-package/decorations',
      '/api/issues',
      '/api/issues?groupBy=direct',
      `/api/roots/npm-package/nodes/${encodeURIComponent(SEMVER_ID)}/insight`,
      `/api/roots/npm-package/nodes/${encodeURIComponent('importer:storefront')}/insight`,
    ]) {
      const reply = await call(server, pathname)
      assert.equal(reply.status, 200, pathname)
      assert.equal(reply.text.includes(SECRET), false, pathname)
    }
  })
})

describe('actions API', () => {
  const ROOT = 'npm-package'
  const SEMVER_ID = 'semver@5.7.2'
  const CANARY = 'canary-token-7'
  const SLOW_RUN = { DEPTRAIL_FAKE_PM_SLEEP_MS: '600' }
  const META = {
    semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.6.3', '7.7.1'], latest: '7.7.1' }),
    'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
    'vue-eslint-parser': makeMeta({
      versions: ['9.4.3', '9.4.4', '10.0.0'],
      manifests: { '9.4.3': { semver: '5.7.2' }, '9.4.4': { semver: '^7.3.6' }, '10.0.0': { semver: '^7.6.0' } },
    }),
    'eslint-plugin-vue': makeMeta({ versions: ['9.32.0'], manifests: { '9.32.0': { 'vue-eslint-parser': '^9.4.3' } } }),
  }
  const VIEW = makeEnrichmentView({
    meta: META,
    vulns: { 'semver@5.7.2': ['GHSA-semver-0001'], 'vue-eslint-parser@9.4.3': ['GHSA-parser-0001'] },
    advisories: {
      semver: [makeAdvisory({ id: 'GHSA-semver-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })],
      'vue-eslint-parser': [makeAdvisory({ id: 'GHSA-parser-0001', severity: 'moderate', events: [{ introduced: '0' }, { fixed: '10.0.0' }] })],
    },
  })

  type Harness = { server: RunningServer; service: ActionService; pnpm: FakeManager; logged: string[]; workDir: string; secrets: ReturnType<typeof createSecretSet> }

  const workDirs: string[] = []
  const closers: (() => Promise<void>)[] = []

  async function setupHarness(env: Record<string, string> = {}, prepareRepo: (repo: string) => Promise<void> = async () => {}): Promise<Harness> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'deptrail-actions-api-'))
    workDirs.push(workDir)
    const repo = path.join(workDir, 'monolith')
    await cp(monolithFixture, repo, { recursive: true })
    await prepareRepo(repo)
    const pnpm = await installFakePackageManager(workDir, 'pnpm')
    const prepared = path.join(workDir, 'prepared-lock.yaml')
    const lockfile = await readFile(path.join(repo, ROOT, 'pnpm-lock.yaml'), 'utf8')
    await writeFile(prepared, lockfile.replaceAll('5.7.2', '5.7.3'))
    const session = await startScanSession({ repoPath: repo, reader: createFsReader(repo), runner: throwingRunner, cache: null, env: {}, userNpmrc: null })
    await session.ready
    const secrets = createSecretSet()
    const runner = createProcessRunner()
    const service = createActionService({
      repoPath: repo,
      session,
      enrichment: stubEnrichment(VIEW, {}, { published: META }),
      runner,
      env: pnpm.env({ COREPACK_ENABLE_NETWORK: '0', DEPTRAIL_FAKE_PM_LOCKFILES: JSON.stringify([prepared]), ...env }),
      offline: false,
      secrets,
    })
    service.track(session.scan.roots)
    const logged: string[] = []
    const staticDir = await mkdtemp(path.join(workDir, 'static-'))
    const server = await startServer({ session, enrichment: stubEnrichment(VIEW), actions: service, staticDir, errorStream: { write: (text) => void logged.push(text) } })
    closers.push(async () => {
      await server.close()
      await service.close()
    })
    return { server, service, pnpm, logged, workDir, secrets }
  }

  async function call(harness: Harness, method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = { 'x-deptrail-token': harness.server.token }
    if (method !== 'GET') headers.origin = `http://127.0.0.1:${harness.server.port}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const reply = await request(harness.server, { method, path: pathname, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: reply.status, json: reply.text === '' ? undefined : JSON.parse(reply.text), text: reply.text }
  }

  const base = `/api/roots/${ROOT}`

  async function addSemverFix(harness: Harness): Promise<void> {
    const added = await call(harness, 'POST', `${base}/changes`, { nodeId: SEMVER_ID, choice: 'recommended' })
    assert.equal(added.status, 201, added.text)
  }

  async function followJob(harness: Harness, jobId: string): Promise<any> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const reply = await call(harness, 'GET', `/api/jobs/${jobId}`)
      assert.equal(reply.status, 200)
      if (reply.json.state !== 'running') return reply.json
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('job did not finish')
  }

  async function ready(harness: Harness): Promise<void> {
    assert.equal((await call(harness, 'GET', `${base}/nodes/${encodeURIComponent('importer:.')}/actions`)).status, 200)
  }

  async function startedPreview(harness: Harness): Promise<string> {
    const started = await call(harness, 'POST', `${base}/preview`)
    assert.equal(started.status, 202, started.text)
    return started.json.jobId
  }

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
    await Promise.all(workDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('puts an actions summary on every root of the scan', async () => {
    const harness = await setupHarness()
    const scan = (await call(harness, 'GET', '/api/scan')).json as ScanSummary
    assert.ok(scan.roots.length > 0)
    for (const root of scan.roots) {
      assert.equal(typeof root.actions.available, 'boolean')
      assert.equal(root.actions.changeCount, 0)
      assert.equal(root.actions.revertable, false)
    }
  })

  it('lists node actions with the fix options', async () => {
    const harness = await setupHarness()
    await ready(harness)
    const reply = await call(harness, 'GET', `${base}/nodes/${encodeURIComponent(SEMVER_ID)}/actions`)
    assert.equal(reply.status, 200)
    assert.ok(reply.json.fix.options.length > 0)
    assert.equal((await call(harness, 'GET', `${base}/nodes/${encodeURIComponent(SEMVER_ID)}/actions?kinds=bogus`)).status, 400)
    assert.equal((await call(harness, 'POST', `${base}/nodes/${encodeURIComponent(SEMVER_ID)}/actions`)).status, 405)
  })

  it('adds, conflicts, validates and removes changes', async () => {
    const harness = await setupHarness()
    await ready(harness)
    const added = await call(harness, 'POST', `${base}/changes`, { nodeId: SEMVER_ID, choice: 'recommended' })
    assert.equal(added.status, 201)
    assert.equal(added.json.choice, 'chain')
    const conflict = await call(harness, 'POST', `${base}/changes`, { nodeId: 'vue-eslint-parser@9.4.3(eslint@9.17.0)', choice: 'override' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.conflictsWith, added.json.id)
    assert.equal((await call(harness, 'POST', `${base}/changes`, { choice: 'recommended' })).status, 400)
    assert.equal((await call(harness, 'POST', `${base}/changes`, { nodeId: SEMVER_ID, choice: 'nonsense' })).status, 400)
    const listed = await call(harness, 'GET', `${base}/changes`)
    assert.equal(listed.json.items.length, 1)
    assert.equal((await call(harness, 'DELETE', `${base}/changes/unknown-item`)).status, 404)
    assert.equal((await call(harness, 'DELETE', `${base}/changes/${added.json.id}`)).status, 204)
    await addSemverFix(harness)
    assert.equal((await call(harness, 'DELETE', `${base}/changes`)).status, 204)
    assert.deepEqual((await call(harness, 'GET', `${base}/changes`)).json.items, [])
    assert.equal((await call(harness, 'PUT', `${base}/changes`)).status, 405)
    assert.equal((await call(harness, 'GET', `${base}/changes/recommended`)).status, 405)
    assert.equal((await call(harness, 'POST', '/api/roots/nope/changes', { nodeId: SEMVER_ID, choice: 'recommended' })).status, 404)
  })

  it('replaces a change in place and refuses an unknown item, a bad body or a conflict', async () => {
    const harness = await setupHarness()
    await ready(harness)
    const update = await call(harness, 'POST', `${base}/changes`, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    assert.equal(update.status, 201, update.text)
    const chain = await call(harness, 'POST', `${base}/changes`, { nodeId: SEMVER_ID, choice: 'recommended' })
    assert.equal(chain.status, 201, chain.text)
    const replaced = await call(harness, 'PUT', `${base}/changes/${update.json.id}`, { nodeId: 'semver@7.6.3', choice: 'latest' })
    assert.equal(replaced.status, 200, replaced.text)
    assert.deepEqual(replaced.json.goal.importers, ['importer:.', 'importer:storefront'])
    const itemIds = async (): Promise<string[]> => (await call(harness, 'GET', `${base}/changes`)).json.items.map((item: { id: string }) => item.id)
    assert.deepEqual(await itemIds(), [replaced.json.id, chain.json.id])
    const conflict = await call(harness, 'PUT', `${base}/changes/${replaced.json.id}`, { nodeId: 'vue-eslint-parser@9.4.3(eslint@9.17.0)', choice: 'override' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.conflictsWith, chain.json.id)
    assert.equal((await call(harness, 'PUT', `${base}/changes/unknown-item`, { nodeId: 'semver@7.6.3', choice: 'latest' })).status, 404)
    const invalid = await call(harness, 'PUT', `${base}/changes/${replaced.json.id}`, { choice: 'latest' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error, 'Invalid body: expected { nodeId: string, choice: string, version?: string, importers?: string[], kinds?: string[] }')
    assert.equal((await call(harness, 'PUT', `${base}/changes/${replaced.json.id}`)).status, 400)
    assert.equal((await call(harness, 'PATCH', `${base}/changes/${replaced.json.id}`, { nodeId: 'semver@7.6.3', choice: 'latest' })).status, 405)
    assert.equal((await call(harness, 'PUT', '/api/roots/nope/changes/item', { nodeId: 'semver@7.6.3', choice: 'latest' })).status, 404)
    const tokenOnly = { 'x-deptrail-token': harness.server.token, 'content-type': 'application/json' }
    const body = JSON.stringify({ nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:.'] })
    const withoutOrigin = await request(harness.server, { method: 'PUT', path: `${base}/changes/${replaced.json.id}`, headers: tokenOnly, body })
    assert.equal(withoutOrigin.status, 403)
    assert.equal(JSON.parse(withoutOrigin.text).error, 'Forbidden origin')
    const notJson = await request(harness.server, {
      method: 'PUT',
      path: `${base}/changes/${replaced.json.id}`,
      headers: { ...tokenOnly, origin: `http://127.0.0.1:${harness.server.port}`, 'content-type': 'text/plain' },
      body,
    })
    assert.equal(notJson.status, 415)
    assert.deepEqual(await itemIds(), [replaced.json.id, chain.json.id])
  })

  it('restores the cleared changes once', async () => {
    const harness = await setupHarness()
    await ready(harness)
    await addSemverFix(harness)
    assert.equal((await call(harness, 'DELETE', `${base}/changes`)).status, 204)
    const restored = await call(harness, 'POST', `${base}/changes/restore-cleared`)
    assert.equal(restored.status, 200, restored.text)
    assert.deepEqual(restored.json, { restored: 1, skipped: [] })
    assert.equal((await call(harness, 'GET', `${base}/changes`)).json.items.length, 1)
    assert.deepEqual((await call(harness, 'POST', `${base}/changes/restore-cleared`)).json, { restored: 0, skipped: [] })
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assert.equal((await call(harness, method, `${base}/changes/restore-cleared`)).status, 405, method)
    }
    assert.equal((await call(harness, 'GET', `${base}/changes`)).json.items.length, 1)
    assert.equal((await call(harness, 'POST', '/api/roots/nope/changes/restore-cleared')).status, 404)
  })

  it('collects the recommended fixes as a job', async () => {
    const harness = await setupHarness()
    await ready(harness)
    const started = await call(harness, 'POST', `${base}/changes/recommended`, { kinds: ['prod', 'dev'] })
    assert.equal(started.status, 202, started.text)
    const job = await followJob(harness, started.json.jobId)
    assert.equal(job.kind, 'collect')
    assert.equal(job.state, 'done')
    assert.equal((await call(harness, 'POST', `${base}/changes/recommended`, { kinds: 'prod' })).status, 400)
    assert.equal((await call(harness, 'POST', `${base}/changes/recommended`, { kinds: ['bogus'] })).status, 400)
    const empty = await call(harness, 'POST', `${base}/changes/recommended`, { kinds: [] })
    assert.equal(empty.status, 400, empty.text)
    assert.deepEqual(empty.json, { error: 'Invalid kinds' })
  })

  it('runs a preview job and serves its file diffs', async () => {
    const harness = await setupHarness()
    await ready(harness)
    await addSemverFix(harness)
    const job = await followJob(harness, await startedPreview(harness))
    assert.equal(job.state, 'done', job.error)
    const diff = await call(harness, 'GET', `${base}/preview/files/0/diff`)
    assert.equal(diff.status, 200)
    assert.equal(typeof diff.json.diff, 'string')
    assert.equal(diff.json.truncated, false)
    assert.equal((await call(harness, 'GET', `${base}/preview/files/99/diff`)).status, 404)
    assert.equal((await call(harness, 'GET', `${base}/preview/files/-1/diff`)).status, 400)
    assert.equal((await call(harness, 'POST', `${base}/preview/files/0/diff`)).status, 405)
  })

  it('validates apply bodies and refuses another preview id', async () => {
    const harness = await setupHarness()
    await ready(harness)
    await addSemverFix(harness)
    const job = await followJob(harness, await startedPreview(harness))
    assert.equal(job.state, 'done', job.error)
    const previewId = job.result.previewId as string
    const invalid = await call(harness, 'POST', `${base}/apply`, { previewId, install: 'yes' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error, 'Invalid body: expected { previewId: string, install: boolean }')
    assert.equal((await call(harness, 'POST', `${base}/apply`)).status, 400)
    assert.equal((await call(harness, 'POST', `${base}/apply`, { previewId: 'another', install: false })).status, 409)
    assert.equal((await call(harness, 'POST', `${base}/revert`)).status, 409)
    assert.equal((await call(harness, 'GET', `${base}/apply`)).status, 405)
  })

  it('applies a preview and reverts it', async () => {
    const harness = await setupHarness()
    await ready(harness)
    await addSemverFix(harness)
    const preview = await followJob(harness, await startedPreview(harness))
    const applied = await call(harness, 'POST', `${base}/apply`, { previewId: preview.result.previewId, install: false })
    assert.equal(applied.status, 202, applied.text)
    const applyJob = await followJob(harness, applied.json.jobId)
    assert.equal(applyJob.state, 'done')
    assert.deepEqual(applyJob.result, { goalsMet: 1, install: 'not-run', files: ['pnpm-lock.yaml'] })
    const afterApply = (await call(harness, 'GET', `${base}/changes`)).json
    assert.equal(afterApply.revertable, true)
    assert.deepEqual(afterApply.items, [])
    assert.deepEqual(afterApply.revert, { files: ['pnpm-lock.yaml'], itemCount: 1 })
    assert.deepEqual(afterApply.job.result.files, ['pnpm-lock.yaml'])
    const reverted = await call(harness, 'POST', `${base}/revert`)
    assert.equal(reverted.status, 202, reverted.text)
    const revertJob = await followJob(harness, reverted.json.jobId)
    assert.equal(revertJob.state, 'done')
    assert.deepEqual(revertJob.result, { restored: 1, skipped: [], appliedInstall: 'not-run' })
    const afterRevert = (await call(harness, 'GET', `${base}/changes`)).json
    assert.equal(afterRevert.items.length, 1)
    assert.equal('revert' in afterRevert, false)
  })

  it('serves job logs from a line and refuses to cancel a finished job', async () => {
    const harness = await setupHarness()
    await ready(harness)
    await addSemverFix(harness)
    const jobId = await startedPreview(harness)
    await followJob(harness, jobId)
    const since = await call(harness, 'GET', `/api/jobs/${jobId}?since=1`)
    assert.equal(since.json.firstLine, 1)
    assert.equal((await call(harness, 'GET', `/api/jobs/${jobId}?since=-1`)).status, 400)
    assert.equal((await call(harness, 'GET', `/api/jobs/${jobId}?since=x`)).status, 400)
    assert.equal((await call(harness, 'GET', '/api/jobs/unknown')).status, 404)
    assert.equal((await call(harness, 'POST', `/api/jobs/${jobId}/cancel`)).status, 409)
    assert.equal((await call(harness, 'POST', '/api/jobs/unknown/cancel')).status, 404)
    assert.equal((await call(harness, 'POST', `/api/jobs/${jobId}`)).status, 405)
    assert.equal((await call(harness, 'GET', `/api/jobs/${jobId}/cancel`)).status, 405)
  })

  it('cancels a running preview', async () => {
    const harness = await setupHarness({ DEPTRAIL_FAKE_PM_SLEEP_MS: '20000' })
    await ready(harness)
    await addSemverFix(harness)
    const jobId = await startedPreview(harness)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await call(harness, 'POST', `/api/jobs/${jobId}/cancel`)).status, 202)
    assert.equal((await followJob(harness, jobId)).state, 'cancelled')
  })

  it('refuses resolve and rescan while a preview runs', async () => {
    const harness = await setupHarness(SLOW_RUN)
    await ready(harness)
    await addSemverFix(harness)
    const jobId = await startedPreview(harness)
    const resolve = await call(harness, 'POST', `${base}/resolve`)
    assert.equal(resolve.status, 409)
    assert.equal(resolve.json.error, `A change job is running for ${ROOT}`)
    const rescan = await call(harness, 'POST', '/api/rescan')
    assert.equal(rescan.status, 409)
    assert.equal(rescan.json.error, 'A change job is running')
    assert.equal((await call(harness, 'POST', `${base}/preview`)).status, 409)
    assert.equal((await followJob(harness, jobId)).state, 'done')
    assert.equal((await call(harness, 'POST', '/api/rescan')).status, 202)
  })

  it('keeps a secret from the npmrc out of every response and log', async () => {
    const harness = await setupHarness({}, async (repo) => {
      await writeFile(path.join(repo, ROOT, '.npmrc'), `//registry.example.test/:_authToken=${CANARY}\n`)
    })
    harness.secrets.add(CANARY)
    const script = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      "if (process.argv[2] === '--version') {",
      "  process.stdout.write('10.34.3\\n')",
      '} else {',
      "  process.stderr.write(fs.readFileSync('.npmrc', 'utf8'))",
      '  process.exitCode = 1',
      '}',
      '',
    ].join('\n')
    const executable = path.join(harness.pnpm.binDir, 'pnpm')
    await writeFile(executable, script)
    await chmod(executable, 0o755)
    await ready(harness)
    await addSemverFix(harness)
    const jobId = await startedPreview(harness)
    const job = await followJob(harness, jobId)
    assert.equal(job.state, 'failed')
    assert.ok(job.log.some((line: string) => line.includes('[redacted]')))
    const seen = [
      JSON.stringify(job),
      (await call(harness, 'GET', `/api/jobs/${jobId}`)).text,
      (await call(harness, 'GET', `${base}/changes`)).text,
      (await call(harness, 'GET', '/api/scan')).text,
      harness.logged.join(''),
    ]
    for (const text of seen) assert.equal(text.includes(CANARY), false)
  })

  it('answers unavailable actions when the server has none', async () => {
    const staticDir = await mkdtemp(path.join(tmpdir(), 'deptrail-actions-off-'))
    workDirs.push(staticDir)
    const session = await startScanSession({ repoPath: monolithFixture, reader: createFsReader(monolithFixture), runner: throwingRunner, cache: null, env: {}, userNpmrc: null })
    await session.ready
    const server = await startServer({ session, staticDir })
    closers.push(() => server.close())
    const headers = { 'x-deptrail-token': server.token, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' }
    const scan = JSON.parse((await request(server, { path: '/api/scan', headers })).text) as ScanSummary
    assert.ok(scan.roots.every((root) => root.actions.reason === 'Actions are not enabled'))
    const refused = await request(server, { method: 'POST', path: `${base}/preview`, headers })
    assert.equal(refused.status, 409)
    assert.deepEqual(JSON.parse(refused.text), { error: 'Actions are not enabled' })
  })
})

describe('branches API', () => {
  const MAIN = 'a'.repeat(40)
  const OTHER = 'b'.repeat(40)
  const MAIN_REF = 'refs/heads/main'
  const COMMITTED_AT = '2026-10-20T10:00:00.000Z'
  let session: ScanSession
  let staticDir: string
  let server: RunningServer
  let bare: RunningServer
  let sources: SourceRegistry

  function call(target: RunningServer, method: string, pathname: string, body?: unknown, withOrigin = true): Promise<Reply> {
    const headers: Record<string, string> = { 'x-deptrail-token': target.token }
    if (withOrigin && method !== 'GET') headers.origin = `http://127.0.0.1:${target.port}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    return request(target, { method, path: pathname, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }

  before(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'deptrail-branches-static-'))
    await writeFile(path.join(staticDir, 'index.html'), '<html>deptrail</html>')
    session = await startScanSession({ repoPath: monolithFixture, reader: createFsReader(monolithFixture), runner: throwingRunner, cache: null, env: {}, userNpmrc: null })
    await session.ready
    const tree = await directoryTree(monolithFixture)
    const git: GitRepository = {
      prefix: '',
      head: async () => ({ commit: MAIN, branch: MAIN_REF }),
      refs: async () => ({ refs: [{ name: MAIN_REF, short: 'main', kind: 'branch', commit: MAIN, committedAt: COMMITTED_AT }], defaultBranch: MAIN_REF }),
      tree: async () => tree.index,
      mergeBase: async () => MAIN,
      readBlob: tree.readBlob,
      close: () => {},
    }
    sources = createSourceRegistry({
      working: session,
      openSession: () =>
        startScanSession({
          repoPath: monolithFixture,
          reader: createGitReader(tree.index, tree.readBlob),
          runner: throwingRunner,
          cache: null,
          env: {},
          userNpmrc: null,
          useInstalled: false,
          onRootPublished: () => sources.rootsChanged(),
        }),
      onRootsChanged: () => {},
    })
    server = await startServer({ session, staticDir, branches: createBranches(git, sources) })
    bare = await startServer({ session, staticDir })
  })

  after(async () => {
    await server.close()
    await bare.close()
    await rm(staticDir, { recursive: true, force: true })
  })

  it('serves git info', async () => {
    const reply = await call(server, 'GET', '/api/git')
    assert.equal(reply.status, 200)
    const info = JSON.parse(reply.text)
    assert.equal(info.available, true)
    assert.equal(info.defaultBranch, MAIN_REF)
    assert.deepEqual(info.head, { commit: MAIN, branch: MAIN_REF })
    assert.equal(info.refs[0].name, MAIN_REF)
  })

  it('answers the quiet default without branches', async () => {
    const reply = await call(bare, 'GET', '/api/git')
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(reply.text), { available: false, reason: 'Branches are not enabled', quiet: true })
  })

  it('opens a ref and serves its scan under /api/commits', async () => {
    const opened = await call(server, 'POST', '/api/sources', { ref: MAIN_REF })
    assert.equal(opened.status, 200)
    assert.deepEqual(JSON.parse(opened.text), { key: MAIN, commit: MAIN, ref: MAIN_REF, committedAt: COMMITTED_AT })
    await sources.commit(MAIN)?.session.ready
    const scan = await call(server, 'GET', `/api/commits/${MAIN}/scan`)
    assert.equal(scan.status, 200)
    const summary = JSON.parse(scan.text) as ScanSummary
    assert.deepEqual(
      summary.roots.map((root) => root.id),
      session.scan.roots.map((root) => root.id),
    )
    assert.ok(summary.roots.every((root) => root.status === 'ready'))
    for (const pathname of [
      `/api/commits/${MAIN}/search?q=semver`,
      `/api/commits/${MAIN}/duplicates`,
      `/api/commits/${MAIN}/issues`,
      `/api/commits/${MAIN}/roots/${encodeRootSegment('npm-package')}/importers`,
      `/api/commits/${MAIN}/roots/${encodeRootSegment('services/api')}/importers`,
    ]) {
      assert.equal((await call(server, 'GET', pathname)).status, 200, pathname)
    }
  })

  it('refuses actions on a commit', async () => {
    await call(server, 'POST', '/api/sources', { ref: MAIN_REF })
    await sources.commit(MAIN)?.session.ready
    const changes = await call(server, 'GET', `/api/commits/${MAIN}/roots/npm-package/changes`)
    assert.equal(changes.status, 200)
    assert.deepEqual(JSON.parse(changes.text).items, [])
    const preview = await call(server, 'POST', `/api/commits/${MAIN}/roots/npm-package/preview`)
    assert.equal(preview.status, 409)
    assert.deepEqual(JSON.parse(preview.text), { error: 'Actions apply to the working tree. Switch to it to change files.' })
    const summary = JSON.parse((await call(server, 'GET', `/api/commits/${MAIN}/scan`)).text) as ScanSummary
    assert.ok(summary.roots.every((root) => root.actions.available === false && root.actions.reason === 'Actions apply to the working tree. Switch to it to change files.'))
  })

  it('refuses to run the package manager for a commit root', async () => {
    await call(server, 'POST', '/api/sources', { ref: MAIN_REF })
    await sources.commit(MAIN)?.session.ready
    const resolve = await call(server, 'POST', `/api/commits/${MAIN}/roots/npm-package/resolve`)
    assert.equal(resolve.status, 409)
    assert.deepEqual(JSON.parse(resolve.text), { error: COMMIT_RESOLVE_REASON })
  })

  it('does not route rescan or other resources under a commit', async () => {
    await call(server, 'POST', '/api/sources', { ref: MAIN_REF })
    assert.equal((await call(server, 'POST', `/api/commits/${MAIN}/rescan`)).status, 404)
    assert.equal((await call(server, 'GET', `/api/commits/${MAIN}/git`)).status, 404)
    assert.equal((await call(server, 'GET', `/api/commits/${MAIN}/jobs/x`)).status, 404)
  })

  it('answers 404 for a commit that is not open', async () => {
    const reply = await call(server, 'GET', `/api/commits/${OTHER}/scan`)
    assert.equal(reply.status, 404)
    assert.deepEqual(JSON.parse(reply.text), { error: `Unknown source ${OTHER}` })
    assert.equal((await call(server, 'GET', '/api/commits/not-a-sha/scan')).status, 404)
  })

  it('validates the body and the origin of POST /api/sources', async () => {
    const malformed = await call(server, 'POST', '/api/sources', { branch: 'main' })
    assert.equal(malformed.status, 400)
    assert.deepEqual(JSON.parse(malformed.text), { error: 'Invalid body: expected { ref: string } or { mergeBase: { base: string, target: string } }' })
    assert.equal((await call(server, 'POST', '/api/sources', { ref: '--all' })).status, 400)
    assert.equal((await call(server, 'POST', '/api/sources', { ref: 'refs/heads/gone' })).status, 404)
    assert.equal((await call(server, 'POST', '/api/sources', { ref: MAIN_REF }, false)).status, 403)
  })

  it('opens a merge base', async () => {
    await call(server, 'POST', '/api/sources', { ref: MAIN_REF })
    const reply = await call(server, 'POST', '/api/sources', { mergeBase: { base: 'work', target: MAIN } })
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(reply.text), { key: MAIN, commit: MAIN })
  })

  it('compares two sources', async () => {
    await call(server, 'POST', '/api/sources', { ref: MAIN_REF })
    await sources.commit(MAIN)?.session.ready
    const reply = await call(server, 'GET', `/api/compare?base=work&target=${MAIN}`)
    assert.equal(reply.status, 200)
    const comparison = JSON.parse(reply.text) as CompareResponse
    assert.equal(comparison.complete, true)
    assert.deepEqual(
      comparison.roots.map((root) => root.rootId),
      session.scan.roots.map((root) => root.id),
    )
    assert.equal((await call(server, 'GET', '/api/compare?base=work')).status, 400)
    const unknown = await call(server, 'GET', `/api/compare?base=work&target=${OTHER}`)
    assert.equal(unknown.status, 404)
    assert.deepEqual(JSON.parse(unknown.text), { error: `Unknown source ${OTHER}` })
  })
})
