import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChangeItem, ChangesResponse, Job, Preview } from '../src/actions/types.ts'
import type { ChildrenResult, RootSummary, SearchHit } from '../ui/src/api.ts'
import {
  changeStep,
  directDependencyNode,
  editLookup,
  nodeInRoot,
  primaryAction,
  sectionRoots,
  UNDO_WINDOW_MS,
  updateSize,
} from '../ui/src/changes-flow.ts'

const FIX_ITEM: ChangeItem = {
  id: 'fix-1',
  goal: { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: ['GHSA-e2e0-chld-0001'], severity: 'high' },
  choice: 'chain',
  steps: [{ kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: '' }],
  warnings: [],
}

const RELOCK_UPDATE: ChangeItem = {
  id: 'update-1',
  goal: { kind: 'update', name: 'toolkit', importers: ['importer:api', 'importer:web'], target: '2.1.0' },
  choice: 'wanted',
  steps: [{ kind: 'relock', name: 'toolkit', from: '2.0.0', to: '2.1.0', reason: '' }],
  warnings: [],
}

const RANGE_UPDATE: ChangeItem = {
  id: 'update-2',
  goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '3.0.0' },
  choice: 'latest',
  steps: [
    { kind: 'set-range', importer: 'importer:web', dependency: 'toolkit', field: 'dependencies', place: 'manifest', from: '^2.0.0', to: '^3.0.0', reason: '' },
  ],
  warnings: ['major update'],
}

function root(id: string, actions: Partial<RootSummary['actions']> = {}): RootSummary {
  return { id, actions: { available: true, changeCount: 0, revertable: false, ...actions } } as unknown as RootSummary
}

function job(kind: Job['kind'], state: Job['state']): Job {
  return { id: `${kind}-${state}`, rootId: 'shop', kind, state, log: [], firstLine: 0 }
}

function preview(stale: boolean): Preview {
  return {
    id: 'preview-1',
    rootId: 'shop',
    createdAt: '2026-10-26T12:00:00.000Z',
    stale,
    manager: { name: 'pnpm', version: '10.0.0' },
    goals: [],
    newIssues: [],
    warnings: [],
    files: [],
    packageChanges: [],
  }
}

function changes(overrides: Partial<ChangesResponse> = {}): ChangesResponse {
  return { items: [], revertable: false, installByDefault: false, ...overrides }
}

describe('sectionRoots', () => {
  const roots = [
    root('shop', { changeCount: 1 }),
    root('docs'),
    root('shop-npm', { job: { id: 'job-1', kind: 'preview', state: 'running' } }),
    root('legacy', { revertable: true }),
    root('admin', { job: { id: 'job-2', kind: 'preview', state: 'done' } }),
  ]

  it('lists the roots with changes, a running job or a revertable apply in All roots, in scan order', () => {
    assert.deepEqual(sectionRoots(roots, undefined), ['shop', 'shop-npm', 'legacy'])
  })

  it('always lists the scope root of a single-root scope, even without work', () => {
    assert.deepEqual(sectionRoots(roots, 'docs'), ['docs'])
    assert.deepEqual(sectionRoots(roots, 'shop'), ['shop'])
  })

  it('lists nothing for a scope that is not in the scan', () => {
    assert.deepEqual(sectionRoots(roots, 'missing'), [])
    assert.deepEqual(sectionRoots([], undefined), [])
  })
})

describe('changeStep', () => {
  it('is changes without a preview', () => {
    assert.equal(changeStep(changes({ items: [FIX_ITEM] })), 'changes')
    assert.equal(changeStep(changes()), 'changes')
  })

  it('is apply with a fresh preview and preview with a stale one', () => {
    assert.equal(changeStep(changes({ items: [FIX_ITEM], preview: preview(false) })), 'apply')
    assert.equal(changeStep(changes({ items: [FIX_ITEM], preview: preview(true) })), 'preview')
  })

  it('is changes when a stale preview is left after every item went away', () => {
    assert.equal(changeStep(changes({ preview: preview(true) })), 'changes')
  })

  it('is applied when the latest job is a finished apply and no items are left', () => {
    assert.equal(changeStep(changes({ job: job('apply', 'done'), revertable: true })), 'applied')
  })

  it('is not applied while the apply runs, after it failed or when items are left', () => {
    assert.equal(changeStep(changes({ job: job('apply', 'running') })), 'changes')
    assert.equal(changeStep(changes({ job: job('apply', 'failed') })), 'changes')
    assert.equal(changeStep(changes({ items: [FIX_ITEM], job: job('apply', 'done') })), 'changes')
    assert.equal(changeStep(changes({ job: job('revert', 'done') })), 'changes')
  })
})

describe('primaryAction', () => {
  it('is preview when there are items and no preview', () => {
    assert.equal(primaryAction(changes({ items: [FIX_ITEM] })), 'preview')
  })

  it('is apply with a fresh preview and preview again with a stale one', () => {
    assert.equal(primaryAction(changes({ items: [FIX_ITEM], preview: preview(false) })), 'apply')
    assert.equal(primaryAction(changes({ items: [FIX_ITEM], preview: preview(true) })), 'preview-again')
  })

  it('is nothing without items', () => {
    assert.equal(primaryAction(changes()), undefined)
    assert.equal(primaryAction(changes({ preview: preview(true) })), undefined)
    assert.equal(primaryAction(changes({ job: job('apply', 'done'), revertable: true })), undefined)
  })
})

describe('UNDO_WINDOW_MS', () => {
  it('offers Undo for 10 seconds', () => {
    assert.equal(UNDO_WINDOW_MS, 10_000)
  })
})

describe('editLookup', () => {
  it('finds a fix by the name and version of its goal', () => {
    assert.deepEqual(editLookup(FIX_ITEM), { kind: 'version', name: 'child-lib', version: '1.0.0' })
  })

  it('finds an update among the direct dependencies of its first workspace package', () => {
    assert.deepEqual(editLookup(RELOCK_UPDATE), { kind: 'direct', name: 'toolkit', importer: 'importer:api' })
    assert.deepEqual(editLookup(RANGE_UPDATE), { kind: 'direct', name: 'toolkit', importer: 'importer:web' })
  })

  it('falls back to the re-locked version of an update without workspace packages', () => {
    const item: ChangeItem = { ...RELOCK_UPDATE, goal: { kind: 'update', name: 'toolkit', importers: [], target: '2.1.0' } }
    assert.deepEqual(editLookup(item), { kind: 'version', name: 'toolkit', version: '2.0.0' })
  })

  it('finds nothing for an update without workspace packages or a re-lock', () => {
    const item: ChangeItem = { ...RANGE_UPDATE, goal: { kind: 'update', name: 'toolkit', importers: [], target: '3.0.0' } }
    assert.equal(editLookup(item), undefined)
  })
})

describe('nodeInRoot', () => {
  const hits: SearchHit[] = [
    { name: 'child-lib-extra', versions: [{ version: '1.0.0', roots: [{ rootId: 'shop', nodeId: 'child-lib-extra@1.0.0' }] }] },
    {
      name: 'child-lib',
      versions: [
        { version: '1.0.1', roots: [{ rootId: 'shop', nodeId: 'child-lib@1.0.1' }] },
        {
          version: '1.0.0',
          roots: [
            { rootId: 'shop', nodeId: 'child-lib@1.0.0(react@18.0.0)' },
            { rootId: 'shop', nodeId: 'child-lib@1.0.0' },
            { rootId: 'shop-npm', nodeId: 'child-lib@1.0.0' },
          ],
        },
      ],
    },
  ]

  it('prefers the plain node of the version in the root', () => {
    assert.equal(nodeInRoot(hits, 'shop', 'child-lib', '1.0.0'), 'child-lib@1.0.0')
    assert.equal(nodeInRoot(hits, 'shop-npm', 'child-lib', '1.0.0'), 'child-lib@1.0.0')
  })

  it('takes a peer variant when the root has no plain node', () => {
    const peerOnly: SearchHit[] = [{ name: 'child-lib', versions: [{ version: '1.0.0', roots: [{ rootId: 'shop', nodeId: 'child-lib@1.0.0(react@18.0.0)' }] }] }]
    assert.equal(nodeInRoot(peerOnly, 'shop', 'child-lib', '1.0.0'), 'child-lib@1.0.0(react@18.0.0)')
  })

  it('finds nothing in another root, for another version or another name', () => {
    assert.equal(nodeInRoot(hits, 'docs', 'child-lib', '1.0.0'), undefined)
    assert.equal(nodeInRoot(hits, 'shop-npm', 'child-lib', '1.0.1'), undefined)
    assert.equal(nodeInRoot(hits, 'shop', 'child', '1.0.0'), undefined)
  })
})

describe('directDependencyNode', () => {
  function row(id: string, name: string, kind: ChildrenResult['rows'][number]['kind'], isImporter = false): ChildrenResult['rows'][number] {
    return { node: { id, name, version: '2.0.0', isImporter, isPlaceholder: false }, kind, range: '^2.0.0', hasChildren: false, repeated: false }
  }

  it('returns the node the workspace package depends on', () => {
    const rows = [row('helper@1.0.0', 'helper', 'prod'), row('toolkit@2.0.0', 'toolkit', 'prod')]
    assert.equal(directDependencyNode(rows, 'toolkit'), 'toolkit@2.0.0')
  })

  it('prefers a regular dependency over a peer and never returns a workspace package', () => {
    const rows = [row('importer:toolkit', 'toolkit', 'prod', true), row('toolkit@2.0.0(react@18.0.0)', 'toolkit', 'peer'), row('toolkit@2.0.0', 'toolkit', 'dev')]
    assert.equal(directDependencyNode(rows, 'toolkit'), 'toolkit@2.0.0')
    assert.equal(directDependencyNode([row('importer:toolkit', 'toolkit', 'prod', true)], 'toolkit'), undefined)
  })

  it('finds nothing when the workspace package does not depend on the name', () => {
    assert.equal(directDependencyNode([row('helper@1.0.0', 'helper', 'prod')], 'toolkit'), undefined)
  })
})

describe('updateSize', () => {
  it('compares the re-locked version with the target', () => {
    assert.equal(updateSize(RELOCK_UPDATE), 'minor')
  })

  it('compares the lowest version of the old range with the target', () => {
    assert.equal(updateSize(RANGE_UPDATE), 'major')
    const patch: ChangeItem = {
      ...RANGE_UPDATE,
      goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '2.0.5' },
      steps: [{ kind: 'set-range', importer: 'importer:web', dependency: 'toolkit', field: 'dependencies', place: 'catalog', from: '~2.0.0', to: '~2.0.5', reason: '' }],
    }
    assert.equal(updateSize(patch), 'patch')
  })

  it('has no size for a fix, an unreadable range or a target that is not newer', () => {
    assert.equal(updateSize(FIX_ITEM), undefined)
    const tagged: ChangeItem = {
      ...RANGE_UPDATE,
      steps: [{ kind: 'set-range', importer: 'importer:web', dependency: 'toolkit', field: 'dependencies', place: 'manifest', from: 'latest', to: '^3.0.0', reason: '' }],
    }
    assert.equal(updateSize(tagged), undefined)
    const older: ChangeItem = { ...RANGE_UPDATE, goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '1.9.0' } }
    assert.equal(updateSize(older), undefined)
  })
})
