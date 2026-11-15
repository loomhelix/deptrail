import { SEVERITY_ORDER } from '../../src/enrich/types.ts'
import { IMPORTER_PREFIX, type NodeId } from '../../src/model.ts'
import type { ChildrenResult } from '../../src/query/children.ts'
import type { NodeDecoration } from '../../src/query/decorations.ts'
import type { DependentsResult } from '../../src/query/dependents.ts'
import type { NodeView } from '../../src/query/lookup.ts'
import type { PackageInsight } from '../../src/query/package-insight.ts'
import type { SearchHit } from '../../src/query/search.ts'
import { severityTone, vulnerabilityTone, type BadgeTone } from './badges.ts'
import { credentialsHint } from './insight-text.ts'
import { peerVariantsOf, type PeerVariant } from './node-id.ts'
import { nodeIdLabel, nodeLabel } from './labels.ts'
import {
  checkedTimeText,
  DEPRECATED,
  DEPRECATED_TITLE,
  failedCheckNotice,
  failedCheckTitle,
  knownVulnerabilitiesTitle,
  latestText,
  MALICIOUS,
  NO_KNOWN_ISSUES,
  NO_KNOWN_ISSUES_TITLE,
  NO_RANGE,
  NOT_CHECKED,
  NOT_IN_REGISTRY,
  notCheckedTitle,
  OFFLINE_EXPLANATION,
  skippedCheckTitle,
  staleCheckNotice,
  updateLabelText,
  updateLabelTitle,
  VERSION_NOT_IN_REGISTRY,
  vulnerableBelowText,
  vulnerableBelowTitle,
} from './vocabulary.ts'

export type WhyHereRow = { parent: NodeId; parentLabel: string; range: string; direct: boolean; from: string[] }
export type HeaderLabel = { key: string; text: string; tone: BadgeTone; outlined: boolean; title: string }
export type AlsoInRoot = { root: string; node: NodeId; version: string }
export type DetailsMoreFacts = { latest?: string; checks: string[]; notes: string[] }
export type WhyHereRequest = { parent: NodeId; range: string }
export type VulnerableBelowRow = { node: NodeId; label: string; vuln: NonNullable<NodeDecoration['vuln']> }
export type HeaderContext = { isDirect: boolean; decorationsLoaded: boolean; checksDone: boolean }

const WHY_HERE_LIMIT = 5
const ALSO_IN_LIMIT = 3
const NOTICE_HINT_SEPARATOR = ' '

type DependentsGraph = { views: Map<NodeId, NodeView>; parentsOf: Map<NodeId, NodeId[]> }

function dependentsGraph(dependents: DependentsResult): DependentsGraph {
  const views = new Map<NodeId, NodeView>([[dependents.focus.id, dependents.focus]])
  const parentsOf = new Map<NodeId, NodeId[]>([[dependents.focus.id, dependents.focusParents.map((link) => link.id)]])
  for (const entry of dependents.nodes) {
    views.set(entry.node.id, entry.node)
    parentsOf.set(entry.node.id, entry.parents.map((link) => link.id))
  }
  return { views, parentsOf }
}

function isWorkspacePackage(id: NodeId): boolean {
  return id.startsWith(IMPORTER_PREFIX)
}

function labelOf(id: NodeId, graph: DependentsGraph): string {
  const view = graph.views.get(id)
  return view === undefined ? nodeIdLabel(id) : nodeLabel(view)
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

function workspacePackagesAbove(start: NodeId, graph: DependentsGraph): string[] {
  const seen = new Set<NodeId>([start])
  const queue = [start]
  const workspacePackages = new Set<NodeId>()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const parent of graph.parentsOf.get(queue[cursor]) ?? []) {
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(parent)
      if (isWorkspacePackage(parent)) workspacePackages.add(parent)
    }
  }
  return [...workspacePackages].map((id) => labelOf(id, graph)).sort(compareLabels)
}

export function whyHereRows(
  requested: readonly WhyHereRequest[],
  dependents: DependentsResult,
  limit: number = WHY_HERE_LIMIT,
): { rows: WhyHereRow[]; more: number } {
  const graph = dependentsGraph(dependents)
  const rows = requested.slice(0, limit).map((entry): WhyHereRow => {
    const direct = isWorkspacePackage(entry.parent)
    return {
      parent: entry.parent,
      parentLabel: labelOf(entry.parent, graph),
      range: entry.range === '' ? NO_RANGE : entry.range,
      direct,
      from: direct ? [] : workspacePackagesAbove(entry.parent, graph),
    }
  })
  return { rows, more: requested.length - rows.length }
}

export function whyHereOf(
  insight: PackageInsight | null,
  dependents: DependentsResult,
  limit: number = WHY_HERE_LIMIT,
): { rows: WhyHereRow[]; more: number } {
  const requested = insight?.requested ?? dependents.focusParents.map((link) => ({ parent: link.id, range: link.range }))
  const { rows, more } = whyHereRows(requested, dependents, limit)
  return { rows, more: more + (insight?.requestedTruncated ?? 0) }
}

function problemLabels(decoration: NodeDecoration | undefined, isDirect: boolean): HeaderLabel[] {
  const labels: HeaderLabel[] = []
  const vuln = decoration?.vuln
  if (vuln !== undefined) {
    labels.push({
      key: 'vuln',
      text: vuln.malicious ? MALICIOUS : vuln.severity,
      tone: vulnerabilityTone(vuln),
      outlined: false,
      title: knownVulnerabilitiesTitle(vuln.count, vuln.severity),
    })
  }
  if (decoration?.deprecated) labels.push({ key: 'deprecated', text: DEPRECATED, tone: 'warn', outlined: false, title: DEPRECATED_TITLE })
  const outdated = decoration?.outdated
  if (outdated !== undefined && isDirect) {
    labels.push({
      key: 'update',
      text: updateLabelText(outdated.latest, outdated.level),
      tone: 'info',
      outlined: false,
      title: updateLabelTitle(outdated.latest, outdated.level),
    })
  }
  const below = decoration?.below
  if (below !== undefined) {
    labels.push({
      key: 'below',
      text: vulnerableBelowText(below.count, below.worst),
      tone: severityTone(below.worst),
      outlined: true,
      title: vulnerableBelowTitle(below.count, below.worst),
    })
  }
  return labels
}

function notCheckedReasons(insight: PackageInsight): string[] {
  const { registry, vulnerabilities } = insight
  const reasons = new Set<string>()
  if (vulnerabilities.state === 'skipped') reasons.add(skippedCheckTitle(vulnerabilities.reason))
  if (vulnerabilities.state === 'offline' || registry.state === 'offline') reasons.add(OFFLINE_EXPLANATION)
  if (vulnerabilities.state === 'failed') reasons.add(failedCheckTitle('osv', vulnerabilities.message))
  if (registry.state === 'failed') reasons.add(failedCheckTitle('registry', registry.message))
  return [...reasons]
}

function checkedClean(insight: PackageInsight): boolean {
  const { registry, vulnerabilities } = insight
  return vulnerabilities.state === 'ok' && vulnerabilities.items.length === 0 && registry.state === 'ok' && registry.deprecated === undefined
}

function hasKnownProblem(decoration: NodeDecoration | undefined): boolean {
  return decoration?.vuln !== undefined || decoration?.deprecated === true || decoration?.below !== undefined
}

export function headerLabels(decoration: NodeDecoration | undefined, insight: PackageInsight | null, context: HeaderContext): HeaderLabel[] {
  const labels = problemLabels(decoration, context.isDirect)
  if (insight === null) return labels
  const reasons = notCheckedReasons(insight)
  if (reasons.length > 0) {
    labels.push({ key: 'not-checked', text: NOT_CHECKED, tone: 'neutral', outlined: true, title: notCheckedTitle(reasons) })
  } else if (context.checksDone && context.decorationsLoaded && !hasKnownProblem(decoration) && checkedClean(insight)) {
    labels.push({ key: 'clean', text: NO_KNOWN_ISSUES, tone: 'ok', outlined: false, title: NO_KNOWN_ISSUES_TITLE })
  }
  return labels
}

function isPreferred(candidate: AlsoInRoot, known: AlsoInRoot | undefined, preferredVersions: ReadonlySet<string>): boolean {
  return known === undefined || (!preferredVersions.has(known.version) && preferredVersions.has(candidate.version))
}

export function variantInRoot(hits: readonly SearchHit[], name: string, root: string, node: NodeId): PeerVariant | undefined {
  const nodesInRoot = hits
    .filter((hit) => hit.name === name)
    .flatMap((hit) => hit.versions.flatMap((entry) => entry.roots))
    .filter((place) => place.rootId === root)
    .map((place) => place.nodeId)
  return peerVariantsOf([...nodesInRoot, node]).get(node)
}

export function alsoInRoots(
  hits: readonly SearchHit[],
  name: string,
  root: string,
  selectedVersion?: string,
  limit: number = ALSO_IN_LIMIT,
): { roots: AlsoInRoot[]; more: number } {
  const versions = hits.filter((hit) => hit.name === name).flatMap((hit) => hit.versions)
  const versionsInRoot = versions.filter((entry) => entry.roots.some((place) => place.rootId === root)).map((entry) => entry.version)
  const preferredVersions = new Set(selectedVersion === undefined ? versionsInRoot : [selectedVersion])
  const byRoot = new Map<string, AlsoInRoot>()
  for (const entry of versions) {
    for (const place of entry.roots) {
      if (place.rootId === root) continue
      const candidate: AlsoInRoot = { root: place.rootId, node: place.nodeId, version: entry.version }
      if (isPreferred(candidate, byRoot.get(place.rootId), preferredVersions)) byRoot.set(place.rootId, candidate)
    }
  }
  const sameVersionFirst = (entry: AlsoInRoot): number => (preferredVersions.has(entry.version) ? 0 : 1)
  const ordered = [...byRoot.values()].sort(
    (left, right) => sameVersionFirst(left) - sameVersionFirst(right) || compareLabels(left.root, right.root),
  )
  return { roots: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) }
}

function withHint(text: string, hint: string | undefined): string {
  return hint === undefined ? text : `${text}${NOTICE_HINT_SEPARATOR}${hint}`
}

export function checkNotices(insight: PackageInsight, now: number): string[] {
  const { registry, vulnerabilities } = insight
  const notices: string[] = []
  if (registry.state === 'stale') notices.push(staleCheckNotice('registry', registry.fetchedAt, now))
  if (registry.state === 'failed') {
    notices.push(withHint(failedCheckNotice('registry', registry.message), credentialsHint(registry.message ?? '')))
  }
  if (vulnerabilities.state === 'stale') notices.push(staleCheckNotice('osv', vulnerabilities.fetchedAt, now))
  if (vulnerabilities.state === 'failed') notices.push(failedCheckNotice('osv', vulnerabilities.message))
  return notices
}

export function detailsMoreFacts(insight: PackageInsight | null, isDirect: boolean, now: number): DetailsMoreFacts {
  const facts: DetailsMoreFacts = { checks: [], notes: [] }
  if (insight === null) return facts
  const { registry, vulnerabilities } = insight
  if (!isDirect && registry.latest !== undefined) facts.latest = latestText(registry.latest)
  if ((registry.state === 'ok' || registry.state === 'not-found') && registry.fetchedAt !== undefined) {
    facts.checks.push(checkedTimeText('registry', registry.fetchedAt, now))
  }
  if (vulnerabilities.state === 'ok' && vulnerabilities.fetchedAt !== undefined) {
    facts.checks.push(checkedTimeText('osv', vulnerabilities.fetchedAt, now))
  }
  if (registry.versionMissing) facts.notes.push(VERSION_NOT_IN_REGISTRY)
  if (registry.state === 'not-found') facts.notes.push(NOT_IN_REGISTRY)
  return facts
}

function nodesBelow(result: ChildrenResult): NodeView[] {
  const views = new Map<NodeId, NodeView>()
  const pending = [...result.rows]
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { node } = pending[cursor]
    if (node.id === result.node.id || views.has(node.id)) continue
    views.set(node.id, node)
    pending.push(...(result.nested[node.id] ?? []))
  }
  return [...views.values()]
}

function compareVulnerableRows(left: VulnerableBelowRow, right: VulnerableBelowRow): number {
  return SEVERITY_ORDER.indexOf(left.vuln.severity) - SEVERITY_ORDER.indexOf(right.vuln.severity) || compareLabels(left.label, right.label)
}

export function vulnerableBelowRows(result: ChildrenResult, decorations: Readonly<Record<NodeId, NodeDecoration>>): VulnerableBelowRow[] {
  return nodesBelow(result)
    .flatMap((view): VulnerableBelowRow[] => {
      const vuln = decorations[view.id]?.vuln
      return vuln === undefined ? [] : [{ node: view.id, label: nodeLabel(view), vuln }]
    })
    .sort(compareVulnerableRows)
}
