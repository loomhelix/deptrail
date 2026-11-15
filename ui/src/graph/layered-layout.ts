export type LayoutInput = { nodes: { id: string; layer: number; width: number }[]; edges: { from: string; to: string }[] }
export type LayoutOutput = {
  positions: Map<string, { x: number; y: number }>
  paths: { from: string; to: string; d: string }[]
  width: number
  height: number
}
export type LayoutOptions = { layerGap?: number; rowGap?: number; sweeps?: number }

export const DEFAULT_LAYER_GAP = 220
export const DEFAULT_ROW_GAP = 36
const DEFAULT_SWEEPS = 4

type LayoutNode = LayoutInput['nodes'][number]
type AdjacentNeighbours = { previous: Set<string>; next: Set<string> }

function groupByLayer(nodes: readonly LayoutNode[]): string[][] {
  const idsByLayer = new Map<number, string[]>()
  for (const node of nodes) {
    const ids = idsByLayer.get(node.layer) ?? []
    ids.push(node.id)
    idsByLayer.set(node.layer, ids)
  }
  return [...idsByLayer].sort(([left], [right]) => left - right).map(([, ids]) => ids)
}

function adjacentNeighbours(edges: LayoutInput['edges'], layerOf: ReadonlyMap<string, number>): Map<string, AdjacentNeighbours> {
  const neighbours = new Map<string, AdjacentNeighbours>()
  const entryOf = (id: string): AdjacentNeighbours => {
    let entry = neighbours.get(id)
    if (!entry) {
      entry = { previous: new Set(), next: new Set() }
      neighbours.set(id, entry)
    }
    return entry
  }
  for (const { from, to } of edges) {
    const fromLayer = layerOf.get(from)
    const toLayer = layerOf.get(to)
    if (fromLayer === undefined || toLayer === undefined) continue
    if (toLayer === fromLayer + 1) {
      entryOf(from).next.add(to)
      entryOf(to).previous.add(from)
    } else if (toLayer === fromLayer - 1) {
      entryOf(from).previous.add(to)
      entryOf(to).next.add(from)
    }
  }
  return neighbours
}

function meanIndex(ids: ReadonlySet<string> | undefined, rowOf: ReadonlyMap<string, number>): number | undefined {
  if (!ids || ids.size === 0) return undefined
  let sum = 0
  for (const id of ids) sum += rowOf.get(id)!
  return sum / ids.size
}

function reorderByBarycenter(
  order: string[],
  rowOf: Map<string, number>,
  neighboursOf: (id: string) => ReadonlySet<string> | undefined,
): string[] {
  const keptInPlace: (string | undefined)[] = new Array(order.length)
  const movable: { id: string; barycenter: number }[] = []
  order.forEach((id, row) => {
    const barycenter = meanIndex(neighboursOf(id), rowOf)
    if (barycenter === undefined) keptInPlace[row] = id
    else movable.push({ id, barycenter })
  })
  movable.sort((left, right) => left.barycenter - right.barycenter)
  let cursor = 0
  const reordered = order.map((_, row) => keptInPlace[row] ?? movable[cursor++]!.id)
  reordered.forEach((id, row) => rowOf.set(id, row))
  return reordered
}

function orderLayers(layers: string[][], neighbours: ReadonlyMap<string, AdjacentNeighbours>, sweeps: number): Map<string, number> {
  const rowOf = new Map<string, number>()
  for (const ids of layers) ids.forEach((id, row) => rowOf.set(id, row))
  for (let sweep = 0; sweep < sweeps; sweep++) {
    if (sweep % 2 === 0) {
      for (let index = 1; index < layers.length; index++) {
        layers[index] = reorderByBarycenter(layers[index]!, rowOf, (id) => neighbours.get(id)?.previous)
      }
    } else {
      for (let index = layers.length - 2; index >= 0; index--) {
        layers[index] = reorderByBarycenter(layers[index]!, rowOf, (id) => neighbours.get(id)?.next)
      }
    }
  }
  return rowOf
}

function bezierPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const middleX = (fromX + toX) / 2
  return `M${fromX},${fromY} C${middleX},${fromY} ${middleX},${toY} ${toX},${toY}`
}

export function layeredLayout(input: LayoutInput, options: LayoutOptions = {}): LayoutOutput {
  const layerGap = options.layerGap ?? DEFAULT_LAYER_GAP
  const rowGap = options.rowGap ?? DEFAULT_ROW_GAP
  const sweeps = options.sweeps ?? DEFAULT_SWEEPS
  if (input.nodes.length === 0) return { positions: new Map(), paths: [], width: 0, height: 0 }

  const nodeById = new Map<string, LayoutNode>()
  for (const node of input.nodes) if (!nodeById.has(node.id)) nodeById.set(node.id, node)
  const nodes = [...nodeById.values()]
  const layerOf = new Map(nodes.map((node) => [node.id, node.layer]))
  const minLayer = nodes.reduce((lowest, node) => Math.min(lowest, node.layer), Infinity)
  const layers = groupByLayer(nodes)
  const rowOf = orderLayers(layers, adjacentNeighbours(input.edges, layerOf), sweeps)

  const positions = new Map<string, { x: number; y: number }>()
  let width = 0
  for (const node of nodes) {
    const x = (node.layer - minLayer) * layerGap
    positions.set(node.id, { x, y: rowOf.get(node.id)! * rowGap })
    width = Math.max(width, x + node.width)
  }
  const height = layers.reduce((tallest, ids) => Math.max(tallest, ids.length), 0) * rowGap

  const paths: LayoutOutput['paths'] = []
  for (const { from, to } of input.edges) {
    const source = positions.get(from)
    const target = positions.get(to)
    if (!source || !target) continue
    paths.push({ from, to, d: bezierPath(source.x + nodeById.get(from)!.width, source.y, target.x, target.y) })
  }
  return { positions, paths, width, height }
}
