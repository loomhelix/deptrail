import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSecretSet } from '../src/config/secrets.ts'
import { createEnrichmentCache, ENRICHMENT_TTL_MS } from '../src/enrich/enrichment-cache.ts'
import { createEnrichmentService, type EnrichmentService, type EnrichmentServiceOptions } from '../src/enrich/enrichment-service.ts'
import { createHttpClient } from '../src/enrich/http.ts'
import type { VulnRef } from '../src/enrich/types.ts'
import type { RootGraph } from '../src/model.ts'
import { createFsReader } from '../src/sources/file-reader.ts'
import { makeEnrichmentView, makeMeta, stubEnrichment } from './helpers/enrichment-view.ts'
import { startFakeServer, type FakeReply, type FakeServer, type RecordedRequest } from './helpers/fake-http.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const ETAG = '"packument-v1"'
const CANARY_TOKEN = 'canary-token-1'
const PAST_TTL_MS = ENRICHMENT_TTL_MS + 60_000
const X_VULN: VulnRef = { id: 'GHSA-x-0001', modified: '2024-01-01T00:00:00Z' }

type VersionEntry = { dependencies?: Record<string, string>; deprecated?: string }
type Packuments = Record<string, Record<string, VersionEntry>>
type BatchBody = { queries: { package: { name: string; ecosystem: string }; version: string }[] }
type QueryBody = { package: { name: string; ecosystem: string } }
type ReplyOverride = (request: RecordedRequest) => FakeReply | undefined
type OsvFixture = { vulnsByVersion?: Record<string, VulnRef[]>; advisoriesByName?: Record<string, unknown[]> }
type Context = { repo: string; cacheDir: string; registry: FakeServer; osv: FakeServer }

const X_PACKUMENT: Record<string, VersionEntry> = {
  '1.0.0': { dependencies: { tslib: '^2.0.0' }, deprecated: 'use y' },
  '1.1.0': { dependencies: { tslib: '^2.1.0' } },
  '2.0.0': { dependencies: { tslib: '^2.6.0' } },
}

const X_OSV: OsvFixture = {
  vulnsByVersion: { 'x@1.0.0': [X_VULN] },
  advisoriesByName: {
    x: [
      {
        id: X_VULN.id,
        modified: X_VULN.modified,
        summary: 'x is vulnerable',
        aliases: [],
        database_specific: { severity: 'HIGH' },
        affected: [{ package: { ecosystem: 'npm', name: 'x' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.1.0' }] }] }],
      },
    ],
  },
}

const servers: FakeServer[] = []
const sandboxes: string[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(sandboxes.map((sandbox) => rm(sandbox, { recursive: true, force: true })))
})

async function serve(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler)
  servers.push(server)
  return server
}

function packumentBody(entries: Record<string, VersionEntry>): unknown {
  const versions = Object.keys(entries)
  return {
    'dist-tags': { latest: versions[versions.length - 1] },
    versions: Object.fromEntries(versions.map((version) => [version, { version, ...entries[version] }])),
  }
}

function startRegistry(packuments: Packuments, override?: ReplyOverride): Promise<FakeServer> {
  return serve((request) => {
    const overridden = override?.(request)
    if (overridden !== undefined) return overridden
    const entries = packuments[request.path]
    if (entries === undefined) return { status: 404 }
    if (request.headers['if-none-match'] === ETAG) return { status: 304, headers: { etag: ETAG } }
    return { headers: { etag: ETAG }, body: packumentBody(entries) }
  })
}

function startOsv(fixture: OsvFixture, override?: ReplyOverride): Promise<FakeServer> {
  return serve((request) => {
    const overridden = override?.(request)
    if (overridden !== undefined) return overridden
    if (request.path === '/v1/querybatch') {
      const body = JSON.parse(request.body) as BatchBody
      const results = body.queries.map((query) => ({ vulns: fixture.vulnsByVersion?.[`${query.package.name}@${query.version}`] ?? [] }))
      return { body: { results } }
    }
    if (request.path === '/v1/query') {
      const body = JSON.parse(request.body) as QueryBody
      return { body: { vulns: fixture.advisoriesByName?.[body.package.name] ?? [] } }
    }
    return { status: 404 }
  })
}

async function setup(
  packuments: Packuments,
  osvFixture: OsvFixture = {},
  overrides: { registry?: ReplyOverride; osv?: ReplyOverride } = {},
): Promise<Context> {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-on-demand-'))
  sandboxes.push(sandbox)
  const repo = path.join(sandbox, 'repo')
  await mkdir(repo, { recursive: true })
  return {
    repo,
    cacheDir: path.join(sandbox, 'cache'),
    registry: await startRegistry(packuments, overrides.registry),
    osv: await startOsv(osvFixture, overrides.osv),
  }
}

async function writeNpmrc(context: Context, rootPath: string, text: string): Promise<void> {
  await mkdir(path.join(context.repo, rootPath), { recursive: true })
  await writeFile(path.join(context.repo, rootPath, '.npmrc'), text)
}

function serviceFor(context: Context, overrides: Partial<EnrichmentServiceOptions> = {}): EnrichmentService {
  return createEnrichmentService({
    reader: createFsReader(context.repo),
    env: {},
    userNpmrc: null,
    http: createHttpClient({ userAgent: 'deptrail-test/1.0', sleep: async () => {} }),
    osvUrl: context.osv.url,
    cache: createEnrichmentCache(context.cacheDir),
    secrets: createSecretSet(),
    offline: false,
    ...overrides,
  })
}

function rootGraph(
  id: string,
  rootPath: string,
  packageIds: string[],
  registry: string,
  scopedRegistries: Record<string, string> = {},
): RootGraph {
  const graph = makeGraph({
    importers: { [rootPath]: packageIds },
    packages: Object.fromEntries(packageIds.map((packageId) => [packageId, []])),
  })
  graph.id = id
  graph.path = rootPath
  graph.config = { registry, scopedRegistries, hasAuth: false, catalogs: {}, overrides: {}, workspacePatterns: [], warnings: [] }
  return graph
}

function requestsTo(server: FakeServer, requestPath: string): RecordedRequest[] {
  return server.requests.filter((request) => request.path === requestPath)
}

function sentVersionKeys(osv: FakeServer): string[] {
  return requestsTo(osv, '/v1/querybatch').flatMap((request) =>
    (JSON.parse(request.body) as BatchBody).queries.map((query) => `${query.package.name}@${query.version}`),
  )
}

async function cacheFiles(cacheDir: string): Promise<{ relative: string; content: string }[]> {
  const entries = await readdir(cacheDir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
  return Promise.all(files.map(async (file) => ({ relative: path.relative(cacheDir, file), content: await readFile(file, 'utf8') })))
}

describe('published versions', () => {
  it('returns the manifest of every version, sends the root token and keeps it out of the cache', async () => {
    const context = await setup({ '/x': X_PACKUMENT })
    await writeNpmrc(context, 'packages/a', `//127.0.0.1:${context.registry.port}/:_authToken=${CANARY_TOKEN}\n`)
    const root = rootGraph('a', 'packages/a', [], context.registry.url)
    const published = await serviceFor(context).publishedVersions(root, 'x')
    assert.ok(published.state === 'ok')
    assert.deepEqual(published.meta.versions, ['1.0.0', '1.1.0', '2.0.0'])
    assert.deepEqual(published.meta.manifests, {
      '1.0.0': { tslib: '^2.0.0' },
      '1.1.0': { tslib: '^2.1.0' },
      '2.0.0': { tslib: '^2.6.0' },
    })
    assert.deepEqual(published.meta.deprecated, { '1.0.0': 'use y' })
    assert.equal(requestsTo(context.registry, '/x')[0].headers.authorization, `Bearer ${CANARY_TOKEN}`)
    const files = await cacheFiles(context.cacheDir)
    assert.equal(files.length, 1)
    assert.match(files[0].relative, /^registry-versions\/[0-9a-f]{64}\.json$/)
    for (const { content } of files) {
      assert.ok(!content.includes(CANARY_TOKEN))
      assert.ok(!content.includes(`127.0.0.1:${context.registry.port}`))
    }
  })

  it('serves a second call and a new service on the same cache without a request', async () => {
    const context = await setup({ '/x': X_PACKUMENT })
    const root = rootGraph('a', '.', [], context.registry.url)
    const first = serviceFor(context)
    await first.publishedVersions(root, 'x')
    const again = await first.publishedVersions(root, 'x')
    const second = await serviceFor(context).publishedVersions(root, 'x')
    assert.equal(requestsTo(context.registry, '/x').length, 1)
    assert.ok(again.state === 'ok' && second.state === 'ok')
    assert.deepEqual(Object.keys(second.meta.manifests), ['1.0.0', '1.1.0', '2.0.0'])
  })

  it('loads a name once for concurrent calls', async () => {
    const context = await setup({ '/x': X_PACKUMENT })
    const root = rootGraph('a', '.', [], context.registry.url)
    const service = serviceFor(context)
    const results = await Promise.all([service.publishedVersions(root, 'x'), service.publishedVersions(root, 'x')])
    assert.deepEqual(results.map(({ state }) => state), ['ok', 'ok'])
    assert.equal(requestsTo(context.registry, '/x').length, 1)
  })

  it('revalidates an expired record with If-None-Match and keeps its meta on 304', async () => {
    const context = await setup({ '/x': X_PACKUMENT })
    const root = rootGraph('a', '.', [], context.registry.url)
    await serviceFor(context).publishedVersions(root, 'x')
    const revalidated = await serviceFor(context, { now: () => Date.now() + PAST_TTL_MS }).publishedVersions(root, 'x')
    const requests = requestsTo(context.registry, '/x')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], ETAG)
    assert.ok(revalidated.state === 'ok')
    assert.deepEqual(Object.keys(revalidated.meta.manifests), ['1.0.0', '1.1.0', '2.0.0'])
  })

  it('returns the meta of an expired record when the registry fails', async () => {
    let failing = false
    const context = await setup({ '/x': X_PACKUMENT }, {}, { registry: () => (failing ? { status: 500 } : undefined) })
    const root = rootGraph('a', '.', [], context.registry.url)
    await serviceFor(context).publishedVersions(root, 'x')
    failing = true
    const expired = await serviceFor(context, { now: () => Date.now() + PAST_TTL_MS }).publishedVersions(root, 'x')
    assert.ok(expired.state === 'ok')
    assert.deepEqual(expired.meta.versions, ['1.0.0', '1.1.0', '2.0.0'])
  })

  it('gives the reason of a failed load', async () => {
    const context = await setup({ '/x': X_PACKUMENT }, {}, {
      registry: (request) => (request.path === '/private-x' ? { status: 401 } : undefined),
    })
    const root = rootGraph('a', '.', [], context.registry.url)
    const service = serviceFor(context)
    assert.deepEqual(await service.publishedVersions(root, 'private-x'), { state: 'failed', reason: 'rejected credentials (401)' })
    assert.deepEqual(await service.publishedVersions(root, 'missing'), { state: 'failed', reason: 'not found in the registry' })
    const unscanned = rootGraph('b', 'packages/b', [], context.registry.url)
    delete unscanned.config
    assert.deepEqual(await service.publishedVersions(unscanned, 'x'), { state: 'failed', reason: 'the root is not scanned' })
  })

  it('gives the offline reason without a request', async () => {
    const context = await setup({ '/x': X_PACKUMENT }, X_OSV)
    const root = rootGraph('a', '.', [], context.registry.url)
    const service = serviceFor(context, { offline: true })
    assert.deepEqual(await service.publishedVersions(root, 'x'), { state: 'failed', reason: 'deptrail was started with --offline' })
    assert.deepEqual(await service.assess(root, [{ name: 'x', version: '1.0.0' }]), [
      { name: 'x', version: '1.0.0', vulnIds: [], notChecked: 'deptrail was started with --offline' },
    ])
    assert.equal(context.registry.requests.length, 0)
    assert.equal(context.osv.requests.length, 0)
  })
})

describe('assess', () => {
  it('gives the severity, vulnerability ids and deprecation of a vulnerable deprecated version', async () => {
    const context = await setup({ '/x': X_PACKUMENT, '/z': { '2.0.0': {} } }, X_OSV)
    const root = rootGraph('a', '.', [], context.registry.url)
    const assessed = await serviceFor(context).assess(root, [
      { name: 'x', version: '1.0.0' },
      { name: 'z', version: '2.0.0' },
    ])
    assert.deepEqual(assessed, [
      { name: 'x', version: '1.0.0', severity: 'high', vulnIds: [X_VULN.id], deprecated: 'use y' },
      { name: 'z', version: '2.0.0', vulnIds: [] },
    ])
  })

  it('deduplicates its input, keeps the input order and does not send unknown versions', async () => {
    const context = await setup({ '/x': X_PACKUMENT, '/z': { '2.0.0': {} } }, X_OSV)
    const root = rootGraph('a', '.', [], context.registry.url)
    const assessed = await serviceFor(context).assess(root, [
      { name: 'z', version: '2.0.0' },
      { name: 'x', version: '1.1.0' },
      { name: 'z', version: '2.0.0' },
      { name: 'x', version: '^1.0.0' },
    ])
    assert.deepEqual(assessed, [
      { name: 'z', version: '2.0.0', vulnIds: [] },
      { name: 'x', version: '1.1.0', vulnIds: [] },
      { name: 'x', version: '^1.0.0', vulnIds: [], notChecked: 'unknown version' },
    ])
    assert.deepEqual(sentVersionKeys(context.osv), ['z@2.0.0', 'x@1.1.0'])
    assert.equal(requestsTo(context.registry, '/x').length, 1)
  })

  it('never sends a name of a private scope to OSV', async () => {
    const context = await setup({ '/x': X_PACKUMENT }, X_OSV)
    const declaring = rootGraph('a', 'packages/a', [], context.registry.url, { '@acme': `${context.registry.url}/acme/` })
    const other = rootGraph('b', 'packages/b', [], context.registry.url)
    const tracking = serviceFor(context)
    tracking.track([declaring, other])
    await tracking.settled()
    const assessed = await tracking.assess(other, [
      { name: '@acme/y', version: '1.0.0' },
      { name: 'x', version: '1.0.0' },
    ])
    assert.deepEqual(assessed[0], { name: '@acme/y', version: '1.0.0', vulnIds: [], notChecked: 'private scope' })
    assert.equal(assessed[1].severity, 'high')
    const untracked = await serviceFor(context, { cache: null }).assess(declaring, [{ name: '@acme/y', version: '1.0.0' }])
    assert.equal(untracked[0].notChecked, 'private scope')
    assert.ok(context.osv.requests.length > 0)
    assert.ok(context.osv.requests.every((request) => !request.body.includes('@acme')))
  })

  it('marks every version as not checked with the OSV reason when OSV fails', async () => {
    const context = await setup({ '/x': X_PACKUMENT }, X_OSV, { osv: () => ({ status: 500 }) })
    const root = rootGraph('a', '.', [], context.registry.url)
    assert.deepEqual(await serviceFor(context).assess(root, [{ name: 'x', version: '1.0.0' }]), [
      { name: 'x', version: '1.0.0', vulnIds: [], deprecated: 'use y', notChecked: 'OSV responded with HTTP 500' },
    ])
  })

  it('keeps the vulnerability ids with an unknown severity when the advisories cannot be loaded', async () => {
    const context = await setup({ '/x': X_PACKUMENT }, X_OSV, { osv: (request) => (request.path === '/v1/query' ? { status: 400 } : undefined) })
    const root = rootGraph('a', '.', [], context.registry.url)
    assert.deepEqual(await serviceFor(context).assess(root, [{ name: 'x', version: '1.0.0' }]), [
      { name: 'x', version: '1.0.0', severity: 'unknown', vulnIds: [X_VULN.id], deprecated: 'use y' },
    ])
  })

  it('reuses the matches and advisories of a tracked root', async () => {
    const context = await setup({ '/x': X_PACKUMENT, '/z': { '2.0.0': {} } }, X_OSV)
    const root = rootGraph('a', '.', ['x@1.0.0'], context.registry.url)
    const service = serviceFor(context, { cache: null })
    service.track([root])
    await service.settled()
    const advisoryQueries = requestsTo(context.osv, '/v1/query').length
    const assessed = await service.assess(root, [
      { name: 'x', version: '1.0.0' },
      { name: 'z', version: '2.0.0' },
    ])
    assert.deepEqual(sentVersionKeys(context.osv), ['x@1.0.0', 'z@2.0.0'])
    assert.equal(requestsTo(context.osv, '/v1/query').length, advisoryQueries)
    assert.equal(assessed[0].severity, 'high')
  })

  it('caches what it looked up for a new service', async () => {
    const context = await setup({ '/x': X_PACKUMENT }, X_OSV)
    const root = rootGraph('a', '.', [], context.registry.url)
    const first = await serviceFor(context).assess(root, [{ name: 'x', version: '1.0.0' }])
    const requestsBefore = context.osv.requests.length + context.registry.requests.length
    const second = await serviceFor(context).assess(root, [{ name: 'x', version: '1.0.0' }])
    assert.equal(context.osv.requests.length + context.registry.requests.length, requestsBefore)
    assert.deepEqual(second, first)
  })

  it('leaves the status counts and the revision unchanged', async () => {
    const context = await setup({ '/x': X_PACKUMENT, '/z': { '2.0.0': {} } }, X_OSV)
    const root = rootGraph('a', '.', ['x@1.0.0'], context.registry.url)
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    const status = service.status(false)
    const revision = service.revision
    await service.publishedVersions(root, 'x')
    await service.publishedVersions(root, 'z')
    await service.assess(root, [
      { name: 'x', version: '1.1.0' },
      { name: 'z', version: '2.0.0' },
    ])
    assert.deepEqual(service.status(false), status)
    assert.equal(service.revision, revision)
  })
})

describe('stubEnrichment on demand', () => {
  it('answers published versions and assessments from its spec and records the names', async () => {
    const meta = makeMeta({ versions: ['1.0.0'] })
    const stub = stubEnrichment(makeEnrichmentView({}), {}, {
      published: { x: meta },
      assessed: { 'x@1.0.0': { severity: 'low', vulnIds: ['GHSA-1'] } },
    })
    const root = rootGraph('a', '.', [], 'https://registry.npmjs.org/')
    assert.deepEqual(await stub.publishedVersions(root, 'x'), { state: 'ok', meta })
    assert.deepEqual(await stub.publishedVersions(root, 'y'), { state: 'failed', reason: 'not found in the registry' })
    assert.deepEqual(stub.publishedCalls, ['x', 'y'])
    assert.deepEqual(await stub.assess(root, [{ name: 'x', version: '1.0.0' }, { name: 'y', version: '2.0.0' }]), [
      { name: 'x', version: '1.0.0', severity: 'low', vulnIds: ['GHSA-1'] },
      { name: 'y', version: '2.0.0', vulnIds: [] },
    ])
  })
})
