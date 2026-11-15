import type { RootGraph } from '../model.ts'
import { advisoriesOfMatch, worstSeverity } from '../query/enrichment-lookup.ts'
import type { RegistryCredentials } from './credentials.ts'
import { isFresh } from './enrichment-cache.ts'
import { hasKnownVersion, inPrivateScope, registryKeyOf, registryUrlOf, type TrackableRoot } from './enrichment-keys.ts'
import type { EnrichmentService } from './enrichment-service.ts'
import {
  ADVISORIES_VIEWS,
  advisoriesCover,
  isCachedAdvisories,
  isCachedMatch,
  isCachedRegistry,
  registryOk,
  type CacheAccess,
  type CachedMatch,
  type CachedRegistry,
  type Limiter,
} from './enrichment-store.ts'
import type { HttpClient } from './http.ts'
import { queryPackageAdvisories, queryVersions, versionKey, type BatchOutcome, type VersionQuery } from './osv-client.ts'
import { failureReason, fetchPackageMeta } from './registry-client.ts'
import type { AdvisoriesState, AssessedPackage, EnrichmentView, MatchState, PublishedVersions, VulnRef } from './types.ts'

export type OnDemandDependencies = {
  http: HttpClient
  osvUrl: string
  offline: boolean
  cache: CacheAccess
  now: () => number
  credentialsOf(root: TrackableRoot): Promise<RegistryCredentials>
  registryLimiterOf(registryUrl: string): Limiter
  limitPackageQueries: Limiter
  privateScopes(): ReadonlySet<string>
  storedMatchOf(key: string): MatchState | undefined
  storedAdvisoriesOf(name: string): AdvisoriesState | undefined
}

export type OnDemandLookups = Pick<EnrichmentService, 'publishedVersions' | 'assess'>

type VersionsTarget = { key: string; registryUrl: string; name: string; root: TrackableRoot }
type FetchedVersions = { record: CachedRegistry } | { failure: string }
type MatchedState = Extract<MatchState, { vulns: VulnRef[] }>
type Findings = { matches: Map<string, MatchState>; view: Pick<EnrichmentView, 'advisoriesOf'> }

const OFFLINE_REASON = 'deptrail was started with --offline'
const NOT_SCANNED_REASON = 'the root is not scanned'
const NOT_FOUND_REASON = 'not found in the registry'
const NOT_MODIFIED_WITHOUT_VALIDATOR = 'responded with HTTP 304'
const MISSING_OSV_RESULT = 'returned a malformed response'
const PRIVATE_SCOPE_NOTE = 'private scope'
const UNKNOWN_VERSION_NOTE = 'unknown version'
const OSV_LABEL = 'OSV'
const PENDING = { state: 'pending' } as const

function isConfigured(root: RootGraph): root is TrackableRoot {
  return root.config !== undefined
}

function isMatched(state: MatchState | undefined): state is MatchedState {
  return state?.state === 'ok' || state?.state === 'stale'
}

function publishedOf(record: CachedRegistry): PublishedVersions {
  return record.state === 'ok' ? { state: 'ok', meta: record.meta } : { state: 'failed', reason: NOT_FOUND_REASON }
}

function failedOrExpired(reason: string, expired: CachedRegistry | undefined): PublishedVersions {
  return expired?.state === 'ok' ? { state: 'ok', meta: expired.meta } : { state: 'failed', reason }
}

function distinctQueries(packages: readonly VersionQuery[]): VersionQuery[] {
  const byKey = new Map<string, VersionQuery>()
  for (const { name, version } of packages) {
    const key = versionKey(name, version)
    if (!byKey.has(key)) byKey.set(key, { name, version })
  }
  return [...byKey.values()]
}

function skipNoteOf(target: VersionQuery, privateScopes: ReadonlySet<string>): string | undefined {
  if (inPrivateScope(target.name, privateScopes)) return PRIVATE_SCOPE_NOTE
  return hasKnownVersion(target.version) ? undefined : UNKNOWN_VERSION_NOTE
}

function failedBatch(queries: readonly VersionQuery[], reason: string): BatchOutcome {
  return { matches: new Map(), failed: new Map(queries.map(({ name, version }) => [versionKey(name, version), reason])) }
}

function reportedByName(targets: readonly VersionQuery[], matches: Map<string, MatchState>): Map<string, VulnRef[]> {
  const reported = new Map<string, VulnRef[]>()
  for (const { name, version } of targets) {
    const match = matches.get(versionKey(name, version))
    if (!isMatched(match) || match.vulns.length === 0) continue
    reported.set(name, [...(reported.get(name) ?? []), ...match.vulns])
  }
  return reported
}

function unmatchedNote(match: MatchState | undefined): string {
  return `${OSV_LABEL} ${match?.state === 'failed' ? match.reason : MISSING_OSV_RESULT}`
}

function vulnerabilityFields(target: VersionQuery, findings: Findings): Pick<AssessedPackage, 'severity' | 'vulnIds' | 'notChecked'> {
  const match = findings.matches.get(versionKey(target.name, target.version))
  if (!isMatched(match)) return { vulnIds: [], notChecked: unmatchedNote(match) }
  const advisories = advisoriesOfMatch(findings.view, target.name, match)
  const severity = worstSeverity(advisories.map((advisory) => advisory.severity))
  return { vulnIds: advisories.map((advisory) => advisory.id), ...(severity === undefined ? {} : { severity }) }
}

export function createOnDemandLookups(dependencies: OnDemandDependencies): OnDemandLookups {
  const { http, osvUrl, offline, cache, now } = dependencies
  const versionsRecords = new Map<string, CachedRegistry>()
  const versionsLoads = new Map<string, Promise<PublishedVersions>>()

  const nowIso = () => new Date(now()).toISOString()
  const isFreshNow = (fetchedAt: string) => isFresh(fetchedAt, now())

  async function fetchVersionsRecord(target: VersionsTarget, known: CachedRegistry | undefined): Promise<FetchedVersions> {
    const validator = known?.state === 'ok' ? known : undefined
    const { authorizationFor } = await dependencies.credentialsOf(target.root)
    const result = await dependencies.registryLimiterOf(target.registryUrl)(() =>
      fetchPackageMeta(http, {
        registry: target.registryUrl,
        name: target.name,
        etag: validator?.etag,
        versionsInUse: [],
        allManifests: true,
        authorizationFor,
      }),
    )
    const fetchedAt = nowIso()
    if (result.state === 'ok') return { record: registryOk(result.meta, fetchedAt, result.etag) }
    if (result.state === 'not-found') return { record: { state: 'not-found', fetchedAt } }
    if (result.state === 'not-modified' && validator !== undefined) {
      return { record: registryOk(validator.meta, fetchedAt, validator.etag) }
    }
    return { failure: result.state === 'failed' ? result.reason : NOT_MODIFIED_WITHOUT_VALIDATOR }
  }

  async function loadVersions(target: VersionsTarget): Promise<PublishedVersions> {
    const keyParts = [target.registryUrl, target.name]
    let known = versionsRecords.get(target.key)
    try {
      const cached = await cache.read('registry-versions', keyParts, isCachedRegistry)
      if (cached !== undefined && isFreshNow(cached.fetchedAt)) {
        versionsRecords.set(target.key, cached)
        return publishedOf(cached)
      }
      known = cached ?? known
      const fetched = await fetchVersionsRecord(target, known)
      if ('failure' in fetched) return failedOrExpired(fetched.failure, known)
      versionsRecords.set(target.key, fetched.record)
      await cache.write('registry-versions', keyParts, fetched.record)
      return publishedOf(fetched.record)
    } catch (error) {
      return failedOrExpired(failureReason(error), known)
    }
  }

  async function publishedVersions(root: RootGraph, name: string): Promise<PublishedVersions> {
    if (offline) return { state: 'failed', reason: OFFLINE_REASON }
    if (!isConfigured(root)) return { state: 'failed', reason: NOT_SCANNED_REASON }
    const registryUrl = registryUrlOf(root.config, name)
    const key = registryKeyOf(registryUrl, name)
    const remembered = versionsRecords.get(key)
    if (remembered !== undefined && isFreshNow(remembered.fetchedAt)) return publishedOf(remembered)
    const loading = versionsLoads.get(key)
    if (loading !== undefined) return loading
    const load = loadVersions({ key, registryUrl, name, root }).finally(() => versionsLoads.delete(key))
    versionsLoads.set(key, load)
    return load
  }

  async function queryMatches(unresolved: readonly VersionQuery[], matches: Map<string, MatchState>): Promise<void> {
    if (unresolved.length === 0) return
    const outcome = await queryVersions(http, osvUrl, unresolved).catch((error: unknown) => failedBatch(unresolved, failureReason(error)))
    const fetchedAt = nowIso()
    const writes = unresolved.map(({ name, version }) => {
      const key = versionKey(name, version)
      const vulns = outcome.matches.get(key)
      if (vulns === undefined) {
        matches.set(key, { state: 'failed', reason: outcome.failed.get(key) ?? MISSING_OSV_RESULT })
        return undefined
      }
      const record: CachedMatch = { state: 'ok', vulns, fetchedAt }
      matches.set(key, record)
      return cache.write('osv-matches', [key], record)
    })
    await Promise.all(writes)
  }

  async function matchesOf(targets: readonly VersionQuery[]): Promise<Map<string, MatchState>> {
    const matches = new Map<string, MatchState>()
    await Promise.all(
      targets.map(async ({ name, version }) => {
        const key = versionKey(name, version)
        const stored = dependencies.storedMatchOf(key)
        if (isMatched(stored)) {
          matches.set(key, stored)
          return
        }
        const cached = await cache.read('osv-matches', [key], isCachedMatch)
        if (cached !== undefined && isFreshNow(cached.fetchedAt)) matches.set(key, cached)
      }),
    )
    await queryMatches(targets.filter(({ name, version }) => !matches.has(versionKey(name, version))), matches)
    return matches
  }

  async function advisoriesOf(name: string, reported: readonly VulnRef[]): Promise<AdvisoriesState> {
    const stored = dependencies.storedAdvisoriesOf(name)
    if ((stored?.state === 'ok' || stored?.state === 'stale') && advisoriesCover(stored.advisories, reported)) return stored
    const cached = await cache.read('osv-packages', [name], isCachedAdvisories)
    if (cached !== undefined && isFreshNow(cached.fetchedAt) && advisoriesCover(cached.advisories, reported)) {
      return ADVISORIES_VIEWS.ofSuccess(cached)
    }
    const result = await dependencies
      .limitPackageQueries(() => queryPackageAdvisories(http, osvUrl, name))
      .catch((error: unknown) => ({ state: 'failed' as const, reason: failureReason(error) }))
    if (result.state === 'failed') return ADVISORIES_VIEWS.ofFailure(result.reason, undefined)
    const record = { fetchedAt: nowIso(), advisories: result.advisories }
    await cache.write('osv-packages', [name], record)
    return ADVISORIES_VIEWS.ofSuccess(record)
  }

  async function findingsOf(targets: readonly VersionQuery[]): Promise<Findings> {
    const matches = await matchesOf(targets)
    const loaded = await Promise.all(
      [...reportedByName(targets, matches)].map(async ([name, reported]) => [name, await advisoriesOf(name, reported)] as const),
    )
    const advisoriesByName = new Map<string, AdvisoriesState>(loaded)
    return { matches, view: { advisoriesOf: (name) => advisoriesByName.get(name) ?? PENDING } }
  }

  async function deprecationsOf(root: RootGraph, targets: readonly VersionQuery[]): Promise<Map<string, string>> {
    const known = targets.filter(({ version }) => hasKnownVersion(version))
    const names = [...new Set(known.map(({ name }) => name))]
    const published = new Map(await Promise.all(names.map(async (name) => [name, await publishedVersions(root, name)] as const)))
    const deprecations = new Map<string, string>()
    for (const { name, version } of known) {
      const loaded = published.get(name)
      const message = loaded?.state === 'ok' ? loaded.meta.deprecated[version] : undefined
      if (message !== undefined) deprecations.set(versionKey(name, version), message)
    }
    return deprecations
  }

  async function assess(root: RootGraph, packages: readonly VersionQuery[]): Promise<AssessedPackage[]> {
    const targets = distinctQueries(packages)
    const privateScopes = new Set([...dependencies.privateScopes(), ...Object.keys(root.config?.scopedRegistries ?? {})])
    if (offline) {
      return targets.map((target) => ({ ...target, vulnIds: [], notChecked: skipNoteOf(target, privateScopes) ?? OFFLINE_REASON }))
    }
    const checked = targets.filter((target) => skipNoteOf(target, privateScopes) === undefined)
    const [findings, deprecations] = await Promise.all([findingsOf(checked), deprecationsOf(root, targets)])
    return targets.map((target) => {
      const skipNote = skipNoteOf(target, privateScopes)
      const deprecated = deprecations.get(versionKey(target.name, target.version))
      return {
        ...target,
        ...(skipNote === undefined ? vulnerabilityFields(target, findings) : { vulnIds: [], notChecked: skipNote }),
        ...(deprecated === undefined ? {} : { deprecated }),
      }
    })
  }

  return { publishedVersions, assess }
}
