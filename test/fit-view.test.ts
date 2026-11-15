import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fitTransform } from '../ui/src/graph/fit-view.ts'

describe('fitTransform', () => {
  it('centers content that fits at its natural size', () => {
    assert.deepEqual(fitTransform({ width: 200, height: 100 }, { width: 600, height: 400 }), { x: 200, y: 150, k: 1 })
  })

  it('scales content down to fit inside the padded viewport', () => {
    const transform = fitTransform({ width: 828, height: 100 }, { width: 600, height: 400 })
    assert.equal(transform.k, 552 / 828)
    assert.equal(transform.x, 24)
    assert.equal(transform.y, (400 - 100 * transform.k) / 2)
  })

  it('stops at half size and centers the anchor along an axis that still overflows', () => {
    const transform = fitTransform({ width: 3000, height: 100 }, { width: 600, height: 400 }, { x: 2900, y: 50 })
    assert.deepEqual(transform, { x: 300 - 2900 * 0.5, y: (400 - 50) / 2, k: 0.5 })
  })

  it('starts an overflowing axis at the padding when there is no anchor', () => {
    assert.deepEqual(fitTransform({ width: 300, height: 3000 }, { width: 600, height: 400 }), { x: 225, y: 24, k: 0.5 })
  })

  it('offsets by the padding when the viewport is not measured yet', () => {
    assert.deepEqual(fitTransform({ width: 300, height: 300 }, { width: 0, height: 0 }), { x: 24, y: 24, k: 1 })
  })
})
