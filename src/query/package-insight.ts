import semver from 'semver'
import { IMPORTER_PREFIX, PLACEHOLDER_PREFIX, type NodeId, type PackageNode, type RootGraph } from '../model.ts'
import type { Advisory, EnrichmentView, MatchState, RegistryState, Severity, SkipReason } from '../enrich/types.ts'
import { advisoriesOfMatch, nodeAdvisories, nodeMeta, worstSeverity, type RequestedRange } from './enrichment-lookup.ts'
import type { FixKind, NodeFix } from './fixes.ts'
import { requireNode, type KindFilter } from './lookup.ts'
import { edgeFixes, nodeFix, normalizedRequestedRange } from './node-fix.ts'
import { outdatedLevel, wantedVersion, type OutdatedLevel } from './versions.ts'

export type InsightAdvisory = Pick<Advisory, 'id' | 'aliases' | 'summary' | 'severity' | 'malicious' | 'url' | 'fixedIn' | 'cvss'>

export type PackageInsight = {
  revision: number
  registry: {
    state: 'pending' | 'ok' | 'stale' | 'not-found' | 'failed' | 'offline' | 'not-applicable'
    message?: string
    fetchedAt?: string
    latest?: string
    outdatedLevel?: OutdatedLevel
    deprecated?: string
    versionMissing?: true
  }
  requested: {
    parent: NodeId
    range: string
    rangeSource: RequestedRange['source']
    normalizedRange?: string
    wanted?: string
    fix?: FixKind
    fixVersion?: string
  }[]
  requestedTruncated: number
  vulnerabilities: {
    state: 'pending' | 'ok' | 'stale' | 'skipped' | 'failed' | 'offline' | 'not-applicable'
    reason?: SkipReason
    message?: string
    fetchedAt?: string
    items: InsightAdvisory[]
  }
  fix?: NodeFix
  versionSeverities: Record<string, Severity>
}

export const REQUESTED_CAP = 50

function insightAdvisory(advisory: Advisory): InsightAdvisory {
  const item: InsightAdvisory = {
    id: advisory.id,
    aliases: advisory.aliases,
    summary: advisory.summary,
    severity: advisory.severity,
    malicious: advisory.malicious,
    url: advisory.url,
    fixedIn: advisory.fixedIn,
  }
  if (advisory.cvss !== undefined) item.cvss = advisory.cvss
  return item
}

function registrySection(registry: RegistryState, node: PackageNode): PackageInsight['registry'] {
  if (registry.state === 'failed') return { state: 'failed', message: registry.reason }
  if (registry.state === 'not-found') return { state: 'not-found', fetchedAt: registry.fetchedAt }
  if (registry.state !== 'ok' && registry.state !== 'stale') return { state: registry.state }
  const { meta } = registry
  const section: PackageInsight['registry'] = { state: registry.state, fetchedAt: registry.fetchedAt }
  const latest = meta.distTags.latest
  if (latest !== undefined) section.latest = latest
  const level = outdatedLevel(node.version, latest)
  if (level !== undefined) section.outdatedLevel = level
  const deprecated = meta.deprecated[node.version]
  if (deprecated !== undefined) section.deprecated = deprecated
  if (semver.valid(node.version) !== null && !meta.versions.includes(node.version)) section.versionMissing = true
  return section
}

function vulnerabilitiesSection(match: MatchState, advisories: Advisory[]): PackageInsight['vulnerabilities'] {
  if (match.state === 'ok' || match.state === 'stale') {
    return { state: match.state, fetchedAt: match.fetchedAt, items: advisories.map(insightAdvisory) }
  }
  if (match.state === 'skipped') return { state: 'skipped', reason: match.reason, items: [] }
  if (match.state === 'failed') return { state: 'failed', message: match.reason, items: [] }
  return { state: match.state, items: [] }
}

function requestedSection(
  view: EnrichmentView,
  root: RootGraph,
  node: PackageNode,
  kinds: KindFilter,
  vulnerable: boolean,
): Pick<PackageInsight, 'requested' | 'requestedTruncated'> {
  const meta = nodeMeta(view, root, node)
  const all = edgeFixes(view, root, node, kinds)
  const requested = all.slice(0, REQUESTED_CAP).map(({ parent, range, fix }) => {
    const row: PackageInsight['requested'][number] = { parent, range: range.range, rangeSource: range.source }
    const normalizedRange = normalizedRequestedRange(root, node, meta, range)
    if (normalizedRange !== undefined) row.normalizedRange = normalizedRange
    const wanted = meta ? wantedVersion(meta.versions, normalizedRange) : undefined
    if (wanted !== undefined) row.wanted = wanted
    if (vulnerable) {
      row.fix = fix.kind
      if (fix.version !== undefined) row.fixVersion = fix.version
    }
    return row
  })
  return { requested, requestedTruncated: all.length - requested.length }
}

function versionSeverities(view: EnrichmentView, node: PackageNode, monolithVersions: readonly string[]): Record<string, Severity> {
  const result: Record<string, Severity> = {}
  for (const version of monolithVersions) {
    if (version === node.version) continue
    const advisories = advisoriesOfMatch(view, node.name, view.matchOfVersion(node.name, version))
    const worst = worstSeverity(advisories.map((advisory) => advisory.severity))
    if (worst !== undefined) result[version] = worst
  }
  return result
}

export function packageInsight(
  view: EnrichmentView,
  root: RootGraph,
  nodeId: NodeId,
  kinds: KindFilter,
  monolithVersions: readonly string[],
): PackageInsight {
  const found = requireNode(root, nodeId)
  if (found.id.startsWith(IMPORTER_PREFIX) || found.id.startsWith(PLACEHOLDER_PREFIX)) {
    return {
      revision: view.revision,
      registry: { state: 'not-applicable' },
      requested: [],
      requestedTruncated: 0,
      vulnerabilities: { state: 'not-applicable', items: [] },
      versionSeverities: {},
    }
  }
  const node = found as PackageNode
  const advisories = nodeAdvisories(view, root, node)
  const vulnerable = advisories.length > 0
  const insight: PackageInsight = {
    revision: view.revision,
    registry: registrySection(view.registryOf(root, node), node),
    ...requestedSection(view, root, node, kinds, vulnerable),
    vulnerabilities: vulnerabilitiesSection(view.matchOf(root, node), advisories),
    versionSeverities: versionSeverities(view, node, monolithVersions),
  }
  const fix = nodeFix(view, root, node, kinds)
  if (fix !== undefined) insight.fix = fix
  return insight
}
