import { PLACEHOLDER_PREFIX, type NodeId, type RootGraph } from '../model.ts'

export type GlobalEntry = { rootId: string; nodeId: NodeId; version: string }
export type GlobalIndex = Map<string, GlobalEntry[]>

export function buildGlobalIndex(roots: RootGraph[]): GlobalIndex {
  const index: GlobalIndex = new Map()
  for (const root of roots) {
    if (root.status !== 'ready') continue
    for (const node of root.packages.values()) {
      if (node.id.startsWith(PLACEHOLDER_PREFIX)) continue
      const entry: GlobalEntry = { rootId: root.id, nodeId: node.id, version: node.version }
      const entries = index.get(node.name)
      if (entries) entries.push(entry)
      else index.set(node.name, [entry])
    }
  }
  return index
}
