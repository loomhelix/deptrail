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

  it('expands brace sets, nested and negated ones too', () => {
    const matches = compileWorkspacePatterns(['apps/{web,api}', 'packages/{a,b/{c,d}}'])
    assert.equal(matches('apps/web'), true)
    assert.equal(matches('apps/api'), true)
    assert.equal(matches('apps/docs'), false)
    assert.equal(matches('packages/a'), true)
    assert.equal(matches('packages/b/d'), true)
    assert.equal(matches('packages/b'), false)
    const withoutLegacy = compileWorkspacePatterns(['packages/*', '!packages/{legacy,old}'])
    assert.equal(withoutLegacy('packages/legacy'), false)
    assert.equal(withoutLegacy('packages/old'), false)
    assert.equal(withoutLegacy('packages/new'), true)
    assert.equal(compileWorkspacePatterns(['../libs/{a,b}'])('../libs/b'), true)
  })

  it('keeps a brace without a comma or without its closing brace literal', () => {
    assert.equal(compileWorkspacePatterns(['packages/{a}'])('packages/{a}'), true)
    assert.equal(compileWorkspacePatterns(['packages/{a,b'])('packages/{a,b'), true)
    assert.equal(compileWorkspacePatterns(['packages/{a,b'])('packages/a'), false)
  })

  it('matches character classes and their negations', () => {
    const matches = compileWorkspacePatterns(['packages/app-[ab]', 'libs/[!x]*', 'tools/v[0-9]'])
    assert.equal(matches('packages/app-a'), true)
    assert.equal(matches('packages/app-c'), false)
    assert.equal(matches('libs/y1'), true)
    assert.equal(matches('libs/x1'), false)
    assert.equal(matches('tools/v7'), true)
    assert.equal(matches('tools/vx'), false)
    assert.equal(compileWorkspacePatterns(['packages/[a'])('packages/[a'), true)
  })

  it('never lets a wildcard match a directory that starts with a dot, as pnpm and npm do', () => {
    assert.equal(compileWorkspacePatterns(['packages/*'])('packages/.cache'), false)
    assert.equal(compileWorkspacePatterns(['packages/?cache'])('packages/.cache'), false)
    assert.equal(compileWorkspacePatterns(['packages/[.a]cache'])('packages/.cache'), false)
    assert.equal(compileWorkspacePatterns(['apps/**'])('apps/.turbo/x'), false)
    assert.equal(compileWorkspacePatterns(['apps/**'])('apps/x/.y'), false)
    assert.equal(compileWorkspacePatterns(['packages/.internal'])('packages/.internal'), true)
    assert.equal(compileWorkspacePatterns(['packages/.*'])('packages/.internal'), true)
    assert.equal(compileWorkspacePatterns(['packages/.*'])('packages/..'), false)
  })
})
