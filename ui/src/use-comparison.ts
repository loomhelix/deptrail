import { onScopeDispose, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import type { CompareResponse } from '../../src/query/compare-shape.ts'
import { ApiError, type DeptrailApi } from './api.ts'
import { sourceKey, WORKING_KEY, type ShownSource } from './source.ts'

export type MergeBaseState = { state: 'off' } | { state: 'pending' } | { state: 'found'; commit: string } | { state: 'none' }
export type ComparisonState = { status: 'loading' | 'ready' | 'error'; response?: CompareResponse; mergeBase: MergeBaseState; error?: string }

export type ComparisonInputs = {
  target: ShownSource
  base: Ref<string>
  mergeBase: Ref<boolean>
  enrichmentRevision: Ref<number>
  active: Ref<boolean>
  pollMs?: number
}

type ComparisonApi = Pick<DeptrailApi, 'openSource' | 'compare'>
type ResolvedBase = { key: string; mergeBase: MergeBaseState }

const DEFAULT_POLL_MS = 1000
const NOT_FOUND = 404
const CONFLICT = 409
const UNKNOWN_SOURCE_PREFIX = 'Unknown source '

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status
}

function namesSource(error: unknown, key: string): boolean {
  return error instanceof ApiError && error.message === `${UNKNOWN_SOURCE_PREFIX}${key}`
}

function isSettling(response: CompareResponse): boolean {
  return !response.complete || response.roots.some((root) => root.riskPending > 0)
}

export function useComparison(api: ComparisonApi, inputs: ComparisonInputs): { state: ShallowRef<ComparisonState> } {
  const targetKey = sourceKey(inputs.target)
  const pollMs = inputs.pollMs ?? DEFAULT_POLL_MS
  const state = shallowRef<ComparisonState>({ status: 'loading', mergeBase: { state: 'off' } })
  let generation = 0
  let resolved: ResolvedBase | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined

  function stopPolling(): void {
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    pollTimer = undefined
  }

  async function resolveBase(): Promise<ResolvedBase> {
    const base = inputs.base.value
    const baseKey = base === WORKING_KEY ? WORKING_KEY : (await api.openSource({ ref: base })).key
    if (!inputs.mergeBase.value) return { key: baseKey, mergeBase: { state: 'off' } }
    try {
      const opened = await api.openSource({ mergeBase: { base: baseKey, target: targetKey } })
      return { key: opened.key, mergeBase: { state: 'found', commit: opened.commit } }
    } catch (error) {
      if (isStatus(error, CONFLICT)) return { key: baseKey, mergeBase: { state: 'none' } }
      throw error
    }
  }

  async function compareResolved(run: number, base: ResolvedBase): Promise<void> {
    const response = await api.compare(base.key, targetKey)
    if (run !== generation) return
    state.value = { status: 'ready', response, mergeBase: base.mergeBase }
    stopPolling()
    if (isSettling(response)) pollTimer = setTimeout(() => void refresh(run), pollMs)
  }

  async function fetchWithReopen(run: number, reopen: boolean): Promise<void> {
    try {
      if (resolved === undefined || reopen) {
        const base = await resolveBase()
        if (run !== generation) return
        resolved = base
      }
      await compareResolved(run, resolved)
    } catch (error) {
      if (run !== generation) return
      if (!reopen && isStatus(error, NOT_FOUND) && !namesSource(error, targetKey)) {
        await fetchWithReopen(run, true)
        return
      }
      state.value = { status: 'error', mergeBase: state.value.mergeBase, error: messageOf(error) }
    }
  }

  function refresh(run: number): Promise<void> {
    if (run !== generation || !inputs.active.value) return Promise.resolve()
    return fetchWithReopen(run, false)
  }

  function restart(): void {
    stopPolling()
    if (!inputs.active.value) return
    const run = ++generation
    resolved = undefined
    state.value = { status: 'loading', mergeBase: inputs.mergeBase.value ? { state: 'pending' } : { state: 'off' } }
    void fetchWithReopen(run, false)
  }

  watch([inputs.base, inputs.mergeBase, inputs.active], restart, { immediate: true })
  watch(inputs.enrichmentRevision, () => {
    if (state.value.status === 'ready') void refresh(generation)
  })
  onScopeDispose(() => {
    generation += 1
    stopPolling()
  })

  return { state }
}
