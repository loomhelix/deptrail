import type { NodeId } from '../../../src/model.ts'
import type { SubgraphEdge, SubgraphNode, SubgraphResult } from '../../../src/query/subgraph.ts'
import { nodeLabel } from '../labels.ts'
import type { PeerVariant } from '../node-id.ts'
import { clusterLabel, clusterLabelParts, clusterTitle } from '../vocabulary.ts'
import { clusterSceneNode, markDirectNodes, packageSceneNode, uniqueEdges, type GraphScene, type SceneNode } from './graph-scene.ts'

export type MergedRoot = {
  nodes: SubgraphNode[]
  edges: SubgraphEdge[]
  reachedBy: ReadonlyMap<NodeId, readonly NodeId[]>
  truncated: boolean
}
export type NodeCluster = { id: string; importerNames: string[]; label: string; title: string; memberIds: NodeId[] }

export function mergeImporterSubgraphs(results: readonly SubgraphResult[]): MergedRoot {
  const merged = new Map<NodeId, SubgraphNode>()
  const reachedBy = new Map<NodeId, NodeId[]>()
  const edges = new Map<string, SubgraphEdge>()
  for (const result of results) {
    for (const entry of result.nodes) {
      const known = merged.get(entry.node.id)
      if (!known || entry.layer < known.layer) merged.set(entry.node.id, { node: known?.node ?? entry.node, layer: entry.layer })
      const importers = reachedBy.get(entry.node.id) ?? []
      if (!importers.includes(result.focus)) importers.push(result.focus)
      reachedBy.set(entry.node.id, importers)
    }
    for (const edge of result.edges) edges.set(`${edge.from}\u0000${edge.to}\u0000${edge.kind}`, edge)
  }
  return {
    nodes: [...merged.values()].sort((left, right) => left.layer - right.layer),
    edges: [...edges.values()],
    reachedBy,
    truncated: results.some((result) => result.truncated),
  }
}

export function firstNodesByLayer(merged: MergedRoot, limit: number): MergedRoot {
  if (merged.nodes.length <= limit) return merged
  const nodes = merged.nodes.slice(0, limit)
  const kept = new Set(nodes.map((entry) => entry.node.id))
  return { ...merged, nodes, edges: merged.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) }
}

export function clusterNodes(merged: MergedRoot): NodeCluster[] {
  const importerLabels = new Map(
    merged.nodes.filter((entry) => entry.node.isImporter).map((entry) => [entry.node.id, nodeLabel(entry.node)]),
  )
  const groups = new Map<string, { id: string; importerNames: string[]; memberIds: NodeId[] }>()
  for (const { node } of merged.nodes) {
    if (node.isImporter) continue
    const importers = merged.reachedBy.get(node.id) ?? []
    const id = `cluster:${importers.join(',')}`
    let group = groups.get(id)
    if (!group) {
      group = { id, importerNames: importers.map((importerId) => importerLabels.get(importerId) ?? importerId), memberIds: [] }
      groups.set(id, group)
    }
    group.memberIds.push(node.id)
  }
  return [...groups.values()]
    .filter((group) => group.memberIds.length > 1)
    .map((group) => ({
      ...group,
      label: clusterLabel(group.importerNames, group.memberIds.length),
      title: clusterTitle(group.importerNames),
    }))
}

export function wholeRootScene(
  merged: MergedRoot,
  clusters: readonly NodeCluster[],
  expandedIds: ReadonlySet<string>,
  variants: ReadonlyMap<NodeId, PeerVariant> = new Map(),
): GraphScene {
  const collapsedClusterOf = new Map<NodeId, NodeCluster>()
  for (const cluster of clusters) {
    if (expandedIds.has(cluster.id)) continue
    for (const memberId of cluster.memberIds) collapsedClusterOf.set(memberId, cluster)
  }
  const nodes: SceneNode[] = []
  const drawnClusters = new Set<string>()
  for (const { node, layer } of merged.nodes) {
    const cluster = collapsedClusterOf.get(node.id)
    if (!cluster) {
      nodes.push(packageSceneNode(node, layer, variants.get(node.id)))
    } else if (!drawnClusters.has(cluster.id)) {
      drawnClusters.add(cluster.id)
      const { name, suffix } = clusterLabelParts(cluster.importerNames, cluster.memberIds.length)
      nodes.push(clusterSceneNode({ id: cluster.id, name, suffix, title: cluster.title, size: cluster.memberIds.length }, layer))
    }
  }
  const keyOf = (id: NodeId): string => collapsedClusterOf.get(id)?.id ?? id
  const edges = uniqueEdges(merged.edges.map((edge) => ({ from: keyOf(edge.from), to: keyOf(edge.to) })))
  return { nodes: markDirectNodes(nodes, edges), edges }
}
