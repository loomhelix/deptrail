import { IMPORTER_PREFIX, type NodeId, type PackageNode, type RootGraph } from '../model.ts'
import { SEVERITY_ORDER, type EnrichmentView, type Severity } from '../enrich/types.ts'
import { decorations, isDirectDependency, type NodeDecoration } from './decorations.ts'
import { dependentsSummary, ParentLinkResolver, type DependentsSummary } from './dependents.ts'
import { nodeAdvisories, nodeMeta, requestedRange, worstSeverity } from './enrichment-lookup.ts'
import type { NodeFix } from './fixes.ts'
import { findNode, type KindFilter } from './lookup.ts'
import { normalizedRequestedRange, nodeFix } from './node-fix.ts'
import { wantedVersion, type OutdatedLevel } from './versions.ts'

export type IssueKind = 'vulnerability' | 'deprecated' | 'outdated'
export type IssueLocation = { rootId: string; nodeId: NodeId; via: { direct: NodeId; importers: NodeId[] }[]; viaTruncated: number; fix?: NodeFix }
export type IssueRow = {
  name: string
  version: string
  kinds: IssueKind[]
  severity?: Severity
  malicious?: true
  vulnIds: string[]
  deprecatedMessage?: string
  latest?: string
  outdatedLevel?: OutdatedLevel
  wanted?: string
  locations: IssueLocation[]
}
export type DirectGroupIssue = { nodeId: NodeId; name: string; version: string; kinds: IssueKind[]; severity?: Severity; vulnIds: string[]; fix?: NodeFix }
export type DirectGroup = {
  rootId: string
  direct: NodeId
  name: string
  version: string
  importers: NodeId[]
  importersTruncated: number
  decoration: NodeDecoration
  worst?: Severity
  issues: DirectGroupIssue[]
  issuesTruncated: number
}

export const VIA_CAP = 20
export const IMPORTERS_CAP = 20
export const GROUP_ISSUES_CAP = 50

const OUTDATED_ORDER: readonly (OutdatedLevel | undefined)[] = ['major', 'minor', 'patch', undefined]

type FlaggedNode = {
  root: RootGraph
  node: PackageNode
  decoration: NodeDecoration
  isDirect: boolean
  summary: DependentsSummary
  kinds: IssueKind[]
  vulnIds: string[]
  deprecatedMessage?: string
  wanted?: string
  fix: () => NodeFix | undefined
}

type SortKey = { name: string; version: string; severity?: Severity; deprecated: boolean; outdatedLevel?: OutdatedLevel }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function severityPosition(severity: Severity | undefined): number {
  return severity === undefined ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(severity)
}

function compareSortKeys(left: SortKey, right: SortKey): number {
  return (
    severityPosition(left.severity) - severityPosition(right.severity) ||
    Number(right.deprecated) - Number(left.deprecated) ||
    OUTDATED_ORDER.indexOf(left.outdatedLevel) - OUTDATED_ORDER.indexOf(right.outdatedLevel) ||
    compareText(left.name, right.name) ||
    compareText(left.version, right.version)
  )
}

function sortKeyOf(flagged: FlaggedNode): SortKey {
  return {
    name: flagged.node.name,
    version: flagged.node.version,
    severity: flagged.decoration.vuln?.severity,
    deprecated: flagged.kinds.includes('deprecated'),
    outdatedLevel: flagged.kinds.includes('outdated') ? flagged.decoration.outdated?.level : undefined,
  }
}

function compareFlagged(left: FlaggedNode, right: FlaggedNode): number {
  return compareSortKeys(sortKeyOf(left), sortKeyOf(right))
}

function issueKindsOf(decoration: NodeDecoration, isDirect: boolean): IssueKind[] {
  const kinds: IssueKind[] = []
  if (decoration.vuln) kinds.push('vulnerability')
  if (decoration.deprecated) kinds.push('deprecated')
  if (decoration.outdated && isDirect) kinds.push('outdated')
  return kinds
}

function sharedWantedVersion(view: EnrichmentView, root: RootGraph, node: PackageNode, kinds: KindFilter): string | undefined {
  const meta = nodeMeta(view, root, node)
  if (!meta) return undefined
  const wanted = new Set<string | undefined>()
  for (const link of new ParentLinkResolver(root, kinds).of(node)) {
    if (!link.id.startsWith(IMPORTER_PREFIX)) continue
    const range = normalizedRequestedRange(root, node, meta, requestedRange(view, root, findNode(root, link.id) ?? node, link.range, node))
    wanted.add(wantedVersion(meta.versions, range))
  }
  return wanted.size === 1 ? [...wanted][0] : undefined
}

function lazily<T>(compute: () => T): () => T {
  let computed = false
  let value: T
  return () => {
    if (!computed) {
      value = compute()
      computed = true
    }
    return value
  }
}

function flaggedNodesOf(view: EnrichmentView, root: RootGraph, kinds: KindFilter): FlaggedNode[] {
  const decorated = decorations(view, root, kinds)
  const result: FlaggedNode[] = []
  for (const node of root.packages.values()) {
    const decoration = decorated[node.id]
    if (!decoration) continue
    const isDirect = isDirectDependency(root, node, kinds)
    const flaggedKinds = issueKindsOf(decoration, isDirect)
    if (flaggedKinds.length === 0) continue
    const summary = dependentsSummary(root, node.id, kinds)
    if (summary.importers.length === 0 && !isDirect) continue
    const deprecatedMessage = decoration.deprecated ? nodeMeta(view, root, node)?.deprecated[node.version] : undefined
    result.push({
      root,
      node,
      decoration,
      isDirect,
      summary,
      kinds: flaggedKinds,
      vulnIds: decoration.vuln ? nodeAdvisories(view, root, node).map((advisory) => advisory.id) : [],
      ...(deprecatedMessage === undefined ? {} : { deprecatedMessage }),
      fix: lazily(() => nodeFix(view, root, node, kinds)),
    })
  }
  return result
}

function locationOf(flagged: FlaggedNode): IssueLocation {
  const location: IssueLocation = {
    rootId: flagged.root.id,
    nodeId: flagged.node.id,
    via: flagged.summary.via.slice(0, VIA_CAP),
    viaTruncated: Math.max(0, flagged.summary.via.length - VIA_CAP),
  }
  const fix = flagged.fix()
  if (fix) location.fix = fix
  return location
}

function mergedRow(group: FlaggedNode[], wanted: string | undefined): IssueRow {
  const first = group[0]
  const kinds = (['vulnerability', 'deprecated', 'outdated'] as IssueKind[]).filter((kind) => group.some((flagged) => flagged.kinds.includes(kind)))
  const row: IssueRow = {
    name: first.node.name,
    version: first.node.version,
    kinds,
    vulnIds: [...new Set(group.flatMap((flagged) => flagged.vulnIds))],
    locations: group.map(locationOf),
  }
  const severity = worstSeverity(group.flatMap((flagged) => (flagged.decoration.vuln ? [flagged.decoration.vuln.severity] : [])))
  if (severity) row.severity = severity
  if (group.some((flagged) => flagged.decoration.vuln?.malicious)) row.malicious = true
  const deprecatedMessage = group.find((flagged) => flagged.deprecatedMessage !== undefined)?.deprecatedMessage
  if (deprecatedMessage !== undefined) row.deprecatedMessage = deprecatedMessage
  const outdated = group.find((flagged) => flagged.kinds.includes('outdated'))?.decoration.outdated
  if (outdated) {
    row.latest = outdated.latest
    row.outdatedLevel = outdated.level
  }
  if (wanted !== undefined) row.wanted = wanted
  return row
}

export function issuesByPackage(view: EnrichmentView, roots: readonly RootGraph[], kinds: KindFilter): IssueRow[] {
  const groups = new Map<string, FlaggedNode[]>()
  for (const root of roots) {
    for (const flagged of flaggedNodesOf(view, root, kinds)) {
      const key = `${flagged.node.name}@${flagged.node.version}`
      const group = groups.get(key)
      if (group) group.push(flagged)
      else groups.set(key, [flagged])
    }
  }
  const rows: { row: IssueRow; key: SortKey }[] = []
  for (const group of groups.values()) {
    const wantedVersions = group.map((flagged) => sharedWantedVersion(view, flagged.root, flagged.node, kinds))
    const wanted = new Set(wantedVersions).size === 1 ? wantedVersions[0] : undefined
    const row = mergedRow(group, wanted)
    rows.push({ row, key: { name: row.name, version: row.version, severity: row.severity, deprecated: row.kinds.includes('deprecated'), outdatedLevel: row.outdatedLevel } })
  }
  return rows.sort((left, right) => compareSortKeys(left.key, right.key)).map((entry) => entry.row)
}

type GroupBuilder = { group: DirectGroup; worstSeen: Severity[] }

function groupFor(builders: Map<string, GroupBuilder>, root: RootGraph, direct: PackageNode, importers: NodeId[], decoration: NodeDecoration): GroupBuilder {
  const key = `${root.id}|${direct.id}`
  const existing = builders.get(key)
  if (existing) return existing
  const created: GroupBuilder = {
    worstSeen: [],
    group: {
      rootId: root.id,
      direct: direct.id,
      name: direct.name,
      version: direct.version,
      importers: importers.slice(0, IMPORTERS_CAP),
      importersTruncated: Math.max(0, importers.length - IMPORTERS_CAP),
      decoration,
      issues: [],
      issuesTruncated: 0,
    },
  }
  builders.set(key, created)
  return created
}

function issueOf(flagged: FlaggedNode): DirectGroupIssue {
  const issue: DirectGroupIssue = {
    nodeId: flagged.node.id,
    name: flagged.node.name,
    version: flagged.node.version,
    kinds: flagged.kinds,
    vulnIds: flagged.vulnIds,
  }
  if (flagged.decoration.vuln) issue.severity = flagged.decoration.vuln.severity
  const fix = flagged.fix()
  if (fix) issue.fix = fix
  return issue
}

function compareGroups(left: DirectGroup, right: DirectGroup): number {
  return severityPosition(left.worst) - severityPosition(right.worst) || compareText(left.name, right.name) || compareText(left.rootId, right.rootId)
}

export function issuesByDirect(view: EnrichmentView, roots: readonly RootGraph[], kinds: KindFilter): DirectGroup[] {
  const builders = new Map<string, GroupBuilder>()
  for (const root of roots) {
    const decorated = decorations(view, root, kinds)
    const flaggedNodes = flaggedNodesOf(view, root, kinds).sort(compareFlagged)
    for (const flagged of flaggedNodes) {
      if (flagged.isDirect) {
        const own = flagged.summary.via.find((entry) => entry.direct === flagged.node.id)
        groupFor(builders, root, flagged.node, own?.importers ?? [], decorated[flagged.node.id] ?? {})
      }
      for (const entry of flagged.summary.via) {
        const direct = root.packages.get(entry.direct)
        if (!direct) continue
        const builder = groupFor(builders, root, direct, entry.importers, decorated[direct.id] ?? {})
        if (direct.id === flagged.node.id) continue
        if (flagged.decoration.vuln) builder.worstSeen.push(flagged.decoration.vuln.severity)
        if (builder.group.issues.length < GROUP_ISSUES_CAP) builder.group.issues.push(issueOf(flagged))
        else builder.group.issuesTruncated++
      }
    }
  }
  const groups: DirectGroup[] = []
  for (const { group, worstSeen } of builders.values()) {
    const worst = worstSeverity(worstSeen)
    if (worst) group.worst = worst
    groups.push(group)
  }
  return groups.sort(compareGroups)
}
