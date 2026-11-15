import { IMPORTER_PREFIX, type NodeId, type PackageNode, type RootGraph } from '../model.ts'
import type { EnrichmentView, PackageMeta } from '../enrich/types.ts'
import { ParentLinkResolver } from './dependents.ts'
import { completePackageAdvisories, nodeAdvisories, nodeMeta, requestedRange, type RequestedRange } from './enrichment-lookup.ts'
import { combineFixes, edgeFix, type EdgeFix, type NodeFix } from './fixes.ts'
import { findNode, type KindFilter } from './lookup.ts'
import { normalizeRange, safeVersions } from './versions.ts'

export type ParentEdgeFix = { parent: NodeId; parentIsImporter: boolean; range: RequestedRange; fix: EdgeFix }

export function normalizedRequestedRange(root: RootGraph, node: PackageNode, meta: PackageMeta | undefined, requested: RequestedRange): string | undefined {
  return normalizeRange(requested.range, {
    name: node.name,
    catalogs: root.config?.catalogs ?? {},
    distTags: meta?.distTags,
  })
}

export function safeCandidates(view: EnrichmentView, root: RootGraph, node: PackageNode, meta: PackageMeta | undefined): string[] | undefined {
  if (meta === undefined) return undefined
  const advisories = completePackageAdvisories(view, root, node)
  if (advisories === undefined) return undefined
  return safeVersions(meta, advisories).filter((version) => version !== node.version)
}

export function edgeFixes(view: EnrichmentView, root: RootGraph, node: PackageNode, kinds: KindFilter): ParentEdgeFix[] {
  const meta = nodeMeta(view, root, node)
  const safe = safeCandidates(view, root, node, meta)
  const result: ParentEdgeFix[] = []
  for (const link of new ParentLinkResolver(root, kinds).of(node)) {
    const parent = findNode(root, link.id)
    if (!parent) continue
    const parentIsImporter = link.id.startsWith(IMPORTER_PREFIX)
    const range = requestedRange(view, root, parent, link.range, node)
    const fix = edgeFix({
      current: node.version,
      range: normalizedRequestedRange(root, node, meta, range),
      parentIsImporter,
      safe,
    })
    result.push({ parent: link.id, parentIsImporter, range, fix })
  }
  return result
}

export function nodeFix(view: EnrichmentView, root: RootGraph, node: PackageNode, kinds: KindFilter): NodeFix | undefined {
  if (nodeAdvisories(view, root, node).length === 0) return undefined
  return combineFixes(edgeFixes(view, root, node, kinds))
}
