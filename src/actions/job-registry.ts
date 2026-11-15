import { randomUUID } from 'node:crypto'
import { processSecrets, type SecretSet } from '../config/secrets.ts'
import { messageOf } from '../scan/build-root.ts'
import type { Job, JobKind, JobPhase, JobResult } from './types.ts'

export const JOB_LOG_LINES = 2000

export type JobContext = { signal: AbortSignal; log(line: string): void; phase(phase: JobPhase): void }
export type JobRun = (context: JobContext) => Promise<JobResult | undefined>

export type JobRegistry = {
  start(rootId: string, kind: JobKind, run: JobRun): Job
  get(id: string, since: number): Job | undefined
  running(rootId: string): Job | undefined
  latest(rootId: string): Job | undefined
  cancel(id: string): void
  cancelAll(): void
}

type JobRecord = {
  id: string
  rootId: string
  kind: JobKind
  state: Job['state']
  phase?: JobPhase
  lines: string[]
  droppedLines: number
  error?: string
  result?: JobResult
  controller: AbortController
}

type Outcome = { result: JobResult | undefined } | { failure: unknown }

function snapshot(record: JobRecord, since: number): Job {
  const firstLine = Math.max(since, record.droppedLines)
  return {
    id: record.id,
    rootId: record.rootId,
    kind: record.kind,
    state: record.state,
    ...(record.phase === undefined ? {} : { phase: record.phase }),
    log: record.lines.slice(firstLine - record.droppedLines),
    firstLine,
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.result === undefined ? {} : { result: record.result }),
  }
}

function startRun(run: JobRun, context: JobContext): Promise<JobResult | undefined> {
  try {
    return run(context)
  } catch (failure) {
    return Promise.reject(failure)
  }
}

export function createJobRegistry(secrets: SecretSet = processSecrets): JobRegistry {
  const records = new Map<string, JobRecord>()

  function appendLine(record: JobRecord, line: string): void {
    if (record.state !== 'running') return
    record.lines.push(secrets.redact(line))
    if (record.lines.length <= JOB_LOG_LINES) return
    record.lines.shift()
    record.droppedLines++
  }

  function settle(record: JobRecord, outcome: Outcome): void {
    if (record.controller.signal.aborted) {
      record.state = 'cancelled'
      return
    }
    if ('failure' in outcome) {
      record.state = 'failed'
      record.error = secrets.redact(messageOf(outcome.failure))
      return
    }
    record.state = 'done'
    if (outcome.result !== undefined) record.result = outcome.result
  }

  function dropFinished(rootId: string): void {
    for (const [id, record] of records) {
      if (record.rootId === rootId && record.state !== 'running') records.delete(id)
    }
  }

  function newest(rootId: string, accepts: (record: JobRecord) => boolean): Job | undefined {
    let found: JobRecord | undefined
    for (const record of records.values()) {
      if (record.rootId === rootId && accepts(record)) found = record
    }
    return found === undefined ? undefined : snapshot(found, 0)
  }

  return {
    start(rootId, kind, run) {
      dropFinished(rootId)
      const record: JobRecord = { id: randomUUID(), rootId, kind, state: 'running', lines: [], droppedLines: 0, controller: new AbortController() }
      records.set(record.id, record)
      const context: JobContext = {
        signal: record.controller.signal,
        log: (line) => appendLine(record, line),
        phase: (phase) => {
          if (record.state === 'running') record.phase = phase
        },
      }
      startRun(run, context).then(
        (result) => settle(record, { result }),
        (failure: unknown) => settle(record, { failure }),
      )
      return snapshot(record, 0)
    },
    get(id, since) {
      const record = records.get(id)
      return record === undefined ? undefined : snapshot(record, since)
    },
    running(rootId) {
      return newest(rootId, (record) => record.state === 'running')
    },
    latest(rootId) {
      return newest(rootId, () => true)
    },
    cancel(id) {
      const record = records.get(id)
      if (record?.state === 'running') record.controller.abort()
    },
    cancelAll() {
      for (const record of records.values()) {
        if (record.state === 'running') record.controller.abort()
      }
    },
  }
}
