import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GRAPH_OPTIONS, downDepthChange, graphScopeFor, parseCount, shownDownDepth } from '../ui/src/explore-options.ts'

describe('parseCount', () => {
  it('reads a whole number at or above the minimum', () => {
    assert.equal(parseCount('3', 0), 3)
    assert.equal(parseCount('0', 0), 0)
    assert.equal(parseCount(' 12 ', 1), 12)
  })

  it('rejects empty, fractional, negative and too small values', () => {
    for (const raw of ['', '  ', '1.5', '-1', 'abc', '1e']) assert.equal(parseCount(raw, 0), undefined, raw)
    assert.equal(parseCount('0', 1), undefined)
  })
})

describe('graph down depth', () => {
  it('shows the context depth around the package and its own depth for the whole root', () => {
    assert.equal(shownDownDepth(DEFAULT_GRAPH_OPTIONS, 2), 2)
    assert.equal(shownDownDepth({ ...DEFAULT_GRAPH_OPTIONS, scope: 'whole-root', wholeRootDown: 4 }, 2), 4)
  })

  it('changes the context depth around the package and the graph option for the whole root', () => {
    assert.deepEqual(downDepthChange(DEFAULT_GRAPH_OPTIONS, 3), { filters: { down: 3 } })
    assert.deepEqual(downDepthChange({ ...DEFAULT_GRAPH_OPTIONS, scope: 'whole-root' }, 3), { graph: { wholeRootDown: 3 } })
  })
})

describe('graphScopeFor', () => {
  it('shows the whole root when no package is anchored and the chosen scope otherwise', () => {
    assert.equal(graphScopeFor(DEFAULT_GRAPH_OPTIONS, undefined), 'whole-root')
    assert.equal(graphScopeFor(DEFAULT_GRAPH_OPTIONS, 'semver@5.7.2'), 'package')
    assert.equal(graphScopeFor({ ...DEFAULT_GRAPH_OPTIONS, scope: 'whole-root' }, 'semver@5.7.2'), 'whole-root')
  })
})
