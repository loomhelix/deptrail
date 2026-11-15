import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compileWorkspacePatterns } from '../src/config/glob.ts'

describe('compileWorkspacePatterns', () => {
  it('matches a single segment with *', () => {
    const matches = compileWorkspacePatterns(['packages/*'])
    assert.equal(matches('packages/a'), true)
    assert.equal(matches('packages/a/b'), false)
    assert.equal(matches('other/a'), false)
  })

  it('matches any number of segments with **', () => {
    const matches = compileWorkspacePatterns(['apps/**'])
    assert.equal(matches('apps/x/y'), true)
    assert.equal(matches('apps/x'), true)
    assert.equal(matches('libs/x'), false)
  })

  it('matches partial segments', () => {
    const matches = compileWorkspacePatterns(['packages/app-*'])
    assert.equal(matches('packages/app-web'), true)
    assert.equal(matches('packages/lib-web'), false)
  })

  it('excludes paths matched by a negated pattern', () => {
    const matches = compileWorkspacePatterns(['packages/**', '!**/test/**'])
    assert.equal(matches('packages/a'), true)
    assert.equal(matches('packages/test/x'), false)
  })

  it('lets later patterns override earlier ones', () => {
    const matches = compileWorkspacePatterns(['!packages/legacy', 'packages/*'])
    assert.equal(matches('packages/legacy'), true)
  })

  it('ignores leading ./ and trailing slashes in patterns', () => {
    const matches = compileWorkspacePatterns(['./packages/*/'])
    assert.equal(matches('packages/a'), true)
  })

  it('matches nothing for an empty pattern list', () => {
    assert.equal(compileWorkspacePatterns([])('packages/a'), false)
  })

  it('never lets a wildcard match a parent segment', () => {
    assert.equal(compileWorkspacePatterns(['**'])('../../libs/ui'), false)
    assert.equal(compileWorkspacePatterns(['*'])('..'), false)
    assert.equal(compileWorkspacePatterns(['../*/x'])('../../x'), false)
    assert.equal(compileWorkspacePatterns(['../../libs/*'])('../../libs/ui'), true)
    assert.equal(compileWorkspacePatterns(['../..'])('../..'), true)
    assert.equal(compileWorkspacePatterns(['../**'])('../a/b'), true)
    assert.equal(compileWorkspacePatterns(['../**'])('../../x'), false)
    assert.equal(compileWorkspacePatterns(['../*'])('../a'), true)
  })
})
