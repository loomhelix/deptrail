import type { SecretSet } from '../config/secrets.ts'
import type { KeyPlan } from './enrichment-keys.ts'
import type { RecordStore } from './enrichment-store.ts'
import type { AdvisoriesState, EnrichmentProblem, EnrichmentStatus, MatchState, RegistryState } from './types.ts'

export type Progress = { total: number; done: number; failed: number }
export type RevisionCounter = { readonly current: number; resultLanded(): void; drained(): void }
export type ProblemSources = {
  registry: RecordStore<unknown, RegistryState>
  matches: RecordStore<unknown, MatchState>
  advisories: RecordStore<unknown, AdvisoriesState>
  osvUrl: string
  secrets: SecretSet
}

const UNPARSABLE_ORIGIN = 'invalid URL'
const GROUP_KEY_SEPARATOR = '\0'

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return UNPARSABLE_ORIGIN
  }
}

export function offlineStatus(revision: number): EnrichmentStatus {
  return {
    state: 'offline',
    revision,
    registry: { total: 0, done: 0, failed: 0 },
    osv: { total: 0, done: 0, skipped: 0, failed: 0 },
    problems: [],
  }
}

export function progressOf<State extends { state: string }>(keys: Iterable<string>, store: RecordStore<unknown, State>): Progress {
  const progress: Progress = { total: 0, done: 0, failed: 0 }
  for (const key of keys) {
    progress.total++
    const state = store.settledStateOf(key)
    if (state === undefined) continue
    progress.done++
    if (state.state === 'failed') progress.failed++
  }
  return progress
}

export function problemsOf(plan: KeyPlan, sources: ProblemSources): EnrichmentProblem[] {
  const groups = new Map<string, EnrichmentProblem>()
  const count = (source: EnrichmentProblem['source'], origin: string, failure: string | undefined) => {
    if (failure === undefined) return
    const groupKey = [source, origin, failure].join(GROUP_KEY_SEPARATOR)
    const group = groups.get(groupKey) ?? { source, origin, message: sources.secrets.redact(failure), count: 0 }
    group.count++
    groups.set(groupKey, group)
  }
  for (const target of plan.registry.values()) {
    const failure = sources.registry.settledFailureOf(target.key)
    if (failure !== undefined) count('registry', originOf(target.registryUrl), failure)
  }
  const osvOrigin = originOf(sources.osvUrl)
  for (const key of plan.versions.keys()) count('osv', osvOrigin, sources.matches.settledFailureOf(key))
  for (const name of new Set([...plan.versions.values()].map((target) => target.name))) {
    count('osv', osvOrigin, sources.advisories.settledFailureOf(name))
  }
  return [...groups.values()]
}

export function createRevisionCounter(intervalMs: number): RevisionCounter {
  let revision = 0
  let landedSinceIncrement = false
  let throttle: NodeJS.Timeout | undefined

  function increment(): void {
    revision++
    landedSinceIncrement = false
    throttle = setTimeout(() => {
      throttle = undefined
      if (landedSinceIncrement) increment()
    }, intervalMs)
    throttle.unref()
  }

  return {
    get current() {
      return revision
    },
    resultLanded() {
      landedSinceIncrement = true
      if (throttle === undefined) increment()
    },
    drained() {
      clearTimeout(throttle)
      throttle = undefined
      landedSinceIncrement = false
      revision++
    },
  }
}
