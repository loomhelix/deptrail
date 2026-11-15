import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { layeredLayout, type LayoutInput, type LayoutOutput } from '../ui/src/graph/layered-layout.ts'
import { fastestRun } from './helpers/timing.ts'

function node(id: string, layer: number, width = 100): LayoutInput['nodes'][number] {
  return { id, layer, width }
}

function position(output: LayoutOutput, id: string): { x: number; y: number } {
  const placed = output.positions.get(id)
  assert.ok(placed, `${id} has a position`)
  return placed
}

function rowOrder(output: LayoutOutput, ids: string[]): string[] {
  return [...ids].sort((left, right) => position(output, left).y - position(output, right).y)
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function randomLayeredInput(nodeCount: number, layerCount: number, seed: number): LayoutInput {
  const random = seededRandom(seed)
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!
  const nodes = Array.from({ length: nodeCount }, (_, index) => node(`n${index}`, index % layerCount, 80 + Math.floor(random() * 160)))
  const idsByLayer = Array.from({ length: layerCount }, (_, layer) => nodes.filter((entry) => entry.layer === layer).map((entry) => entry.id))
  const edges: LayoutInput['edges'] = []
  for (const entry of nodes) {
    if (entry.layer === layerCount - 1) continue
    for (let count = 0; count < 3; count++) edges.push({ from: entry.id, to: pick(idsByLayer[entry.layer + 1]!) })
    if (entry.layer < layerCount - 2 && random() < 0.2) edges.push({ from: entry.id, to: pick(idsByLayer[entry.layer + 2]!) })
  }
  return { nodes, edges }
}

describe('layeredLayout', () => {
  it('places a chain of four layers at strictly increasing x from the lowest layer', () => {
    const output = layeredLayout({
      nodes: [node('focus', 0), node('parent', -1), node('grandparent', -2), node('importer', -3)],
      edges: [
        { from: 'importer', to: 'grandparent' },
        { from: 'grandparent', to: 'parent' },
        { from: 'parent', to: 'focus' },
      ],
    })
    const xs = ['importer', 'grandparent', 'parent', 'focus'].map((id) => position(output, id).x)
    assert.deepEqual(xs, [0, 220, 440, 660])
    for (let index = 1; index < xs.length; index++) assert.ok(xs[index]! > xs[index - 1]!)
  })

  it('removes the crossing of a1→b2 and a2→b1', () => {
    const output = layeredLayout({
      nodes: [node('a1', 0), node('a2', 0), node('b1', 1), node('b2', 1)],
      edges: [
        { from: 'a1', to: 'b2' },
        { from: 'a2', to: 'b1' },
      ],
    })
    const sourcesInOrder = position(output, 'a1').y < position(output, 'a2').y
    const targetsInOrder = position(output, 'b2').y < position(output, 'b1').y
    assert.equal(sourcesInOrder, targetsInOrder)
  })

  it('returns an empty layout for an empty input', () => {
    const output = layeredLayout({ nodes: [], edges: [] })
    assert.equal(output.width, 0)
    assert.equal(output.height, 0)
    assert.equal(output.positions.size, 0)
    assert.deepEqual(output.paths, [])
  })

  it('lays out a 300-node random layered input in under 50 ms', () => {
    const input = randomLayeredInput(300, 8, 42)
    const { result: output, elapsed } = fastestRun(() => layeredLayout(input))
    assert.equal(output.positions.size, 300)
    assert.equal(output.paths.length, input.edges.length)
    assert.ok(elapsed < 50, `layout took ${elapsed.toFixed(1)} ms`)
  })

  it('draws each edge as a cubic Bézier from the right edge of its source to the left edge of its target', () => {
    const output = layeredLayout({
      nodes: [node('a1', 0, 100), node('a2', 0, 120), node('b', 1, 80)],
      edges: [{ from: 'a2', to: 'b' }],
    })
    assert.deepEqual(position(output, 'a2'), { x: 0, y: 36 })
    assert.deepEqual(position(output, 'b'), { x: 220, y: 0 })
    assert.deepEqual(output.paths, [{ from: 'a2', to: 'b', d: 'M120,36 C170,36 170,0 220,0' }])
  })

  it('draws edges that skip layers or point back directly between their endpoints', () => {
    const output = layeredLayout({
      nodes: [node('a', 0), node('b', 1), node('c', 2)],
      edges: [
        { from: 'a', to: 'c' },
        { from: 'c', to: 'b' },
        { from: 'a', to: 'missing' },
      ],
    })
    assert.deepEqual(output.paths, [
      { from: 'a', to: 'c', d: 'M100,0 C270,0 270,0 440,0' },
      { from: 'c', to: 'b', d: 'M540,0 C380,0 380,0 220,0' },
    ])
  })

  it('keeps nodes without neighbours in the adjacent layer at their position', () => {
    const output = layeredLayout({
      nodes: [node('p', 0), node('q', 0), node('lonely', 1), node('b', 1), node('a', 1)],
      edges: [
        { from: 'p', to: 'a' },
        { from: 'q', to: 'b' },
      ],
    })
    assert.deepEqual(rowOrder(output, ['lonely', 'a', 'b']), ['lonely', 'a', 'b'])
    assert.equal(position(output, 'lonely').y, 0)
  })

  it('keeps the previous order on ties', () => {
    const output = layeredLayout({
      nodes: [node('p', 0), node('d', 1), node('c', 1), node('e', 1)],
      edges: [
        { from: 'p', to: 'd' },
        { from: 'p', to: 'c' },
        { from: 'p', to: 'e' },
      ],
    })
    assert.deepEqual(rowOrder(output, ['c', 'd', 'e']), ['d', 'c', 'e'])
  })

  it('reorders the first layer only on the up sweep that follows the down sweep', () => {
    const input: LayoutInput = {
      nodes: [node('a', 0), node('b', 0), node('c', 0), node('x', 1), node('y', 1)],
      edges: [
        { from: 'a', to: 'y' },
        { from: 'b', to: 'x' },
        { from: 'c', to: 'y' },
      ],
    }
    assert.deepEqual(rowOrder(layeredLayout(input, { sweeps: 1 }), ['a', 'b', 'c']), ['a', 'b', 'c'])
    assert.deepEqual(rowOrder(layeredLayout(input), ['a', 'b', 'c']), ['b', 'a', 'c'])
    assert.deepEqual(rowOrder(layeredLayout(input), ['x', 'y']), ['x', 'y'])
  })

  it('orders a layer by the mean position of its neighbours in the adjacent layer', () => {
    const output = layeredLayout({
      nodes: [node('top', 0), node('middle', 0), node('bottom', 0), node('wide', 1), node('low', 1), node('high', 1)],
      edges: [
        { from: 'top', to: 'high' },
        { from: 'bottom', to: 'low' },
        { from: 'top', to: 'wide' },
        { from: 'bottom', to: 'wide' },
      ],
    })
    assert.deepEqual(rowOrder(output, ['wide', 'low', 'high']), ['high', 'wide', 'low'])
  })

  it('applies the layer and row gaps and covers every node with width and height', () => {
    const output = layeredLayout(
      {
        nodes: [node('a', 0, 100), node('b', 0, 50), node('c', 1, 200)],
        edges: [],
      },
      { layerGap: 150, rowGap: 30 },
    )
    assert.deepEqual(position(output, 'b'), { x: 0, y: 30 })
    assert.deepEqual(position(output, 'c'), { x: 150, y: 0 })
    assert.equal(output.width, 350)
    assert.equal(output.height, 60)
  })
})
