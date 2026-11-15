import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CompareResponse, RootComparison } from '../src/query/compare-shape.ts'
import { baseLabel, compareNoteText, COMPARE_ROW_LIMIT, compareSummary, presenceText, rootsInScope } from '../ui/src/compare-model.ts'

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const LABELS = { base: 'origin/main', target: 'Working tree' }

function root(overrides: Partial<RootComparison>): RootComparison {
  return { rootId: 'shop', presence: 'both', state: 'ready', notes: [], exact: true, versions: [], directs: [], importers: [], risk: [], riskPending: 0, ...overrides }
}

const CHANGED = root({
  versions: [
    { name: 'a', change: 'added', base: [], target: ['1.0.0'] },
    { name: 'b', change: 'added', base: [], target: ['1.0.0'] },
    { name: 'c', change: 'removed', base: ['1.0.0'], target: [] },
    { name: 'd', change: 'upgraded', base: ['1.0.0'], target: ['2.0.0'] },
    { name: 'e', change: 'downgraded', base: ['2.0.0'], target: ['1.0.0'] },
    { name: 'f', change: 'changed', base: ['1.0.0', '2.0.0'], target: ['2.0.0'] },
  ],
  risk: [
    { name: 'v', version: '1.0.0', issue: 'vulnerability', change: 'introduced', severity: 'high' },
    { name: 'w', version: '1.0.0', issue: 'vulnerability', change: 'resolved', severity: 'low' },
    { name: 'x', version: '1.0.0', issue: 'vulnerability', change: 'resolved', severity: 'low' },
    { name: 'y', version: '1.0.0', issue: 'deprecated', change: 'introduced' },
  ],
})

describe('compare model', () => {
  it('limits tables to 100 rows before Show all', () => {
    assert.equal(COMPARE_ROW_LIMIT, 100)
  })

  it('summarizes the changes', () => {
    assert.equal(compareSummary([CHANGED, root({ rootId: 'tools', versions: [{ name: 'a', change: 'added', base: [], target: ['1.0.0'] }] })], LABELS), '2 roots changed · 3 added, 1 removed, 3 changed · 1 vulnerable version introduced · 2 resolved')
    assert.equal(compareSummary([root({ versions: [{ name: 'a', change: 'added', base: [], target: ['1.0.0'] }, { name: 'b', change: 'added', base: [], target: ['1.0.0'] }] })], LABELS), '1 root changed · 2 added')
    assert.equal(compareSummary([root({ directs: [{ importer: 'web', importerName: 'web', name: 'a', kind: 'prod', change: 'added', target: '1.0.0' }] })], LABELS), '1 root changed')
    assert.equal(compareSummary([], LABELS), 'No dependency changes between origin/main and the working tree.')
    assert.equal(compareSummary([], { base: 'Working tree', target: 'fix/a' }), 'No dependency changes between the working tree and fix/a.')
  })

  it('words notes with the side labels', () => {
    assert.equal(compareNoteText({ side: 'target', kind: 'inexact', source: 'manifest-only' }, LABELS), 'Package versions are not compared: the working tree builds this root from package.json manifests only.')
    assert.equal(compareNoteText({ side: 'base', kind: 'inexact', source: 'resolved-today' }, LABELS), 'Package versions are not compared: origin/main builds this root from versions resolved today.')
    assert.equal(compareNoteText({ side: 'base', kind: 'failed', error: 'boom' }, LABELS), 'origin/main failed to scan this root: boom')
    assert.equal(compareNoteText({ side: 'target', kind: 'failed', error: 'boom' }, LABELS), 'Working tree failed to scan this root: boom')
    assert.equal(compareNoteText({ side: 'base', kind: 'submodule' }, LABELS), 'Not compared: this root is inside a git submodule, and origin/main does not read submodules.')
  })

  it('says where a one-sided root is', () => {
    assert.equal(presenceText('base-only', LABELS), 'Only in origin/main')
    assert.equal(presenceText('target-only', LABELS), 'Only in the working tree')
    assert.equal(presenceText('both', LABELS), undefined)
  })

  it('keeps roots with changes in the scope', () => {
    const response: CompareResponse = { revision: 1, complete: true, roots: [CHANGED, root({ rootId: 'same' }), root({ rootId: 'tools', presence: 'target-only' })] }
    assert.deepEqual(
      rootsInScope(response, undefined).map((entry) => entry.rootId),
      ['shop', 'tools'],
    )
    assert.deepEqual(
      rootsInScope(response, 'tools').map((entry) => entry.rootId),
      ['tools'],
    )
    assert.deepEqual(rootsInScope(response, 'same'), [])
  })

  it('labels the base', () => {
    assert.equal(baseLabel('work', undefined), 'Working tree')
    assert.equal(baseLabel('HEAD', undefined), 'HEAD')
    assert.equal(baseLabel('refs/remotes/origin/main', undefined), 'origin/main')
    assert.equal(baseLabel('refs/remotes/origin/main', { commit: COMMIT }), 'merge base abcdef1')
  })
})
