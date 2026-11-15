import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BUMP_LIST_CAP, combineFixes, edgeFix, type EdgeFix } from '../src/query/fixes.ts'

describe('edgeFix', () => {
  const safe = ['5.7.3', '6.3.1']

  it('re-locks within the range', () => {
    assert.deepEqual(edgeFix({ current: '5.7.2', range: '2 || 3 || 4 || 5', parentIsImporter: false, safe }), { kind: 'within-range', version: '5.7.3' })
  })

  it('asks a package parent to bump', () => {
    assert.deepEqual(edgeFix({ current: '5.7.2', range: '5.7.2', parentIsImporter: false, safe }), { kind: 'bump-parent' })
  })

  it('raises an importer range to the lowest higher safe version', () => {
    assert.deepEqual(edgeFix({ current: '5.7.2', range: '5.7.2', parentIsImporter: true, safe }), { kind: 'bump-manifest', version: '5.7.3' })
    assert.deepEqual(edgeFix({ current: '7.0.0', range: '7.0.0', parentIsImporter: true, safe }), { kind: 'no-fix' })
  })

  it('reports no-fix and unknown', () => {
    assert.deepEqual(edgeFix({ current: '1.0.0', range: '^1.0.0', parentIsImporter: false, safe: [] }), { kind: 'no-fix' })
    assert.deepEqual(edgeFix({ current: '1.0.0', range: '^1.0.0', parentIsImporter: false, safe: undefined }), { kind: 'unknown' })
  })

  it('handles an undefined range', () => {
    assert.deepEqual(edgeFix({ current: '5.7.2', range: undefined, parentIsImporter: false, safe }), { kind: 'bump-parent' })
  })
})

describe('combineFixes', () => {
  const within = (version: string): EdgeFix => ({ kind: 'within-range', version })

  it('relocks when every edge is within range', () => {
    const same = combineFixes([{ parent: 'a', parentIsImporter: false, fix: within('5.7.3') }, { parent: 'b', parentIsImporter: false, fix: within('5.7.3') }])
    assert.equal(same.kind, 'relock')
    assert.equal(same.version, '5.7.3')
    const differing = combineFixes([{ parent: 'a', parentIsImporter: false, fix: within('5.7.3') }, { parent: 'b', parentIsImporter: false, fix: within('6.3.1') }])
    assert.equal(differing.kind, 'relock')
    assert.equal(differing.version, undefined)
  })

  it('is partial when some edges need a bump', () => {
    const result = combineFixes([{ parent: 'a', parentIsImporter: false, fix: within('5.7.3') }, { parent: 'b', parentIsImporter: false, fix: { kind: 'bump-parent' } }])
    assert.equal(result.kind, 'partial')
    assert.deepEqual(result.bump, [{ nodeId: 'b', isImporter: false }])
  })

  it('caps the bump list', () => {
    const edges = Array.from({ length: 25 }, (_, index) => ({ parent: `p${index}`, parentIsImporter: false, fix: { kind: 'bump-parent' } as EdgeFix }))
    const result = combineFixes(edges)
    assert.equal(result.kind, 'bump')
    assert.equal(result.bump.length, BUMP_LIST_CAP)
    assert.equal(result.bumpTruncated, 5)
  })

  it('handles empty, no-fix and unknown', () => {
    assert.equal(combineFixes([]).kind, 'unknown')
    assert.equal(combineFixes([{ parent: 'a', parentIsImporter: false, fix: { kind: 'no-fix' } }]).kind, 'no-fix')
    assert.equal(combineFixes([{ parent: 'a', parentIsImporter: false, fix: { kind: 'unknown' } }]).kind, 'unknown')
    assert.equal(combineFixes([{ parent: 'a', parentIsImporter: false, fix: { kind: 'unknown' } }, { parent: 'b', parentIsImporter: false, fix: { kind: 'no-fix' } }]).kind, 'unknown')
    assert.deepEqual(combineFixes([{ parent: 'a', parentIsImporter: false, fix: { kind: 'unknown' } }, { parent: 'b', parentIsImporter: false, fix: { kind: 'no-fix' } }]).bump, [])
  })
})
