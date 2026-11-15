import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ALL_KINDS, UnknownNodeError } from '../src/query/lookup.ts'
import { subgraph } from '../src/query/subgraph.ts'
import type { DepKind } from '../src/model.ts'
import { makeFanIn, makeGraph } from './helpers/graph-factory.ts'
import { fastestRun } from './helpers/timing.ts'

const PARSER = 'vue-eslint-parser@9.4.3'

function parserGraph() {
  return makeGraph({
    importers: { app: ['eslint-plugin-vue@9.32.0'] },
    packages: {
      'eslint-plugin-vue@9.32.0': [PARSER],
      [PARSER]: ['semver@5.7.2', 'espree@9.6.1'],
      'semver@5.7.2': [],
      'espree@9.6.1': [],
    },
  })
}

function layersById(result: ReturnType<typeof subgraph>) {
  return Object.fromEntries(result.nodes.map((entry) => [entry.node.id, entry.layer]))
}

describe('subgraph layers', () => {
  it('places parents above and children below the focus', () => {
    const result = subgraph(parserGraph(), PARSER, { up: 1, down: 1, limit: 300, kinds: ALL_KINDS })
    assert.equal(result.focus, PARSER)
    assert.deepEqual(layersById(result), {
      [PARSER]: 0,
      'eslint-plugin-vue@9.32.0': -1,
      'semver@5.7.2': 1,
      'espree@9.6.1': 1,
    })
    assert.equal(result.truncated, false)
    assert.deepEqual(result.edges, [
      { from: PARSER, to: 'semver@5.7.2', kind: 'prod' },
      { from: PARSER, to: 'espree@9.6.1', kind: 'prod' },
      { from: 'eslint-plugin-vue@9.32.0', to: PARSER, kind: 'prod' },
    ])
    assert.deepEqual(result.stubs, [{ at: 'eslint-plugin-vue@9.32.0', side: 'up', hidden: 1 }])
  })

  it('walks several layers in each direction and keeps the first layer of a node', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0'] },
      packages: { 'a@1.0.0': ['b@1.0.0', 'c@1.0.0'], 'b@1.0.0': ['c@1.0.0'], 'c@1.0.0': ['d@1.0.0'], 'd@1.0.0': [] },
    })
    const result = subgraph(graph, 'b@1.0.0', { up: 5, down: 5, limit: 300, kinds: ALL_KINDS })
    assert.deepEqual(layersById(result), {
      'b@1.0.0': 0,
      'a@1.0.0': -1,
      'importer:app': -2,
      'c@1.0.0': 1,
      'd@1.0.0': 2,
    })
    assert.equal(result.edges.length, 5)
    assert.deepEqual(result.stubs, [])
  })

  it('does not expand upward nodes downward', () => {
    const graph = makeGraph({
      importers: {},
      packages: { 'top@1.0.0': ['mid@1.0.0', 'side@1.0.0'], 'mid@1.0.0': ['leaf@1.0.0'], 'leaf@1.0.0': [], 'side@1.0.0': [] },
    })
    const result = subgraph(graph, 'leaf@1.0.0', { up: 2, down: 2, limit: 300, kinds: ALL_KINDS })
    assert.deepEqual(Object.keys(layersById(result)).sort(), ['leaf@1.0.0', 'mid@1.0.0', 'top@1.0.0'])
    assert.deepEqual(result.edges.length, 2)
  })

  it('stubs a hidden neighbour count on the frontier', () => {
    const result = subgraph(parserGraph(), PARSER, { up: 0, down: 0, limit: 300, kinds: ALL_KINDS })
    assert.deepEqual(result.stubs, [
      { at: PARSER, side: 'up', hidden: 1 },
      { at: PARSER, side: 'down', hidden: 2 },
    ])
  })

  it('stops at the node limit with exact stub counts', () => {
    const result = subgraph(parserGraph(), PARSER, { up: 1, down: 1, limit: 3, kinds: ALL_KINDS })
    assert.equal(result.nodes.length, 3)
    assert.equal(result.truncated, true)
    assert.deepEqual(result.stubs, [
      { at: PARSER, side: 'down', hidden: 1 },
      { at: 'eslint-plugin-vue@9.32.0', side: 'up', hidden: 1 },
    ])
  })

  it('is not truncated when the limit equals the reachable node count', () => {
    const result = subgraph(parserGraph(), PARSER, { up: 1, down: 1, limit: 4, kinds: ALL_KINDS })
    assert.equal(result.nodes.length, 4)
    assert.equal(result.truncated, false)
  })

  it('terminates on cycles', () => {
    const graph = makeGraph({
      importers: {},
      packages: { 'a@1.0.0': ['b@1.0.0'], 'b@1.0.0': ['c@1.0.0'], 'c@1.0.0': ['a@1.0.0'] },
    })
    const result = subgraph(graph, 'a@1.0.0', { up: 10, down: 10, limit: 300, kinds: ALL_KINDS })
    assert.equal(result.nodes.length, 3)
    assert.equal(result.edges.length, 3)
    assert.deepEqual(result.stubs, [])
  })

  it('honours the kind filter for walking, edges and stubs', () => {
    const graph = makeGraph({
      importers: {},
      packages: { 'a@1.0.0': ['b@1.0.0', 'dev:c@1.0.0'], 'b@1.0.0': [], 'c@1.0.0': [] },
    })
    const withoutDev: ReadonlySet<DepKind> = new Set<DepKind>(['prod', 'optional', 'peer'])
    const result = subgraph(graph, 'a@1.0.0', { up: 1, down: 1, limit: 300, kinds: withoutDev })
    assert.deepEqual(Object.keys(layersById(result)).sort(), ['a@1.0.0', 'b@1.0.0'])
    assert.deepEqual(result.stubs, [])
  })

  it('throws UnknownNodeError for an unknown focus', () => {
    assert.throws(
      () => subgraph(parserGraph(), 'nope@1.0.0', { up: 1, down: 1, limit: 300, kinds: ALL_KINDS }),
      UnknownNodeError,
    )
  })

  it('answers a tslib-like fan-in in under 100 ms', () => {
    const graph = makeFanIn(20000)
    const { result, elapsed } = fastestRun(() => subgraph(graph, 'tslib@2.6.0', { up: 2, down: 2, limit: 300, kinds: ALL_KINDS }))
    assert.equal(result.nodes.length, 300)
    assert.equal(result.truncated, true)
    assert.deepEqual(result.stubs.find((stub) => stub.at === 'tslib@2.6.0'), { at: 'tslib@2.6.0', side: 'up', hidden: 19701 })
    assert.ok(elapsed < 100, `took ${elapsed} ms`)
  })

  it('serializes to plain JSON', () => {
    const result = subgraph(parserGraph(), PARSER, { up: 1, down: 1, limit: 3, kinds: ALL_KINDS })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  })
})
