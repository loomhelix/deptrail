import { IMPORTER_PREFIX, PLACEHOLDER_PREFIX, type DepKind, type Edge, type Importer, type NodeId, type PackageNode, type RootGraph } from '../model.ts'

export type KindFilter = ReadonlySet<DepKind>
export const ALL_KINDS: KindFilter = new Set<DepKind>(['prod', 'dev', 'optional', 'peer'])

export type NodeView = {
  id: NodeId
  name: string
  version: string
  peerSuffix?: string
  isImporter: boolean
  isPlaceholder: boolean
}

export type GraphNode = Importer | PackageNode

export class UnknownNodeError extends Error {
  readonly nodeId: NodeId

  constructor(nodeId: NodeId) {
    super(`Unknown node ${nodeId}`)
    this.name = 'UnknownNodeError'
    this.nodeId = nodeId
  }
}

const importerIndexes = new WeakMap<RootGraph, Map<NodeId, Importer>>()

function importerIndex(root: RootGraph): Map<NodeId, Importer> {
  const cached = importerIndexes.get(root)
  if (cached) return cached
  const index = new Map(root.importers.map((importer) => [importer.id, importer]))
  importerIndexes.set(root, index)
  return index
}

export function findNode(root: RootGraph, id: NodeId): GraphNode | undefined {
  return root.packages.get(id) ?? importerIndex(root).get(id)
}

export function requireNode(root: RootGraph, id: NodeId): GraphNode {
  const node = findNode(root, id)
  if (!node) throw new UnknownNodeError(id)
  return node
}

export function viewOf(node: GraphNode): NodeView {
  const isImporter = node.id.startsWith(IMPORTER_PREFIX)
  const view: NodeView = {
    id: node.id,
    name: node.name,
    version: isImporter ? '' : (node as PackageNode).version,
    isImporter,
    isPlaceholder: node.id.startsWith(PLACEHOLDER_PREFIX),
  }
  const peerSuffix = (node as PackageNode).peerSuffix
  if (peerSuffix !== undefined) view.peerSuffix = peerSuffix
  return view
}

export function lookup(root: RootGraph, id: NodeId): NodeView | undefined {
  const node = findNode(root, id)
  return node ? viewOf(node) : undefined
}

export function passingEdges(node: GraphNode, kinds: KindFilter): Edge[] {
  return node.deps.filter((edge) => kinds.has(edge.kind))
}
