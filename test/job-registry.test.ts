import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { JOB_LOG_LINES, createJobRegistry, type JobContext } from '../src/actions/job-registry.ts'
import { createSecretSet } from '../src/config/secrets.ts'

const CANARY = 'canary-token-7'

function untilAborted(context: JobContext): Promise<undefined> {
  return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
}

describe('job registry', () => {
  it('keeps the last 2,000 log lines and says where they start', async () => {
    const registry = createJobRegistry()
    const started = registry.start('root-a', 'preview', async (context) => {
      for (let line = 1; line <= 2500; line++) context.log(`line ${line}`)
      return { previewId: 'preview-1' }
    })
    await nextTurn()
    assert.equal(JOB_LOG_LINES, 2000)
    const all = registry.get(started.id, 0)
    assert.equal(all?.firstLine, 500)
    assert.equal(all?.log.length, 2000)
    assert.equal(all?.log[0], 'line 501')
    assert.equal(all?.log.at(-1), 'line 2500')
    const tail = registry.get(started.id, 2400)
    assert.equal(tail?.firstLine, 2400)
    assert.deepEqual(tail?.log, Array.from({ length: 100 }, (_, index) => `line ${2401 + index}`))
    assert.deepEqual(registry.get(started.id, 3000)?.log, [])
  })

  it('starts a job as running with a new id and records its phase', async () => {
    const registry = createJobRegistry()
    let finish: (value: undefined) => void = () => {}
    const started = registry.start('root-a', 'apply', (context) => {
      context.phase('writing')
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    assert.match(started.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(started, { id: started.id, rootId: 'root-a', kind: 'apply', state: 'running', phase: 'writing', log: [], firstLine: 0 })
    assert.equal(registry.running('root-a')?.id, started.id)
    assert.notEqual(registry.start('root-b', 'apply', async () => undefined).id, started.id)
    finish(undefined)
    await nextTurn()
    assert.equal(registry.get(started.id, 0)?.state, 'done')
    assert.equal(registry.get(started.id, 0)?.result, undefined)
  })

  it('is done with the result of a run that resolves', async () => {
    const registry = createJobRegistry()
    const started = registry.start('root-a', 'collect', async (context) => {
      context.log('adding fixes')
      return { added: 2, skipped: [] }
    })
    await nextTurn()
    const job = registry.get(started.id, 0)
    assert.equal(job?.state, 'done')
    assert.deepEqual(job?.result, { added: 2, skipped: [] })
    assert.deepEqual(job?.log, ['adding fixes'])
    assert.equal(registry.running('root-a'), undefined)
    assert.equal(registry.latest('root-a')?.id, started.id)
  })

  it('fails with the redacted message of a run that throws and redacts log lines', async () => {
    const secrets = createSecretSet()
    secrets.add(CANARY)
    const registry = createJobRegistry(secrets)
    const started = registry.start('root-a', 'preview', async (context) => {
      context.log(`token ${CANARY}`)
      throw new Error(`pnpm failed with ${CANARY}`)
    })
    await nextTurn()
    const job = registry.get(started.id, 0)
    assert.equal(job?.state, 'failed')
    assert.equal(job?.error, 'pnpm failed with [redacted]')
    assert.deepEqual(job?.log, ['token [redacted]'])
    assert.equal(job?.result, undefined)
  })

  it('fails a run that throws before it returns a promise', async () => {
    const registry = createJobRegistry()
    const started = registry.start('root-a', 'preview', () => {
      throw new Error('could not start')
    })
    await nextTurn()
    assert.equal(registry.get(started.id, 0)?.state, 'failed')
    assert.equal(registry.get(started.id, 0)?.error, 'could not start')
  })

  it('is cancelled when its signal is aborted, whatever the run does next', async () => {
    const registry = createJobRegistry()
    const rejecting = registry.start('root-a', 'preview', (context) => untilAborted(context))
    const resolving = registry.start('root-b', 'apply', async (context) => {
      await untilAborted(context).catch(() => undefined)
      return { goalsMet: 1 }
    })
    registry.cancel(rejecting.id)
    registry.cancel(resolving.id)
    await nextTurn()
    assert.equal(registry.get(rejecting.id, 0)?.state, 'cancelled')
    assert.equal(registry.get(rejecting.id, 0)?.error, undefined)
    assert.equal(registry.get(resolving.id, 0)?.state, 'cancelled')
    registry.cancel('unknown-id')
  })

  it('cancels every running job', async () => {
    const registry = createJobRegistry()
    const first = registry.start('root-a', 'preview', (context) => untilAborted(context))
    const second = registry.start('root-b', 'preview', (context) => untilAborted(context))
    registry.cancelAll()
    await nextTurn()
    assert.equal(registry.get(first.id, 0)?.state, 'cancelled')
    assert.equal(registry.get(second.id, 0)?.state, 'cancelled')
  })

  it('drops the finished job of a root when the next job of that root starts', async () => {
    const registry = createJobRegistry()
    const first = registry.start('root-a', 'preview', async () => ({ previewId: 'one' }))
    const other = registry.start('root-b', 'preview', async () => ({ previewId: 'two' }))
    await nextTurn()
    const second = registry.start('root-a', 'apply', async () => ({ goalsMet: 0 }))
    assert.equal(registry.get(first.id, 0), undefined)
    assert.equal(registry.latest('root-a')?.id, second.id)
    assert.equal(registry.get(other.id, 0)?.state, 'done')
    assert.equal(registry.get('unknown-id', 0), undefined)
    assert.equal(registry.latest('root-c'), undefined)
  })
})
