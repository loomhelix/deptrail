export const RESCAN_WAIT_LIMIT_MS = 60_000

export type PendingRescan = { previousScannedAt: string | null; deadline: number }
export type RescanProgress = 'waiting' | 'started' | 'timed-out'

export function startRescanWait(previousScannedAt: string | null, now: number): PendingRescan {
  return { previousScannedAt, deadline: now + RESCAN_WAIT_LIMIT_MS }
}

export function rescanProgress(pending: PendingRescan, scannedAt: string | undefined, now: number): RescanProgress {
  if (scannedAt !== undefined && scannedAt !== pending.previousScannedAt) return 'started'
  return now >= pending.deadline ? 'timed-out' : 'waiting'
}
