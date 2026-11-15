import type { PackageNode, RootGraph } from '../model.ts'
import { SEVERITY_ORDER, type Advisory, type EnrichmentView, type MatchState, type PackageMeta, type Severity } from '../enrich/types.ts'
import { IMPORTER_PREFIX } from '../model.ts'
import type { GraphNode } from './lookup.ts'

export type RequestedRange = { range: string; source: 'published-manifest' | 'lockfile' }

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity)
}

export function worstSeverity(severities: Iterable<Severity>): Severity | undefined {
  let worst: Severity | undefined
  for (const severity of severities) {
    if (worst === undefined || severityRank(severity) < severityRank(worst)) worst = severity
  }
  return worst
}

export function nodeMeta(view: EnrichmentView, root: RootGraph, node: PackageNode): PackageMeta | undefined {
  const registry = view.registryOf(root, node)
  return registry.state === 'ok' || registry.state === 'stale' ? registry.meta : undefined
}

function standInAdvisory(id: string): Advisory {
  return {
    id,
    aliases: [],
    summary: '',
    severity: 'unknown',
    malicious: false,
    url: `https://osv.dev/vulnerability/${id}`,
    fixedIn: [],
    modified: '',
    affected: [],
  }
}

function compareAdvisories(left: Advisory, right: Advisory): number {
  const bySeverity = severityRank(left.severity) - severityRank(right.severity)
  if (bySeverity !== 0) return bySeverity
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function findAdvisory(advisories: readonly Advisory[], id: string): Advisory | undefined {
  return advisories.find((advisory) => advisory.id === id || advisory.aliases.includes(id))
}

function loadedAdvisoriesOf(view: Pick<EnrichmentView, 'advisoriesOf'>, name: string): Advisory[] | undefined {
  const loaded = view.advisoriesOf(name)
  return loaded.state === 'ok' || loaded.state === 'stale' ? loaded.advisories : undefined
}

export function nodeAdvisories(view: EnrichmentView, root: RootGraph, node: PackageNode): Advisory[] {
  return advisoriesOfMatch(view, node.name, view.matchOf(root, node))
}

export function completePackageAdvisories(view: EnrichmentView, root: RootGraph, node: PackageNode): Advisory[] | undefined {
  const match = view.matchOf(root, node)
  if (match.state !== 'ok' && match.state !== 'stale') return undefined
  const known = loadedAdvisoriesOf(view, node.name)
  if (known === undefined) return undefined
  for (const { id } of match.vulns) {
    if (findAdvisory(known, id) === undefined) return undefined
  }
  return known
}

export function advisoriesOfMatch(view: Pick<EnrichmentView, 'advisoriesOf'>, name: string, match: MatchState): Advisory[] {
  if (match.state !== 'ok' && match.state !== 'stale') return []
  const known = loadedAdvisoriesOf(view, name) ?? []
  const result = match.vulns.map(({ id }) => findAdvisory(known, id) ?? standInAdvisory(id))
  const distinct = [...new Map(result.map((advisory) => [advisory.id, advisory])).values()]
  return distinct.sort(compareAdvisories)
}

function isPackageNode(node: GraphNode): node is PackageNode {
  return !node.id.startsWith(IMPORTER_PREFIX)
}

export function requestedRange(
  view: EnrichmentView,
  root: RootGraph,
  parent: GraphNode,
  lockfileRange: string,
  child: PackageNode,
): RequestedRange {
  if (isPackageNode(parent)) {
    const published = nodeMeta(view, root, parent)?.manifests[parent.version]?.[child.name]
    if (published !== undefined) return { range: published, source: 'published-manifest' }
  }
  return { range: lockfileRange, source: 'lockfile' }
}
