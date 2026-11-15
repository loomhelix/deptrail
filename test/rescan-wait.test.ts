import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RESCAN_WAIT_LIMIT_MS, rescanProgress, startRescanWait } from '../ui/src/rescan-wait.ts'

const PREVIOUS = '2026-10-25T10:00:00.000Z'
const STARTED_AT = 1_000_000

describe('rescan wait', () => {
  it('waits for a new scan for at most 60 seconds', () => {
    assert.equal(RESCAN_WAIT_LIMIT_MS, 60_000)
  })

  it('keeps waiting while the scan time is unchanged and the limit is not reached', () => {
    const pending = startRescanWait(PREVIOUS, STARTED_AT)
    assert.equal(rescanProgress(pending, PREVIOUS, STARTED_AT + RESCAN_WAIT_LIMIT_MS - 1), 'waiting')
    assert.equal(rescanProgress(pending, undefined, STARTED_AT + 1), 'waiting')
  })

  it('reports a started rescan once the scan time changes', () => {
    const pending = startRescanWait(PREVIOUS, STARTED_AT)
    assert.equal(rescanProgress(pending, '2026-10-25T10:00:05.000Z', STARTED_AT + 5000), 'started')
    assert.equal(rescanProgress(startRescanWait(null, STARTED_AT), PREVIOUS, STARTED_AT + 1), 'started')
  })

  it('gives up once the limit is reached without a new scan', () => {
    const pending = startRescanWait(PREVIOUS, STARTED_AT)
    assert.equal(rescanProgress(pending, PREVIOUS, STARTED_AT + RESCAN_WAIT_LIMIT_MS), 'timed-out')
  })
})
