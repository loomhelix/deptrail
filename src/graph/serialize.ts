import type { PackageNode, Scan } from '../model.ts'
import type { RootGraph } from '../model.ts'

type SerializedRootGraph = Omit<RootGraph, 'packages' | 'config'> & { packages: PackageNode[]; hasAuth: boolean }

export function serializeRootGraph(graph: RootGraph): unknown {
  const { config, packages, ...rest } = graph
  const serialized: SerializedRootGraph = { ...rest, hasAuth: config?.hasAuth ?? false, packages: [...packages.values()] }
  return serialized
}

export function deserializeRootGraph(json: unknown): RootGraph {
  const serialized = json as SerializedRootGraph
  if (typeof serialized !== 'object' || serialized === null || !Array.isArray(serialized.packages)) {
    throw new Error('Serialized root graph is malformed')
  }
  const { hasAuth: _hasAuth, packages: serializedPackages, ...rest } = serialized
  const packages = new Map<string, PackageNode>()
  for (const node of serializedPackages) packages.set(node.id, node)
  return { ...rest, packages }
}

export function serializeScan(scan: Scan): unknown {
  return { repoPath: scan.repoPath, scannedAt: scan.scannedAt, roots: scan.roots.map(serializeRootGraph) }
}
