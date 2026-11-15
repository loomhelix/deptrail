import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSecretSet, type SecretSet } from '../src/config/secrets.ts'
import { createEnrichmentCache, ENRICHMENT_TTL_MS, type EnrichmentCache } from '../src/enrich/enrichment-cache.ts'
import {
  createEnrichmentService,
  offlineEnrichment,
  type EnrichmentService,
  type EnrichmentServiceOptions,
} from '../src/enrich/enrichment-service.ts'
import { createHttpClient, type HttpClient } from '../src/enrich/http.ts'
import { decorations, issueCounts } from '../src/query/decorations.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import { packageInsight } from '../src/query/package-insight.ts'
import { headerLabels } from '../ui/src/why-here.ts'
import type { VulnRef } from '../src/enrich/types.ts'
import type { PackageNode, RootConfig, RootGraph } from '../src/model.ts'
import { createFsReader, type FileReader } from '../src/sources/file-reader.ts'
import { startFakeServer, type FakeReply, type FakeServer, type RecordedRequest } from './helpers/fake-http.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const ETAG = '"packument-v1"'
const CANARY_TOKEN = 'canary-token-1'
const LODASH_VULN: VulnRef = { id: 'GHSA-lodash-0001', modified: '2024-01-01T00:00:00Z' }
const PAST_TTL_MS = ENRICHMENT_TTL_MS + 60_000

type BatchBody = { queries: { package: { name: string; ecosystem: string }; version: string }[] }
type QueryBody = { package: { name: string; ecosystem: string } }
type ReplyOverride = (request: RecordedRequest) => FakeReply | Promise<FakeReply> | undefined
type OsvFixture = { vulnsByVersion?: Record<string, VulnRef[]>; advisoriesByName?: Record<string, unknown[]> }
type Context = {
  repo: string
  cacheDir: string
  registry: FakeServer
  osv: FakeServer
  secrets: SecretSet
  sleeps: number[]
  http: HttpClient
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

function packumentBody(versions: readonly string[]): unknown {
  return {
    'dist-tags': { latest: versions[versions.length - 1] },
    versions: Object.fromEntries(versions.map((version) => [version, { version, dependencies: { tslib: '^2.0.0' } }])),
  }
}

function startRegistry(versionsByPath: Record<string, string[]>, override?: ReplyOverride): Promise<FakeServer> {
  return serve((request) => {
    const overridden = override?.(request)
    if (overridden !== undefined) return overridden
    const versions = versionsByPath[request.path]
    if (versions === undefined) return { status: 404 }
    if (request.headers['if-none-match'] === ETAG) return { status: 304, headers: { etag: ETAG } }
    return { headers: { etag: ETAG }, body: packumentBody(versions) }
  })
}

function advisoryRecord(name: string, ref: VulnRef): Record<string, unknown> {
  return {
    id: ref.id,
    modified: ref.modified,
    summary: `${name} is vulnerable`,
    aliases: [],
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { ecosystem: 'npm', name },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.22' }] }],
        versions: [],
      },
    ],
  }
}

const LODASH_OSV: OsvFixture = {
  vulnsByVersion: { 'lodash@4.17.20': [LODASH_VULN], 'lodash@4.17.21': [LODASH_VULN] },
  advisoriesByName: { lodash: [advisoryRecord('lodash', LODASH_VULN)] },
}

function startOsv(fixture: OsvFixture = {}, override?: ReplyOverride): Promise<FakeServer> {
  return serve((request) => {
    const overridden = override?.(request)
    if (overridden !== undefined) return overridden
    if (request.path === '/v1/querybatch') {
      const body = JSON.parse(request.body) as BatchBody
      const results = body.queries.map((query) => ({
        vulns: fixture.vulnsByVersion?.[`${query.package.name}@${query.version}`] ?? [],
      }))
      return { body: { results } }
    }
    if (request.path === '/v1/query') {
      const body = JSON.parse(request.body) as QueryBody
      return { body: { vulns: fixture.advisoriesByName?.[body.package.name] ?? [] } }
    }
    return { status: 404 }
  })
}

function recordingHttp(sleeps: number[], signal?: AbortSignal): HttpClient {
  return createHttpClient({
    userAgent: 'deptrail-test/1.0',
    signal,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
}

async function setup(
  registry: Record<string, string[]>,
  osvFixture: OsvFixture = {},
  overrides: { registry?: ReplyOverride; osv?: ReplyOverride } = {},
): Promise<Context> {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-enrichment-service-'))
  sandboxes.push(sandbox)
  const repo = path.join(sandbox, 'repo')
  await mkdir(repo, { recursive: true })
  const sleeps: number[] = []
  return {
    repo,
    cacheDir: path.join(sandbox, 'cache'),
    registry: await startRegistry(registry, overrides.registry),
    osv: await startOsv(osvFixture, overrides.osv),
    secrets: createSecretSet(),
    sleeps,
    http: recordingHttp(sleeps),
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
    http: context.http,
    osvUrl: context.osv.url,
    cache: createEnrichmentCache(context.cacheDir),
    secrets: context.secrets,
    offline: false,
    ...overrides,
  })
}

function rootGraph(id: string, rootPath: string, packageIds: string[], config: Partial<RootConfig> & { registry: string }): RootGraph {
  const graph = makeGraph({
    importers: { [rootPath]: packageIds },
    packages: Object.fromEntries(packageIds.map((packageId) => [packageId, []])),
  })
  graph.id = id
  graph.path = rootPath
  graph.config = {
    scopedRegistries: {},
    hasAuth: false,
    catalogs: {},
    overrides: {},
    workspacePatterns: [],
    warnings: [],
    ...config,
  }
  return graph
}

function nodeOf(root: RootGraph, id: string): PackageNode {
  const node = root.packages.get(id)
  assert.ok(node, `missing node ${id}`)
  return node
}

function requestsTo(server: FakeServer, requestPath: string): RecordedRequest[] {
  return server.requests.filter((request) => request.path === requestPath)
}

function sentVersionKeys(osv: FakeServer): string[] {
  return requestsTo(osv, '/v1/querybatch').flatMap((request) =>
    (JSON.parse(request.body) as BatchBody).queries.map((query) => `${query.package.name}@${query.version}`),
  )
}

async function cacheFileContents(cacheDir: string): Promise<string[]> {
  const entries = await readdir(cacheDir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
  return Promise.all(files.map((file) => readFile(file, 'utf8')))
}

function fetchedAtOf(state: { state: string; fetchedAt?: string }): number {
  assert.ok('fetchedAt' in state && typeof state.fetchedAt === 'string', `no fetchedAt in ${state.state}`)
  return Date.parse(state.fetchedAt)
}

function countingReader(context: Context): { reader: FileReader; readsOf(target: string): number } {
  const inner = createFsReader(context.repo)
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('enrichment service keys', () => {
  it('fetches a package shared by two roots once and sends its version to OSV once', async () => {
    const context = await setup({ '/lodash': ['4.17.20', '4.17.21'] })
    const first = rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url })
    const second = rootGraph('b', 'packages/b', ['lodash@4.17.21'], { registry: `${context.registry.url}/` })
    const service = serviceFor(context)
    service.track([first, second])
    await service.settled()
    assert.equal(requestsTo(context.registry, '/lodash').length, 1)
    assert.deepEqual(sentVersionKeys(context.osv), ['lodash@4.17.21'])
    assert.equal(service.registryOf(second, nodeOf(second, 'lodash@4.17.21')).state, 'ok')
    assert.equal(service.matchOf(first, nodeOf(first, 'lodash@4.17.21')).state, 'ok')
  })

  it('skips private scopes declared by any root in every root and routes them to the scoped registry', async () => {
    const context = await setup({ '/acme/@acme%2fui': ['1.0.0'], '/@acme%2fui': ['1.0.0'], '/lodash': ['4.17.21'] })
    const withScope = rootGraph('a', 'packages/a', ['@acme/ui@1.0.0', 'lodash@4.17.21'], {
      registry: context.registry.url,
      scopedRegistries: { '@acme': `${context.registry.url}/acme/` },
    })
    const withoutScope = rootGraph('b', 'packages/b', ['@acme/ui@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([withScope, withoutScope])
    await service.settled()
    const privateSkip = { state: 'skipped', reason: 'private-scope' }
    assert.deepEqual(service.matchOf(withScope, nodeOf(withScope, '@acme/ui@1.0.0')), privateSkip)
    assert.deepEqual(service.matchOf(withoutScope, nodeOf(withoutScope, '@acme/ui@1.0.0')), privateSkip)
    assert.deepEqual(service.matchOfVersion('@acme/ui', '1.0.0'), privateSkip)
    assert.ok(context.osv.requests.length > 0)
    assert.ok(context.osv.requests.every((request) => !request.body.includes('@acme/')))
    assert.equal(requestsTo(context.registry, '/acme/@acme%2fui').length, 1)
    assert.equal(service.registryOf(withScope, nodeOf(withScope, '@acme/ui@1.0.0')).state, 'ok')
  })

  it('skips non-registry packages as not checked, marks placeholders as not applicable and sends nothing for them', async () => {
    const context = await setup({})
    const graph = makeGraph({ importers: { '.': ['local-lib@1.0.0'] }, packages: { 'local-lib@1.0.0': ['missing@2.0.0'] } })
    graph.config = rootGraph('x', '.', [], { registry: context.registry.url }).config
    const local = nodeOf(graph, 'local-lib@1.0.0')
    local.nonRegistry = true
    const placeholder = [...graph.packages.values()].find((node) => node.id.startsWith('?:'))
    assert.ok(placeholder)
    const service = serviceFor(context)
    service.track([graph])
    await service.settled()
    assert.deepEqual(service.registryOf(graph, local), { state: 'not-applicable' })
    assert.deepEqual(service.matchOf(graph, local), { state: 'skipped', reason: 'non-registry' })
    assert.deepEqual(service.registryOf(graph, placeholder), { state: 'not-applicable' })
    assert.deepEqual(service.matchOf(graph, placeholder), { state: 'not-applicable' })
    assert.equal(context.registry.requests.length, 0)
    assert.equal(context.osv.requests.length, 0)
    const insight = packageInsight(service, graph, 'local-lib@1.0.0', ALL_KINDS, [])
    assert.deepEqual(insight.vulnerabilities, { state: 'skipped', reason: 'non-registry', items: [] })
    assert.deepEqual(insight.registry, { state: 'not-applicable' })
    assert.deepEqual(
      headerLabels(undefined, insight, { isDirect: true, decorationsLoaded: true, checksDone: true }).map((label) => [label.text, label.title]),
      [['not checked', 'Not from a registry (git, file, or link)']],
    )
    assert.deepEqual(decorations(service, graph, ALL_KINDS), {})
    assert.deepEqual(issueCounts(service, graph), { vulnerable: 0, deprecated: 0, outdatedDirect: 0 })
    assert.deepEqual(service.status(false).osv, { total: 0, done: 0, skipped: 0, failed: 0 })
  })

  it('gives a manifest-only range registry data and skips it for OSV as an unknown version', async () => {
    const context = await setup({ '/left-pad': ['1.2.0', '1.3.0'] })
    const root = rootGraph('a', '.', ['left-pad@^1.2.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    const registry = service.registryOf(root, nodeOf(root, 'left-pad@^1.2.0'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(registry.meta.versions, ['1.2.0', '1.3.0'])
    assert.deepEqual(service.matchOf(root, nodeOf(root, 'left-pad@^1.2.0')), { state: 'skipped', reason: 'unknown-version' })
    assert.equal(context.osv.requests.length, 0)
  })

  it('does not fetch a key twice when a second pass starts while the first is in flight', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, LODASH_OSV)
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    service.track([root])
    await service.settled()
    assert.equal(requestsTo(context.registry, '/lodash').length, 1)
    assert.deepEqual(sentVersionKeys(context.osv), ['lodash@4.17.21'])
    assert.equal(requestsTo(context.osv, '/v1/query').length, 1)
  })

  it('covers the versions of two consecutive passes over one key', async () => {
    const context = await setup({ '/lodash': ['4.17.20', '4.17.21'] })
    const first = rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url })
    const second = rootGraph('b', 'packages/b', ['lodash@4.17.20'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([first])
    service.track([first, second])
    await service.settled()
    const registry = service.registryOf(second, nodeOf(second, 'lodash@4.17.20'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(Object.keys(registry.meta.manifests).sort(), ['4.17.20', '4.17.21'])
    assert.equal(requestsTo(context.registry, '/lodash').length, 1)
  })

  it('refetches without If-None-Match when a later pass brings a version while the key is being fetched', async () => {
    const arrived = deferred<void>()
    const reply = deferred<void>()
    let held = false
    const context = await setup({ '/lodash': ['4.17.20', '4.17.21'] }, {}, {
      registry: (request) => {
        if (request.path !== '/lodash' || held) return undefined
        held = true
        arrived.resolve()
        return reply.promise.then(() => ({ headers: { etag: ETAG }, body: packumentBody(['4.17.20', '4.17.21']) }))
      },
    })
    const first = rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url })
    const second = rootGraph('b', 'packages/b', ['lodash@4.17.20'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([first])
    await arrived.promise
    service.track([first, second])
    reply.resolve()
    await service.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], undefined)
    const registry = service.registryOf(second, nodeOf(second, 'lodash@4.17.20'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(Object.keys(registry.meta.manifests).sort(), ['4.17.20', '4.17.21'])
    assert.deepEqual(service.status(false).registry, { total: 1, done: 1, failed: 0 })
  })

  it('keeps a scope private after the root that declared it fails', async () => {
    const context = await setup({ '/acme/@acme%2fui': ['1.0.0'], '/@acme%2fui': ['1.0.0'], '/lodash': ['4.17.21'] })
    const declaring = rootGraph('a', 'packages/a', ['lodash@4.17.21'], {
      registry: context.registry.url,
      scopedRegistries: { '@acme': `${context.registry.url}/acme/` },
    })
    const using = rootGraph('b', 'packages/b', ['@acme/ui@1.0.0'], { registry: context.registry.url })
    const failed: RootGraph = { ...rootGraph('a', 'packages/a', [], { registry: context.registry.url }), status: 'failed', error: 'broken' }
    delete failed.config
    const service = serviceFor(context)
    service.track([declaring, using])
    await service.settled()
    service.track([failed, using])
    await service.settled()
    service.refresh()
    await service.settled()
    const privateSkip = { state: 'skipped', reason: 'private-scope' }
    assert.ok(context.osv.requests.length > 0)
    assert.ok(context.osv.requests.every((request) => !request.body.includes('@acme/')))
    assert.deepEqual(service.matchOf(using, nodeOf(using, '@acme/ui@1.0.0')), privateSkip)
    assert.deepEqual(service.matchOfVersion('@acme/ui', '1.0.0'), privateSkip)
    assert.equal(service.status(false).osv.skipped, 1)
  })

  it('waits for scanning roots before sending anything to OSV', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] })
    const ready = rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url })
    const scanning: RootGraph = { ...rootGraph('b', 'packages/b', [], { registry: context.registry.url }), status: 'scanning' }
    delete scanning.config
    const service = serviceFor(context)
    service.track([ready, scanning])
    await service.settled()
    assert.equal(service.registryOf(ready, nodeOf(ready, 'lodash@4.17.21')).state, 'ok')
    assert.deepEqual(service.matchOf(ready, nodeOf(ready, 'lodash@4.17.21')), { state: 'pending' })
    assert.equal(context.osv.requests.length, 0)
    service.track([ready, rootGraph('b', 'packages/b', [], { registry: context.registry.url })])
    await service.settled()
    assert.deepEqual(sentVersionKeys(context.osv), ['lodash@4.17.21'])
  })
})

describe('enrichment service credentials', () => {
  it('sends the root token to its registry only and keeps it out of the cache', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, LODASH_OSV)
    await writeNpmrc(context, 'packages/a', `//127.0.0.1:${context.registry.port}/:_authToken=${CANARY_TOKEN}\n`)
    const root = rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    assert.equal(requestsTo(context.registry, '/lodash')[0].headers.authorization, `Bearer ${CANARY_TOKEN}`)
    assert.ok(context.osv.requests.every((request) => request.headers.authorization === undefined))
    const contents = await cacheFileContents(context.cacheDir)
    assert.ok(contents.length >= 3)
    for (const content of contents) {
      assert.ok(!content.includes(CANARY_TOKEN))
      assert.ok(!content.includes(context.registry.url))
      assert.ok(!content.includes(`127.0.0.1:${context.registry.port}`))
    }
    assert.equal(context.secrets.redact(CANARY_TOKEN), '[redacted]')
  })

  it('fetches a shared key with the credentials of the first root that needs it', async () => {
    const context = await setup({ '/lodash': ['4.17.21'], '/is-odd': ['1.0.0'] })
    await writeNpmrc(context, 'packages/a', `//127.0.0.1:${context.registry.port}/:_authToken=first-token-1\n`)
    await writeNpmrc(context, 'packages/b', `//127.0.0.1:${context.registry.port}/:_authToken=second-token-1\n`)
    const first = rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url })
    const second = rootGraph('b', 'packages/b', ['lodash@4.17.21', 'is-odd@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([first, second])
    await service.settled()
    assert.deepEqual(
      requestsTo(context.registry, '/lodash').map((request) => request.headers.authorization),
      ['Bearer first-token-1'],
    )
    assert.equal(requestsTo(context.registry, '/is-odd')[0].headers.authorization, 'Bearer second-token-1')
    assert.equal(context.secrets.redact('second-token-1'), '[redacted]')
  })

  it('reads the npmrc of each root path once across track passes and again after refresh', async () => {
    const context = await setup({ '/lodash': ['4.17.21'], '/is-odd': ['1.0.0'] })
    await writeNpmrc(context, 'packages/a', `//127.0.0.1:${context.registry.port}/:_authToken=first-token-1\n`)
    const counting = countingReader(context)
    const rootsOfScan = () => [
      rootGraph('a', 'packages/a', ['lodash@4.17.21'], { registry: context.registry.url }),
      rootGraph('b', 'packages/b', ['is-odd@1.0.0'], { registry: context.registry.url }),
    ]
    const service = serviceFor(context, { reader: counting.reader })
    service.track(rootsOfScan())
    await service.settled()
    service.track(rootsOfScan())
    await service.settled()
    service.track(rootsOfScan())
    await service.settled()
    assert.equal(counting.readsOf('packages/a/.npmrc'), 1)
    assert.equal(counting.readsOf('packages/b/.npmrc'), 1)
    service.refresh()
    await service.settled()
    assert.equal(counting.readsOf('packages/a/.npmrc'), 2)
    assert.equal(counting.readsOf('packages/b/.npmrc'), 2)
    service.track(rootsOfScan())
    await service.settled()
    assert.equal(counting.readsOf('packages/a/.npmrc'), 2)
  })

  it('sends a token fixed in the npmrc after refresh', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, {}, {
      registry: (request) => (request.headers.authorization === 'Bearer fixed-token-1' ? undefined : { status: 401 }),
    })
    await writeNpmrc(context, '.', `//127.0.0.1:${context.registry.port}/:_authToken=expired-token-1\n`)
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    assert.deepEqual(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')), { state: 'failed', reason: 'rejected credentials (401)' })
    await writeNpmrc(context, '.', `//127.0.0.1:${context.registry.port}/:_authToken=fixed-token-1\n`)
    service.track([root])
    await service.settled()
    assert.equal(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'failed')
    service.refresh()
    await service.settled()
    assert.deepEqual(
      requestsTo(context.registry, '/lodash').map((request) => request.headers.authorization),
      ['Bearer expired-token-1', 'Bearer fixed-token-1'],
    )
    assert.equal(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'ok')
    assert.equal(context.secrets.redact('fixed-token-1'), '[redacted]')
  })

  it('registers the token on the first offline pass and reads the npmrc once', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] })
    await writeNpmrc(context, '.', `//127.0.0.1:${context.registry.port}/:_authToken=${CANARY_TOKEN}\n`)
    const counting = countingReader(context)
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context, { reader: counting.reader, offline: true })
    service.track([root])
    await service.settled()
    assert.equal(context.secrets.redact(CANARY_TOKEN), '[redacted]')
    service.track([root])
    await service.settled()
    assert.equal(counting.readsOf('.npmrc'), 1)
    assert.equal(context.registry.requests.length, 0)
  })
})

describe('enrichment service cache', () => {
  it('serves a second service on the same cache within the TTL without any request', async () => {
    const context = await setup({ '/lodash': ['4.17.21'], '/is-odd': ['1.0.0'] }, LODASH_OSV)
    const root = rootGraph('a', '.', ['lodash@4.17.21', 'is-odd@1.0.0', 'unpublished@1.0.0'], { registry: context.registry.url })
    const first = serviceFor(context)
    first.track([root])
    await first.settled()
    const requestsBefore = context.registry.requests.length + context.osv.requests.length
    const second = serviceFor(context)
    second.track([root])
    await second.settled()
    assert.equal(context.registry.requests.length + context.osv.requests.length, requestsBefore)
    assert.equal(second.registryOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'ok')
    assert.equal(second.registryOf(root, nodeOf(root, 'unpublished@1.0.0')).state, 'not-found')
    const match = second.matchOf(root, nodeOf(root, 'lodash@4.17.21'))
    assert.ok(match.state === 'ok')
    assert.deepEqual(match.vulns, [LODASH_VULN])
    assert.equal(second.advisoriesOf('lodash').state, 'ok')
  })

  it('revalidates an expired entry with If-None-Match and keeps it as ok with a new fetchedAt on 304', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] })
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const first = serviceFor(context)
    first.track([root])
    await first.settled()
    const firstFetchedAt = fetchedAtOf(first.registryOf(root, nodeOf(root, 'lodash@4.17.21')))
    const second = serviceFor(context, { now: () => Date.now() + PAST_TTL_MS })
    second.track([root])
    await second.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], ETAG)
    const revalidated = second.registryOf(root, nodeOf(root, 'lodash@4.17.21'))
    assert.equal(revalidated.state, 'ok')
    assert.ok(fetchedAtOf(revalidated) > firstFetchedAt)
  })

  it('refetches without If-None-Match when a new version of a cached package comes into use', async () => {
    const context = await setup({ '/lodash': ['4.17.20', '4.17.21'] })
    const first = serviceFor(context)
    first.track([rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })])
    await first.settled()
    const wider = rootGraph('a', '.', ['lodash@4.17.20', 'lodash@4.17.21'], { registry: context.registry.url })
    const second = serviceFor(context)
    second.track([wider])
    await second.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], undefined)
    const registry = second.registryOf(wider, nodeOf(wider, 'lodash@4.17.20'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(Object.keys(registry.meta.manifests).sort(), ['4.17.20', '4.17.21'])
  })

  it('refetches a fresh cached packument once without If-None-Match when it does not list a version in use', async () => {
    const versionsByPath = { '/lodash': ['4.17.20'] }
    const context = await setup(versionsByPath)
    const first = serviceFor(context)
    first.track([rootGraph('a', '.', ['lodash@4.17.20'], { registry: context.registry.url })])
    await first.settled()
    versionsByPath['/lodash'] = ['4.17.20', '4.17.21']
    const released = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const second = serviceFor(context)
    second.track([released])
    await second.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], undefined)
    const registry = second.registryOf(released, nodeOf(released, 'lodash@4.17.21'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(registry.meta.versions, ['4.17.20', '4.17.21'])
    assert.deepEqual(registry.meta.manifests['4.17.21'], { tslib: '^2.0.0' })
  })

  it('refetches a stored packument once when a later pass brings a version it does not list', async () => {
    const versionsByPath = { '/lodash': ['4.17.20'] }
    const context = await setup(versionsByPath)
    const service = serviceFor(context)
    service.track([rootGraph('a', '.', ['lodash@4.17.20'], { registry: context.registry.url })])
    await service.settled()
    versionsByPath['/lodash'] = ['4.17.20', '4.17.21']
    const wider = rootGraph('a', '.', ['lodash@4.17.20', 'lodash@4.17.21'], { registry: context.registry.url })
    service.track([wider])
    await service.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], undefined)
    const registry = service.registryOf(wider, nodeOf(wider, 'lodash@4.17.21'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(Object.keys(registry.meta.manifests).sort(), ['4.17.20', '4.17.21'])
  })

  it('refetches a cached packument that still does not list a version in use only once across passes', async () => {
    const context = await setup({ '/lodash': ['4.17.20'] })
    const first = serviceFor(context)
    first.track([rootGraph('a', '.', ['lodash@4.17.20'], { registry: context.registry.url })])
    await first.settled()
    const rootOfScan = () => rootGraph('a', '.', ['lodash@4.17.20', 'lodash@9.9.9'], { registry: context.registry.url })
    const second = serviceFor(context)
    second.track([rootOfScan()])
    await second.settled()
    second.track([rootOfScan()])
    await second.settled()
    assert.equal(requestsTo(context.registry, '/lodash').length, 2)
    const root = rootOfScan()
    const registry = second.registryOf(root, nodeOf(root, 'lodash@9.9.9'))
    assert.ok(registry.state === 'ok')
    assert.deepEqual(registry.meta.versions, ['4.17.20'])
  })

  it('refetches a just-landed packument that does not list a version in use only once across passes', async () => {
    const context = await setup({ '/lodash': ['4.17.20'] })
    const rootOfScan = () => rootGraph('a', '.', ['lodash@9.9.9'], { registry: context.registry.url })
    const service = serviceFor(context, { cache: null })
    service.track([rootOfScan()])
    await service.settled()
    service.track([rootOfScan()])
    await service.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], undefined)
    assert.equal(service.registryOf(rootOfScan(), nodeOf(rootOfScan(), 'lodash@9.9.9')).state, 'ok')
  })

  it('ignores a cache entry of the wrong shape and refetches it', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] })
    const registryUrl = `${context.registry.url}/`
    await createEnrichmentCache(context.cacheDir).write('registry', [registryUrl, 'lodash'], { state: 'ok', fetchedAt: new Date().toISOString() })
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: registryUrl })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    assert.equal(requestsTo(context.registry, '/lodash').length, 1)
    assert.equal(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'ok')
  })

  it('keeps working when cache writes reject', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, LODASH_OSV)
    const failingCache: EnrichmentCache = {
      read: async () => null,
      write: async () => {
        throw new Error('disk full')
      },
    }
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context, { cache: failingCache })
    service.track([root])
    await service.settled()
    assert.equal(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'ok')
    assert.equal(service.matchOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'ok')
    assert.equal(service.advisoriesOf('lodash').state, 'ok')
    assert.equal(service.status(false).state, 'done')
  })
})

describe('enrichment service failures', () => {
  it('uses an expired entry as stale when the registry fails and reports one problem', async () => {
    let failing = false
    const context = await setup({ '/lodash': ['4.17.21'] }, {}, { registry: () => (failing ? { status: 500 } : undefined) })
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const first = serviceFor(context)
    first.track([root])
    await first.settled()
    const firstFetchedAt = fetchedAtOf(first.registryOf(root, nodeOf(root, 'lodash@4.17.21')))
    failing = true
    const second = serviceFor(context, { now: () => Date.now() + PAST_TTL_MS })
    second.track([root])
    await second.settled()
    const stale = second.registryOf(root, nodeOf(root, 'lodash@4.17.21'))
    assert.ok(stale.state === 'stale')
    assert.equal(fetchedAtOf(stale), firstFetchedAt)
    assert.deepEqual(stale.meta.versions, ['4.17.21'])
    assert.deepEqual(context.sleeps, [1000, 4000])
    assert.deepEqual(second.status(false).problems, [
      { source: 'registry', origin: context.registry.url, message: 'responded with HTTP 500', count: 1 },
    ])
  })

  it('uses expired matches as stale when OSV fails and reports the OSV origin', async () => {
    let failing = false
    const context = await setup({ '/lodash': ['4.17.21'] }, LODASH_OSV, { osv: () => (failing ? { status: 503 } : undefined) })
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const first = serviceFor(context)
    first.track([root])
    await first.settled()
    failing = true
    const second = serviceFor(context, { now: () => Date.now() + PAST_TTL_MS })
    second.track([root])
    await second.settled()
    const match = second.matchOf(root, nodeOf(root, 'lodash@4.17.21'))
    assert.ok(match.state === 'stale')
    assert.deepEqual(match.vulns, [LODASH_VULN])
    assert.equal(second.advisoriesOf('lodash').state, 'stale')
    assert.deepEqual(second.status(false).problems, [
      { source: 'osv', origin: context.osv.url, message: 'responded with HTTP 503', count: 2 },
    ])
  })

  it('groups rejected credentials of one registry into one problem while another registry works', async () => {
    const context = await setup({ '/is-odd': ['1.0.0'] })
    const rejecting = await startRegistry({}, () => ({ status: 401 }))
    const rejected = rootGraph('a', 'packages/a', ['left-pad@1.0.0', 'right-pad@1.0.0'], { registry: rejecting.url })
    const working = rootGraph('b', 'packages/b', ['is-odd@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([rejected, working])
    await service.settled()
    assert.equal(service.registryOf(working, nodeOf(working, 'is-odd@1.0.0')).state, 'ok')
    assert.deepEqual(service.registryOf(rejected, nodeOf(rejected, 'left-pad@1.0.0')), {
      state: 'failed',
      reason: 'rejected credentials (401)',
    })
    const status = service.status(false)
    assert.deepEqual(status.problems, [
      { source: 'registry', origin: rejecting.url, message: 'rejected credentials (401)', count: 2 },
    ])
    assert.deepEqual(status.registry, { total: 3, done: 3, failed: 2 })
  })

  it('fails the unsent keys of a registry after its first rejected credentials and retries on refresh', async () => {
    const context = await setup({ '/is-odd': ['1.0.0'] })
    const rejecting = await startRegistry({}, () => ({ status: 401 }))
    const packageIds = Array.from({ length: 20 }, (_, index) => `pkg-${index}@1.0.0`)
    const rejected = rootGraph('a', 'packages/a', packageIds, { registry: rejecting.url })
    const working = rootGraph('b', 'packages/b', ['is-odd@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    const assertEveryKeyRejected = () => {
      for (const id of packageIds) {
        assert.deepEqual(service.registryOf(rejected, nodeOf(rejected, id)), { state: 'failed', reason: 'rejected credentials (401)' })
      }
      assert.deepEqual(service.status(false).problems, [
        { source: 'registry', origin: rejecting.url, message: 'rejected credentials (401)', count: 20 },
      ])
    }
    service.track([rejected, working])
    await service.settled()
    const firstPassRequests = rejecting.requests.length
    assert.ok(firstPassRequests >= 1 && firstPassRequests <= 16, `${firstPassRequests} requests in the first pass`)
    assertEveryKeyRejected()
    assert.equal(service.registryOf(working, nodeOf(working, 'is-odd@1.0.0')).state, 'ok')
    assert.equal(requestsTo(context.registry, '/is-odd').length, 1)
    service.refresh()
    await service.settled()
    const refreshRequests = rejecting.requests.length - firstPassRequests
    assert.ok(refreshRequests >= 1 && refreshRequests <= 16, `${refreshRequests} requests after refresh`)
    assertEveryKeyRejected()
  })

  it('serves expired data as stale for keys failed without a request after rejected credentials', async () => {
    let rejecting = false
    const packageIds = Array.from({ length: 20 }, (_, index) => `pkg-${index}@1.0.0`)
    const packuments = Object.fromEntries(packageIds.map((id) => [`/${id.split('@')[0]}`, ['1.0.0']]))
    const context = await setup(packuments, {}, { registry: () => (rejecting ? { status: 401 } : undefined) })
    const root = rootGraph('a', '.', packageIds, { registry: context.registry.url })
    const first = serviceFor(context)
    first.track([root])
    await first.settled()
    const requestsBefore = context.registry.requests.length
    rejecting = true
    const second = serviceFor(context, { now: () => Date.now() + PAST_TTL_MS })
    second.track([root])
    await second.settled()
    assert.ok(context.registry.requests.length - requestsBefore <= 16)
    for (const id of packageIds) assert.equal(second.registryOf(root, nodeOf(root, id)).state, 'stale')
    assert.deepEqual(second.status(false).problems, [
      { source: 'registry', origin: context.registry.url, message: 'rejected credentials (401)', count: 20 },
    ])
  })

  it('fails only the package that answers 403 and requests every other package of the registry', async () => {
    const packageIds = Array.from({ length: 20 }, (_, index) => `pkg-${index}@1.0.0`)
    const packuments = Object.fromEntries(packageIds.map((id) => [`/${id.split('@')[0]}`, ['1.0.0']]))
    const context = await setup(packuments, {}, {
      registry: (request) => (request.path === '/pkg-3' ? { status: 403 } : undefined),
    })
    const root = rootGraph('a', '.', packageIds, { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    for (const id of packageIds) {
      const state = service.registryOf(root, nodeOf(root, id))
      if (id === 'pkg-3@1.0.0') assert.deepEqual(state, { state: 'failed', reason: 'rejected credentials (403)' })
      else assert.equal(state.state, 'ok', id)
    }
    for (const id of packageIds) assert.equal(requestsTo(context.registry, `/${id.split('@')[0]}`).length, 1, id)
    assert.deepEqual(service.status(false).problems, [
      { source: 'registry', origin: context.registry.url, message: 'rejected credentials (403)', count: 1 },
    ])
  })

  it('does not fail the keys of a root whose token works because another root with the same registry URL was rejected', async () => {
    const idsOf = (prefix: string) => Array.from({ length: 20 }, (_, index) => `${prefix}-${index}@1.0.0`)
    const rejectedIds = idsOf('a')
    const workingIds = idsOf('b')
    const packuments = Object.fromEntries([...rejectedIds, ...workingIds].map((id) => [`/${id.split('@')[0]}`, ['1.0.0']]))
    const context = await setup(packuments, {}, {
      registry: (request) => (request.headers.authorization === 'Bearer bad-token-1' ? { status: 401 } : undefined),
    })
    await writeNpmrc(context, 'packages/a', `//127.0.0.1:${context.registry.port}/:_authToken=bad-token-1\n`)
    await writeNpmrc(context, 'packages/b', `//127.0.0.1:${context.registry.port}/:_authToken=good-token-1\n`)
    const rejected = rootGraph('a', 'packages/a', rejectedIds, { registry: context.registry.url })
    const working = rootGraph('b', 'packages/b', workingIds, { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([rejected, working])
    await service.settled()
    for (const id of workingIds) {
      assert.equal(service.registryOf(working, nodeOf(working, id)).state, 'ok', id)
      assert.equal(requestsTo(context.registry, `/${id.split('@')[0]}`).length, 1, id)
    }
    for (const id of rejectedIds) {
      assert.deepEqual(service.registryOf(rejected, nodeOf(rejected, id)), { state: 'failed', reason: 'rejected credentials (401)' })
    }
    const rejectedRequests = rejectedIds.filter((id) => requestsTo(context.registry, `/${id.split('@')[0]}`).length > 0)
    assert.ok(rejectedRequests.length <= 16, `${rejectedRequests.length} rejected keys were requested`)
  })

  it('keeps sending to another registry URL on the same origin after one rejects credentials', async () => {
    const context = await setup({ '/is-odd': ['1.0.0'] }, {}, {
      registry: (request) => (request.path.startsWith('/private/') ? { status: 401 } : undefined),
    })
    const packageIds = Array.from({ length: 20 }, (_, index) => `pkg-${index}@1.0.0`)
    const rejected = rootGraph('a', 'packages/a', packageIds, { registry: `${context.registry.url}/private/` })
    const working = rootGraph('b', 'packages/b', ['is-odd@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([rejected, working])
    await service.settled()
    assert.equal(service.registryOf(working, nodeOf(working, 'is-odd@1.0.0')).state, 'ok')
    assert.deepEqual(service.status(false).problems, [
      { source: 'registry', origin: context.registry.url, message: 'rejected credentials (401)', count: 20 },
    ])
  })
})

describe('enrichment service retries', () => {
  it('keeps failed registry and advisories keys failed across track passes until refresh', async () => {
    const context = await setup({}, LODASH_OSV, {
      registry: () => ({ status: 401 }),
      osv: (request) => (request.path === '/v1/query' ? { status: 400 } : undefined),
    })
    const root = rootGraph('a', '.', ['lodash@4.17.21', 'left-pad@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    service.track([root])
    await service.settled()
    assert.equal(requestsTo(context.registry, '/lodash').length, 1)
    assert.equal(requestsTo(context.registry, '/left-pad').length, 1)
    assert.equal(requestsTo(context.osv, '/v1/query').length, 1)
    assert.deepEqual(service.registryOf(root, nodeOf(root, 'left-pad@1.0.0')), {
      state: 'failed',
      reason: 'rejected credentials (401)',
    })
    assert.deepEqual(service.advisoriesOf('lodash'), { state: 'failed', reason: 'responded with HTTP 400' })
    service.refresh()
    await service.settled()
    assert.equal(requestsTo(context.registry, '/lodash').length, 2)
    assert.equal(requestsTo(context.registry, '/left-pad').length, 2)
    assert.equal(requestsTo(context.osv, '/v1/query').length, 2)
  })

  it('keeps failed matches failed across track passes until refresh', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, {}, { osv: () => ({ status: 400 }) })
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    service.track([root])
    await service.settled()
    assert.equal(requestsTo(context.osv, '/v1/querybatch').length, 1)
    assert.deepEqual(service.matchOf(root, nodeOf(root, 'lodash@4.17.21')), {
      state: 'failed',
      reason: 'responded with HTTP 400',
    })
    service.refresh()
    await service.settled()
    assert.equal(requestsTo(context.osv, '/v1/querybatch').length, 2)
  })
})

describe('enrichment service status', () => {
  it('reports running until settled, then done with counts, finishedAt and a throttled revision', async () => {
    const fixedNow = Date.parse('2026-10-25T12:00:00.000Z')
    const context = await setup({ '/lodash': ['4.17.21'], '/acme/@acme%2fui': ['1.0.0'], '/left-pad': ['1.2.0'] })
    const root = rootGraph('a', '.', ['lodash@4.17.21', '@acme/ui@1.0.0', 'left-pad@^1.2.0', 'local@1.0.0'], {
      registry: context.registry.url,
      scopedRegistries: { '@acme': `${context.registry.url}/acme/` },
    })
    nodeOf(root, 'local@1.0.0').nonRegistry = true
    const service = serviceFor(context, { now: () => fixedNow, revisionIntervalMs: 60_000 })
    assert.equal(service.revision, 0)
    service.track([root])
    assert.equal(service.status(false).state, 'running')
    assert.equal(service.status(true).state, 'running')
    await service.settled()
    assert.deepEqual(service.status(false), {
      state: 'done',
      revision: 2,
      registry: { total: 3, done: 3, failed: 0 },
      osv: { total: 1, done: 1, skipped: 2, failed: 0 },
      problems: [],
      finishedAt: '2026-10-25T12:00:00.000Z',
    })
    assert.equal(service.status(true).state, 'running')
    assert.equal(service.revision, 2)
  })

  it('reads credentials but sends nothing when offline', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, LODASH_OSV)
    await writeNpmrc(context, '.', `//127.0.0.1:${context.registry.port}/:_authToken=${CANARY_TOKEN}\n`)
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context, { offline: true })
    service.track([root])
    await service.settled()
    assert.equal(context.registry.requests.length, 0)
    assert.equal(context.osv.requests.length, 0)
    assert.deepEqual(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')), { state: 'offline' })
    assert.deepEqual(service.matchOf(root, nodeOf(root, 'lodash@4.17.21')), { state: 'offline' })
    assert.equal(service.status(false).state, 'offline')
    assert.equal(context.secrets.redact(CANARY_TOKEN), '[redacted]')
  })

  it('gives an offline service that reads nothing', async () => {
    const service = offlineEnrichment()
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: 'https://registry.npmjs.org/' })
    service.track([root])
    await service.settled()
    assert.deepEqual(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')), { state: 'offline' })
    assert.equal(service.status(false).state, 'offline')
  })
})

describe('enrichment service refresh and shutdown', () => {
  it('re-requests every key with If-None-Match on refresh', async () => {
    const context = await setup({ '/lodash': ['4.17.21'] }, LODASH_OSV)
    const root = rootGraph('a', '.', ['lodash@4.17.21'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    service.refresh()
    await service.settled()
    const requests = requestsTo(context.registry, '/lodash')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['if-none-match'], ETAG)
    assert.equal(requestsTo(context.osv, '/v1/querybatch').length, 2)
    assert.equal(requestsTo(context.osv, '/v1/query').length, 2)
    assert.equal(service.registryOf(root, nodeOf(root, 'lodash@4.17.21')).state, 'ok')
  })

  it('cancels requests in flight on close and settles with the key failed', async () => {
    const arrived = deferred<void>()
    const reply = deferred<FakeReply>()
    const context = await setup({}, {}, {
      registry: (request) => {
        if (request.path !== '/slow-pkg') return undefined
        arrived.resolve()
        return reply.promise
      },
    })
    const abort = new AbortController()
    const root = rootGraph('a', '.', ['slow-pkg@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context, { http: recordingHttp(context.sleeps, abort.signal), abort })
    try {
      service.track([root])
      await arrived.promise
      service.close()
      await service.settled()
      assert.deepEqual(service.registryOf(root, nodeOf(root, 'slow-pkg@1.0.0')), {
        state: 'failed',
        reason: 'request was canceled',
      })
      assert.equal(service.status(false).state, 'done')
    } finally {
      reply.resolve({ body: packumentBody(['1.0.0']) })
    }
  })
})

describe('enrichment service advisories', () => {
  it('queries the advisories of a vulnerable name once and serves them', async () => {
    const context = await setup({ '/lodash': ['4.17.20', '4.17.21'], '/is-odd': ['1.0.0'] }, LODASH_OSV)
    const root = rootGraph('a', '.', ['lodash@4.17.20', 'lodash@4.17.21', 'is-odd@1.0.0'], { registry: context.registry.url })
    const service = serviceFor(context)
    service.track([root])
    await service.settled()
    const queries = requestsTo(context.osv, '/v1/query')
    assert.equal(queries.length, 1)
    assert.deepEqual(JSON.parse(queries[0].body), { package: { name: 'lodash', ecosystem: 'npm' } })
    const advisories = service.advisoriesOf('lodash')
    assert.ok(advisories.state === 'ok')
    assert.deepEqual(
      advisories.advisories.map((advisory) => [advisory.id, advisory.severity]),
      [[LODASH_VULN.id, 'high']],
    )
    assert.deepEqual(service.advisoriesOf('is-odd'), { state: 'pending' })
    const match = service.matchOfVersion('lodash', '4.17.20')
    assert.ok(match.state === 'ok')
    assert.deepEqual(match.vulns, [LODASH_VULN])
    assert.equal(service.matchOfVersion('is-odd', '1.0.0').state, 'ok')
  })
})
