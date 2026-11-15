import { after, before, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { createActionService, type ActionService } from '../../src/actions/action-service.ts'
import { unifiedDiff } from '../../src/actions/text-diff.ts'
import type { NodeActions } from '../../src/actions/types.ts'
import type { CommandRunner, ProcessRunner } from '../../src/adapters/command-runner.ts'
import { createSecretSet } from '../../src/config/secrets.ts'
import { createEnrichmentCache } from '../../src/enrich/enrichment-cache.ts'
import { createEnrichmentService, type EnrichmentService } from '../../src/enrich/enrichment-service.ts'
import { createHttpClient, type HttpClient } from '../../src/enrich/http.ts'
import type { Advisory, EnrichmentView, PackageMeta, Severity } from '../../src/enrich/types.ts'
import type { DepKind, NodeId, PackageNode, RootGraph } from '../../src/model.ts'
import { decorations, issueCounts } from '../../src/query/decorations.ts'
import { dependents } from '../../src/query/dependents.ts'
import { duplicates } from '../../src/query/duplicates.ts'
import { issuesByDirect, issuesByPackage } from '../../src/query/issues.ts'
import { ALL_KINDS, type KindFilter } from '../../src/query/lookup.ts'
import { nodeFix } from '../../src/query/node-fix.ts'
import { packageInsight, REQUESTED_CAP } from '../../src/query/package-insight.ts'
import { search } from '../../src/query/search.ts'
import { subgraph, type SubgraphResult } from '../../src/query/subgraph.ts'
import { startScanSession, type ScanSession } from '../../src/scan/scan-session.ts'
import { encodeRootSegment } from '../../src/server/root-segment.ts'
import { startServer, type RunningServer } from '../../src/server/server.ts'
import { createFsReader } from '../../src/sources/file-reader.ts'
import { createHash } from 'node:crypto'
import { findRoots } from '../../src/discovery/find-roots.ts'
import { parseTree } from '../../src/git/tree-index.ts'
import { compareSources } from '../../src/query/compare.ts'
import { createGitReader } from '../../src/sources/git-reader.ts'
import { treeBuffer } from '../helpers/git-tree.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta, stubEnrichment, type ViewSpec } from '../helpers/enrichment-view.ts'
import { startFakeServer, type FakeServer, type RecordedRequest } from '../helpers/fake-http.ts'
import { generateMonolith } from './generate-monolith.ts'

const ROOT_COUNT = 8
const PACKAGES_PER_ROOT = 6250
const SEED = 1
const COLD_SCAN_BUDGET_MS = 5000
const QUERY_BUDGET_MS = 100
const TRAIL_DEPTH = 50
const SUBGRAPH_OPTIONS = { up: 3, down: 1, limit: 300, kinds: ALL_KINDS }
const MEASURED_ROOT = 'root-0'
const SHARED_PACKAGE = 'tslib'
const MIN_SHARED_DEPENDENT_SHARE = 0.2
const VULNERABLE_NODE_COUNT = 200
const WARM_UP_REVISION = 1
const MEASURED_REVISION = 2
const POLLING_REVISION = 3
const POLL_CYCLES = 10
const POLLED_KINDS: KindFilter = new Set<DepKind>(['prod'])
const SEVERITY_CYCLE: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown']
const WARM_TRACK_BUDGET_MS = 2000
const PERF_USER_AGENT = 'deptrail-perf/1.0'
const ACTIONS_REVISION = 4
const PROBED_MANAGER_VERSION = '10.34.3'
const DIFF_LINE_COUNT = 60_000
const DIFF_CHANGE_COUNT = 1_000
const DIFF_BUDGET_MS = 1000
const DIFF_CHANGE_SUFFIX = ' # changed'
const PERF_LOCKFILE = 'pnpm-lock.yaml'

const warmUpFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'monolith')

const throwingRunner: CommandRunner = async () => {
  throw new Error('runner must not be called')
}

const probingRunner: ProcessRunner = {
  run: async () => ({ code: 0, stdout: `${PROBED_MANAGER_VERSION}\n`, stderr: '', timedOut: false, cancelled: false }),
  killRunning() {},
}

type Timed<T> = { result: T; firstMs: number; ms: number }

function startSession(repoPath: string): Promise<ScanSession> {
  return startScanSession({
    repoPath,
    reader: createFsReader(repoPath),
    runner: throwingRunner,
    cache: null,
    env: {},
    userNpmrc: null,
  })
}

function timedAfterWarmUp<T>(work: () => T): Timed<T> {
  const firstStarted = performance.now()
  work()
  const firstMs = performance.now() - firstStarted
  const started = performance.now()
  const result = work()
  return { result, firstMs, ms: performance.now() - started }
}

async function timedAsyncAfterWarmUp<T>(work: () => Promise<T>): Promise<Timed<T>> {
  const firstStarted = performance.now()
  await work()
  const firstMs = performance.now() - firstStarted
  const started = performance.now()
  const result = await work()
  return { result, firstMs, ms: performance.now() - started }
}

function withoutPublishedVersionLoads(enrichment: EnrichmentService): EnrichmentService {
  return {
    ...enrichment,
    publishedVersions: async (_root, name) => {
      throw new Error(`published versions of ${name} must not be loaded`)
    },
  }
}

function scatteredChanges(lines: readonly string[], count: number): string[] {
  const stride = lines.length / count
  const changed = new Set(Array.from({ length: count }, (_, position) => Math.floor((position + 0.5) * stride)))
  return lines.map((line, index) => (changed.has(index) ? `${line}${DIFF_CHANGE_SUFFIX}` : line))
}

function report(t: TestContext, label: string, timed: { firstMs?: number; ms: number }): void {
  const first = timed.firstMs === undefined ? '' : ` (first call ${timed.firstMs.toFixed(1)} ms)`
  t.diagnostic(`${label}: ${timed.ms.toFixed(1)} ms${first}`)
}

type FirstCall<T> = { result: T; warmUpMs: number; ms: number }
type ManifestsByVersion = Record<string, Record<string, string>>
type BatchBody = { queries: unknown[] }

function reportFirstCall(t: TestContext, label: string, timed: FirstCall<unknown>): void {
  t.diagnostic(`${label}: ${timed.ms.toFixed(1)} ms at a new revision (warm-up ${timed.warmUpMs.toFixed(1)} ms)`)
}

function publishedManifestsByName(roots: readonly RootGraph[]): Map<string, ManifestsByVersion> {
  const manifestsByName = new Map<string, ManifestsByVersion>()
  for (const root of roots) {
    for (const node of root.packages.values()) {
      const manifests = manifestsByName.get(node.name) ?? {}
      manifestsByName.set(node.name, manifests)
      if (manifests[node.version] !== undefined) continue
      const declared: Record<string, string> = {}
      for (const edge of node.deps) {
        const child = root.packages.get(edge.to)
        if (child) declared[child.name] = `^${child.version}`
      }
      manifests[node.version] = declared
    }
  }
  return manifestsByName
}

function spreadVulnerableNodes(root: RootGraph, includedId: NodeId, count: number): PackageNode[] {
  const included = root.packages.get(includedId)!
  const others = [...root.packages.values()].filter((node) => node.id !== includedId)
  const stride = Math.floor(others.length / (count - 1))
  return [included, ...Array.from({ length: count - 1 }, (_, position) => others[position * stride]!)]
}

function syntheticStore(roots: readonly RootGraph[], vulnerable: readonly PackageNode[]): ViewSpec {
  const vulns: Record<string, string[]> = {}
  const advisories: Record<string, Advisory[]> = {}
  const fixedVersionByName = new Map<string, string>()
  vulnerable.forEach((node, position) => {
    const id = `GHSA-perf-${position}`
    const fixed = semver.inc(node.version, 'patch')!
    vulns[`${node.name}@${node.version}`] = [id]
    advisories[node.name] = [
      makeAdvisory({ id, severity: SEVERITY_CYCLE[position % SEVERITY_CYCLE.length], events: [{ introduced: '0' }, { fixed }], fixedIn: [fixed] }),
    ]
    fixedVersionByName.set(node.name, fixed)
  })
  const meta: Record<string, PackageMeta> = {}
  for (const [name, manifests] of publishedManifestsByName(roots)) {
    const fixed = fixedVersionByName.get(name)
    const versions = [...new Set([...Object.keys(manifests), ...(fixed === undefined ? [] : [fixed])])].sort(semver.compare)
    meta[name] = makeMeta({ versions, latest: versions[versions.length - 1], manifests })
  }
  return { meta, vulns, advisories }
}

function versionsInUseByName(roots: readonly RootGraph[]): Map<string, Set<string>> {
  const versionsByName = new Map<string, Set<string>>()
  for (const root of roots) {
    for (const node of root.packages.values()) {
      const versions = versionsByName.get(node.name) ?? new Set<string>()
      versionsByName.set(node.name, versions)
      versions.add(node.version)
    }
  }
  return versionsByName
}

function startAbbreviatedRegistry(versionsByName: ReadonlyMap<string, ReadonlySet<string>>): Promise<FakeServer> {
  return startFakeServer((request: RecordedRequest) => {
    const name = decodeURIComponent(request.path.slice(1))
    const versions = [...(versionsByName.get(name) ?? [])]
    if (versions.length === 0) return { status: 404 }
    return {
      body: {
        name,
        'dist-tags': { latest: versions[versions.length - 1] },
        versions: Object.fromEntries(versions.map((version) => [version, { name, version }])),
      },
    }
  })
}

function startCleanOsv(): Promise<FakeServer> {
  return startFakeServer((request: RecordedRequest) => {
    if (request.path !== '/v1/querybatch') return { status: 404 }
    const { queries } = JSON.parse(request.body) as BatchBody
    return { body: { results: queries.map(() => ({})) } }
  })
}

function servedFrom(roots: readonly RootGraph[], registryUrl: string): RootGraph[] {
  return roots.map((root) => ({ ...root, config: { ...root.config!, registry: registryUrl } }))
}

function perfService(repoPath: string, cacheDir: string, http: HttpClient, osvUrl: string): EnrichmentService {
  return createEnrichmentService({
    reader: createFsReader(repoPath),
    env: {},
    userNpmrc: null,
    http,
    osvUrl,
    cache: createEnrichmentCache(cacheDir),
    secrets: createSecretSet(),
    offline: false,
  })
}

function getJson(server: RunningServer, pathname: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port: server.port, path: pathname, headers: { 'x-deptrail-token': server.token } },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () =>
          resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
        )
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

describe('performance on a generated monolith', () => {
  let sandbox: string
  let session: ScanSession
  let coldScanMs: number
  let measuredRoot: RootGraph
  let sharedPackageId: NodeId

  before(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-perf-'))
    await generateMonolith(sandbox, { roots: ROOT_COUNT, packagesPerRoot: PACKAGES_PER_ROOT, seed: SEED })
    await (await startSession(warmUpFixture)).ready
    const started = performance.now()
    session = await startSession(sandbox)
    await session.ready
    coldScanMs = performance.now() - started
    measuredRoot = session.root(MEASURED_ROOT)!
    const sharedEntry = session.index.get(SHARED_PACKAGE)?.find((entry) => entry.rootId === MEASURED_ROOT)
    sharedPackageId = sharedEntry!.nodeId
  })

  after(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it(`scans ${ROOT_COUNT} roots of ${PACKAGES_PER_ROOT} packages cold in under ${COLD_SCAN_BUDGET_MS} ms`, (t) => {
    report(t, 'cold scan', { ms: coldScanMs })
    assert.equal(session.scan.roots.length, ROOT_COUNT)
    for (const root of session.scan.roots) {
      assert.equal(root.status, 'ready', `${root.id}: ${root.error ?? ''}`)
      assert.equal(root.source, 'lockfile')
      assert.equal(root.packages.size, PACKAGES_PER_ROOT)
      assert.deepStrictEqual(root.warnings, [])
    }
    assert.ok(coldScanMs < COLD_SCAN_BUDGET_MS, `cold scan took ${coldScanMs.toFixed(0)} ms`)
  })

  it(`answers dependents of ${SHARED_PACKAGE} at depth ${TRAIL_DEPTH} in under ${QUERY_BUDGET_MS} ms`, (t) => {
    const timed = timedAfterWarmUp(() => dependents(measuredRoot, sharedPackageId, TRAIL_DEPTH, ALL_KINDS))
    report(t, 'dependents', timed)
    assert.ok(timed.result.focusParents.length > PACKAGES_PER_ROOT * MIN_SHARED_DEPENDENT_SHARE)
    assert.ok(timed.result.summary.importers.length > 0)
    assert.ok(timed.ms < QUERY_BUDGET_MS, `dependents took ${timed.ms.toFixed(1)} ms`)
  })

  it(`answers a subgraph limited to ${SUBGRAPH_OPTIONS.limit} nodes in under ${QUERY_BUDGET_MS} ms`, (t) => {
    const timed = timedAfterWarmUp(() => subgraph(measuredRoot, sharedPackageId, SUBGRAPH_OPTIONS))
    report(t, 'subgraph', timed)
    assert.equal(timed.result.nodes.length, SUBGRAPH_OPTIONS.limit)
    assert.equal(timed.result.truncated, true)
    assert.ok(timed.ms < QUERY_BUDGET_MS, `subgraph took ${timed.ms.toFixed(1)} ms`)
  })

  it(`searches for ${SHARED_PACKAGE} in under ${QUERY_BUDGET_MS} ms`, (t) => {
    const timed = timedAfterWarmUp(() => search(session.index, SHARED_PACKAGE))
    report(t, 'search', timed)
    assert.equal(timed.result[0]?.name, SHARED_PACKAGE)
    const rootsFound = timed.result[0].versions.flatMap((version) => version.roots.map((root) => root.rootId))
    assert.equal(rootsFound.length, ROOT_COUNT)
    assert.ok(timed.ms < QUERY_BUDGET_MS, `search took ${timed.ms.toFixed(1)} ms`)
  })

  it(`lists duplicates across all roots in under ${QUERY_BUDGET_MS} ms`, (t) => {
    const timed = timedAfterWarmUp(() => duplicates(session.index))
    report(t, 'duplicates', timed)
    assert.ok(timed.result.length > 0)
    assert.ok(timed.result.some((entry) => entry.name === SHARED_PACKAGE))
    assert.ok(timed.ms < QUERY_BUDGET_MS, `duplicates took ${timed.ms.toFixed(1)} ms`)
  })

  it(`serves the ${SHARED_PACKAGE} subgraph over HTTP in under ${QUERY_BUDGET_MS} ms`, async (t) => {
    const staticDir = await mkdtemp(path.join(tmpdir(), 'deptrail-perf-static-'))
    const server = await startServer({ session, port: 0, staticDir })
    try {
      const pathname = `/api/roots/${encodeRootSegment(MEASURED_ROOT)}/nodes/${encodeURIComponent(sharedPackageId)}/subgraph`
      const started = performance.now()
      const response = await getJson(server, pathname)
      const ms = performance.now() - started
      report(t, 'HTTP subgraph round trip', { ms })
      assert.equal(response.status, 200)
      assert.equal((response.body as SubgraphResult).nodes.length, SUBGRAPH_OPTIONS.limit)
      assert.ok(ms < QUERY_BUDGET_MS, `HTTP subgraph round trip took ${ms.toFixed(1)} ms`)
    } finally {
      await server.close()
      await rm(staticDir, { recursive: true, force: true })
    }
  })

  it(`diffs ${DIFF_LINE_COUNT} lines with ${DIFF_CHANGE_COUNT} scattered changes in under ${DIFF_BUDGET_MS} ms`, async (t) => {
    const lockfileLines = (await readFile(path.join(sandbox, measuredRoot.path, PERF_LOCKFILE), 'utf8')).split('\n')
    assert.ok(lockfileLines.length >= DIFF_LINE_COUNT, `the generated lockfile has ${lockfileLines.length} lines`)
    const beforeLines = lockfileLines.slice(0, DIFF_LINE_COUNT)
    const beforeText = `${beforeLines.join('\n')}\n`
    const afterText = `${scatteredChanges(beforeLines, DIFF_CHANGE_COUNT).join('\n')}\n`
    const started = performance.now()
    const result = unifiedDiff(PERF_LOCKFILE, beforeText, afterText)
    const ms = performance.now() - started
    report(t, `unified diff of ${DIFF_LINE_COUNT} lines`, { ms })
    assert.equal(result.added, DIFF_CHANGE_COUNT)
    assert.equal(result.removed, DIFF_CHANGE_COUNT)
    assert.ok(ms < DIFF_BUDGET_MS, `unified diff took ${ms.toFixed(0)} ms`)
  })

  describe(`enrichment with ${VULNERABLE_NODE_COUNT} vulnerable nodes in ${MEASURED_ROOT}`, () => {
    let store: ViewSpec
    let sharedMonolithVersions: string[]
    let vulnerableNodes: PackageNode[]

    const viewAt = (revision: number): EnrichmentView => makeEnrichmentView({ ...store, revision })

    function firstCallAtNewRevision<T>(work: (view: EnrichmentView) => T): FirstCall<T> {
      const warmUpStarted = performance.now()
      work(viewAt(WARM_UP_REVISION))
      const warmUpMs = performance.now() - warmUpStarted
      const started = performance.now()
      const result = work(viewAt(MEASURED_REVISION))
      return { result, warmUpMs, ms: performance.now() - started }
    }

    before(() => {
      vulnerableNodes = spreadVulnerableNodes(measuredRoot, sharedPackageId, VULNERABLE_NODE_COUNT)
      store = syntheticStore(session.scan.roots, vulnerableNodes)
      sharedMonolithVersions = [...new Set((session.index.get(SHARED_PACKAGE) ?? []).map((entry) => entry.version))]
    })

    it(`decorates ${MEASURED_ROOT} on the first call at a new revision in under ${QUERY_BUDGET_MS} ms`, (t) => {
      const timed = firstCallAtNewRevision((view) => decorations(view, measuredRoot, ALL_KINDS))
      reportFirstCall(t, 'decorations', timed)
      const decorated = Object.values(timed.result)
      assert.equal(decorated.filter((decoration) => decoration.vuln).length, VULNERABLE_NODE_COUNT)
      assert.ok(decorated.some((decoration) => decoration.below))
      assert.ok(timed.ms < QUERY_BUDGET_MS, `decorations took ${timed.ms.toFixed(1)} ms`)
    })

    it(`groups issues of ${MEASURED_ROOT} by package on the first call at a new revision in under ${QUERY_BUDGET_MS} ms`, (t) => {
      const timed = firstCallAtNewRevision((view) => issuesByPackage(view, [measuredRoot], ALL_KINDS))
      reportFirstCall(t, 'issues by package', timed)
      const shared = timed.result.find((row) => row.name === SHARED_PACKAGE)
      assert.ok(shared)
      assert.ok(shared.kinds.includes('vulnerability'))
      assert.ok(shared.locations[0]?.fix)
      assert.ok(timed.ms < QUERY_BUDGET_MS, `issues by package took ${timed.ms.toFixed(1)} ms`)
    })

    it(`groups issues of ${MEASURED_ROOT} by direct dependency on the first call at a new revision in under ${QUERY_BUDGET_MS} ms`, (t) => {
      const timed = firstCallAtNewRevision((view) => issuesByDirect(view, [measuredRoot], ALL_KINDS))
      reportFirstCall(t, 'issues by direct dependency', timed)
      assert.ok(timed.result.length > 0)
      assert.ok(timed.result.some((group) => group.issues.some((issue) => issue.name === SHARED_PACKAGE)))
      assert.ok(timed.ms < QUERY_BUDGET_MS, `issues by direct dependency took ${timed.ms.toFixed(1)} ms`)
    })

    it(`builds the insight of ${SHARED_PACKAGE} on the first call at a new revision in under ${QUERY_BUDGET_MS} ms`, (t) => {
      const timed = firstCallAtNewRevision((view) => packageInsight(view, measuredRoot, sharedPackageId, ALL_KINDS, sharedMonolithVersions))
      reportFirstCall(t, 'package insight', timed)
      assert.equal(timed.result.vulnerabilities.items.length, 1)
      assert.equal(timed.result.requested.length, REQUESTED_CAP)
      assert.ok(timed.result.requestedTruncated > 0)
      assert.ok(timed.result.fix)
      assert.ok(timed.ms < QUERY_BUDGET_MS, `package insight took ${timed.ms.toFixed(1)} ms`)
    })

    it(`alternates filtered decorations with issue counts of ${MEASURED_ROOT} ${POLL_CYCLES} times at a new revision in under ${QUERY_BUDGET_MS} ms`, (t) => {
      const view = viewAt(POLLING_REVISION)
      const started = performance.now()
      for (let cycle = 0; cycle < POLL_CYCLES; cycle++) {
        decorations(view, measuredRoot, POLLED_KINDS)
        issueCounts(view, measuredRoot)
      }
      const ms = performance.now() - started
      report(t, `${POLL_CYCLES} polling cycles`, { ms })
      assert.equal(issueCounts(view, measuredRoot).vulnerable, VULNERABLE_NODE_COUNT)
      assert.ok(ms < QUERY_BUDGET_MS, `${POLL_CYCLES} polling cycles took ${ms.toFixed(1)} ms`)
    })

    it(`tracks every key from a warm cache to settled in under ${WARM_TRACK_BUDGET_MS} ms without fetching`, async (t) => {
      const cacheDir = await mkdtemp(path.join(tmpdir(), 'deptrail-perf-enrichment-'))
      const registry = await startAbbreviatedRegistry(versionsInUseByName(session.scan.roots))
      const osv = await startCleanOsv()
      try {
        const roots = servedFrom(session.scan.roots, registry.url)
        const cold = perfService(sandbox, cacheDir, createHttpClient({ userAgent: PERF_USER_AGENT, sleep: async () => {} }), osv.url)
        cold.track(roots)
        await cold.settled()
        const coldStatus = cold.status(false)
        cold.close()
        assert.equal(coldStatus.registry.failed, 0)
        assert.equal(coldStatus.osv.failed, 0)
        assert.equal(coldStatus.registry.done, coldStatus.registry.total)
        assert.equal(coldStatus.osv.done, coldStatus.osv.total)

        let fetchCalls = 0
        const throwingFetch: typeof fetch = async () => {
          fetchCalls++
          throw new TypeError('fetch must not be called')
        }
        const warm = perfService(sandbox, cacheDir, createHttpClient({ userAgent: PERF_USER_AGENT, fetchImpl: throwingFetch }), osv.url)
        const started = performance.now()
        warm.track(roots)
        await warm.settled()
        const ms = performance.now() - started
        const warmStatus = warm.status(false)
        warm.close()
        report(t, `warm track of ${warmStatus.registry.total} registry and ${warmStatus.osv.total} OSV keys`, { ms })
        t.diagnostic(`fetch calls: ${fetchCalls}`)
        assert.equal(fetchCalls, 0)
        assert.equal(warmStatus.registry.failed, 0)
        assert.equal(warmStatus.osv.failed, 0)
        assert.equal(warmStatus.registry.done, coldStatus.registry.total)
        assert.equal(warmStatus.osv.done, coldStatus.osv.total)
        assert.ok(ms < WARM_TRACK_BUDGET_MS, `warm track took ${ms.toFixed(0)} ms`)
      } finally {
        await registry.close()
        await osv.close()
        await rm(cacheDir, { recursive: true, force: true })
      }
    })

    describe(`actions in ${MEASURED_ROOT} without published-version loads`, () => {
      let actions: ActionService
      let relockNode: PackageNode
      let directDependency: PackageNode

      function isVulnerable(node: PackageNode): boolean {
        return store.vulns?.[`${node.name}@${node.version}`] !== undefined
      }

      before(() => {
        const view = viewAt(ACTIONS_REVISION)
        actions = createActionService({
          repoPath: sandbox,
          session,
          enrichment: withoutPublishedVersionLoads(stubEnrichment(view)),
          runner: probingRunner,
          env: {},
          offline: false,
          secrets: createSecretSet(),
        })
        actions.track(session.scan.roots)
        relockNode = vulnerableNodes.find((node) => nodeFix(view, measuredRoot, node, ALL_KINDS)?.kind === 'relock')!
        directDependency = measuredRoot.importers
          .flatMap((importer) => importer.deps)
          .map((edge) => measuredRoot.packages.get(edge.to))
          .find((node): node is PackageNode => node !== undefined && !isVulnerable(node))!
      })

      after(async () => {
        await actions.close()
      })

      async function measuredActions(t: TestContext, label: string, node: PackageNode): Promise<Timed<NodeActions>> {
        const timed = await timedAsyncAfterWarmUp(() => actions.nodeActions(MEASURED_ROOT, node.id, ALL_KINDS))
        report(t, `${label} (${node.id})`, timed)
        return timed
      }

      it(`builds the actions of a vulnerable node with a relock fix in under ${QUERY_BUDGET_MS} ms`, async (t) => {
        assert.ok(relockNode, 'a vulnerable node with a relock fix')
        const timed = await measuredActions(t, 'relock node actions', relockNode)
        assert.equal(timed.result.unavailable, undefined)
        assert.equal(timed.result.fix?.options[0]?.choice, 'relock')
        assert.equal(timed.result.fix?.options[0]?.recommended, true)
        assert.ok(timed.ms < QUERY_BUDGET_MS, `relock node actions took ${timed.ms.toFixed(1)} ms`)
      })

      it(`builds the update actions of a direct dependency in under ${QUERY_BUDGET_MS} ms`, async (t) => {
        assert.ok(directDependency, `a direct dependency of ${MEASURED_ROOT}`)
        const timed = await measuredActions(t, 'direct dependency actions', directDependency)
        assert.equal(timed.result.unavailable, undefined)
        assert.equal(timed.result.update?.name, directDependency.name)
        assert.ok((timed.result.update?.versions.length ?? 0) > 0)
        assert.ok((timed.result.update?.importers.length ?? 0) > 0)
        assert.ok(timed.ms < QUERY_BUDGET_MS, `direct dependency actions took ${timed.ms.toFixed(1)} ms`)
      })
    })
  })
})

describe('performance of branch reading and comparison', () => {
  const TREE_ROOT_COUNT = 8
  const TREE_PACKAGES_PER_ROOT = 40
  const TREE_SOURCE_DIRECTORIES = 2000
  const TREE_FILES_PER_DIRECTORY = 49
  const TREE_ENTRY_LIMIT = 2_000_000
  const TREE_BUDGET_MS = 2000
  const COMPARE_BUDGET_MS = 300
  const SECOND_SEED = 2
  const sandboxes: string[] = []
  let base: ScanSession
  let target: ScanSession

  function generatedTree(): { buffer: Buffer; blobs: Map<string, Buffer>; entryCount: number } {
    const blobs = new Map<string, Buffer>()
    const entries: [string, string, string, string][] = []
    const blobId = (content: string): string => {
      const id = createHash('sha1').update(content).digest('hex')
      blobs.set(id, Buffer.from(content))
      return id
    }
    const directory = (directoryPath: string) => entries.push(['040000', 'tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', directoryPath])
    const file = (filePath: string, content: string) => entries.push(['100644', 'blob', blobId(content), filePath])
    for (let rootIndex = 0; rootIndex < TREE_ROOT_COUNT; rootIndex++) {
      const root = `apps/root-${rootIndex}`
      directory(root)
      file(`${root}/package.json`, `{"name":"root-${rootIndex}"}`)
      file(`${root}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\n")
      file(`${root}/pnpm-workspace.yaml`, 'packages:\n  - packages/*\n')
      directory(`${root}/packages`)
      for (let packageIndex = 0; packageIndex < TREE_PACKAGES_PER_ROOT; packageIndex++) {
        directory(`${root}/packages/p-${packageIndex}`)
        file(`${root}/packages/p-${packageIndex}/package.json`, `{"name":"p-${rootIndex}-${packageIndex}"}`)
      }
    }
    for (let directoryIndex = 0; directoryIndex < TREE_SOURCE_DIRECTORIES; directoryIndex++) {
      const sources = `src/dir-${directoryIndex}`
      directory(sources)
      for (let fileIndex = 0; fileIndex < TREE_FILES_PER_DIRECTORY; fileIndex++) entries.push(['100644', 'blob', 'f'.repeat(40), `${sources}/file-${fileIndex}.ts`])
    }
    directory('apps')
    directory('src')
    return { buffer: treeBuffer(entries), blobs, entryCount: entries.length }
  }

  before(async () => {
    for (const seed of [SEED, SECOND_SEED]) {
      const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-perf-compare-'))
      sandboxes.push(dir)
      await generateMonolith(dir, { roots: ROOT_COUNT, packagesPerRoot: PACKAGES_PER_ROOT, seed })
    }
    base = await startSession(sandboxes[0]!)
    target = await startSession(sandboxes[1]!)
    await Promise.all([base.ready, target.ready])
  })

  after(async () => {
    await Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it(`indexes a tree of 100,000 entries and finds its roots in under ${TREE_BUDGET_MS} ms`, async (t) => {
    const { buffer, blobs, entryCount } = generatedTree()
    assert.ok(entryCount >= 100_000, `the tree has ${entryCount} entries`)
    const started = performance.now()
    const index = parseTree(buffer, '', TREE_ENTRY_LIMIT)
    const roots = await findRoots(createGitReader(index, async (id) => blobs.get(id) ?? null))
    const ms = performance.now() - started
    report(t, 'tree index and discovery', { ms })
    assert.equal(roots.length, TREE_ROOT_COUNT)
    assert.ok(roots.every((root) => root.importerPaths.length === TREE_PACKAGES_PER_ROOT + 1))
    assert.ok(ms < TREE_BUDGET_MS, `tree index and discovery took ${ms.toFixed(0)} ms`)
  })

  it(`compares two generated monoliths in under ${COMPARE_BUDGET_MS} ms`, (t) => {
    const view = makeEnrichmentView({})
    const timed = timedAfterWarmUp(() => compareSources(view, { roots: base.scan.roots }, { roots: target.scan.roots }))
    report(t, 'compare', timed)
    assert.equal(timed.result.roots.length, ROOT_COUNT)
    assert.ok(timed.result.roots.some((root) => root.versions.length > 0))
    assert.ok(timed.ms < COMPARE_BUDGET_MS, `compare took ${timed.ms.toFixed(1)} ms`)
  })
})
