import type { DepKind, NodeId, RootGraph } from '../model.ts'
import { passingEdges, requireNode, viewOf, type KindFilter, type NodeView } from './lookup.ts'

export type ChildRow = { node: NodeView; kind: DepKind; range: string; hasChildren: boolean; repeated: boolean }
export type ChildrenResult = { node: NodeView; rows: ChildRow[]; nested: Record<NodeId, ChildRow[]> }

function rowsOf(root: RootGraph, id: NodeId, kinds: KindFilter): ChildRow[] {
  return passingEdges(requireNode(root, id), kinds).map((edge) => {
    const child = requireNode(root, edge.to)
    return {
      node: viewOf(child),
      kind: edge.kind,
      range: edge.range,
      hasChildren: child.deps.some((childEdge) => kinds.has(childEdge.kind)),
      repeated: false,
    }
  })
}

export function children(root: RootGraph, id: NodeId, depth: number, kinds: KindFilter): ChildrenResult {
  const focus = requireNode(root, id)
  const levels = Math.max(1, Math.floor(depth))
  const rows = rowsOf(root, id, kinds)
  const nested: Record<NodeId, ChildRow[]> = {}
  const expanded = new Set<NodeId>([id])
  let currentLevel = rows
  for (let level = 1; level <= levels && currentLevel.length > 0; level++) {
    const nextLevel: ChildRow[] = []
    for (const row of currentLevel) {
      if (expanded.has(row.node.id)) {
        row.repeated = true
        continue
      }
      if (level === levels) continue
      expanded.add(row.node.id)
      const childRows = rowsOf(root, row.node.id, kinds)
      nested[row.node.id] = childRows
      nextLevel.push(...childRows)
    }
    currentLevel = nextLevel
  }
  return { node: viewOf(focus), rows, nested }
}
