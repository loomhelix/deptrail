import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Job } from '../src/actions/types.ts'
import type { DepKind } from '../src/model.ts'
import { addRecommendedToRoots } from '../ui/src/add-recommended.ts'

type ScriptedRoot = Partial<Pick<Job, 'state' | 'error' | 'result'>> | Error

const JOB_PREFIX = 'job-'

function scriptedApi(roots: Readonly<Record<string, ScriptedRoot>>) {
  const calls: string[] = []
  const api = {
    async addRecommended(root: string, kinds: DepKind[]): Promise<{ jobId: string }> {
      calls.push(`add ${root} ${kinds.join(',')}`)
      const script = roots[root]
      if (script instanceof Error) throw script
      return { jobId: `${JOB_PREFIX}${root}` }
    },
    async job(id: string): Promise<Job> {
      calls.push(`poll ${id}`)
      const root = id.slice(JOB_PREFIX.length)
      const script = roots[root]
      const reply = script instanceof Error || script === undefined ? {} : script
      return { id, rootId: root, kind: 'collect', state: 'done', log: [], firstLine: 0, ...reply }
    },
  }
  return { api, calls }
}

const noSleep = { sleep: async (): Promise<void> => undefined }

describe('addRecommendedToRoots', () => {
  it('adds to each root one after another and keeps the result of each', async () => {
    const skipped = [{ name: 'parent-lib', reason: 'no fixed version yet' }]
    const { api, calls } = scriptedApi({ shop: { result: { added: 2 } }, 'shop-npm': { result: { added: 1, skipped } } })
    const started: string[] = []
    const results = await addRecommendedToRoots(api, ['shop', 'shop-npm'], ['prod', 'dev'], { poll: noSleep, onRoot: (root) => started.push(root) })
    assert.deepEqual(calls, ['add shop prod,dev', 'poll job-shop', 'add shop-npm prod,dev', 'poll job-shop-npm'])
    assert.deepEqual(started, ['shop', 'shop-npm'])
    assert.deepEqual(results, [
      { root: 'shop', result: { added: 2 } },
      { root: 'shop-npm', result: { added: 1, skipped } },
    ])
  })

  it('keeps going after a root fails and says why it failed', async () => {
    const { api } = scriptedApi({
      shop: new Error('Server error'),
      'shop-npm': { state: 'failed', error: 'the lockfile changed' },
      docs: { state: 'failed' },
      web: { state: 'cancelled' },
      api: { result: { added: 1 } },
    })
    const results = await addRecommendedToRoots(api, ['shop', 'shop-npm', 'docs', 'web', 'api'], ['prod'], { poll: noSleep })
    assert.deepEqual(results, [
      { root: 'shop', result: undefined, error: 'Server error' },
      { root: 'shop-npm', result: undefined, error: 'the lockfile changed' },
      { root: 'docs', result: undefined, error: 'the job failed' },
      { root: 'web', result: undefined, error: 'the job was canceled' },
      { root: 'api', result: { added: 1 } },
    ])
  })

  it('stops when the caller aborts', async () => {
    const { api, calls } = scriptedApi({ shop: { result: { added: 1 } }, 'shop-npm': { result: { added: 1 } } })
    const controller = new AbortController()
    const onRoot = (root: string): void => {
      if (root === 'shop-npm') controller.abort()
    }
    await assert.rejects(addRecommendedToRoots(api, ['shop', 'shop-npm'], ['prod'], { poll: noSleep, onRoot, signal: controller.signal }))
    assert.deepEqual(calls, ['add shop prod', 'poll job-shop'])
  })
})
