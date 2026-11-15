import type { Job } from '../../src/actions/types.ts'
import type { DepKind } from '../../src/model.ts'
import type { DeptrailApi } from './api.ts'
import { pollJob, type JobPollOptions } from './job-poll.ts'
import { JOB_CANCELED, JOB_FAILED, type RootCollectResult } from './vocabulary.ts'

export type AddRecommendedOptions = { signal?: AbortSignal; onRoot?: (root: string) => void; poll?: Omit<JobPollOptions, 'signal'> }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultOf(root: string, job: Job): RootCollectResult {
  if (job.state === 'done') return { root, result: job.result }
  return { root, result: undefined, error: job.error ?? (job.state === 'cancelled' ? JOB_CANCELED : JOB_FAILED) }
}

async function addToRoot(
  api: Pick<DeptrailApi, 'addRecommended' | 'job'>,
  root: string,
  kinds: DepKind[],
  options: AddRecommendedOptions,
): Promise<RootCollectResult> {
  try {
    const { jobId } = await api.addRecommended(root, kinds)
    return resultOf(root, await pollJob(api, jobId, () => undefined, { ...options.poll, signal: options.signal }))
  } catch (error) {
    options.signal?.throwIfAborted()
    return { root, result: undefined, error: messageOf(error) }
  }
}

export async function addRecommendedToRoots(
  api: Pick<DeptrailApi, 'addRecommended' | 'job'>,
  roots: readonly string[],
  kinds: DepKind[],
  options: AddRecommendedOptions = {},
): Promise<RootCollectResult[]> {
  const results: RootCollectResult[] = []
  for (const root of roots) {
    options.onRoot?.(root)
    options.signal?.throwIfAborted()
    results.push(await addToRoot(api, root, kinds, options))
  }
  return results
}
