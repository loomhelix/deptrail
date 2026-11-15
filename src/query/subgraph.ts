import type { DepKind, NodeId, RootGraph } from '../model.ts'
import { ParentLinkResolver } from './dependents.ts'
import { passingEdges, requireNode, viewOf, type GraphNode, type KindFilter, type NodeView } from './lookup.ts'

export type SubgraphNode = { node: NodeView; layer: number }
export type SubgraphEdge = { from: NodeId; to: NodeId; kind: DepKind }
export type SubgraphStub = { at: NodeId; side: 'up' | 'down'; hidden: number }
export type SubgraphResult = {
  focus: NodeId
  nodes: SubgraphNode[]
  edges: SubgraphEdge[]
  stubs: SubgraphStub[]
  truncated: boolean
}
export type SubgraphOptions = { up: number; down: number; limit: number; kinds: KindFilter }

type Visit = { node: GraphNode; layer: number }

class SubgraphWalk {
  private readonly root: RootGraph
  private readonly options: SubgraphOptions
  private readonly links: ParentLinkResolver
  private readonly visited = new Map<NodeId, Visit>()
  private readonly queue: Visit[] = []
  truncated = false

  constructor(root: RootGraph, options: SubgraphOptions) {
    this.root = root
    this.options = options
    this.links = new ParentLinkResolver(root, options.kinds)
  }

  run(focus: GraphNode): Visit[] {
    this.visit(focus, 0)
    for (let cursor = 0; cursor < this.queue.length; cursor++) {
      const { node, layer } = this.queue[cursor]
      if (this.canExpandUp(layer)) {
        for (const parentId of this.parentIds(node)) this.visit(requireNode(this.root, parentId), layer - 1, true)
      }
      if (this.canExpandDown(layer)) {
        for (const childId of this.childIds(node)) this.visit(requireNode(this.root, childId), layer + 1, true)
      }
    }
    return this.queue
  }

  has(id: NodeId): boolean {
    return this.visited.has(id)
  }

  parentIds(node: GraphNode): NodeId[] {
    return [...new Set(this.links.of(node).map((link) => link.id))]
  }

  childIds(node: GraphNode): NodeId[] {
    return [...new Set(passingEdges(node, this.options.kinds).map((edge) => edge.to))]
  }

  canExpandUp(layer: number): boolean {
    return layer <= 0 && layer > -this.options.up
  }

  canExpandDown(layer: number): boolean {
    return layer >= 0 && layer < this.options.down
  }

  private visit(node: GraphNode, layer: number, enforceLimit = false): void {
    if (this.visited.has(node.id)) return
    if (enforceLimit && this.queue.length >= this.options.limit) {
      this.truncated = true
      return
    }
    const visit = { node, layer }
    this.visited.set(node.id, visit)
    this.queue.push(visit)
  }
}

function collectEdges(walk: SubgraphWalk, visits: Visit[], kinds: KindFilter): SubgraphEdge[] {
  const edges: SubgraphEdge[] = []
  const seen = new Set<string>()
  for (const { node } of visits) {
    for (const edge of passingEdges(node, kinds)) {
      if (!walk.has(edge.to)) continue
      const key = `${node.id}\u0000${edge.to}\u0000${edge.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: node.id, to: edge.to, kind: edge.kind })
    }
  }
  return edges
}

function countHidden(walk: SubgraphWalk, ids: NodeId[]): number {
  let hidden = 0
  for (const id of ids) if (!walk.has(id)) hidden++
  return hidden
}

function collectStubs(walk: SubgraphWalk, visits: Visit[]): SubgraphStub[] {
  const stubs: SubgraphStub[] = []
  for (const { node, layer } of visits) {
    if (layer <= 0) {
      const hidden = countHidden(walk, walk.parentIds(node))
      if (hidden > 0) stubs.push({ at: node.id, side: 'up', hidden })
    }
    if (layer >= 0) {
      const hidden = countHidden(walk, walk.childIds(node))
      if (hidden > 0) stubs.push({ at: node.id, side: 'down', hidden })
    }
  }
  return stubs
}

export function subgraph(root: RootGraph, id: NodeId, options: SubgraphOptions): SubgraphResult {
  const focus = requireNode(root, id)
  const walk = new SubgraphWalk(root, options)
  const visits = walk.run(focus)
  return {
    focus: id,
    nodes: visits.map(({ node, layer }) => ({ node: viewOf(node), layer })),
    edges: collectEdges(walk, visits, options.kinds),
    stubs: collectStubs(walk, visits),
    truncated: walk.truncated,
  }
}
