import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Job } from '../src/actions/types.ts'
import { pollJob } from '../ui/src/job-poll.ts'

type JobReply = Pick<Job, 'state' | 'log' | 'firstLine'> & Partial<Job>

function scriptedApi(replies: JobReply[]) {
  const sinces: number[] = []
  const api = {
    async job(id: string, since: number): Promise<Job> {
      sinces.push(since)
      const reply = replies.shift()
      if (reply === undefined) throw new Error('no more scripted replies')
      return { id, rootId: 'shop', kind: 'preview', ...reply }
    },
  }
  return { api, sinces }
}

function lines(prefix: string, count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${start + index}`)
}

describe('pollJob', () => {
  it('asks for the lines after the ones it has and resolves with the finished job', async () => {
    const { api, sinces } = scriptedApi([
      { state: 'running', phase: 'staging', log: ['copying', 'resolving'], firstLine: 0 },
      { state: 'running', phase: 'resolving', log: ['Progress: resolved 4'], firstLine: 2 },
      { state: 'done', log: [], firstLine: 3, result: { previewId: 'preview-1' } },
    ])
    const updates: { state: string; log: string[] }[] = []
    const sleeps: number[] = []
    const finished = await pollJob(api, 'job-1', (job, log) => updates.push({ state: job.state, log: [...log] }), {
      intervalMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    assert.deepEqual(sinces, [0, 2, 3])
    assert.deepEqual(sleeps, [250, 250])
    assert.equal(finished.state, 'done')
    assert.deepEqual(finished.result, { previewId: 'preview-1' })
    assert.deepEqual(updates, [
      { state: 'running', log: ['copying', 'resolving'] },
      { state: 'running', log: ['copying', 'resolving', 'Progress: resolved 4'] },
      { state: 'done', log: ['copying', 'resolving', 'Progress: resolved 4'] },
    ])
  })

  it('waits one second between requests by default', async () => {
    const { api } = scriptedApi([
      { state: 'running', log: [], firstLine: 0 },
      { state: 'failed', log: ['ERR_PNPM_FETCH_404'], firstLine: 0, error: 'pnpm install failed' },
    ])
    const sleeps: number[] = []
    const finished = await pollJob(api, 'job-1', () => {}, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    assert.deepEqual(sleeps, [1000])
    assert.equal(finished.error, 'pnpm install failed')
  })

  it('continues after lines the server no longer keeps', async () => {
    const { api, sinces } = scriptedApi([
      { state: 'running', log: ['a', 'b'], firstLine: 0 },
      { state: 'running', log: ['f', 'g'], firstLine: 5 },
      { state: 'cancelled', log: [], firstLine: 7 },
    ])
    let lastLog: readonly string[] = []
    await pollJob(api, 'job-1', (_job, log) => (lastLog = log), { sleep: async () => {} })
    assert.deepEqual(sinces, [0, 2, 7])
    assert.deepEqual(lastLog, ['a', 'b', 'f', 'g'])
  })

  it('keeps the last 2,000 lines', async () => {
    const { api } = scriptedApi([
      { state: 'running', log: lines('line', 1500), firstLine: 0 },
      { state: 'done', log: lines('line', 1000, 1500), firstLine: 1500 },
    ])
    let lastLog: readonly string[] = []
    await pollJob(api, 'job-1', (_job, log) => (lastLog = log), { sleep: async () => {} })
    assert.equal(lastLog.length, 2000)
    assert.equal(lastLog[0], 'line 500')
    assert.equal(lastLog.at(-1), 'line 2499')
  })

  it('stops asking once the signal aborts', async () => {
    const { api, sinces } = scriptedApi([
      { state: 'running', log: [], firstLine: 0 },
      { state: 'running', log: [], firstLine: 0 },
    ])
    const controller = new AbortController()
    await assert.rejects(
      pollJob(api, 'job-1', () => controller.abort(), { signal: controller.signal, sleep: async () => {} }),
      { name: 'AbortError' },
    )
    assert.deepEqual(sinces, [0])
  })

  it('wakes up from its own wait when the signal aborts', async () => {
    const { api, sinces } = scriptedApi([{ state: 'running', log: [], firstLine: 0 }])
    const controller = new AbortController()
    const polling = pollJob(api, 'job-1', () => setImmediate(() => controller.abort()), { signal: controller.signal, intervalMs: 60_000 })
    await assert.rejects(polling, { name: 'AbortError' })
    assert.deepEqual(sinces, [0])
  })
})
