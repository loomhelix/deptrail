import type { JobKind } from '../../src/actions/types.ts'
import { ApiError, type RootSummary, type ScanSummary } from './api.ts'
import { LOADING_SCAN, notInScanText, scanFailedText, scanningMessage } from './vocabulary.ts'

const KEY_SEPARATOR = '\n'
const FIELD_SEPARATOR = '\t'
const ROOT_NOT_READY_STATUS = 409
const NOT_FOUND_STATUS = 404
const UNKNOWN_SOURCE_PREFIX = 'Unknown source '
const REBUILDING_JOB_KINDS: ReadonlySet<JobKind> = new Set(['apply', 'revert'])

function finishedRebuildJob(root: RootSummary | undefined): string {
  const job = root?.actions.job
  return job !== undefined && job.state !== 'running' && REBUILDING_JOB_KINDS.has(job.kind) ? job.id : ''
}

export function rootRevision(scannedAt: string | undefined, root: RootSummary | undefined): string {
  return [scannedAt ?? '', root?.status ?? '', root?.source ?? '', finishedRebuildJob(root)].join(KEY_SEPARATOR)
}

export function scanRevision(scan: ScanSummary | null): string | undefined {
  if (scan === null) return undefined
  const rootStates = scan.roots.map((root) => [root.id, root.status, root.source, finishedRebuildJob(root)].join(FIELD_SEPARATOR))
  return [scan.scannedAt, ...rootStates].join(KEY_SEPARATOR)
}

export function rootBlocker(rootId: string, root: RootSummary | undefined, scanLoaded: boolean): string | null {
  if (!scanLoaded) return LOADING_SCAN
  if (!root) return notInScanText(rootId)
  if (root.status === 'scanning') return scanningMessage(root.id)
  if (root.status === 'failed') return scanFailedText(root.id, root.error)
  return null
}

export function changeCountInScope(roots: readonly RootSummary[], root: string | undefined): number {
  const counted = root === undefined ? roots : roots.filter((candidate) => candidate.id === root)
  return counted.reduce((total, candidate) => total + candidate.actions.changeCount, 0)
}

export function isRootBusy(error: unknown): boolean {
  return error instanceof ApiError && error.status === ROOT_NOT_READY_STATUS
}

export function isDroppedSource(error: unknown): boolean {
  return error instanceof ApiError && error.status === NOT_FOUND_STATUS && error.message.startsWith(UNKNOWN_SOURCE_PREFIX)
}

export function isMissingNode(error: unknown): boolean {
  return error instanceof ApiError && error.status === NOT_FOUND_STATUS && !isDroppedSource(error)
}
