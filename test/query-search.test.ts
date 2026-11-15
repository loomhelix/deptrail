import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildGlobalIndex } from '../src/graph/global-index.ts'
import { search } from '../src/query/search.ts'
import { makeGraph } from './helpers/graph-factory.ts'

function indexWithSemver() {
  const main = { ...makeGraph({ importers: {}, packages: { 'semver@5.7.2': [], 'semver@7.6.3': [], 'semver-diff@4.0.0': [], 'lodash@4.17.21': [] } }), id: 'npm-package' }
  const legacy = { ...makeGraph({ importers: {}, packages: { 'semver@6.3.1': [], 'semver@5.7.2': [] } }), id: 'legacy/admin' }
  const manifestOnly = { ...makeGraph({ importers: {}, packages: { 'semver@^7.6.0': [], '@vue/compiler-sfc@3.5.0': [] } }), id: 'tools/ci' }
  return buildGlobalIndex([main, legacy, manifestOnly])
}

function versionsOf(hit: { versions: { version: string }[] }) {
  return hit.versions.map((entry) => entry.version)
}

describe('search', () => {
  it('filters versions with name@range', () => {
    const hits = search(indexWithSemver(), 'semver@<7')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].name, 'semver')
    assert.deepEqual(versionsOf(hits[0]), ['6.3.1', '5.7.2'])
    assert.deepEqual(hits[0].versions[1].roots, [
      { rootId: 'legacy/admin', nodeId: 'semver@5.7.2' },
      { rootId: 'npm-package', nodeId: 'semver@5.7.2' },
    ])
  })

  it('matches name exactly for name@range and ignores a range with no matches', () => {
    assert.deepEqual(search(indexWithSemver(), 'semver-d@>=1'), [])
    assert.deepEqual(search(indexWithSemver(), 'semver@>=9'), [])
  })

  it('returns no hits for an invalid range', () => {
    assert.deepEqual(search(indexWithSemver(), 'semver@not-a-range'), [])
  })

  it('treats a leading @ as part of the name', () => {
    const hits = search(indexWithSemver(), '@vue/comp')
    assert.deepEqual(hits.map((hit) => hit.name), ['@vue/compiler-sfc'])
  })

  it('splits a scoped name on the last @', () => {
    const hits = search(indexWithSemver(), '@vue/compiler-sfc@>=3')
    assert.deepEqual(hits.map((hit) => hit.name), ['@vue/compiler-sfc'])
  })

  it('does a case-insensitive substring match with exact and shorter names first', () => {
    const hits = search(indexWithSemver(), 'SEMVER')
    assert.deepEqual(hits.map((hit) => hit.name), ['semver', 'semver-diff'])
    assert.deepEqual(versionsOf(hits[0]), ['7.6.3', '6.3.1', '5.7.2', '^7.6.0'])
  })

  it('caps the number of hits', () => {
    assert.equal(search(indexWithSemver(), 'semver', 1).length, 1)
  })

  it('returns nothing for a blank query', () => {
    assert.deepEqual(search(indexWithSemver(), '   '), [])
  })

  it('serializes to plain JSON', () => {
    const hits = search(indexWithSemver(), 'semver')
    assert.deepEqual(JSON.parse(JSON.stringify(hits)), hits)
  })
})
