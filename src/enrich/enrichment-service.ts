import { posix } from 'node:path'
import { createSecretSet, type SecretSet } from '../config/secrets.ts'
import type { RootGraph } from '../model.ts'
import type { FileReader } from '../sources/file-reader.ts'
import { readRegistryCredentials, type AuthorizationLookup, type RegistryCredentials } from './credentials.ts'
import { isFresh, type EnrichmentCache } from './enrichment-cache.ts'
import {
  hasKnownVersion,
  inPrivateScope,
  isPlaceholder,
  isRegistryPackage,
  planKeys,
  registryKeyOf,
  registryUrlOf,
  type KeyPlan,
  type RegistryTarget,
  type TrackableRoot,
  type VersionTarget,
} from './enrichment-keys.ts'
import { createRevisionCounter, offlineStatus, problemsOf, progressOf } from './enrichment-status.ts'
import {
  ADVISORIES_VIEWS,
  advisoriesCover,
  createCacheAccess,
  createLimiter,
  createRecordStore,
  isCachedAdvisories,
  isCachedMatch,
  isCachedRegistry,
  MATCH_VIEWS,
  REGISTRY_VIEWS,
  registryOk,
  type CachedAdvisories,
  type CachedMatch,
  type CachedRegistry,
  type Limiter,
} from './enrichment-store.ts'
import { HTTP_DEFAULTS, HttpError, type HttpClient } from './http.ts'
import { createOnDemandLookups } from './on-demand.ts'
import { OSV_DEFAULT_URL, queryPackageAdvisories, queryVersions, versionKey, type BatchOutcome } from './osv-client.ts'
import { failureReason, fetchPackageMeta, metaCovers, packumentUrl, type RegistryFetchResult } from './registry-client.ts'
import type { AssessedPackage, EnrichmentStatus, EnrichmentView, MatchState, PublishedVersions, VulnRef } from './types.ts'

export type EnrichmentServiceOptions = {
  reader: FileReader
  env: Record<string, string | undefined>
  userNpmrc: string | null
  http: HttpClient
  osvUrl: string
  cache: EnrichmentCache | null
  secrets: SecretSet
  offline: boolean
  abort?: AbortController
  now?: () => number
  revisionIntervalMs?: number
}

export type EnrichmentService = EnrichmentView & {
  track(roots: readonly RootGraph[]): void
  refresh(): void
  status(anyRootScanning: boolean): EnrichmentStatus
  settled(): Promise<void>
  close(): void
  publishedVersions(root: RootGraph, name: string): Promise<PublishedVersions>
  assess(root: RootGraph, packages: readonly { name: string; version: string }[]): Promise<AssessedPackage[]>
}

type Pass = { plan: KeyPlan; forceExpired: boolean; rejectedCredentials: Map<string, string> }
type AdvisoryTarget = { key: string; reported: VulnRef[] }
type UnresolvedVersion = { target: VersionTarget; lastGood: CachedMatch | undefined }
type FetchedRegistry = { record: CachedRegistry } | { failure: string }

const NO_AUTHORIZATION_MARKER = 'no-authorization'
const DEFAULT_REVISION_INTERVAL_MS = 1000
const CACHE_CONCURRENCY = 64
const REGISTRY_REQUESTS_PER_URL = HTTP_DEFAULTS.concurrencyPerOrigin
const OSV_PARALLEL_PACKAGE_QUERIES = 8
const NPMRC_FILE = '.npmrc'
const NOT_MODIFIED_WITHOUT_VALIDATOR = 'responded with HTTP 304'
const MISSING_OSV_RESULT = 'returned a malformed response'

const PENDING = { state: 'pending' } as const
const OFFLINE = { state: 'offline' } as const
const NOT_APPLICABLE = { state: 'not-applicable' } as const
const PRIVATE_SCOPE_SKIP = { state: 'skipped', reason: 'private-scope' } as const
const NON_REGISTRY_SKIP = { state: 'skipped', reason: 'non-registry' } as const
const UNKNOWN_VERSION_SKIP = { state: 'skipped', reason: 'unknown-version' } as const

const EMPTY_READER: FileReader = {
  readText: async () => null,
  exists: async () => false,
  listDir: async () => [],
  realpath: async () => null,
}

const NO_NETWORK: HttpClient = {
  request: async () => {
    throw new HttpError('network')
  },
}

function omitsVersionInUse(record: CachedRegistry, versionsInUse: readonly string[]): boolean {
  if (record.state !== 'ok') return false
  const listed = new Set(record.meta.versions)
  return versionsInUse.some((version) => hasKnownVersion(version) && !listed.has(version))
}

export function createEnrichmentService(options: EnrichmentServiceOptions): EnrichmentService {
  const { reader, env, userNpmrc, http, osvUrl, secrets, offline } = options
  const now = options.now ?? Date.now
  const cache = createCacheAccess(options.cache, CACHE_CONCURRENCY)
  const limitPackageQueries = createLimiter(OSV_PARALLEL_PACKAGE_QUERIES)
  const registryLimiters = new Map<string, Limiter>()
  const refetchedForUnlistedVersion = new Set<string>()
  const revisions = createRevisionCounter(options.revisionIntervalMs ?? DEFAULT_REVISION_INTERVAL_MS)
  const landed = () => revisions.resultLanded()
  const registryStore = createRecordStore(REGISTRY_VIEWS, landed)
  const matchStore = createRecordStore(MATCH_VIEWS, landed)
  const advisoriesStore = createRecordStore(ADVISORIES_VIEWS, landed)
  const activePasses = new Set<Promise<unknown>>()
  const versionsWantedInFlight = new Map<string, Set<string>>()
  const credentialsByRootPath = new Map<string, Promise<RegistryCredentials>>()
  let trackedRoots: readonly RootGraph[] = []
  let currentPlan = planKeys([], new Set())
  let finishedAt: string | undefined
  let closed = false

  const nowIso = () => new Date(now()).toISOString()
  const isFreshNow = (fetchedAt: string) => isFresh(fetchedAt, now())

  function awaitsRefetchForUnlistedVersion(key: string, record: CachedRegistry, versionsInUse: readonly string[]): boolean {
    return !refetchedForUnlistedVersion.has(key) && omitsVersionInUse(record, versionsInUse)
  }

  function registryRecordUsable(key: string, record: CachedRegistry, versionsInUse: readonly string[]): boolean {
    if (!isFreshNow(record.fetchedAt)) return false
    if (record.state === 'not-found') return true
    return metaCovers(record.meta, versionsInUse) && !awaitsRefetchForUnlistedVersion(key, record, versionsInUse)
  }

  function advisoriesUsable(record: CachedAdvisories, reported: readonly VulnRef[]): boolean {
    return isFreshNow(record.fetchedAt) && advisoriesCover(record.advisories, reported)
  }

  function credentialsOf(root: TrackableRoot): Promise<RegistryCredentials> {
    const known = credentialsByRootPath.get(root.path)
    if (known !== undefined) return known
    const reading = reader
      .readText(posix.join(root.path, NPMRC_FILE))
      .catch(() => null)
      .then((projectNpmrc) => readRegistryCredentials({ projectNpmrc, userNpmrc, env }, secrets))
    credentialsByRootPath.set(root.path, reading)
    return reading
  }

  async function storeRegistry(target: RegistryTarget, record: CachedRegistry): Promise<void> {
    registryStore.succeed(target.key, record)
    await cache.write('registry', [target.registryUrl, target.name], record)
  }

  function registryLimiterOf(registryUrl: string): Limiter {
    const known = registryLimiters.get(registryUrl)
    if (known !== undefined) return known
    const limiter = createLimiter(REGISTRY_REQUESTS_PER_URL)
    registryLimiters.set(registryUrl, limiter)
    return limiter
  }

  function credentialsKeyOf(target: RegistryTarget, authorizationFor: AuthorizationLookup): string {
    const authorization = authorizationFor(packumentUrl(target.registryUrl, target.name))
    return `${target.registryUrl}\n${authorization ?? NO_AUTHORIZATION_MARKER}`
  }

  function rememberRejectedCredentials(pass: Pass, credentialsKey: string, result: RegistryFetchResult): void {
    if (result.state !== 'failed' || !result.authRejected || pass.rejectedCredentials.has(credentialsKey)) return
    pass.rejectedCredentials.set(credentialsKey, result.reason)
  }

  async function fetchRegistryRecord(
    target: RegistryTarget,
    versionsInUse: readonly string[],
    validatorCandidate: CachedRegistry | undefined,
    authorizationFor: AuthorizationLookup,
    credentialsKey: string,
    pass: Pass,
  ): Promise<FetchedRegistry> {
    const validator =
      validatorCandidate?.state === 'ok' && metaCovers(validatorCandidate.meta, versionsInUse) ? validatorCandidate : undefined
    const result = await fetchPackageMeta(http, {
      registry: target.registryUrl,
      name: target.name,
      etag: validator?.etag,
      versionsInUse,
      authorizationFor,
    })
    rememberRejectedCredentials(pass, credentialsKey, result)
    const fetchedAt = nowIso()
    if (result.state === 'ok') return { record: registryOk(result.meta, fetchedAt, result.etag) }
    if (result.state === 'not-found') return { record: { state: 'not-found', fetchedAt } }
    if (result.state === 'not-modified' && validator !== undefined) {
      return { record: registryOk(validator.meta, fetchedAt, validator.etag) }
    }
    return { failure: result.state === 'failed' ? result.reason : NOT_MODIFIED_WITHOUT_VALIDATOR }
  }

  function fetchUnlessCredentialsRejected(
    target: RegistryTarget,
    versionsInUse: readonly string[],
    validatorCandidate: CachedRegistry | undefined,
    authorizationFor: AuthorizationLookup,
    pass: Pass,
  ): Promise<FetchedRegistry> {
    const credentialsKey = credentialsKeyOf(target, authorizationFor)
    return registryLimiterOf(target.registryUrl)(async () => {
      const rejection = pass.rejectedCredentials.get(credentialsKey)
      if (rejection !== undefined) return { failure: rejection }
      return fetchRegistryRecord(target, versionsInUse, validatorCandidate, authorizationFor, credentialsKey, pass)
    })
  }

  function missesVersionsAddedMeanwhile(record: CachedRegistry, requested: readonly string[], wanted: ReadonlySet<string>): boolean {
    return wanted.size > requested.length && record.state === 'ok' && !metaCovers(record.meta, [...wanted])
  }

  async function resolveRegistryTarget(target: RegistryTarget, pass: Pass): Promise<void> {
    const wanted = new Set(target.versionsInUse)
    versionsWantedInFlight.set(target.key, wanted)
    let lastGood: CachedRegistry | undefined
    try {
      const cached = await cache.read('registry', [target.registryUrl, target.name], isCachedRegistry)
      if (cached !== undefined && !pass.forceExpired && registryRecordUsable(target.key, cached, [...wanted])) {
        registryStore.succeed(target.key, cached)
        return
      }
      lastGood = cached ?? registryStore.lastGoodOf(target.key)
      const { authorizationFor } = await credentialsOf(target.credentialsRoot)
      for (;;) {
        const requested = [...wanted]
        const refetchesUnlistedVersion = lastGood !== undefined && omitsVersionInUse(lastGood, requested)
        if (refetchesUnlistedVersion) refetchedForUnlistedVersion.add(target.key)
        const validatorCandidate = refetchesUnlistedVersion ? undefined : lastGood
        const fetched = await fetchUnlessCredentialsRejected(target, requested, validatorCandidate, authorizationFor, pass)
        if ('failure' in fetched) {
          registryStore.fail(target.key, fetched.failure, lastGood)
          return
        }
        await storeRegistry(target, fetched.record)
        const refetchNeeded =
          missesVersionsAddedMeanwhile(fetched.record, requested, wanted) ||
          awaitsRefetchForUnlistedVersion(target.key, fetched.record, [...wanted])
        if (!refetchNeeded) return
        lastGood = fetched.record
      }
    } catch (error) {
      registryStore.fail(target.key, failureReason(error), lastGood)
    } finally {
      registryStore.release(target.key)
      versionsWantedInFlight.delete(target.key)
    }
  }

  function addVersionsToFetchesInFlight(plan: KeyPlan): void {
    for (const target of plan.registry.values()) {
      const wanted = versionsWantedInFlight.get(target.key)
      if (wanted === undefined) continue
      for (const version of target.versionsInUse) wanted.add(version)
    }
  }

  async function queryUnresolved(unresolved: readonly UnresolvedVersion[]): Promise<void> {
    if (unresolved.length === 0) return
    let outcome: BatchOutcome
    try {
      outcome = await queryVersions(http, osvUrl, unresolved.map(({ target }) => ({ name: target.name, version: target.version })))
    } catch (error) {
      const reason = failureReason(error)
      outcome = { matches: new Map(), failed: new Map(unresolved.map(({ target }) => [target.key, reason])) }
    }
    const fetchedAt = nowIso()
    const writes = unresolved.map(({ target, lastGood }) => {
      const vulns = outcome.matches.get(target.key)
      if (vulns === undefined) {
        matchStore.fail(target.key, outcome.failed.get(target.key) ?? MISSING_OSV_RESULT, lastGood)
        return undefined
      }
      const record: CachedMatch = { state: 'ok', vulns, fetchedAt }
      matchStore.succeed(target.key, record)
      return cache.write('osv-matches', [target.key], record)
    })
    await Promise.all(writes)
  }

  async function resolveVersionTargets(targets: readonly VersionTarget[], pass: Pass): Promise<void> {
    try {
      const unresolved: UnresolvedVersion[] = []
      await Promise.all(
        targets.map(async (target) => {
          const cached = await cache.read('osv-matches', [target.key], isCachedMatch)
          if (cached !== undefined && !pass.forceExpired && isFreshNow(cached.fetchedAt)) matchStore.succeed(target.key, cached)
          else unresolved.push({ target, lastGood: cached ?? matchStore.lastGoodOf(target.key) })
        }),
      )
      await queryUnresolved(unresolved)
    } finally {
      for (const target of targets) matchStore.release(target.key)
    }
  }

  function reportedVulnsByName(plan: KeyPlan): Map<string, VulnRef[]> {
    const reported = new Map<string, VulnRef[]>()
    for (const target of plan.versions.values()) {
      const state = matchStore.stateOf(target.key)
      if (state === undefined || (state.state !== 'ok' && state.state !== 'stale') || state.vulns.length === 0) continue
      const refs = reported.get(target.name) ?? []
      refs.push(...state.vulns)
      reported.set(target.name, refs)
    }
    return reported
  }

  async function resolveAdvisoriesTarget(target: AdvisoryTarget, pass: Pass): Promise<void> {
    let lastGood: CachedAdvisories | undefined
    try {
      const cached = await cache.read('osv-packages', [target.key], isCachedAdvisories)
      if (cached !== undefined && !pass.forceExpired && advisoriesUsable(cached, target.reported)) {
        advisoriesStore.succeed(target.key, cached)
        return
      }
      lastGood = cached ?? advisoriesStore.lastGoodOf(target.key)
      const result = await limitPackageQueries(() => queryPackageAdvisories(http, osvUrl, target.key))
      if (result.state === 'failed') {
        advisoriesStore.fail(target.key, result.reason, lastGood)
        return
      }
      const record: CachedAdvisories = { fetchedAt: nowIso(), advisories: result.advisories }
      advisoriesStore.succeed(target.key, record)
      await cache.write('osv-packages', [target.key], record)
    } catch (error) {
      advisoriesStore.fail(target.key, failureReason(error), lastGood)
    } finally {
      advisoriesStore.release(target.key)
    }
  }

  async function resolveOsv(targets: readonly VersionTarget[], pass: Pass): Promise<void> {
    await resolveVersionTargets(targets, pass)
    const advisoryTargets = advisoriesStore.claim(
      [...reportedVulnsByName(pass.plan)].map(([key, reported]) => ({ key, reported })),
      (target) => !pass.forceExpired && advisoriesStore.isKnown(target.key, (record) => advisoriesUsable(record, target.reported)),
    )
    await Promise.all(advisoryTargets.map((target) => resolveAdvisoriesTarget(target, pass)))
  }

  function onlineWork(pass: Pass): Promise<unknown>[] {
    const { plan, forceExpired } = pass
    addVersionsToFetchesInFlight(plan)
    const registryTargets = registryStore.claim(
      plan.registry.values(),
      (target) => !forceExpired && registryStore.isKnown(target.key, (record) => registryRecordUsable(target.key, record, [...target.versionsInUse])),
    )
    const work: Promise<unknown>[] = registryTargets.map((target) => resolveRegistryTarget(target, pass))
    if (plan.waitsForScanningRoots) return work
    const versionTargets = matchStore.claim(
      plan.versions.values(),
      (target) => !forceExpired && matchStore.isKnown(target.key, (record) => isFreshNow(record.fetchedAt)),
    )
    return [...work, resolveOsv(versionTargets, pass)]
  }

  function runPass(roots: readonly RootGraph[], forceExpired: boolean): void {
    const plan = planKeys(roots, currentPlan.privateScopes)
    const pass: Pass = { plan, forceExpired, rejectedCredentials: new Map() }
    const credentialReads = plan.roots.map(credentialsOf)
    if (!offline) currentPlan = plan
    const work = Promise.allSettled([...credentialReads, ...(offline ? [] : onlineWork(pass))])
    const running: Promise<unknown> = work.finally(() => {
      activePasses.delete(running)
      if (activePasses.size > 0) return
      revisions.drained()
      finishedAt = nowIso()
    })
    activePasses.add(running)
  }

  function matchOfVersion(name: string, version: string): MatchState {
    if (offline) return OFFLINE
    if (inPrivateScope(name, currentPlan.privateScopes)) return PRIVATE_SCOPE_SKIP
    const state = matchStore.stateOf(versionKey(name, version))
    if (state !== undefined) return state
    return hasKnownVersion(version) ? PENDING : UNKNOWN_VERSION_SKIP
  }

  function onlineStatus(anyRootScanning: boolean): EnrichmentStatus {
    const running = activePasses.size > 0 || anyRootScanning
    const osv = progressOf(currentPlan.versions.keys(), matchStore)
    return {
      state: running ? 'running' : 'done',
      revision: revisions.current,
      registry: progressOf(currentPlan.registry.keys(), registryStore),
      osv: { total: osv.total, done: osv.done, skipped: currentPlan.skippedVersions, failed: osv.failed },
      problems: problemsOf(currentPlan, {
        registry: registryStore,
        matches: matchStore,
        advisories: advisoriesStore,
        osvUrl,
        secrets,
      }),
      ...(running || finishedAt === undefined ? {} : { finishedAt }),
    }
  }

  const onDemand = createOnDemandLookups({
    http,
    osvUrl,
    offline,
    cache,
    now,
    credentialsOf,
    registryLimiterOf,
    limitPackageQueries,
    privateScopes: () => currentPlan.privateScopes,
    storedMatchOf: matchStore.stateOf,
    storedAdvisoriesOf: advisoriesStore.stateOf,
  })

  return {
    get revision() {
      return revisions.current
    },
    registryOf(root, node) {
      if (!isRegistryPackage(node)) return NOT_APPLICABLE
      if (offline) return OFFLINE
      if (root.config === undefined) return PENDING
      return registryStore.stateOf(registryKeyOf(registryUrlOf(root.config, node.name), node.name)) ?? PENDING
    },
    matchOf(_root, node) {
      if (isRegistryPackage(node)) return matchOfVersion(node.name, node.version)
      return isPlaceholder(node) ? NOT_APPLICABLE : NON_REGISTRY_SKIP
    },
    matchOfVersion,
    advisoriesOf(name) {
      return advisoriesStore.stateOf(name) ?? PENDING
    },
    track(roots) {
      if (closed) return
      trackedRoots = roots
      runPass(roots, false)
    },
    refresh() {
      if (closed) return
      credentialsByRootPath.clear()
      runPass(trackedRoots, true)
    },
    status(anyRootScanning) {
      return offline ? offlineStatus(revisions.current) : onlineStatus(anyRootScanning)
    },
    async settled() {
      while (activePasses.size > 0) await Promise.all(activePasses)
    },
    close() {
      closed = true
      options.abort?.abort()
    },
    publishedVersions: onDemand.publishedVersions,
    assess: onDemand.assess,
  }
}

export function offlineEnrichment(): EnrichmentService {
  return createEnrichmentService({
    reader: EMPTY_READER,
    env: {},
    userNpmrc: null,
    http: NO_NETWORK,
    osvUrl: OSV_DEFAULT_URL,
    cache: null,
    secrets: createSecretSet(),
    offline: true,
  })
}
