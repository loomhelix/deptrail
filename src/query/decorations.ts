import { IMPORTER_PREFIX, type NodeId, type PackageNode, type RootGraph } from '../model.ts'
import { SEVERITY_ORDER, type EnrichmentView, type Severity } from '../enrich/types.ts'
import { nodeAdvisories, nodeMeta, worstSeverity } from './enrichment-lookup.ts'
import { upwardIndex } from './dependents.ts'
import { ALL_KINDS, findNode, type KindFilter } from './lookup.ts'
import { outdatedLevel, type OutdatedLevel } from './versions.ts'

export type NodeDecoration = {
  vuln?: { severity: Severity; count: number; malicious?: true }
  deprecated?: true
  outdated?: { level: OutdatedLevel; latest: string }
  below?: { count: number; worst: Severity }
}

export type IssueCounts = { vulnerable: number; worst?: Severity; deprecated: number; outdatedDirect: number }

type Decorations = Record<NodeId, NodeDecoration>

const memo = new WeakMap<RootGraph, { key: string; result: Decorations }>()
const countsMemo = new WeakMap<RootGraph, { revision: number; counts: IssueCounts }>()

function memoKey(view: EnrichmentView, kinds: KindFilter): string {
  return `${view.revision}|${[...kinds].sort().join(',')}`
}

function decorateNode(view: EnrichmentView, root: RootGraph, node: PackageNode): NodeDecoration {
  const decoration: NodeDecoration = {}
  const advisories = nodeAdvisories(view, root, node)
  if (advisories.length > 0) {
    const vuln: NonNullable<NodeDecoration['vuln']> = {
      severity: worstSeverity(advisories.map((advisory) => advisory.severity)) as Severity,
      count: advisories.length,
    }
    if (advisories.some((advisory) => advisory.malicious)) vuln.malicious = true
    decoration.vuln = vuln
  }
  const meta = nodeMeta(view, root, node)
  if (meta) {
    if (meta.deprecated[node.version] !== undefined) decoration.deprecated = true
    const latest = meta.distTags.latest
    const level = outdatedLevel(node.version, latest)
    if (level && latest) decoration.outdated = { level, latest }
  }
  return decoration
}

function rollUpVulnerabilities(
  root: RootGraph,
  kinds: KindFilter,
  vulnerable: { node: PackageNode; severity: Severity }[],
  result: Decorations,
): void {
  const { ids, positionOf, parentStarts, parentPositions } = upwardIndex(root, kinds)
  const belowCounts = new Int32Array(ids.length)
  const worstRanks = new Int8Array(ids.length)
  const reachedBy = new Int32Array(ids.length).fill(-1)
  const queue = new Int32Array(ids.length)
  vulnerable.forEach(({ node, severity }, source) => {
    const start = positionOf.get(node.id)
    if (start === undefined) return
    const rank = SEVERITY_ORDER.indexOf(severity)
    reachedBy[start] = source
    queue[0] = start
    let queued = 1
    for (let cursor = 0; cursor < queued; cursor++) {
      const position = queue[cursor]
      for (let link = parentStarts[position]; link < parentStarts[position + 1]; link++) {
        const ancestor = parentPositions[link]
        if (reachedBy[ancestor] === source) continue
        reachedBy[ancestor] = source
        queue[queued++] = ancestor
        if (belowCounts[ancestor] === 0 || rank < worstRanks[ancestor]) worstRanks[ancestor] = rank
        belowCounts[ancestor]++
      }
    }
  })
  belowCounts.forEach((count, position) => {
    if (count > 0) (result[ids[position]] ??= {}).below = { count, worst: SEVERITY_ORDER[worstRanks[position]] }
  })
}

export function decorations(view: EnrichmentView, root: RootGraph, kinds: KindFilter): Decorations {
  const key = memoKey(view, kinds)
  const cached = memo.get(root)
  if (cached && cached.key === key) return cached.result
  const result: Decorations = {}
  const vulnerable: { node: PackageNode; severity: Severity }[] = []
  for (const node of root.packages.values()) {
    const decoration = decorateNode(view, root, node)
    if (decoration.vuln) vulnerable.push({ node, severity: decoration.vuln.severity })
    if (decoration.vuln || decoration.deprecated || decoration.outdated) result[node.id] = decoration
  }
  rollUpVulnerabilities(root, kinds, vulnerable, result)
  memo.set(root, { key, result })
  return result
}

export function isDirectDependency(root: RootGraph, node: PackageNode, kinds: KindFilter): boolean {
  for (const dependentId of node.dependents) {
    if (!dependentId.startsWith(IMPORTER_PREFIX)) continue
    const importer = findNode(root, dependentId)
    if (importer?.deps.some((edge) => edge.to === node.id && kinds.has(edge.kind))) return true
  }
  return false
}

export function issueCounts(view: EnrichmentView, root: RootGraph): IssueCounts {
  const known = countsMemo.get(root)
  if (known && known.revision === view.revision) return known.counts
  const decorated = decorations(view, root, ALL_KINDS)
  const severities: Severity[] = []
  let deprecated = 0
  let outdatedDirect = 0
  for (const node of root.packages.values()) {
    const decoration = decorated[node.id]
    if (!decoration) continue
    if (decoration.vuln) severities.push(decoration.vuln.severity)
    if (decoration.deprecated) deprecated++
    if (decoration.outdated && isDirectDependency(root, node, ALL_KINDS)) outdatedDirect++
  }
  const counts: IssueCounts = { vulnerable: severities.length, deprecated, outdatedDirect }
  const worst = worstSeverity(severities)
  if (worst) counts.worst = worst
  countsMemo.set(root, { revision: view.revision, counts })
  return counts
}
