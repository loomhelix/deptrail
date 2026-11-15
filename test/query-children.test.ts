import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { children } from '../src/query/children.ts'
import { ALL_KINDS, UnknownNodeError } from '../src/query/lookup.ts'
import type { DepKind } from '../src/model.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const WITHOUT_DEV: ReadonlySet<DepKind> = new Set<DepKind>(['prod', 'optional', 'peer'])

describe('children', () => {
  it('returns direct rows in deps order with hasChildren', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0', 'dev:b@2.0.0'] },
      packages: { 'a@1.0.0': ['c@3.0.0'], 'b@2.0.0': [], 'c@3.0.0': [] },
    })
    const result = children(graph, 'importer:app', 1, ALL_KINDS)
    assert.equal(result.node.id, 'importer:app')
    assert.deepEqual(
      result.rows.map((row) => [row.node.id, row.kind, row.range, row.hasChildren, row.repeated]),
      [
        ['a@1.0.0', 'prod', '1.0.0', true, false],
        ['b@2.0.0', 'dev', '2.0.0', false, false],
      ],
    )
    assert.deepEqual(result.nested, {})
  })

  it('filters rows and hasChildren by kind', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0', 'dev:b@2.0.0'] },
      packages: { 'a@1.0.0': ['dev:c@3.0.0'], 'b@2.0.0': [], 'c@3.0.0': [] },
    })
    const result = children(graph, 'importer:app', 1, WITHOUT_DEV)
    assert.deepEqual(result.rows.map((row) => [row.node.id, row.hasChildren]), [['a@1.0.0', false]])
  })

  it('marks the second occurrence of a shared child repeated', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0', 'b@1.0.0'] },
      packages: {
        'a@1.0.0': ['shared@1.0.0'],
        'b@1.0.0': ['shared@1.0.0'],
        'shared@1.0.0': ['leaf@1.0.0'],
        'leaf@1.0.0': [],
      },
    })
    const result = children(graph, 'importer:app', 3, ALL_KINDS)
    assert.equal(result.nested['a@1.0.0'][0].repeated, false)
    assert.equal(result.nested['b@1.0.0'][0].repeated, true)
    assert.deepEqual(Object.keys(result.nested).sort(), ['a@1.0.0', 'b@1.0.0', 'shared@1.0.0'])
    assert.equal(result.nested['shared@1.0.0'][0].node.id, 'leaf@1.0.0')
  })

  it('limits nesting to the requested depth', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0'] },
      packages: { 'a@1.0.0': ['b@1.0.0'], 'b@1.0.0': ['c@1.0.0'], 'c@1.0.0': [] },
    })
    const result = children(graph, 'importer:app', 2, ALL_KINDS)
    assert.deepEqual(Object.keys(result.nested), ['a@1.0.0'])
    assert.equal(children(graph, 'importer:app', 0, ALL_KINDS).rows.length, 1)
  })

  it('terminates on a package cycle back to the focus', () => {
    const graph = makeGraph({
      importers: {},
      packages: { 'x@1.0.0': ['y@1.0.0'], 'y@1.0.0': ['x@1.0.0'] },
    })
    const result = children(graph, 'x@1.0.0', 10, ALL_KINDS)
    assert.deepEqual(Object.keys(result.nested), ['y@1.0.0'])
    assert.equal(result.nested['y@1.0.0'][0].repeated, true)
  })

  it('terminates on an importer cycle', () => {
    const graph = makeGraph({ importers: { a: ['importer:b'], b: ['importer:a'] }, packages: {} })
    const result = children(graph, 'importer:a', 10, ALL_KINDS)
    assert.equal(result.rows[0].node.id, 'importer:b')
    assert.equal(result.nested['importer:b'][0].repeated, true)
  })

  it('throws UnknownNodeError for an unknown id', () => {
    const graph = makeGraph({ importers: {}, packages: {} })
    assert.throws(() => children(graph, 'nope@1.0.0', 1, ALL_KINDS), UnknownNodeError)
  })
})
