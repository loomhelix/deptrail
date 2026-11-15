import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ALL_KINDS } from '../src/query/lookup.ts'
import { subgraph } from '../src/query/subgraph.ts'
import { fittedText, focusScene, layerGapFor, nodeWidth, packageSceneNode, pillsWidth, type GraphScene } from '../ui/src/graph/graph-scene.ts'
import type { PeerVariant } from '../ui/src/node-id.ts'
import { packageVariantText } from '../ui/src/vocabulary.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const PARSER = 'vue-eslint-parser@9.4.3'
const PLUGIN = 'eslint-plugin-vue@9.32.0'

function parserGraph() {
  return makeGraph({
    importers: { app: [`dev:${PLUGIN}`] },
    packages: {
      [PLUGIN]: [PARSER, `peer:${PARSER}`],
      [PARSER]: ['semver@5.7.2', 'espree@9.6.1'],
      'semver@5.7.2': [],
      'espree@9.6.1': [],
    },
  })
}

function outline(scene: GraphScene): string[] {
  return scene.nodes.map((node) => `${node.kind} ${node.key} @${node.layer} "${node.label}"`)
}

function edgeList(scene: GraphScene): string[] {
  return scene.edges.map((edge) => `${edge.from} -> ${edge.to}`)
}

describe('nodeWidth', () => {
  it('grows with the label and stays within 80 to 240 px', () => {
    assert.equal(nodeWidth('a'), 80)
    assert.equal(nodeWidth('vue-eslint-parser 9.4.3'), 205)
    assert.ok(nodeWidth('vue-eslint-parser 9.4.3') > nodeWidth('semver 5.7.2'))
    assert.equal(nodeWidth('x'.repeat(100)), 240)
  })

  it('grows past 240 px when its badges need more room than the label', () => {
    const badges = ['1 vulnerable below', '↑ 1.1.0 minor']
    assert.equal(pillsWidth(badges), 244)
    assert.equal(nodeWidth('helper 1.0.0', badges), 244)
    assert.equal(nodeWidth('x'.repeat(100), ['high']), 240)
  })
})

describe('fittedText', () => {
  it('keeps a label that fits and shortens a long one with an ellipsis, keeping the suffix', () => {
    assert.equal(fittedText('semver 5.7.2', nodeWidth('semver 5.7.2')), 'semver 5.7.2')
    const long = `@scope/${'very-long-name-'.repeat(4)}`
    assert.equal(fittedText(long, 240), `${long.slice(0, 26)}…`)
    assert.equal(fittedText(long, 240, ' (12)'), `${long.slice(0, 21)}… (12)`)
  })
})

describe('layerGapFor', () => {
  it('keeps the default gap for narrow nodes and widens it for wide ones', () => {
    assert.equal(layerGapFor([80, 120]), 220)
    assert.equal(layerGapFor([80, 240]), 300)
    assert.equal(layerGapFor([]), 220)
  })
})

describe('focusScene', () => {
  it('turns the subgraph into package and importer nodes with their labels, widths and layers', () => {
    const scene = focusScene(subgraph(parserGraph(), PARSER, { up: 2, down: 1, limit: 300, kinds: ALL_KINDS }))
    assert.deepEqual(outline(scene), [
      `package ${PARSER} @0 "vue-eslint-parser 9.4.3"`,
      `package ${PLUGIN} @-1 "eslint-plugin-vue 9.32.0"`,
      'package semver@5.7.2 @1 "semver 5.7.2"',
      'package espree@9.6.1 @1 "espree 9.6.1"',
      'importer importer:app @-2 "app"',
    ])
    const parser = scene.nodes[0]!
    assert.equal(parser.width, nodeWidth('vue-eslint-parser 9.4.3'))
    assert.equal(parser.text, 'vue-eslint-parser 9.4.3')
    assert.ok(parser.kind === 'package' && parser.id === PARSER && parser.name === 'vue-eslint-parser')
  })

  it('marks the nodes that have an importer predecessor as direct', () => {
    const scene = focusScene(subgraph(parserGraph(), PARSER, { up: 2, down: 1, limit: 300, kinds: ALL_KINDS }))
    const direct = scene.nodes.flatMap((node) => (node.kind === 'package' && node.isDirect ? [node.id] : []))
    assert.deepEqual(direct, [PLUGIN])
  })

  it('draws one edge per connected pair whatever the dependency kinds', () => {
    const scene = focusScene(subgraph(parserGraph(), PARSER, { up: 2, down: 1, limit: 300, kinds: ALL_KINDS }))
    assert.deepEqual(edgeList(scene).sort(), [
      `${PLUGIN} -> ${PARSER}`,
      `importer:app -> ${PLUGIN}`,
      `${PARSER} -> espree@9.6.1`,
      `${PARSER} -> semver@5.7.2`,
    ])
  })

  it('adds a "+N paths" stub one layer outward for each side with hidden nodes, in the singular for one', () => {
    const scene = focusScene(subgraph(parserGraph(), PARSER, { up: 1, down: 0, limit: 300, kinds: ALL_KINDS }))
    assert.deepEqual(outline(scene), [
      `package ${PARSER} @0 "vue-eslint-parser 9.4.3"`,
      `package ${PLUGIN} @-1 "eslint-plugin-vue 9.32.0"`,
      `stub stub:down:${PARSER} @1 "+2 paths"`,
      `stub stub:up:${PLUGIN} @-2 "+1 path"`,
    ])
    assert.deepEqual(edgeList(scene).sort(), [
      `${PLUGIN} -> ${PARSER}`,
      `stub:up:${PLUGIN} -> ${PLUGIN}`,
      `${PARSER} -> stub:down:${PARSER}`,
    ])
    const upStub = scene.nodes.find((node) => node.key === `stub:up:${PLUGIN}`)
    assert.ok(upStub?.kind === 'stub')
    assert.deepEqual({ at: upStub.at, side: upStub.side, hidden: upStub.hidden }, { at: PLUGIN, side: 'up', hidden: 1 })
    assert.equal(upStub.width, nodeWidth('+1 path'))
  })
})

describe('package nodes with a peer variant', () => {
  const variant: PeerVariant = { position: 2, count: 3, peers: [{ name: 'react', version: '18.3.2' }], suffix: '(react@18.3.2)' }
  const longName = 'a'.repeat(60)
  const view = { id: `${longName}@1.0.0(react@18.3.2)`, name: longName, version: '1.0.0', isImporter: false } as never

  it('keeps the variant at the end of the text when the name is truncated', () => {
    const node = packageSceneNode(view, 0, variant)
    assert.ok(node.text.endsWith('variant 2 of 3'))
    assert.ok(node.text.includes('…'))
    assert.equal(node.label, packageVariantText(longName, '1.0.0', variant))
    assert.equal(node.width, nodeWidth(`${longName} 1.0.0`, [], ' variant 2 of 3'))
    assert.deepEqual(node.variant, variant)
  })

  it('keeps the version visible next to the variant on a node that would otherwise be truncated', () => {
    const react = { id: 'react-dom@18.3.1(react@18.3.1)', name: 'react-dom', version: '18.3.1', isImporter: false } as never
    const node = packageSceneNode(react, 0, { position: 1, count: 2, peers: [], suffix: '' })
    assert.equal(node.text, 'react-dom 18.3.1 variant 1 of 2')
    assert.equal(node.width, nodeWidth('react-dom 18.3.1') + Math.ceil(' variant 1 of 2'.length * 7.85))
  })

  it('keeps the version out of the name budget only when the name is long', () => {
    const node = packageSceneNode(view, 0, variant)
    assert.equal(node.width, 240 + Math.ceil(' variant 2 of 3'.length * 7.85))
  })

  it('leaves a node without a variant as it was', () => {
    const node = packageSceneNode({ ...(view as object), id: 'semver@5.7.2', name: 'semver', version: '5.7.2' } as never, 1)
    assert.equal(node.text, 'semver 5.7.2')
    assert.equal(node.width, nodeWidth('semver 5.7.2'))
    assert.equal(node.variant, undefined)
  })

  it('labels the drawn variants through focusScene', () => {
    const graph = makeGraph({
      importers: { app: ['a@1.0.0'] },
      packages: { 'a@1.0.0': [], 'a@1.0.0(x@1.0.0)': [] },
    })
    const result = subgraph(graph, 'importer:app', { up: 0, down: 3, limit: 50, kinds: ALL_KINDS })
    const scene = focusScene(result, new Map([['a@1.0.0', { position: 1, count: 2, peers: [], suffix: '' }]]))
    const node = scene.nodes.find((entry) => entry.key === 'a@1.0.0')
    assert.ok(node && node.kind === 'package' && node.text.endsWith('variant 1 of 2'))
  })
})
