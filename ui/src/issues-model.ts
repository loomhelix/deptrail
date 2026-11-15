import type { EnrichmentStatus } from '../../src/enrich/types.ts'
import type { ChangeItem, Choice, FixChoice, NodeActions } from '../../src/actions/types.ts'
import type { DepKind, NodeId } from '../../src/model.ts'
import type { DirectGroup, DirectGroupIssue, IssueKind, IssueLocation, IssueRow } from '../../src/query/issues.ts'
import { nodeIdLabel, rootLabel } from './labels.ts'
import { packageNameOf, peerVariantsPerGroup } from './node-id.ts'
import type { RootSummary } from './api.ts'
import {
  CHECKING_FIX,
  fixLoadFailedText,
  fixOptionTitle,
  NO_FIXED_VERSION_YET,
  packageVariantText,
  rootNoteText,
  rootVariantText,
  UNAVAILABLE,
  updateRecommendation,
  type CheckGaps,
  type IssuesEmptyState,
  type KnownProblemsState,
} from './vocabulary.ts'
import { canonicalKinds, DEP_KINDS, ISSUE_KINDS } from './context.ts'

export { ISSUE_KINDS }

export type LocationRow = { key: string; location: IssueLocation; label: string; title?: string }
export type PackageGroup = { key: string; kind: IssueKind; row: IssueRow; locations: LocationRow[] }
export type ViaName = { name: string; workspace: boolean }
export type ViaLabels = { shown: ViaName[]; more: number; all: ViaName[] }
export type VulnerableRoot = { root: string; count: number }
export type DirectIssueEntry = { key: string; kind: IssueKind; row: IssueRow; location: IssueLocation }
export type DirectGroupEntry = { key: string; group: DirectGroup; own?: DirectIssueEntry; issues: DirectIssueEntry[] }
export type WorkspaceProblem = { key: string; node: NodeId; label: string; row: IssueRow }
export type ProblemCount = number | 'loading' | 'failed'
export type KnownGaps = { failedRoots?: readonly string[]; unlistedPaths?: number }
export type RootNote = { rootId: string; text: string }
export type RowActionState =
  | { kind: 'loading' }
  | { kind: 'add'; title: string }
  | { kind: 'in-changes'; itemId: string }
  | { kind: 'update' }
  | { kind: 'reason'; text: string }
  | { kind: 'root-unavailable' }
  | { kind: 'none' }

const SHOWN_VIA_NAMES = 2
const VERSION_SEPARATOR = '@'
const LOCATION_KEY_SEPARATOR = '|'
const FIX_CHOICES: ReadonlySet<Choice> = new Set<FixChoice>(['relock', 'chain', 'override'])

function firstShownKind(kinds: readonly IssueKind[], types: ReadonlySet<IssueKind>): IssueKind | undefined {
  return ISSUE_KINDS.find((kind) => kinds.includes(kind) && types.has(kind))
}

function locationRows(locations: readonly IssueLocation[]): LocationRow[] {
  const variants = peerVariantsPerGroup(
    locations,
    (location) => location.rootId,
    (location) => location.nodeId,
  )
  return locations.map((location) => {
    const variant = variants.get(location.rootId)?.get(location.nodeId)
    return {
      key: `${location.rootId}${LOCATION_KEY_SEPARATOR}${location.nodeId}`,
      location,
      label: variant === undefined ? rootLabel(location.rootId) : rootVariantText(location.rootId, variant),
      title: variant?.suffix,
    }
  })
}

export function packageGroups(rows: readonly IssueRow[], types: readonly IssueKind[], scope: string | undefined): PackageGroup[] {
  const shown = new Set(types)
  const groups: PackageGroup[] = []
  for (const row of rows) {
    const kind = firstShownKind(row.kinds, shown)
    if (kind === undefined) continue
    const inScope = scope === undefined ? row.locations : row.locations.filter((location) => location.rootId === scope)
    if (inScope.length === 0) continue
    groups.push({ key: `${row.name}${VERSION_SEPARATOR}${row.version}`, kind, row, locations: locationRows(inScope) })
  }
  return ISSUE_KINDS.flatMap((kind) => groups.filter((group) => group.kind === kind))
}

function shownLabels(labels: ReadonlyMap<string, boolean>, truncated: number): ViaLabels {
  const all = [...labels].map(([name, workspace]) => ({ name, workspace }))
  const shown = all.slice(0, SHOWN_VIA_NAMES)
  return { shown, more: all.length - shown.length + truncated, all }
}

function addLabel(labels: Map<string, boolean>, name: string, workspace: boolean): void {
  if (!labels.has(name)) labels.set(name, workspace)
}

export function viaLabels(location: IssueLocation): ViaLabels {
  const labels = new Map<string, boolean>()
  for (const entry of location.via) {
    if (entry.direct === location.nodeId) entry.importers.forEach((importer) => addLabel(labels, nodeIdLabel(importer), true))
    else addLabel(labels, packageNameOf(entry.direct), false)
  }
  return shownLabels(labels, location.viaTruncated)
}

export function importerLabels(group: Pick<DirectGroup, 'importers' | 'importersTruncated'>): ViaLabels {
  const labels = new Map<string, boolean>()
  group.importers.forEach((importer) => addLabel(labels, nodeIdLabel(importer), true))
  return shownLabels(labels, group.importersTruncated)
}

function isDirectLocation(location: IssueLocation): boolean {
  return location.via.some((entry) => entry.direct === location.nodeId)
}

export function rowActionState(
  kind: IssueKind,
  location: IssueLocation,
  actions: NodeActions | undefined,
  failure: string | undefined,
  item: ChangeItem | undefined,
  rootReason: string | undefined,
): RowActionState {
  if (item !== undefined) return { kind: 'in-changes', itemId: item.id }
  if (kind === 'outdated' || (kind === 'deprecated' && isDirectLocation(location))) return { kind: 'update' }
  if (kind === 'deprecated') return { kind: 'none' }
  if (rootReason !== undefined) return { kind: 'root-unavailable' }
  if (failure !== undefined) return { kind: 'reason', text: fixLoadFailedText(failure) }
  if (actions === undefined) return { kind: 'loading' }
  if (actions.unavailable !== undefined) return { kind: 'reason', text: actions.unavailable }
  const fix = actions.fix
  const recommended = fix?.options.find((option) => option.recommended)
  if (fix !== undefined && recommended !== undefined) return { kind: 'add', title: fixOptionTitle(recommended, fix.goal) }
  return { kind: 'reason', text: fix?.reason ?? NO_FIXED_VERSION_YET }
}

function isFixChoice(choice: Choice): choice is FixChoice {
  return FIX_CHOICES.has(choice)
}

function inChangesText(row: IssueRow, item: ChangeItem | undefined): string {
  const goal = item?.goal
  if (item === undefined || goal?.kind !== 'fix' || !isFixChoice(item.choice)) return updateRecommendation(row)
  return fixOptionTitle({ choice: item.choice, steps: item.steps }, goal)
}

export function recommendedText(state: RowActionState, row: IssueRow, item: ChangeItem | undefined): string {
  switch (state.kind) {
    case 'loading':
      return CHECKING_FIX
    case 'add':
      return state.title
    case 'reason':
      return state.text
    case 'root-unavailable':
      return UNAVAILABLE
    case 'update':
      return updateRecommendation(row)
    case 'in-changes':
      return inChangesText(row, item)
    case 'none':
      return ''
  }
}

export function rootNotes(
  rows: readonly IssueRow[],
  types: readonly IssueKind[],
  unavailable: ReadonlyMap<string, string>,
  scopeRoot: string | undefined,
): RootNote[] {
  const shown = new Set(types)
  const shownRows = rows.filter((row) => firstShownKind(row.kinds, shown) !== undefined)
  const rootsWithRows = new Set(shownRows.flatMap((row) => row.locations.map((location) => location.rootId)).filter((rootId) => scopeRoot === undefined || rootId === scopeRoot))
  return [...unavailable]
    .filter(([rootId]) => rootsWithRows.has(rootId))
    .sort(([left], [right]) => rootLabel(left).localeCompare(rootLabel(right), 'en'))
    .map(([rootId, reason]) => ({ rootId, text: rootNoteText(scopeRoot === undefined ? rootId : undefined, reason) }))
}

export function rootNoteId(prefix: string, rootId: string): string {
  return `${prefix}-root-note-${encodeURIComponent(rootId)}`
}

export function typeCounts(rows: readonly { kinds: readonly IssueKind[] }[]): Record<IssueKind, number> {
  const counts: Record<IssueKind, number> = { vulnerability: 0, deprecated: 0, outdated: 0 }
  for (const row of rows) {
    for (const kind of row.kinds) counts[kind] += 1
  }
  return counts
}

function decorationKinds(group: DirectGroup): IssueKind[] {
  const flagged: Readonly<Record<IssueKind, boolean>> = {
    vulnerability: group.decoration.vuln !== undefined,
    deprecated: group.decoration.deprecated === true,
    outdated: group.decoration.outdated !== undefined,
  }
  return ISSUE_KINDS.filter((kind) => flagged[kind])
}

function groupKinds(group: DirectGroup): IssueKind[] {
  const kinds = new Set<IssueKind>(decorationKinds(group))
  for (const issue of group.issues) {
    for (const kind of issue.kinds) kinds.add(kind)
  }
  return [...kinds]
}

export function visibleGroups(groups: readonly DirectGroup[], types: readonly IssueKind[]): DirectGroup[] {
  const shown = new Set(types)
  return groups.filter((group) => groupKinds(group).some((kind) => shown.has(kind)))
}

function isPulledInBy(location: IssueLocation, importer: NodeId): boolean {
  return location.via.some((entry) => entry.importers.includes(importer))
}

export function workspaceProblems(rows: readonly IssueRow[], root: string, importer: NodeId): WorkspaceProblem[] {
  return rows.flatMap((row) => {
    const variants = peerVariantsPerGroup(
      row.locations,
      (location) => location.rootId,
      (location) => location.nodeId,
    ).get(root)
    return row.locations
      .filter((location) => location.rootId === root && isPulledInBy(location, importer))
      .map((location) => ({
        key: `${location.rootId}${LOCATION_KEY_SEPARATOR}${location.nodeId}`,
        node: location.nodeId,
        label: packageVariantText(row.name, row.version, variants?.get(location.nodeId)),
        row,
      }))
  })
}

function hasUnlistedPaths(location: IssueLocation, root: string, importer: NodeId): boolean {
  return location.rootId === root && location.viaTruncated > 0 && !isPulledInBy(location, importer)
}

export function unlistedProblemCount(rows: readonly IssueRow[], root: string, importer: NodeId): number {
  return rows.filter((row) => row.locations.some((location) => hasUnlistedPaths(location, root, importer))).length
}

export function vulnerableRoots(rows: readonly IssueRow[], scope: string | undefined): VulnerableRoot[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.kinds.includes('vulnerability')) continue
    const roots = new Set(row.locations.map((location) => location.rootId).filter((root) => scope === undefined || root === scope))
    for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  return [...counts].map(([root, count]) => ({ root, count })).sort((left, right) => left.root.localeCompare(right.root, 'en'))
}

function failedCheckCount(status: EnrichmentStatus): number {
  const reported = status.problems.reduce((total, problem) => total + problem.count, 0)
  return Math.max(reported, status.registry.failed + status.osv.failed)
}

export function checkGaps(status: EnrichmentStatus | undefined, known: KnownGaps = {}): CheckGaps {
  return {
    failedChecks: status?.state === 'done' ? failedCheckCount(status) : 0,
    failedRoots: known.failedRoots ?? [],
    unlistedPaths: known.unlistedPaths ?? 0,
  }
}

export function checksFinishedWithoutFailures(status: EnrichmentStatus | undefined): boolean {
  return status?.state === 'done' && failedCheckCount(status) === 0
}

function hasGaps(gaps: CheckGaps): boolean {
  return gaps.failedChecks > 0 || gaps.failedRoots.length > 0 || gaps.unlistedPaths > 0
}

function settledCheckState(status: EnrichmentStatus | undefined, gaps: CheckGaps): 'checking' | 'offline' | 'clean' | 'incomplete' {
  if (status === undefined || status.state === 'running') return 'checking'
  if (status.state === 'offline') return 'offline'
  return hasGaps(gaps) ? 'incomplete' : 'clean'
}

export function narrowsKinds(kinds: readonly DepKind[]): boolean {
  return DEP_KINDS.some((kind) => !kinds.includes(kind))
}

export function issuesEmptyState(
  hasProblems: boolean,
  kinds: readonly DepKind[],
  status: EnrichmentStatus | undefined,
  gaps: CheckGaps = checkGaps(status),
): IssuesEmptyState {
  if (hasProblems) return 'filtered'
  const settled = settledCheckState(status, gaps)
  return settled === 'clean' && narrowsKinds(kinds) ? 'filtered' : settled
}

export function knownProblemsState(count: ProblemCount, status: EnrichmentStatus | undefined, gaps: CheckGaps = checkGaps(status)): KnownProblemsState {
  if (count === 'loading' || count === 'failed') return count
  return count > 0 ? 'problems' : settledCheckState(status, gaps)
}

export function problemCountOf(problems: readonly unknown[] | null, failure: string | undefined): ProblemCount {
  if (failure !== undefined) return 'failed'
  return problems === null ? 'loading' : problems.length
}

export function rootProblemCount(root: Pick<RootSummary, 'issueCounts'>): ProblemCount {
  const counts = root.issueCounts
  return counts === undefined ? 'loading' : counts.vulnerable + counts.deprecated + counts.outdatedDirect
}

export function toggledTypes(types: readonly IssueKind[], kind: IssueKind, counts: Readonly<Record<IssueKind, number>>): IssueKind[] | undefined {
  if (!types.includes(kind)) return counts[kind] > 0 ? ISSUE_KINDS.filter((entry) => entry === kind || types.includes(entry)) : undefined
  const remaining = types.filter((entry) => entry !== kind)
  return remaining.some((entry) => counts[entry] > 0) ? ISSUE_KINDS.filter((entry) => remaining.includes(entry)) : undefined
}

export function toggledKinds(kinds: readonly DepKind[], kind: DepKind): DepKind[] | undefined {
  const next = kinds.includes(kind) ? kinds.filter((entry) => entry !== kind) : [...kinds, kind]
  return next.length === 0 ? undefined : canonicalKinds(next)
}

function directLocation(group: DirectGroup): IssueLocation {
  return { rootId: group.rootId, nodeId: group.direct, via: [{ direct: group.direct, importers: group.importers }], viaTruncated: group.importersTruncated }
}

function directRow(group: DirectGroup, kinds: IssueKind[], location: IssueLocation): IssueRow {
  const { vuln, outdated } = group.decoration
  return {
    name: group.name,
    version: group.version,
    kinds,
    vulnIds: [],
    ...(vuln === undefined ? {} : { severity: vuln.severity }),
    ...(outdated === undefined ? {} : { latest: outdated.latest, outdatedLevel: outdated.level }),
    locations: [location],
  }
}

function issueLocation(rootId: string, issue: DirectGroupIssue): IssueLocation {
  return { rootId, nodeId: issue.nodeId, via: [], viaTruncated: 0 }
}

function issueRowOf(issue: DirectGroupIssue, location: IssueLocation): IssueRow {
  return {
    name: issue.name,
    version: issue.version,
    kinds: issue.kinds,
    ...(issue.severity === undefined ? {} : { severity: issue.severity }),
    vulnIds: issue.vulnIds,
    locations: [location],
  }
}

function joinedEntry(rowsByPackage: ReadonlyMap<string, IssueRow>, kind: IssueKind, fallback: IssueRow, location: IssueLocation): DirectIssueEntry {
  const row = rowsByPackage.get(`${fallback.name}${VERSION_SEPARATOR}${fallback.version}`)
  const known = row?.locations.find((candidate) => candidate.rootId === location.rootId && candidate.nodeId === location.nodeId)
  if (row === undefined || known === undefined) return { key: location.nodeId, kind, row: fallback, location }
  return { key: location.nodeId, kind, row, location: known }
}

export function directGroupRows(groups: readonly DirectGroup[], rows: readonly IssueRow[], types: readonly IssueKind[]): DirectGroupEntry[] {
  const shown = new Set(types)
  const rowsByPackage = new Map(rows.map((row) => [`${row.name}${VERSION_SEPARATOR}${row.version}`, row]))
  return visibleGroups(groups, types).flatMap((group) => {
    const ownKinds = decorationKinds(group)
    const ownKind = firstShownKind(ownKinds, shown)
    const location = directLocation(group)
    const own = ownKind === undefined ? undefined : joinedEntry(rowsByPackage, ownKind, directRow(group, ownKinds, location), location)
    const issues = group.issues.flatMap((issue) => {
      const kind = firstShownKind(issue.kinds, shown)
      if (kind === undefined) return []
      const fallbackLocation = issueLocation(group.rootId, issue)
      return [joinedEntry(rowsByPackage, kind, issueRowOf(issue, fallbackLocation), fallbackLocation)]
    })
    if (own === undefined && issues.length === 0) return []
    return [{ key: `${group.rootId}${LOCATION_KEY_SEPARATOR}${group.direct}`, group, ...(own === undefined ? {} : { own }), issues }]
  })
}
