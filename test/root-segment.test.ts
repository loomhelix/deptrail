import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeRootSegment, encodeRootSegment } from '../src/server/root-segment.ts'

describe('root segment codec', () => {
  it('maps the repository root to a tilde', () => {
    assert.equal(encodeRootSegment('.'), '~')
    assert.equal(decodeRootSegment('~'), '.')
  })

  it('escapes a root literally named tilde', () => {
    assert.equal(encodeRootSegment('~'), '%7E')
    assert.equal(decodeRootSegment('%7E'), '~')
  })

  it('round-trips ordinary and slash-containing ids', () => {
    for (const id of ['npm-package', 'legacy/admin', '@scope/pkg', 'a b']) {
      assert.equal(decodeRootSegment(encodeRootSegment(id)), id)
    }
  })
})
