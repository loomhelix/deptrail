import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import type { CompareResponse } from '../src/query/compare-shape.ts'
import { ApiError, type DeptrailApi, type OpenSourceRequest } from '../ui/src/api.ts'
import type { ShownSource } from '../ui/src/source.ts'
import { useComparison } from '../ui/src/use-comparison.ts'

const TARGET = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MERGE = 'c'.repeat(40)
const TARGET_SOURCE: ShownSource = { kind: 'commit', ref: 'refs/heads/fix', commit: TARGET }

type Calls = { opened: OpenSourceRequest[]; compared: [string, string][] }
type Fakes = { open?: (request: OpenSourceRequest) => Promise<{ key: string; commit: string }>; compare?: (call: number) => Promise<CompareResponse> }

const COMPLETE: CompareResponse = { revision: 1, complete: true, roots: [] }
const EMPTY_ROOT: CompareResponse['roots'][number] = {
  rootId: 'shop',
  presence: 'both',
  state: 'ready',
  notes: [],
  exact: true,
  versions: [],
  directs: [],
  importers: [],
  risk: [],
  riskPending: 0,
}

async function settle(times = 3): Promise<void> {
  for (let round = 0; round < times; round++) {
    await nextTick()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function setup(base: string, mergeBase: boolean, fakes: Fakes = {}) {
  const calls: Calls = { opened: [], compared: [] }
  const api = {
    openSource: async (request: OpenSourceRequest) => {
      calls.opened.push(request)
      if (fakes.open) return fakes.open(request)
      return 'ref' in request ? { key: BASE, commit: BASE } : { key: MERGE, commit: MERGE }
    },
    compare: async (left: string, right: string) => {
      calls.compared.push([left, right])
      return fakes.compare ? fakes.compare(calls.compared.length) : COMPLETE
    },
  } as unknown as Pick<DeptrailApi, 'openSource' | 'compare'>
  const inputs = { target: TARGET_SOURCE, base: ref(base), mergeBase: ref(mergeBase), enrichmentRevision: ref(1), active: ref(true), pollMs: 5 }
  const scope = effectScope()
  const comparison = scope.run(() => useComparison(api, inputs))!
  return { calls, inputs, comparison, scope }
}

describe('useComparison', () => {
  it('compares the working copy without opening', async () => {
    const { calls, comparison, scope } = setup('work', false)
    await settle()
    assert.deepEqual(calls.opened, [])
    assert.deepEqual(calls.compared, [['work', TARGET]])
    assert.equal(comparison.state.value.status, 'ready')
    assert.deepEqual(comparison.state.value.mergeBase, { state: 'off' })
    scope.stop()
  })

  it('opens a branch base', async () => {
    const { calls, comparison, scope } = setup('refs/heads/main', false)
    await settle()
    assert.deepEqual(calls.opened, [{ ref: 'refs/heads/main' }])
    assert.deepEqual(calls.compared, [[BASE, TARGET]])
    assert.equal(comparison.state.value.response, COMPLETE)
    scope.stop()
  })

  it('uses the merge base', async () => {
    const { calls, comparison, scope } = setup('refs/heads/main', true)
    await settle()
    assert.deepEqual(calls.opened, [{ ref: 'refs/heads/main' }, { mergeBase: { base: BASE, target: TARGET } }])
    assert.deepEqual(calls.compared, [[MERGE, TARGET]])
    assert.deepEqual(comparison.state.value.mergeBase, { state: 'found', commit: MERGE })
    scope.stop()
  })

  it('falls back when there is no merge base', async () => {
    const { calls, comparison, scope } = setup('refs/heads/main', true, {
      open: async (request) => {
        if ('mergeBase' in request) throw new ApiError(409, 'No merge base')
        return { key: BASE, commit: BASE }
      },
    })
    await settle()
    assert.deepEqual(comparison.state.value.mergeBase, { state: 'none' })
    assert.deepEqual(calls.compared, [[BASE, TARGET]])
    assert.equal(comparison.state.value.status, 'ready')
    scope.stop()
  })

  it('polls until complete', async () => {
    const { calls, comparison, scope } = setup('work', false, {
      compare: async (call) => (call < 3 ? { revision: 1, complete: false, roots: [] } : COMPLETE),
    })
    await settle()
    await wait(40)
    await settle()
    assert.equal(calls.compared.length, 3)
    assert.equal(comparison.state.value.response?.complete, true)
    await wait(20)
    assert.equal(calls.compared.length, 3)
    scope.stop()
  })

  it('refetches when the enrichment revision changes', async () => {
    const { calls, inputs, scope } = setup('work', false)
    await settle()
    inputs.enrichmentRevision.value = 2
    await settle()
    assert.equal(calls.compared.length, 2)
    scope.stop()
  })

  it('reopens a dropped base once', async () => {
    const { calls, comparison, scope } = setup('refs/heads/main', false, {
      compare: async (call) => {
        if (call === 1) throw new ApiError(404, `Unknown source ${BASE}`)
        return COMPLETE
      },
    })
    await settle(5)
    assert.equal(calls.opened.length, 2)
    assert.equal(calls.compared.length, 2)
    assert.equal(comparison.state.value.status, 'ready')
    scope.stop()
  })

  it('reports a second 404 as an error', async () => {
    const { comparison, scope } = setup('refs/heads/main', false, {
      compare: async () => {
        throw new ApiError(404, `Unknown source ${BASE}`)
      },
    })
    await settle(5)
    assert.equal(comparison.state.value.status, 'error')
    assert.equal(comparison.state.value.error, `Unknown source ${BASE}`)
    scope.stop()
  })

  it('keeps polling while versions are still being checked', async () => {
    const checking: CompareResponse = { revision: 1, complete: true, roots: [{ ...EMPTY_ROOT, riskPending: 2 }] }
    const { calls, comparison, scope } = setup('work', false, {
      compare: async (call) => (call < 3 ? checking : COMPLETE),
    })
    await settle()
    await wait(40)
    await settle()
    assert.equal(calls.compared.length, 3)
    assert.equal(comparison.state.value.response, COMPLETE)
    await wait(20)
    assert.equal(calls.compared.length, 3)
    scope.stop()
  })

  it('ignores a base that an abandoned run opens late', async () => {
    const OTHER = 'd'.repeat(40)
    let releaseFirst: () => void = () => undefined
    const firstOpened = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { calls, inputs, comparison, scope } = setup('refs/heads/slow', false, {
      open: async (request) => {
        if ('ref' in request && request.ref === 'refs/heads/slow') {
          await firstOpened
          return { key: OTHER, commit: OTHER }
        }
        return { key: BASE, commit: BASE }
      },
      compare: async (call) => (call === 1 ? { revision: 1, complete: false, roots: [] } : COMPLETE),
    })
    await settle()
    inputs.base.value = 'refs/heads/main'
    await settle()
    releaseFirst()
    await settle()
    await wait(20)
    await settle()
    assert.ok(calls.compared.length >= 2)
    assert.deepEqual(
      calls.compared.filter(([base]) => base === OTHER),
      [],
    )
    assert.equal(comparison.state.value.response, COMPLETE)
    scope.stop()
  })

  it('does not reopen the base when the target was dropped', async () => {
    const { calls, comparison, scope } = setup('refs/heads/main', false, {
      compare: async () => {
        throw new ApiError(404, `Unknown source ${TARGET}`)
      },
    })
    await settle(5)
    assert.equal(calls.opened.length, 1)
    assert.equal(calls.compared.length, 1)
    assert.equal(comparison.state.value.status, 'error')
    scope.stop()
  })

  it('stays idle while inactive', async () => {
    const { calls, inputs, scope } = setup('work', false)
    inputs.active.value = false
    await settle()
    const before = calls.compared.length
    inputs.base.value = 'refs/heads/main'
    await settle()
    assert.equal(calls.compared.length, before)
    scope.stop()
  })
})
