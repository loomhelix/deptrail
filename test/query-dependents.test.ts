import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dependents } from '../src/query/dependents.ts'
import { ALL_KINDS, UnknownNodeError, lookup } from '../src/query/lookup.ts'
import type { DepKind } from '../src/model.ts'
import { makeFanIn, makeGraph } from './helpers/graph-factory.ts'
import { fastestRun } from './helpers/timing.ts'

function semverExample(commerceUiEdge: string) {
  return makeGraph({
    importers: {
      'commerce-ui': [commerceUiEdge],
      storefront: ['eslint-plugin-vue@9.32.0'],
      'tools/build': ['read-pkg-up@7.0.1'],
    },
    packages: {
      'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
      'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
      'read-pkg-up@7.0.1': ['normalize-package-data@2.5.0'],
      'normalize-package-data@2.5.0': ['semver@5.7.2'],
      'semver@5.7.2': [],
    },
  })
}

const WITHOUT_DEV: ReadonlySet<DepKind> = new Set<DepKind>(['prod', 'optional', 'peer'])

describe('dependents summary', () => {
  it('lists importers and direct dependencies for the spec example', () => {
    const result = dependents(semverExample('eslint-plugin-vue@9.32.0'), 'semver@5.7.2', 10, ALL_KINDS)
    assert.deepEqual(result.summary, {
      importers: ['importer:commerce-ui', 'importer:storefront', 'importer:tools/build'],
      via: [
        { direct: 'eslint-plugin-vue@9.32.0', importers: ['importer:commerce-ui', 'importer:storefront'] },
        { direct: 'read-pkg-up@7.0.1', importers: ['importer:tools/build'] },
      ],
    })
    assert.equal(result.truncated, false)
  })

  it('drops dev-only paths from the summary when dev is not selected', () => {
    const result = dependents(semverExample('dev:eslint-plugin-vue@9.32.0'), 'semver@5.7.2', 10, WITHOUT_DEV)
    assert.deepEqual(result.summary, {
      importers: ['importer:storefront', 'importer:tools/build'],
      via: [
        { direct: 'eslint-plugin-vue@9.32.0', importers: ['importer:storefront'] },
        { direct: 'read-pkg-up@7.0.1', importers: ['importer:tools/build'] },
      ],
    })
  })

  it('ignores maxDepth in the summary but not in the nodes', () => {
    const result = dependents(semverExample('eslint-plugin-vue@9.32.0'), 'semver@5.7.2', 1, ALL_KINDS)
    assert.deepEqual(
      result.nodes.map((entry) => entry.node.id).sort(),
      ['normalize-package-data@2.5.0', 'vue-eslint-parser@9.4.3'],
    )
    assert.equal(result.summary.importers.length, 3)
  })

  it('reports the focus as a direct dependency when an importer depends on it', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0', 'b@1.0.0'] },
      packages: { 'a@1.0.0': ['b@1.0.0'], 'b@1.0.0': [] },
    })
    const result = dependents(graph, 'b@1.0.0', 5, ALL_KINDS)
    assert.deepEqual(result.summary.via, [
      { direct: 'a@1.0.0', importers: ['importer:app'] },
      { direct: 'b@1.0.0', importers: ['importer:app'] },
    ])
  })
})

describe('dependents dag', () => {
  it('lists each node of a diamond once with all parents and BFS depth', () => {
    const graph = makeGraph({
      importers: { app: ['top@1.0.0'] },
      packages: {
        'top@1.0.0': ['left@1.0.0', 'right@1.0.0'],
        'left@1.0.0': ['bottom@1.0.0'],
        'right@1.0.0': ['bottom@1.0.0'],
        'bottom@1.0.0': [],
      },
    })
    const result = dependents(graph, 'bottom@1.0.0', 10, ALL_KINDS)
    const ids = result.nodes.map((entry) => entry.node.id)
    assert.deepEqual(ids, ['left@1.0.0', 'right@1.0.0', 'top@1.0.0', 'importer:app'])
    assert.deepEqual(result.nodes.map((entry) => entry.depth), [1, 1, 2, 3])
    const top = result.nodes.find((entry) => entry.node.id === 'top@1.0.0')
    assert.deepEqual(top?.parents, [{ id: 'importer:app', kind: 'prod', range: '1.0.0' }])
    assert.equal(result.focus.id, 'bottom@1.0.0')
  })

  it('lists the passing parent links of the focus with their requested ranges', () => {
    const graph = makeGraph({
      importers: { app: ['dev:bottom@1.0.0', 'top@1.0.0'] },
      packages: { 'top@1.0.0': ['bottom@1.0.0'], 'bottom@1.0.0': [] },
    })
    assert.deepEqual(dependents(graph, 'bottom@1.0.0', 1, ALL_KINDS).focusParents, [
      { id: 'importer:app', kind: 'dev', range: '1.0.0' },
      { id: 'top@1.0.0', kind: 'prod', range: '1.0.0' },
    ])
    assert.deepEqual(dependents(graph, 'bottom@1.0.0', 1, WITHOUT_DEV).focusParents, [
      { id: 'top@1.0.0', kind: 'prod', range: '1.0.0' },
    ])
  })

  it('terminates on a package cycle', () => {
    const graph = makeGraph({
      importers: { app: ['x@1.0.0'] },
      packages: { 'x@1.0.0': ['y@1.0.0'], 'y@1.0.0': ['x@1.0.0'] },
    })
    const result = dependents(graph, 'x@1.0.0', 10, ALL_KINDS)
    assert.deepEqual(result.nodes.map((entry) => entry.node.id).sort(), ['importer:app', 'y@1.0.0'])
    assert.deepEqual(result.summary.importers, ['importer:app'])
  })

  it('terminates on an importer cycle', () => {
    const graph = makeGraph({
      importers: { a: ['importer:b', 'lib@1.0.0'], b: ['importer:a'] },
      packages: { 'lib@1.0.0': [] },
    })
    const result = dependents(graph, 'lib@1.0.0', 10, ALL_KINDS)
    assert.deepEqual(result.nodes.map((entry) => entry.node.id).sort(), ['importer:a', 'importer:b'])
    assert.deepEqual(result.summary.importers, ['importer:a', 'importer:b'])
    assert.deepEqual(result.summary.via, [{ direct: 'lib@1.0.0', importers: ['importer:a'] }])
  })

  it('reports the first passing kind of a parent link', () => {
    const graph = makeGraph({
      importers: { app: ['dev:mid@1.0.0', 'mid@1.0.0'] },
      packages: { 'mid@1.0.0': ['lib@1.0.0'], 'lib@1.0.0': [] },
    })
    const withDev = dependents(graph, 'lib@1.0.0', 5, ALL_KINDS)
    assert.equal(withDev.nodes[0].parents[0].kind, 'dev')
    const withoutDev = dependents(graph, 'lib@1.0.0', 5, WITHOUT_DEV)
    assert.equal(withoutDev.nodes[0].parents[0].kind, 'prod')
  })

  it('truncates a fan-in of 20000 dependents within 100 ms', () => {
    const graph = makeFanIn(20000)
    const { result, elapsed } = fastestRun(() => dependents(graph, 'tslib@2.6.0', 5, ALL_KINDS))
    assert.equal(result.truncated, true)
    assert.ok(result.nodes.length <= 5000)
    assert.equal(result.summary.importers.length, 10)
    assert.ok(elapsed < 100, `took ${elapsed} ms`)
  })

  it('honors a custom node limit', () => {
    const result = dependents(makeFanIn(50), 'tslib@2.6.0', 5, ALL_KINDS, 10)
    assert.equal(result.nodes.length, 10)
    assert.equal(result.truncated, true)
  })

  it('throws UnknownNodeError for an unknown id', () => {
    assert.throws(() => dependents(makeFanIn(1), 'nope@1.0.0', 1, ALL_KINDS), UnknownNodeError)
  })
})

describe('lookup', () => {
  it('describes packages, importers and placeholders', () => {
    const graph = makeGraph({ importers: { app: ['missing@1.0.0', 'lib@1.0.0'] }, packages: { 'lib@1.0.0': [] } })
    assert.deepEqual(lookup(graph, 'lib@1.0.0'), {
      id: 'lib@1.0.0',
      name: 'lib',
      version: '1.0.0',
      isImporter: false,
      isPlaceholder: false,
    })
    assert.deepEqual(lookup(graph, 'importer:app'), {
      id: 'importer:app',
      name: 'app',
      version: '',
      isImporter: true,
      isPlaceholder: false,
    })
    assert.equal(lookup(graph, '?:missing@1.0.0')?.isPlaceholder, true)
    assert.equal(lookup(graph, 'absent@1.0.0'), undefined)
  })
})
