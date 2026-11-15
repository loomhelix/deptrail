import semver from 'semver'
import { IMPORTER_PREFIX, PLACEHOLDER_PREFIX, type Edge, type Importer, type PackageNode, type RootGraph, type SourceKind } from '../model.ts'
import { SEVERITY_ORDER, type EnrichmentView } from '../enrich/types.ts'
import { nodeAdvisories, nodeMeta, worstSeverity } from './enrichment-lookup.ts'
import { compareVersions, packageVersions } from './graph-diff.ts'
import type {
  CompareNote,
  CompareResponse,
  CompareSideName,
  DirectChange,
  ImporterChange,
  RiskChange,
  RootComparison,
  VersionChange,
} from './compare-shape.ts'

export * from './compare-shape.ts'

export type CompareSide = { roots: readonly RootGraph[]; skippedSubmodules?: readonly string[] }

type VersionIndex = Map<string, PackageNode>
type SideState = { root: RootGraph; versions: Map<string, Set<string>>; nodes: VersionIndex }
type RiskSide = { side: SideState; only: Map<string, string[]>; change: RiskChange['change'] }

const EXACT_SOURCES: ReadonlySet<SourceKind> = new Set(['lockfile', 'installed'])
const NO_VERSIONS: ReadonlySet<string> = new Set()
const TOP_DIRECTORY = '.'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function versionKey(name: string, version: string): string {
  return `${name}@${version}`
}

function indexVersions(root: RootGraph): VersionIndex {
  const nodes: VersionIndex = new Map()
  for (const node of root.packages.values()) {
    if (node.id.startsWith(PLACEHOLDER_PREFIX)) continue
    const key = versionKey(node.name, node.version)
    if (!nodes.has(key)) nodes.set(key, node)
  }
  return nodes
}

function sideStateOf(root: RootGraph): SideState {
  return { root, versions: packageVersions(root), nodes: indexVersions(root) }
}

function sorted(versions: Iterable<string>): string[] {
  return [...versions].sort(compareVersions)
}

function onlyIn(source: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return sorted([...source].filter((version) => !other.has(version)))
}

function versionChangeKind(base: string[], target: string[]): VersionChange['change'] {
  if (base.length === 0) return 'added'
  if (target.length === 0) return 'removed'
  if (base.length === 1 && target.length === 1 && semver.valid(base[0]) && semver.valid(target[0])) {
    return semver.gt(target[0]!, base[0]!) ? 'upgraded' : 'downgraded'
  }
  return 'changed'
}

function versionChanges(base: SideState, target: SideState): { versions: VersionChange[]; baseOnly: Map<string, string[]>; targetOnly: Map<string, string[]> } {
  const names = [...new Set([...base.versions.keys(), ...target.versions.keys()])].sort(compareText)
  const versions: VersionChange[] = []
  const baseOnly = new Map<string, string[]>()
  const targetOnly = new Map<string, string[]>()
  for (const name of names) {
    const baseSet = base.versions.get(name) ?? NO_VERSIONS
    const targetSet = target.versions.get(name) ?? NO_VERSIONS
    const removed = onlyIn(baseSet, targetSet)
    const added = onlyIn(targetSet, baseSet)
    if (removed.length === 0 && added.length === 0) continue
    if (removed.length > 0) baseOnly.set(name, removed)
    if (added.length > 0) targetOnly.set(name, added)
    const baseVersions = sorted(baseSet)
    const targetVersions = sorted(targetSet)
    const change: VersionChange = { name, change: versionChangeKind(baseVersions, targetVersions), base: baseVersions, target: targetVersions }
    const highest = targetVersions.at(-1)
    const targetNode = highest === undefined ? undefined : target.nodes.get(versionKey(name, highest))?.id
    if (targetNode !== undefined) change.targetNode = targetNode
    versions.push(change)
  }
  return { versions, baseOnly, targetOnly }
}

function allVersionsOf(side: SideState): Map<string, string[]> {
  return new Map([...side.versions].map(([name, versions]) => [name, sorted(versions)]))
}

function dependencyName(root: RootGraph, edge: Edge): string {
  if (edge.to.startsWith(IMPORTER_PREFIX)) return root.importers.find((importer) => importer.id === edge.to)?.name ?? edge.to
  return root.packages.get(edge.to)?.name ?? edge.to
}

function edgesByKey(root: RootGraph, importer: Importer): Map<string, { name: string; edge: Edge }> {
  const edges = new Map<string, { name: string; edge: Edge }>()
  for (const edge of importer.deps) {
    const name = dependencyName(root, edge)
    edges.set(`${name}\0${edge.kind}`, { name, edge })
  }
  return edges
}

function directChangesOf(base: RootGraph, target: RootGraph, baseImporter: Importer, targetImporter: Importer): DirectChange[] {
  const baseEdges = edgesByKey(base, baseImporter)
  const targetEdges = edgesByKey(target, targetImporter)
  const changes: DirectChange[] = []
  const identity = { importer: targetImporter.path, importerName: targetImporter.name }
  for (const [key, before] of baseEdges) {
    const after = targetEdges.get(key)
    if (after === undefined) {
      changes.push({ ...identity, name: before.name, kind: before.edge.kind, change: 'removed', base: before.edge.range })
    } else if (after.edge.range !== before.edge.range) {
      changes.push({ ...identity, name: before.name, kind: before.edge.kind, change: 'changed', base: before.edge.range, target: after.edge.range, targetNode: after.edge.to })
    }
  }
  for (const [key, after] of targetEdges) {
    if (baseEdges.has(key)) continue
    changes.push({ ...identity, name: after.name, kind: after.edge.kind, change: 'added', target: after.edge.range, targetNode: after.edge.to })
  }
  return changes
}

function workspaceChanges(base: RootGraph, target: RootGraph): { directs: DirectChange[]; importers: ImporterChange[] } {
  const baseByPath = new Map(base.importers.map((importer) => [importer.path, importer]))
  const targetByPath = new Map(target.importers.map((importer) => [importer.path, importer]))
  const directs: DirectChange[] = []
  const importers: ImporterChange[] = []
  for (const [path, importer] of baseByPath) {
    const counterpart = targetByPath.get(path)
    if (counterpart === undefined) importers.push({ path, name: importer.name, change: 'removed' })
    else directs.push(...directChangesOf(base, target, importer, counterpart))
  }
  for (const [path, importer] of targetByPath) {
    if (!baseByPath.has(path)) importers.push({ path, name: importer.name, change: 'added' })
  }
  directs.sort((left, right) => compareText(left.importer, right.importer) || compareText(left.name, right.name) || compareText(left.kind, right.kind))
  importers.sort((left, right) => compareText(left.path, right.path))
  return { directs, importers }
}

function severityRank(risk: RiskChange): number {
  return risk.severity === undefined ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(risk.severity)
}

function compareRisk(left: RiskChange, right: RiskChange): number {
  const byChange = left.change === right.change ? 0 : left.change === 'introduced' ? -1 : 1
  return byChange || severityRank(left) - severityRank(right) || compareText(left.name, right.name) || compareVersions(left.version, right.version)
}

function isPending(view: EnrichmentView, root: RootGraph, node: PackageNode): boolean {
  const match = view.matchOf(root, node)
  if (match.state === 'pending' || view.registryOf(root, node).state === 'pending') return true
  return (match.state === 'ok' || match.state === 'stale') && match.vulns.length > 0 && view.advisoriesOf(node.name).state === 'pending'
}

function riskOf(view: EnrichmentView, sides: readonly RiskSide[]): { risk: RiskChange[]; riskPending: number } {
  const risk: RiskChange[] = []
  const pending = new Set<string>()
  for (const { side, only, change } of sides) {
    for (const [name, versions] of only) {
      for (const version of versions) {
        const node = side.nodes.get(versionKey(name, version))
        if (node === undefined) continue
        if (isPending(view, side.root, node)) pending.add(versionKey(name, version))
        const located = change === 'introduced' ? { targetNode: node.id } : {}
        const advisories = nodeAdvisories(view, side.root, node)
        if (advisories.length > 0) {
          const severity = worstSeverity(advisories.map((advisory) => advisory.severity))
          risk.push({ name, version, issue: 'vulnerability', change, ...(severity === undefined ? {} : { severity }), ...located })
        }
        if (nodeMeta(view, side.root, node)?.deprecated[version] !== undefined) {
          risk.push({ name, version, issue: 'deprecated', change, ...located })
        }
      }
    }
  }
  return { risk: risk.sort(compareRisk), riskPending: pending.size }
}

function emptyComparison(rootId: string, presence: RootComparison['presence'], state: RootComparison['state'], notes: CompareNote[], exact: boolean): RootComparison {
  return { rootId, presence, state, notes, exact, versions: [], directs: [], importers: [], risk: [], riskPending: 0 }
}

function isExact(root: RootGraph): boolean {
  return EXACT_SOURCES.has(root.source)
}

function sideNotes(sides: readonly [CompareSideName, RootGraph | undefined][]): CompareNote[] {
  const notes: CompareNote[] = []
  for (const [side, root] of sides) {
    if (root === undefined) continue
    if (root.status === 'failed') notes.push({ side, kind: 'failed', error: root.error ?? '' })
    else if (!isExact(root)) notes.push({ side, kind: 'inexact', source: root.source })
  }
  return notes
}

function isInside(rootId: string, directories: readonly string[] | undefined): boolean {
  return (directories ?? []).some((directory) => directory === TOP_DIRECTORY || rootId === directory || rootId.startsWith(`${directory}/`))
}

function skippingSide(rootId: string, sides: { base: CompareSide; target: CompareSide }, baseRoot: RootGraph | undefined, targetRoot: RootGraph | undefined): CompareSideName | undefined {
  if (baseRoot === undefined && isInside(rootId, sides.base.skippedSubmodules)) return 'base'
  if (targetRoot === undefined && isInside(rootId, sides.target.skippedSubmodules)) return 'target'
  return undefined
}

function compareRoot(view: EnrichmentView, rootId: string, base: RootGraph | undefined, target: RootGraph | undefined, skippedBy?: CompareSideName): RootComparison {
  const presence: RootComparison['presence'] = base === undefined ? 'target-only' : target === undefined ? 'base-only' : 'both'
  if (skippedBy !== undefined) return emptyComparison(rootId, presence, 'ready', [{ side: skippedBy, kind: 'submodule' }], false)
  const present = [base, target].filter((root): root is RootGraph => root !== undefined)
  const exact = present.every(isExact)
  if (present.some((root) => root.status === 'scanning')) return emptyComparison(rootId, presence, 'scanning', [], exact)
  const notes = sideNotes([
    ['base', base],
    ['target', target],
  ])
  if (present.some((root) => root.status === 'failed')) return emptyComparison(rootId, presence, 'failed', notes, exact)
  const comparison = emptyComparison(rootId, presence, 'ready', notes, exact)
  if (base !== undefined && target !== undefined) {
    const baseState = sideStateOf(base)
    const targetState = sideStateOf(target)
    Object.assign(comparison, workspaceChanges(base, target))
    if (!exact) return comparison
    const { versions, baseOnly, targetOnly } = versionChanges(baseState, targetState)
    comparison.versions = versions
    Object.assign(
      comparison,
      riskOf(view, [
        { side: targetState, only: targetOnly, change: 'introduced' },
        { side: baseState, only: baseOnly, change: 'resolved' },
      ]),
    )
    return comparison
  }
  if (!exact) return comparison
  const single = sideStateOf((base ?? target) as RootGraph)
  Object.assign(comparison, riskOf(view, [{ side: single, only: allVersionsOf(single), change: target === undefined ? 'resolved' : 'introduced' }]))
  return comparison
}

export function compareSources(view: EnrichmentView, base: CompareSide, target: CompareSide): CompareResponse {
  const baseById = new Map(base.roots.map((root) => [root.id, root]))
  const targetById = new Map(target.roots.map((root) => [root.id, root]))
  const rootIds = [...new Set([...baseById.keys(), ...targetById.keys()])].sort(compareText)
  const complete = [...base.roots, ...target.roots].every((root) => root.status !== 'scanning')
  return {
    revision: view.revision,
    complete,
    roots: rootIds.map((rootId) => {
      const baseRoot = baseById.get(rootId)
      const targetRoot = targetById.get(rootId)
      return compareRoot(view, rootId, baseRoot, targetRoot, skippingSide(rootId, { base, target }, baseRoot, targetRoot))
    }),
  }
}
