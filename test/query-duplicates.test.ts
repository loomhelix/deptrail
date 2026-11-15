import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildGlobalIndex } from '../src/graph/global-index.ts'
import { duplicates } from '../src/query/duplicates.ts'
import { makeGraph } from './helpers/graph-factory.ts'

function monolithIndex() {
  const main = {
    ...makeGraph({
      importers: {},
      packages: { 'semver@5.7.2': [], 'semver@7.6.3': [], 'lodash@4.17.21': [], 'react@18.0.0': [] },
    }),
    id: 'npm-package',
  }
  const legacy = {
    ...makeGraph({ importers: {}, packages: { 'semver@6.3.1': [], 'lodash@4.17.20': [], 'react@18.0.0': [] } }),
    id: 'legacy/admin',
  }
  const manifestOnly = { ...makeGraph({ importers: {}, packages: { 'semver@^7.6.0': [], 'lodash@^4.0.0': [] } }), id: 'tools/ci' }
  return buildGlobalIndex([main, legacy, manifestOnly])
}

describe('duplicates', () => {
  it('limits a root to its own versions', () => {
    assert.deepEqual(duplicates(monolithIndex(), 'npm-package'), [
      { name: 'semver', versions: [{ version: '7.6.3', roots: ['npm-package'] }, { version: '5.7.2', roots: ['npm-package'] }] },
    ])
  })

  it('combines roots across the monolith and ignores range versions', () => {
    assert.deepEqual(duplicates(monolithIndex()), [
      {
        name: 'semver',
        versions: [
          { version: '7.6.3', roots: ['npm-package'] },
          { version: '6.3.1', roots: ['legacy/admin'] },
          { version: '5.7.2', roots: ['npm-package'] },
        ],
      },
      {
        name: 'lodash',
        versions: [
          { version: '4.17.21', roots: ['npm-package'] },
          { version: '4.17.20', roots: ['legacy/admin'] },
        ],
      },
    ])
  })

  it('does not count one version in several roots as a duplicate', () => {
    const names = duplicates(monolithIndex()).map((entry) => entry.name)
    assert.ok(!names.includes('react'))
  })

  it('returns nothing for an unknown root', () => {
    assert.deepEqual(duplicates(monolithIndex(), 'missing'), [])
  })

  it('serializes to plain JSON', () => {
    const result = duplicates(monolithIndex())
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  })
})
