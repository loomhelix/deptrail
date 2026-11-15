import type { Job } from '../../src/actions/types.ts'
import type { DeptrailApi } from './api.ts'

export const JOB_POLL_INTERVAL_MS = 1000
export const JOB_LOG_LINE_LIMIT = 2000

export type JobPollOptions = { intervalMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal }

function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export async function pollJob(
  api: Pick<DeptrailApi, 'job'>,
  jobId: string,
  onUpdate: (job: Job, log: readonly string[]) => void,
  options: JobPollOptions = {},
): Promise<Job> {
  const { intervalMs = JOB_POLL_INTERVAL_MS, signal } = options
  const sleep = options.sleep ?? ((ms: number) => waitUnlessAborted(ms, signal))
  let since = 0
  let log: string[] = []
  for (;;) {
    signal?.throwIfAborted()
    const job = await api.job(jobId, since)
    signal?.throwIfAborted()
    log = [...log, ...job.log].slice(-JOB_LOG_LINE_LIMIT)
    since = job.firstLine + job.log.length
    onUpdate(job, log)
    if (job.state !== 'running') return job
    await sleep(intervalMs)
  }
}
