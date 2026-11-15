import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RootGraph } from '../src/model.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import { subgraph } from '../src/query/subgraph.ts'
import { fittedText, type GraphScene } from '../ui/src/graph/graph-scene.ts'
import { clusterNodes, firstNodesByLayer, mergeImporterSubgraphs, wholeRootScene, type MergedRoot } from '../ui/src/graph/whole-root.ts'
import { packageNameOf, versionOf } from '../ui/src/node-id.ts'
import { makeGraph, type GraphSpec } from './helpers/graph-factory.ts'

const WEB = 'importer:web'
const ADMIN = 'importer:admin'

const MONOREPO: GraphSpec = {
  importers: { web: ['shared@1.0.0', '@vue/core@3.0.0'], admin: ['shared@1.0.0', 'tool@1.0.0', 'deep@1.0.0'] },
  packages: {
    'shared@1.0.0': ['deep@1.0.0'],
    'deep@1.0.0': [],
    '@vue/core@3.0.0': ['@vue/shared@3.0.0', '@vue/reactivity@3.0.0'],
    '@vue/shared@3.0.0': [],
    '@vue/reactivity@3.0.0': ['@vue/shared@3.0.0'],
    'tool@1.0.0': ['helper@1.0.0', 'util@1.0.0'],
    'helper@1.0.0': [],
    'util@1.0.0': [],
  },
}

function mergeAll(graph: RootGraph, limit = 300): MergedRoot {
  const results = graph.importers.map((importer) => subgraph(graph, importer.id, { up: 0, down: 6, limit, kinds: ALL_KINDS }))
  return mergeImporterSubgraphs(results)
}

function layers(merged: MergedRoot): string[] {
  return merged.nodes.map((entry) => `${entry.node.id}@${entry.layer}`)
}

function outline(scene: GraphScene): string[] {
  return scene.nodes.map((node) => `${node.kind} ${node.kind === 'cluster' ? node.label : node.key} @${node.layer}`)
}

function edgeLabels(scene: GraphScene): string[] {
  const labelOf = new Map(scene.nodes.map((node) => [node.key, node.kind === 'cluster' ? `[${node.label}]` : node.key]))
  return scene.edges.map((edge) => `${labelOf.get(edge.from)} -> ${labelOf.get(edge.to)}`).sort()
}

describe('mergeImporterSubgraphs', () => {
  it('places each node at its smallest depth below any importer, ordered by layer then first appearance', () => {
    const merged = mergeAll(makeGraph(MONOREPO))
    assert.deepEqual(layers(merged), [
      `${WEB}@0`,
      `${ADMIN}@0`,
      'shared@1.0.0@1',
      '@vue/core@3.0.0@1',
      'deep@1.0.0@1',
      'tool@1.0.0@1',
      '@vue/shared@3.0.0@2',
      '@vue/reactivity@3.0.0@2',
      'helper@1.0.0@2',
      'util@1.0.0@2',
    ])
    assert.equal(merged.truncated, false)
  })

  it('records which importers reach each node and keeps each edge once', () => {
    const merged = mergeAll(makeGraph(MONOREPO))
    assert.deepEqual(merged.reachedBy.get('deep@1.0.0'), [WEB, ADMIN])
    assert.deepEqual(merged.reachedBy.get('tool@1.0.0'), [ADMIN])
    assert.equal(merged.edges.filter((edge) => edge.from === 'shared@1.0.0' && edge.to === 'deep@1.0.0').length, 1)
    assert.equal(merged.edges.length, 11)
  })

  it('keeps importers at layer 0 when another importer depends on them', () => {
    const graph = makeGraph({ importers: { web: ['importer:admin'], admin: ['tool@1.0.0'] }, packages: { 'tool@1.0.0': [] } })
    const merged = mergeAll(graph)
    assert.deepEqual(layers(merged), [`${WEB}@0`, `${ADMIN}@0`, 'tool@1.0.0@1'])
  })

  it('is truncated when any importer subgraph was truncated', () => {
    assert.equal(mergeAll(makeGraph(MONOREPO), 3).truncated, true)
  })
})

describe('firstNodesByLayer', () => {
  it('keeps the first nodes by layer and the edges between them', () => {
    const merged = mergeAll(makeGraph(MONOREPO))
    const kept = firstNodesByLayer(merged, 4)
    assert.deepEqual(layers(kept), [`${WEB}@0`, `${ADMIN}@0`, 'shared@1.0.0@1', '@vue/core@3.0.0@1'])
    assert.deepEqual(kept.edges.map((edge) => `${edge.from} -> ${edge.to}`).sort(), [
      `${ADMIN} -> shared@1.0.0`,
      `${WEB} -> @vue/core@3.0.0`,
      `${WEB} -> shared@1.0.0`,
    ])
    assert.equal(firstNodesByLayer(merged, 300), merged)
  })
})

describe('clusterNodes', () => {
  it('groups packages by the workspace packages that pull them in, skipping importers and single packages', () => {
    const clusters = clusterNodes(mergeAll(makeGraph(MONOREPO)))
    assert.deepEqual(
      clusters.map((cluster) => ({ label: cluster.label, title: cluster.title, memberIds: cluster.memberIds })),
      [
        { label: 'Shared by web + admin (2)', title: 'Packages that web and admin both depend on', memberIds: ['shared@1.0.0', 'deep@1.0.0'] },
        { label: 'Only in web (3)', title: 'Packages only web depends on', memberIds: ['@vue/core@3.0.0', '@vue/shared@3.0.0', '@vue/reactivity@3.0.0'] },
        { label: 'Only in admin (3)', title: 'Packages only admin depends on', memberIds: ['tool@1.0.0', 'helper@1.0.0', 'util@1.0.0'] },
      ],
    )
    assert.equal(new Set(clusters.map((cluster) => cluster.id)).size, 3)
  })

  it('keeps scoped and unscoped packages of the same workspace packages in one cluster', () => {
    const graph = makeGraph({
      importers: { web: ['@vue/core@3.0.0', 'lodash@4.0.0'] },
      packages: { '@vue/core@3.0.0': [], 'lodash@4.0.0': [] },
    })
    assert.deepEqual(
      clusterNodes(mergeAll(graph)).map((cluster) => [cluster.label, cluster.memberIds]),
      [['Only in web (2)', ['@vue/core@3.0.0', 'lodash@4.0.0']]],
    )
  })

  it('counts packages shared by three or more workspace packages and names them all in the title', () => {
    const graph = makeGraph({
      importers: { a: ['x@1.0.0'], b: ['x@1.0.0'], c: ['x@1.0.0'] },
      packages: { 'x@1.0.0': ['y@1.0.0'], 'y@1.0.0': [] },
    })
    assert.deepEqual(
      clusterNodes(mergeAll(graph)).map((cluster) => [cluster.label, cluster.title]),
      [['Shared by 3 workspace packages (2)', 'Packages that a, b, and c all depend on']],
    )
  })
})

describe('wholeRootScene', () => {
  it('draws each collapsed cluster as one node at its shallowest layer with remapped edges', () => {
    const merged = mergeAll(makeGraph(MONOREPO))
    const scene = wholeRootScene(merged, clusterNodes(merged), new Set())
    assert.deepEqual(outline(scene), [
      `importer ${WEB} @0`,
      `importer ${ADMIN} @0`,
      'cluster Shared by web + admin (2) @1',
      'cluster Only in web (3) @1',
      'cluster Only in admin (3) @1',
    ])
    const shared = scene.nodes.find((node) => node.label === 'Shared by web + admin (2)')!
    assert.equal(shared.text, fittedText('Shared by web + admin', shared.width, ' (2)'))
    assert.ok(shared.text.endsWith(' (2)'))
    assert.equal(shared.kind === 'cluster' ? shared.title : undefined, 'Packages that web and admin both depend on')
    assert.deepEqual(edgeLabels(scene), [
      `${ADMIN} -> [Only in admin (3)]`,
      `${ADMIN} -> [Shared by web + admin (2)]`,
      `${WEB} -> [Only in web (3)]`,
      `${WEB} -> [Shared by web + admin (2)]`,
    ])
  })

  it('shows the members of an expanded cluster', () => {
    const merged = mergeAll(makeGraph(MONOREPO))
    const clusters = clusterNodes(merged)
    const vue = clusters.find((cluster) => cluster.label === 'Only in web (3)')!
    const scene = wholeRootScene(merged, clusters, new Set([vue.id]))
    assert.deepEqual(outline(scene), [
      `importer ${WEB} @0`,
      `importer ${ADMIN} @0`,
      'cluster Shared by web + admin (2) @1',
      'package @vue/core@3.0.0 @1',
      'cluster Only in admin (3) @1',
      'package @vue/shared@3.0.0 @2',
      'package @vue/reactivity@3.0.0 @2',
    ])
    assert.deepEqual(edgeLabels(scene), [
      '@vue/core@3.0.0 -> @vue/reactivity@3.0.0',
      '@vue/core@3.0.0 -> @vue/shared@3.0.0',
      '@vue/reactivity@3.0.0 -> @vue/shared@3.0.0',
      `${ADMIN} -> [Only in admin (3)]`,
      `${ADMIN} -> [Shared by web + admin (2)]`,
      `${WEB} -> @vue/core@3.0.0`,
      `${WEB} -> [Shared by web + admin (2)]`,
    ])
  })
})

describe('wholeRootScene with peer variants', () => {
  it('labels a variant node and leaves the others alone', () => {
    const graph = makeGraph({
      importers: { web: ['lib@1.0.0'], admin: ['lib@1.0.0(x@1.0.0)', 'other@1.0.0'] },
      packages: { 'lib@1.0.0': [], 'lib@1.0.0(x@1.0.0)': [], 'other@1.0.0': [] },
    })
    const drawn = mergeAll(graph)
    const merged = {
      ...drawn,
      nodes: drawn.nodes.map((entry) => ({ ...entry, node: { ...entry.node, name: packageNameOf(entry.node.id), version: versionOf(entry.node.id) } })),
    }
    const variants = new Map([
      ['lib@1.0.0', { position: 1, count: 2, peers: [], suffix: '' }],
      ['lib@1.0.0(x@1.0.0)', { position: 2, count: 2, peers: [], suffix: '(x@1.0.0)' }],
    ])
    const scene = wholeRootScene(merged, [], new Set(), variants)
    const texts = scene.nodes.filter((node) => node.kind === 'package').map((node) => node.text)
    assert.deepEqual(texts.sort(), ['lib 1.0.0 variant 1 of 2', 'lib 1.0.0 variant 2 of 2', 'other 1.0.0'])
  })
})
