import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, type RootSummary, type ScanSummary } from '../ui/src/api.ts'
import { changeCountInScope, isDroppedSource, isMissingNode, isRootBusy, rootBlocker, rootRevision, scanRevision } from '../ui/src/scan-state.ts'
import { offlineStatus } from '../src/enrich/enrichment-status.ts'

const SCANNED_AT = '2026-10-25T10:00:00.000Z'

function rootSummary(id: string, overrides: Partial<RootSummary> = {}): RootSummary {
  return {
    id,
    path: id,
    manager: 'pnpm',
    source: 'lockfile',
    status: 'ready',
    warnings: [],
    importers: [],
    packageCount: 0,
    duplicateCount: 0,
    hasAuth: false,
    actions: { available: false, changeCount: 0, revertable: false },
    ...overrides,
  }
}

function scanOf(roots: RootSummary[], scannedAt = SCANNED_AT): ScanSummary {
  return { repoPath: '/repo', scannedAt, roots, enrichment: offlineStatus(0) }
}

describe('rootRevision', () => {
  it('stays the same while status, source and scan time stay the same', () => {
    assert.equal(rootRevision(SCANNED_AT, rootSummary('app', { packageCount: 1 })), rootRevision(SCANNED_AT, rootSummary('app', { packageCount: 2 })))
  })

  it('changes with the status, the source and the scan time', () => {
    const ready = rootRevision(SCANNED_AT, rootSummary('app'))
    assert.notEqual(rootRevision(SCANNED_AT, rootSummary('app', { status: 'scanning' })), ready)
    assert.notEqual(rootRevision(SCANNED_AT, rootSummary('app', { source: 'resolved-today' })), ready)
    assert.notEqual(rootRevision('2026-10-25T11:00:00.000Z', rootSummary('app')), ready)
    assert.notEqual(rootRevision(SCANNED_AT, undefined), ready)
  })

  it('changes when an apply or a revert of the root finishes, which rebuilds the root', () => {
    const withJob = (job: RootSummary['actions']['job']): RootSummary => rootSummary('app', { actions: { available: true, changeCount: 0, revertable: true, job } })
    const idle = rootRevision(SCANNED_AT, rootSummary('app'))
    const applying = rootRevision(SCANNED_AT, withJob({ id: 'apply-1', kind: 'apply', state: 'running', phase: 'writing' }))
    const applied = rootRevision(SCANNED_AT, withJob({ id: 'apply-1', kind: 'apply', state: 'done' }))
    const reverted = rootRevision(SCANNED_AT, withJob({ id: 'revert-1', kind: 'revert', state: 'done' }))
    assert.equal(applying, idle)
    assert.notEqual(applied, idle)
    assert.notEqual(reverted, applied)
    assert.equal(rootRevision(SCANNED_AT, withJob({ id: 'preview-1', kind: 'preview', state: 'done' })), idle)
  })
})

describe('scanRevision', () => {
  it('is undefined before the scan is loaded', () => {
    assert.equal(scanRevision(null), undefined)
  })

  it('stays the same across polls that change nothing', () => {
    const roots = () => [rootSummary('one', { status: 'scanning' }), rootSummary('two')]
    assert.equal(scanRevision(scanOf(roots())), scanRevision(scanOf(roots())))
  })

  it('changes when any root finishes, changes source, or the scan restarts', () => {
    const scanning = scanRevision(scanOf([rootSummary('one', { status: 'scanning' }), rootSummary('two')]))
    const finished = scanRevision(scanOf([rootSummary('one'), rootSummary('two')]))
    const rebuilt = scanRevision(scanOf([rootSummary('one'), rootSummary('two', { source: 'resolved-today' })]))
    const restarted = scanRevision(scanOf([rootSummary('one'), rootSummary('two', { source: 'resolved-today' })], '2026-10-25T11:00:00.000Z'))
    assert.equal(new Set([scanning, finished, rebuilt, restarted]).size, 4)
  })

  it('changes when an apply in any root finishes', () => {
    const applied = rootSummary('two', { actions: { available: true, changeCount: 0, revertable: true, job: { id: 'apply-1', kind: 'apply', state: 'done' } } })
    assert.notEqual(scanRevision(scanOf([rootSummary('one'), applied])), scanRevision(scanOf([rootSummary('one'), rootSummary('two')])))
  })
})

describe('rootBlocker', () => {
  it('lets a ready root through', () => {
    assert.equal(rootBlocker('app', rootSummary('app'), true), null)
  })

  it('explains why a root cannot be shown yet', () => {
    assert.equal(rootBlocker('app', undefined, false), 'Loading scan…')
    assert.equal(rootBlocker('app', undefined, true), 'app is not part of this scan.')
    assert.equal(rootBlocker('app', rootSummary('app', { status: 'scanning' }), true), 'Scanning app…')
    assert.equal(rootBlocker('.', rootSummary('.', { status: 'scanning' }), true), 'Scanning repository root…')
    assert.equal(rootBlocker('app', rootSummary('app', { status: 'failed', error: 'boom' }), true), 'app failed to scan: boom')
  })
})

describe('isRootBusy', () => {
  it('recognizes the conflict answer of a root that is not ready', () => {
    assert.equal(isRootBusy(new ApiError(409, 'Root app is scanning')), true)
    assert.equal(isRootBusy(new ApiError(404, 'Unknown node')), false)
    assert.equal(isRootBusy(new Error('offline')), false)
  })
})

describe('isMissingNode', () => {
  it('recognizes the not-found answer for a node that is not in the root', () => {
    assert.equal(isMissingNode(new ApiError(404, 'Unknown node ghost@1.0.0')), true)
    assert.equal(isMissingNode(new ApiError(409, 'Root app is scanning')), false)
    assert.equal(isMissingNode(new Error('offline')), false)
    assert.equal(isMissingNode(new ApiError(404, `Unknown source ${'a'.repeat(40)}`)), false)
  })
})

describe('changeCountInScope', () => {
  const withChanges = (id: string, changeCount: number): RootSummary => rootSummary(id, { actions: { available: true, changeCount, revertable: false } })
  const roots = [withChanges('shop', 2), withChanges('shop-npm', 1), withChanges('legacy/admin', 0)]

  it('adds up the changes of every root in All roots', () => {
    assert.equal(changeCountInScope(roots, undefined), 3)
  })

  it('counts only the changes of the scope root', () => {
    assert.equal(changeCountInScope(roots, 'shop-npm'), 1)
    assert.equal(changeCountInScope(roots, 'legacy/admin'), 0)
  })

  it('counts nothing for a root that is not part of the scan or a scan without roots', () => {
    assert.equal(changeCountInScope(roots, 'gone'), 0)
    assert.equal(changeCountInScope([], undefined), 0)
  })
})

describe('dropped sources', () => {
  it('recognizes a commit source the server no longer keeps', () => {
    assert.equal(isDroppedSource(new ApiError(404, `Unknown source ${'a'.repeat(40)}`)), true)
    assert.equal(isDroppedSource(new ApiError(404, 'Unknown root shop')), false)
    assert.equal(isDroppedSource(new ApiError(409, 'Unknown source x')), false)
    assert.equal(isDroppedSource(new Error('Unknown source x')), false)
  })
})
