import type { EnrichmentCache, EnrichmentCacheKind } from './enrichment-cache.ts'
import { isPackageMeta } from './registry-client.ts'
import type { Advisory, AdvisoriesState, MatchState, PackageMeta, RegistryState, VulnRef } from './types.ts'

export type CachedRegistry =
  | { state: 'ok'; meta: PackageMeta; fetchedAt: string; etag?: string }
  | { state: 'not-found'; fetchedAt: string }
export type CachedMatch = { state: 'ok'; vulns: VulnRef[]; fetchedAt: string }
export type CachedAdvisories = { fetchedAt: string; advisories: Advisory[] }

export type StateViews<Cached, State> = {
  ofSuccess(record: Cached): State
  ofFailure(reason: string, lastGood: Cached | undefined): State
}

export type RecordStore<Cached, State> = {
  stateOf(key: string): State | undefined
  settledStateOf(key: string): State | undefined
  settledFailureOf(key: string): string | undefined
  lastGoodOf(key: string): Cached | undefined
  isKnown(key: string, usable: (record: Cached) => boolean): boolean
  claim<Target extends { key: string }>(targets: Iterable<Target>, isKnown: (target: Target) => boolean): Target[]
  release(key: string): void
  succeed(key: string, record: Cached): void
  fail(key: string, reason: string, lastGood: Cached | undefined): void
}

export type CacheAccess = {
  read<Shape>(kind: EnrichmentCacheKind, keyParts: readonly string[], isShape: (value: unknown) => value is Shape): Promise<Shape | undefined>
  write(kind: EnrichmentCacheKind, keyParts: readonly string[], value: unknown): Promise<void>
}

export type Limiter = <Result>(task: () => Promise<Result>) => Promise<Result>

type StoreEntry<Cached, State> = { state: State; lastGood?: Cached; failure?: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registryOk(meta: PackageMeta, fetchedAt: string, etag: string | undefined): CachedRegistry {
  return etag === undefined ? { state: 'ok', meta, fetchedAt } : { state: 'ok', meta, fetchedAt, etag }
}

export function isCachedRegistry(value: unknown): value is CachedRegistry {
  if (!isPlainObject(value) || typeof value.fetchedAt !== 'string') return false
  if (value.state === 'not-found') return true
  return value.state === 'ok' && isPackageMeta(value.meta) && (value.etag === undefined || typeof value.etag === 'string')
}

function isVulnRef(value: unknown): value is VulnRef {
  return isPlainObject(value) && typeof value.id === 'string' && typeof value.modified === 'string'
}

export function isCachedMatch(value: unknown): value is CachedMatch {
  return (
    isPlainObject(value) &&
    value.state === 'ok' &&
    typeof value.fetchedAt === 'string' &&
    Array.isArray(value.vulns) &&
    value.vulns.every(isVulnRef)
  )
}

function isAdvisory(value: unknown): value is Advisory {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.severity === 'string' &&
    typeof value.malicious === 'boolean' &&
    typeof value.url === 'string' &&
    typeof value.modified === 'string' &&
    Array.isArray(value.aliases) &&
    Array.isArray(value.fixedIn) &&
    Array.isArray(value.affected)
  )
}

export function isCachedAdvisories(value: unknown): value is CachedAdvisories {
  return (
    isPlainObject(value) &&
    typeof value.fetchedAt === 'string' &&
    Array.isArray(value.advisories) &&
    value.advisories.every(isAdvisory)
  )
}

function coversReport(advisory: Advisory, reported: VulnRef): boolean {
  if (advisory.aliases.includes(reported.id)) return true
  return advisory.id === reported.id && !(Date.parse(reported.modified) > Date.parse(advisory.modified))
}

export function advisoriesCover(advisories: readonly Advisory[], reported: readonly VulnRef[]): boolean {
  return reported.every((ref) => advisories.some((advisory) => coversReport(advisory, ref)))
}

export const REGISTRY_VIEWS: StateViews<CachedRegistry, RegistryState> = {
  ofSuccess: (record) =>
    record.state === 'ok'
      ? { state: 'ok', meta: record.meta, fetchedAt: record.fetchedAt }
      : { state: 'not-found', fetchedAt: record.fetchedAt },
  ofFailure: (reason, lastGood) =>
    lastGood?.state === 'ok'
      ? { state: 'stale', meta: lastGood.meta, fetchedAt: lastGood.fetchedAt }
      : { state: 'failed', reason },
}

export const MATCH_VIEWS: StateViews<CachedMatch, MatchState> = {
  ofSuccess: ({ vulns, fetchedAt }) => ({ state: 'ok', vulns, fetchedAt }),
  ofFailure: (reason, lastGood) =>
    lastGood === undefined ? { state: 'failed', reason } : { state: 'stale', vulns: lastGood.vulns, fetchedAt: lastGood.fetchedAt },
}

export const ADVISORIES_VIEWS: StateViews<CachedAdvisories, AdvisoriesState> = {
  ofSuccess: ({ advisories, fetchedAt }) => ({ state: 'ok', advisories, fetchedAt }),
  ofFailure: (reason, lastGood) =>
    lastGood === undefined
      ? { state: 'failed', reason }
      : { state: 'stale', advisories: lastGood.advisories, fetchedAt: lastGood.fetchedAt },
}

export function createRecordStore<Cached, State>(views: StateViews<Cached, State>, onLanded: () => void): RecordStore<Cached, State> {
  const entries = new Map<string, StoreEntry<Cached, State>>()
  const inFlight = new Set<string>()
  return {
    stateOf: (key) => entries.get(key)?.state,
    settledStateOf: (key) => (inFlight.has(key) ? undefined : entries.get(key)?.state),
    settledFailureOf: (key) => (inFlight.has(key) ? undefined : entries.get(key)?.failure),
    lastGoodOf: (key) => entries.get(key)?.lastGood,
    isKnown(key, usable) {
      const entry = entries.get(key)
      if (entry === undefined) return false
      if (entry.failure !== undefined) return true
      return entry.lastGood !== undefined && usable(entry.lastGood)
    },
    claim<Target extends { key: string }>(targets: Iterable<Target>, isKnown: (target: Target) => boolean): Target[] {
      const claimed: Target[] = []
      for (const target of targets) {
        if (inFlight.has(target.key) || isKnown(target)) continue
        inFlight.add(target.key)
        claimed.push(target)
      }
      return claimed
    },
    release: (key) => {
      inFlight.delete(key)
    },
    succeed(key, record) {
      entries.set(key, { state: views.ofSuccess(record), lastGood: record })
      onLanded()
    },
    fail(key, reason, lastGood) {
      entries.set(key, { state: views.ofFailure(reason, lastGood), lastGood, failure: reason })
      onLanded()
    },
  }
}

export function createLimiter(limit: number): Limiter {
  let active = 0
  const waiting: Array<() => void> = []
  return async function limited<Result>(task: () => Promise<Result>): Promise<Result> {
    if (active < limit) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

export function createCacheAccess(cache: EnrichmentCache | null, concurrency: number): CacheAccess {
  const limited = createLimiter(concurrency)
  return {
    async read(kind, keyParts, isShape) {
      if (cache === null) return undefined
      const value = await limited(() => cache.read(kind, keyParts)).catch(() => null)
      return isShape(value) ? value : undefined
    },
    async write(kind, keyParts, value) {
      if (cache === null) return
      await limited(() => cache.write(kind, keyParts, value)).catch(() => undefined)
    },
  }
}
