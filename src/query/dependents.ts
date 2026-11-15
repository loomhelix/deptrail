import { IMPORTER_PREFIX, type DepKind, type Edge, type NodeId, type RootGraph } from '../model.ts'
import { findNode, requireNode, UnknownNodeError, viewOf, type GraphNode, type KindFilter, type NodeView } from './lookup.ts'

export type ParentLink = { id: NodeId; kind: DepKind; range: string }
export type DagNode = { node: NodeView; parents: ParentLink[]; depth: number }
export type DependentsSummary = { importers: NodeId[]; via: { direct: NodeId; importers: NodeId[] }[] }
export type DependentsResult = {
  focus: NodeView
  focusParents: ParentLink[]
  nodes: DagNode[]
  summary: DependentsSummary
  truncated: boolean
}
export type UpwardIndex = {
  ids: readonly NodeId[]
  positionOf: ReadonlyMap<NodeId, number>
  isImporter: Uint8Array
  parentStarts: Int32Array
  parentPositions: Int32Array
}

const DEFAULT_NODE_LIMIT = 5000

const upwardIndexes = new WeakMap<RootGraph, Map<string, UpwardIndex>>()

function kindsKey(kinds: KindFilter): string {
  return [...kinds].sort().join(',')
}

function buildUpwardIndex(root: RootGraph, kinds: KindFilter): UpwardIndex {
  const nodes: GraphNode[] = [...root.importers, ...root.packages.values()]
  const positionOf = new Map(nodes.map((node, position) => [node.id, position]))
  const passingTargets = nodes.map((node) => new Set(node.deps.filter((edge) => kinds.has(edge.kind)).map((edge) => edge.to)))
  const parentStarts = new Int32Array(nodes.length + 1)
  const parentPositions: number[] = []
  nodes.forEach((node, position) => {
    parentStarts[position] = parentPositions.length
    for (const parentId of node.dependents) {
      const parent = positionOf.get(parentId)
      if (parent !== undefined && passingTargets[parent].has(node.id)) parentPositions.push(parent)
    }
  })
  parentStarts[nodes.length] = parentPositions.length
  return {
    ids: nodes.map((node) => node.id),
    positionOf,
    isImporter: Uint8Array.from(nodes, (node) => (node.id.startsWith(IMPORTER_PREFIX) ? 1 : 0)),
    parentStarts,
    parentPositions: Int32Array.from(parentPositions),
  }
}

export function upwardIndex(root: RootGraph, kinds: KindFilter): UpwardIndex {
  const key = kindsKey(kinds)
  let byKinds = upwardIndexes.get(root)
  if (byKinds === undefined) {
    byKinds = new Map()
    upwardIndexes.set(root, byKinds)
  }
  const known = byKinds.get(key)
  if (known) return known
  const built = buildUpwardIndex(root, kinds)
  byKinds.set(key, built)
  return built
}

export class ParentLinkResolver {
  private readonly root: RootGraph
  private readonly kinds: KindFilter
  private readonly firstPassingEdges = new Map<NodeId, Map<NodeId, Edge>>()

  constructor(root: RootGraph, kinds: KindFilter) {
    this.root = root
    this.kinds = kinds
  }

  of(node: GraphNode): ParentLink[] {
    const links: ParentLink[] = []
    for (const parentId of node.dependents) {
      const edge = this.edgesOf(parentId).get(node.id)
      if (edge) links.push({ id: parentId, kind: edge.kind, range: edge.range })
    }
    return links
  }

  private edgesOf(parentId: NodeId): Map<NodeId, Edge> {
    const cached = this.firstPassingEdges.get(parentId)
    if (cached) return cached
    const byTarget = new Map<NodeId, Edge>()
    for (const edge of findNode(this.root, parentId)?.deps ?? []) {
      if (this.kinds.has(edge.kind) && !byTarget.has(edge.to)) byTarget.set(edge.to, edge)
    }
    this.firstPassingEdges.set(parentId, byTarget)
    return byTarget
  }
}

export function dependentsSummary(root: RootGraph, id: NodeId, kinds: KindFilter): DependentsSummary {
  const { ids, positionOf, isImporter, parentStarts, parentPositions } = upwardIndex(root, kinds)
  const focus = positionOf.get(id)
  if (focus === undefined) throw new UnknownNodeError(id)
  const visited = new Uint8Array(ids.length)
  const importers = new Set<NodeId>()
  const importersByDirect = new Map<NodeId, NodeId[]>()
  const queue = [focus]
  visited[focus] = 1
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const position = queue[cursor]
    const importerParents: NodeId[] = []
    for (let link = parentStarts[position]; link < parentStarts[position + 1]; link++) {
      const parent = parentPositions[link]
      if (isImporter[parent] === 1) {
        importers.add(ids[parent])
        importerParents.push(ids[parent])
      }
      if (visited[parent] === 1) continue
      visited[parent] = 1
      queue.push(parent)
    }
    if (importerParents.length > 0 && isImporter[position] === 0) importersByDirect.set(ids[position], importerParents.sort())
  }
  importers.delete(id)
  const via = [...importersByDirect].map(([direct, directImporters]) => ({ direct, importers: directImporters }))
  via.sort((left, right) => (left.direct < right.direct ? -1 : left.direct > right.direct ? 1 : 0))
  return { importers: [...importers].sort(), via }
}

export function dependents(
  root: RootGraph,
  id: NodeId,
  maxDepth: number,
  kinds: KindFilter,
  nodeLimit: number = DEFAULT_NODE_LIMIT,
): DependentsResult {
  const focus = requireNode(root, id)
  const links = new ParentLinkResolver(root, kinds)
  const nodes: DagNode[] = []
  const seen = new Set<NodeId>([id])
  let truncated = false
  let frontier: GraphNode[] = [focus]
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
    const nextFrontier: GraphNode[] = []
    for (const node of frontier) {
      for (const link of links.of(node)) {
        if (seen.has(link.id)) continue
        if (nodes.length >= nodeLimit) {
          truncated = true
          break
        }
        seen.add(link.id)
        const parent = requireNode(root, link.id)
        nodes.push({ node: viewOf(parent), parents: links.of(parent), depth })
        nextFrontier.push(parent)
      }
      if (truncated) break
    }
    frontier = nextFrontier
  }
  return { focus: viewOf(focus), focusParents: links.of(focus), nodes, summary: dependentsSummary(root, id, kinds), truncated }
}
