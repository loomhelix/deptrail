import type { NodeId } from '../../../src/model.ts'
import type { NodeView } from '../../../src/query/lookup.ts'
import type { SubgraphResult, SubgraphStub } from '../../../src/query/subgraph.ts'
import { nodeLabel } from '../labels.ts'
import type { PeerVariant } from '../node-id.ts'
import { hiddenPathsText, packageVariantText, variantBadgeText } from '../vocabulary.ts'
import { DEFAULT_LAYER_GAP } from './layered-layout.ts'

type SceneNodeShape = { key: string; label: string; text: string; layer: number; width: number }
const VARIANT_SEPARATOR = ' '
export type PackageSceneNode = SceneNodeShape & {
  kind: 'package' | 'importer'
  id: NodeId
  name: string
  version: string
  isDirect: boolean
  variant?: PeerVariant
}
export type StubSceneNode = SceneNodeShape & { kind: 'stub' } & SubgraphStub
export type ClusterSceneNode = SceneNodeShape & { kind: 'cluster'; clusterId: string; size: number; title: string }
export type ClusterSceneInput = { id: string; name: string; suffix: string; title: string; size: number }
export type SceneNode = PackageSceneNode | StubSceneNode | ClusterSceneNode
export type SceneEdge = { from: string; to: string }
export type GraphScene = { nodes: SceneNode[]; edges: SceneEdge[] }

export const LABEL_CHAR_WIDTH = 7.85
export const LABEL_PADDING = 12
export const PILL_CHAR_WIDTH = 6.8
const PILL_PADDING = 7
export const PILL_GAP = 4
const MIN_NODE_WIDTH = 80
const MAX_NODE_WIDTH = 240
const MIN_EDGE_SPAN = 60
const ELLIPSIS = '…'
const NO_VARIANTS: ReadonlyMap<NodeId, PeerVariant> = new Map()

export function pillWidth(label: string): number {
  return Math.ceil(label.length * PILL_CHAR_WIDTH + 2 * PILL_PADDING)
}

export function pillsWidth(labels: readonly string[]): number {
  return labels.reduce((total, label) => total + pillWidth(label), 0) + Math.max(0, labels.length - 1) * PILL_GAP
}

export function nodeWidth(label: string, pillLabels: readonly string[] = [], suffix = ''): number {
  const labelEstimate = Math.ceil(label.length * LABEL_CHAR_WIDTH + 2 * LABEL_PADDING)
  const labelWidth = Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, labelEstimate)) + Math.ceil(suffix.length * LABEL_CHAR_WIDTH)
  return Math.max(labelWidth, pillsWidth(pillLabels))
}

export function fittedText(label: string, width: number, suffix = ''): string {
  const capacity = Math.floor((width - 2 * LABEL_PADDING) / LABEL_CHAR_WIDTH)
  if (label.length + suffix.length <= capacity) return `${label}${suffix}`
  return `${label.slice(0, Math.max(0, capacity - suffix.length - ELLIPSIS.length))}${ELLIPSIS}${suffix}`
}

export function layerGapFor(widths: readonly number[]): number {
  const widest = widths.reduce((max, width) => Math.max(max, width), 0)
  return Math.max(DEFAULT_LAYER_GAP, widest + MIN_EDGE_SPAN)
}

export function packageSceneNode(view: NodeView, layer: number, variant?: PeerVariant): PackageSceneNode {
  const base = {
    kind: view.isImporter ? ('importer' as const) : ('package' as const),
    key: view.id,
    id: view.id,
    name: view.name,
    version: view.version,
    isDirect: false,
    layer,
  }
  if (variant === undefined || view.isImporter) {
    const label = nodeLabel(view)
    const width = nodeWidth(label)
    return { ...base, label, text: fittedText(label, width), width }
  }
  const plain = nodeLabel(view)
  const badge = `${VARIANT_SEPARATOR}${variantBadgeText(variant)}`
  const width = nodeWidth(plain, [], badge)
  return {
    ...base,
    label: packageVariantText(view.name, view.version, variant),
    text: fittedText(plain, width, badge),
    width,
    variant,
  }
}

export function clusterSceneNode(cluster: ClusterSceneInput, layer: number): ClusterSceneNode {
  const label = `${cluster.name}${cluster.suffix}`
  const width = nodeWidth(label)
  return {
    kind: 'cluster',
    key: cluster.id,
    clusterId: cluster.id,
    size: cluster.size,
    title: cluster.title,
    label,
    text: fittedText(cluster.name, width, cluster.suffix),
    layer,
    width,
  }
}

function stubSceneNode(stub: SubgraphStub, nodeLayer: number): StubSceneNode {
  const label = hiddenPathsText(stub.hidden)
  const width = nodeWidth(label)
  return {
    kind: 'stub',
    key: `stub:${stub.side}:${stub.at}`,
    at: stub.at,
    side: stub.side,
    hidden: stub.hidden,
    label,
    text: fittedText(label, width),
    layer: stub.side === 'up' ? nodeLayer - 1 : nodeLayer + 1,
    width,
  }
}

export function uniqueEdges(edges: Iterable<SceneEdge>): SceneEdge[] {
  const seen = new Set<string>()
  const unique: SceneEdge[] = []
  for (const { from, to } of edges) {
    const pair = `${from}\u0000${to}`
    if (from === to || seen.has(pair)) continue
    seen.add(pair)
    unique.push({ from, to })
  }
  return unique
}

export function markDirectNodes(nodes: SceneNode[], edges: readonly SceneEdge[]): SceneNode[] {
  const importerKeys = new Set(nodes.filter((node) => node.kind === 'importer').map((node) => node.key))
  const directKeys = new Set(edges.filter((edge) => importerKeys.has(edge.from)).map((edge) => edge.to))
  return nodes.map((node) => (node.kind === 'package' && directKeys.has(node.key) ? { ...node, isDirect: true } : node))
}

export function focusScene(result: SubgraphResult, variants: ReadonlyMap<NodeId, PeerVariant> = NO_VARIANTS): GraphScene {
  const layerOf = new Map(result.nodes.map((entry) => [entry.node.id, entry.layer]))
  const nodes: SceneNode[] = result.nodes.map((entry) => packageSceneNode(entry.node, entry.layer, variants.get(entry.node.id)))
  const edges: SceneEdge[] = uniqueEdges(result.edges)
  for (const stub of result.stubs) {
    const layer = layerOf.get(stub.at)
    if (layer === undefined) continue
    const node = stubSceneNode(stub, layer)
    nodes.push(node)
    edges.push(stub.side === 'up' ? { from: node.key, to: stub.at } : { from: stub.at, to: node.key })
  }
  return { nodes: markDirectNodes(nodes, edges), edges }
}
