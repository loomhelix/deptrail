import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteRange, catalogNameOf } from '../src/actions/range-style.ts'

describe('rewriteRange', () => {
  const editableCases: [string, string][] = [
    ['^1.2.3', '^2.0.0'],
    ['^1.2', '^2.0.0'],
    ['^1', '^2.0.0'],
    ['~1.2.3', '~2.0.0'],
    ['~1.2', '~2.0.0'],
    ['1.2.3', '2.0.0'],
    ['npm:string-width@^4.2.0', 'npm:string-width@^2.0.0'],
    ['npm:@scope/x@~1.0.0', 'npm:@scope/x@~2.0.0']
  ]
  for (const [specifier, expected] of editableCases) {
    it(`keeps the form of ${specifier}`, () => {
      assert.deepEqual(rewriteRange(specifier, '2.0.0'), { editable: true, specifier: expected, formChanged: false })
    })
  }

  for (const specifier of ['>=1.2.0 <2', '1.x']) {
    it(`falls back to a caret for ${specifier}`, () => {
      assert.deepEqual(rewriteRange(specifier, '2.0.0'), { editable: true, specifier: '^2.0.0', formChanged: true })
    })
  }

  const rejectedCases: [string, string][] = [
    ['workspace:*', 'workspace: specifiers are not edited'],
    ['catalog:', 'catalog entries are edited in pnpm-workspace.yaml'],
    ['github:u/r', 'github:u/r is not a registry range'],
    ['npm:x', 'npm:x has no version range'],
    ['latest', 'dist-tag latest is not edited']
  ]
  for (const [specifier, reason] of rejectedCases) {
    it(`rejects ${specifier}`, () => {
      assert.deepEqual(rewriteRange(specifier, '2.0.0'), { editable: false, reason })
    })
  }
})

describe('catalogNameOf', () => {
  it('names the catalog', () => {
    assert.equal(catalogNameOf('catalog:'), 'default')
    assert.equal(catalogNameOf('catalog:react18'), 'react18')
    assert.equal(catalogNameOf('^1.0.0'), undefined)
  })
})
