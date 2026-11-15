import { goalText, importerLabel, INSTALL_FAILURE_PREFIX } from '../../src/actions/labels.ts'
import { shortCommit, shortRef, type ShownSource } from './source.ts'
import type {
  ActionsSummary,
  ChangeItem,
  Choice,
  FixChoice,
  FixGoal,
  FixOption,
  Goal,
  Job,
  JobKind,
  JobPhase,
  JobResult,
  OverridesFile,
  PackageManagerName,
  PreviewFile,
  PreviewGoal,
  RestoreResult,
  SharingRoot,
  Step,
  UpdateChoice,
} from '../../src/actions/types.ts'
import type { EnrichmentStatus, Severity, SkipReason } from '../../src/enrich/types.ts'
import type { DepKind, NodeId, SourceKind } from '../../src/model.ts'
import type { DuplicateEntry } from '../../src/query/duplicates.ts'
import type { IssueKind, IssueRow } from '../../src/query/issues.ts'
import type { SubgraphStub } from '../../src/query/subgraph.ts'
import type { OutdatedLevel } from '../../src/query/versions.ts'
import type { RootSummary } from './api.ts'
import type { ChangeStep, PrimaryAction } from './changes-flow.ts'
import { DEP_KINDS, type ExploreMode, type IssueGrouping, type ViewName } from './context.ts'
import type { GraphScope } from './explore-options.ts'
import type { PeerVariant, VariantPeer } from './node-id.ts'
import type { ListedPlacement } from './visible-tree.ts'
import { APPROXIMATE_SOURCES, countLabel, rootLabel } from './labels.ts'

export type HealthLink = { kind: 'vulnerability' | 'deprecated' | 'outdated' | 'changes'; text: string }
export type ShortcutRow = { keys: string; action: string }
export type IssuesEmptyState = 'checking' | 'offline' | 'clean' | 'incomplete' | 'filtered'
export type KnownProblemsState = 'loading' | 'failed' | 'checking' | 'offline' | 'clean' | 'incomplete' | 'problems'
export type CheckGaps = { failedChecks: number; failedRoots: readonly string[]; unlistedPaths: number }
export type RootCollectResult = { root: string; result: JobResult | undefined; error?: string }
export type CheckSource = 'registry' | 'osv'
export type ChangeStepEntry = { step: Exclude<ChangeStep, 'applied'>; number: number; title: string }
export type ChangesFailure = 'load' | 'clear' | 'undo' | 'preview' | 'apply' | 'revert' | 'cancel' | 'follow' | 'edit'
export type JobOutcome = { text: string; failed: boolean }
export type RootStatusText = 'scanning' | 'failed'
export type StubSide = SubgraphStub['side']

export const ALL_ROOTS = 'All roots'
export const HEALTH_SEPARATOR = ' · '
export const SHOW_ALL_DEPENDENCY_TYPES = 'Show all dependency types'
export const REFRESH = 'Refresh'
export const RESCAN_FILES = 'Rescan files'
export const RECHECK_REGISTRY = 'Recheck registry and OSV'
export const WORKING_TREE = 'Working tree'
export const LOCAL_BRANCHES = 'Local branches'
export const REMOTE_BRANCHES = 'Remote branches'
export const TAGS = 'Tags'
export const CHECKED_OUT = 'checked out'
export const FILTER_REFS_PLACEHOLDER = 'Filter branches and tags'
export const BRANCHES_UNAVAILABLE = 'Branches unavailable'
export const SELECT_SOURCE = 'Select source'
export const LOADING_REFS = 'Loading branches…'

export function headOptionLabel(shortCommit: string): string {
  return `Last commit (HEAD) · ${shortCommit}`
}

export function sourceLabel(source: ShownSource): string {
  return source.kind === 'working' ? WORKING_TREE : shortRef(source.ref)
}

export function moreRefsText(count: number): string {
  return `${count} more. Type to filter.`
}

export function noRefMatchText(filter: string): string {
  return `No branch or tag matches “${filter}”`
}

export function detachedText(shortCommit: string): string {
  return `detached at ${shortCommit}`
}

export function sourceButtonName(label: string): string {
  return `Source: ${label}`
}

export const BACK_TO_WORKING_TREE = 'Back to working tree'
export const CHANGES_ON_COMMIT = 'Changes apply to the working tree.'
export const RELOAD_BRANCH = 'Reload branch'
const READ_ONLY_SOURCE = 'Read-only: changes and actions apply to the working tree.'

export function commitNoticeText(source: Extract<ShownSource, { kind: 'commit' }>, now: number): string {
  const committed = source.committedAt === undefined ? '' : `, committed ${relativeTime(source.committedAt, now)}`
  const skipped = source.skippedSubmodules?.length ? ` ${skippedSubmodulesText(source.skippedSubmodules)}` : ''
  return `Viewing ${shortRef(source.ref)} at ${shortCommit(source.commit)}${committed}. ${READ_ONLY_SOURCE}${skipped}`
}

function skippedSubmodulesText(paths: readonly string[]): string {
  return `Files inside git submodules are not read: ${paths.join(', ')}.`
}

export function noRootsInText(ref: string): string {
  return `No roots in ${shortRef(ref)}`
}

export const BASE = 'Base'
export const SWAP = 'Swap'
export const SINCE_MERGE_BASE = 'Since merge base'
export const NO_MERGE_BASE = 'No merge base'
export const CHECKING_RISK = 'Checking registry and OSV…'
export const SAME_SOURCE = 'Base and target are the same commit.'
export const RISK_HEADING = 'Vulnerabilities and deprecations'
export const DIRECTS_HEADING = 'Direct dependencies'
export const VERSIONS_HEADING = 'Package versions'
export const PACKAGE_COLUMN = 'Package'
export const CHANGE_COLUMN = 'Change'
export const WORKSPACE_PACKAGE_COLUMN = 'Workspace package'
export const DEPENDENCY_COLUMN = 'Dependency'
export const TYPE_COLUMN = 'Type'
export const ISSUE_COLUMN = 'Issue'
export const DEPRECATED_ISSUE = 'deprecated'
export const COMPARING = 'Comparing…'

export function mergeBaseText(shortCommit: string): string {
  return `merge base ${shortCommit}`
}

export function buildingText(label: string): string {
  return `Building ${label}…`
}

export function riskPendingText(count: number): string {
  return `${count} ${count === 1 ? 'version' : 'versions'} still being checked`
}

export function vulnerableIssueText(severity: string): string {
  return `vulnerable · ${severity}`
}

export function showAllText(count: number): string {
  return `Show all ${count}`
}

export function workspacePackageChangeText(change: 'added' | 'removed', name: string, path: string): string {
  const location = path === name ? '' : ` (${path})`
  return `Workspace package ${change}: ${name}${location}`
}

export function compareFailedText(message: string): string {
  return `Could not compare: ${message}`
}

export function compareUnavailableText(reason: string): string {
  return `Compare is unavailable: ${reason}`
}

export const COMPARE_LABEL = 'Compare'
export const SELECT_BASE = 'Select base'
export const KEYBOARD_SHORTCUTS = 'Keyboard shortcuts'
export const SHORTCUT_KEY_HEADING = 'Key'
export const SHORTCUT_ACTION_HEADING = 'Action'
export const SHORTCUT_KEY_SEPARATOR = ', '
export const CLOSE = 'Close'
export const ROOTS_HEADING = 'Roots'
export const DETAILS_HEADING = 'Details'
export const ROOTS_PANEL = 'roots panel'
export const DETAILS_PANEL = 'details panel'
export const ROOTS_PANEL_SHORTCUT = '['
export const DETAILS_PANEL_SHORTCUT = ']'
export const ROOT_PACKAGE = '(root)'
export const VIEWS_LABEL = 'Views'
export const EXPLORE_MODE_LABEL = 'Explore mode'
export const SELECTED = 'Selected'
export const CLEAR_SELECTION = 'Clear selection'
export const EXPLORE_REQUIRES_ROOT = 'Explore requires a single root'
export const EXPLORE_REQUIRES_ROOT_HINT = 'Select a root or search for a package.'
export const EXPLORE_ROOT_CHOICES = 'Roots to explore'
export const EXPLORE_OPTIONS = 'Options'
export const DUPLICATES_ONLY = 'Duplicates only'
const OPTIONS_LABEL_SEPARATOR = ' · '

export function exploreOptionsLabel(duplicatesOnly: boolean): string {
  return duplicatesOnly ? `${EXPLORE_OPTIONS}${OPTIONS_LABEL_SEPARATOR}${DUPLICATES_ONLY}` : EXPLORE_OPTIONS
}
export const LEVELS_UP = 'Levels up'
export const LEVELS_DOWN = 'Levels down'
export const NODE_LIMIT = 'Node limit'
export const GRAPH_SCOPE = 'Scope'
export const GRAPH_HINT = 'Click a package to select it. Drag to pan, scroll to zoom.'
export const GRAPH_NODE_HINT = 'Click to select'
export const GRAPH_ANCHOR_NOTE = 'Explore is built around this package'
export const GRAPH_CLUSTERS = 'Clusters'
export const CLICK_TO_EXPAND = 'Click to expand'
export const DEPENDENTS_NEED_PACKAGE = 'Select a package to see its dependents.'
export const ISSUES_TABLE_LABEL = 'Issues'
export const CHECKING_FIX = 'Checking fix…'
export const ADD_FIX = 'Add fix'
export const UPDATE_PACKAGE = 'Update…'
export const IN_CHANGES = '✓ In changes'
export const NO_FIXED_VERSION_YET = 'No fixed version yet'
export const UNAVAILABLE = 'Unavailable'
const ROOT_NOTE_SEPARATOR = ': '
export const ISSUE_TYPES_LABEL = 'Issue types'
export const VIEW_MENU = 'View'
export const GROUP_BY = 'Group by'
export const DEPENDENCY_TYPES = 'Dependency types'
export const ADD_RECOMMENDED_FIXES = 'Add recommended fixes…'
export const ADD_RECOMMENDED_TITLE = 'Add recommended fixes'
export const ADD_RECOMMENDED_INTRO = 'Adds the recommended fix for each vulnerable package to the changes of each selected root, one root at a time.'
export const ADD_RECOMMENDED_ROOTS = 'Roots'
export const ADD_FIXES = 'Add fixes'
export const CANCEL = 'Cancel'
export const REVIEW_CHANGES = 'Review changes'
export const LOADING_ISSUES = 'Loading issues…'
export const ISSUES_BY_DIRECT_LABEL = 'Issues by direct dependency'
export const JOB_FAILED = 'the job failed'
export const JOB_CANCELED = 'the job was canceled'
export const DEPENDENTS = 'Dependents'
export const OPEN_IN_EXPLORE = 'Open in Explore'
export const NO_DEPENDENTS = 'No dependents in this root with the current filters.'
export const NO_RANGE = '(none)'
export const DIRECT_DEPENDENCY = 'direct dependency'
export const ALSO_IN = 'also in'
export const MORE = 'More'
export const MALICIOUS = 'malicious'
export const DEPRECATED = 'deprecated'
export const DEPRECATED_TITLE = 'This version is deprecated'
export const NO_KNOWN_ISSUES = 'no known issues'
export const NO_KNOWN_ISSUES_TITLE = 'Registry and OSV checks found no issues'
export const NOT_CHECKED = 'not checked'
export const NPM = 'npm'
export const VERSION_NOT_IN_REGISTRY = 'This version is not in the registry. It may have been unpublished.'
export const NOT_IN_REGISTRY = 'Not found in the registry.'
export const ACTIONS_HEADING = 'Actions'
export const ADD_TO_CHANGES = 'Add to changes'
export const IN_CHANGES_REVIEW = '✓ In changes · Review'
export const REPLACE_IN_CHANGES = 'Replace in changes'
export const SAVE_CHANGE = 'Save change'
export const ADDED_TO_CHANGES = 'Added to changes'
export const REPLACED_IN_CHANGES = 'Replaced in changes'
export const RECOMMENDED = 'recommended'
export const VERSION = 'Version'
export const SHOW_PRERELEASES = 'Show prereleases'
export const WORKSPACE_PACKAGES = 'Workspace packages'
export const NO_UPDATE_AVAILABLE = 'No update available.'
export const NOT_A_DIRECT_DEPENDENCY_UPDATE = 'Updates are offered for direct dependencies of a workspace package.'
export const LATEST = 'latest'
export const IN_RANGE = 'in range'
export const CURRENT = 'current'
export const MAJOR_UPDATE = 'major update'
export const SELECT_ISSUE_PROMPT = 'Select an issue to see available actions.'
export const LOADING = 'Loading…'
export const CHECKING_PACKAGES = 'Checking packages…'
export const LOADING_SCAN = 'Loading scan…'
export const NO_KNOWN_ISSUES_STATUS = 'No known issues'
export const ISSUES_IN_DEPENDENCIES = 'Issues in dependencies'
export const NO_ISSUES_IN_DEPENDENCIES = 'No known issues in dependencies'
export const EXPLORE_DEPENDENCIES = 'Explore dependencies'
export const VULNERABLE_DEPENDENCIES = 'Vulnerable dependencies'
export const CHANGE_STEPS_LABEL = 'Steps'
export const CHANGES_EDITED_AFTER_PREVIEW = 'Changes were edited after this preview'
export const NO_CHANGES_YET = 'No changes yet. Add fixes from Issues or the details panel.'
export const LOADING_CHANGES = 'Loading changes…'
export const CLEAR = 'Clear'
export const UNDO = 'Undo'
export const EDIT = 'Edit'
export const RUNNING_JOB = 'Running job'
export const LAST_JOB = 'Last job'
export const REVERT_FILES = 'Revert files'
export const NO_OUTPUT_YET = 'No output yet.'
export const RUN_INSTALL = 'Run install:'
export const APPLY = 'Apply'
export const NONE = 'None'
export const PRODUCT_NAME = 'deptrail'
export const SESSION_REJECTED = 'The session token was rejected. Open the URL that deptrail printed in the terminal.'
export const RESCAN_DID_NOT_FINISH = 'Rescan did not finish. Check the terminal for errors.'
export const PACKAGE_DETAILS = 'Package details'
export const DISMISS = 'Dismiss'
export const SEARCH_PACKAGES = 'Search packages'
export const SEARCH_PLACEHOLDER = 'Search packages or name@range'
export const SEARCH_RESULTS = 'Search results'
export const SEARCHING = 'Searching…'
export const LOADING_ROOTS = 'Loading roots…'
export const NO_ROOTS_FOUND = 'No package.json roots were found.'
export const PACKAGE_CHECKS = 'Package checks'
export const REGISTRY_CHECKS = 'Registry checks'
export const RESOLVE_VERSIONS = 'Resolve versions'
export const CREDENTIALS_HINT = 'Check the token for this registry in .npmrc.'
export const DUPLICATE_BADGE = 'dup'
export const SHOWN_ABOVE = 'shown above'
export const FAILED_TO_LOAD = 'failed to load'
export const NO_DUPLICATES_BELOW_ROW = 'No duplicated packages below this row.'
export const GRAPH_LABEL = 'Dependency graph'
export const NEW_FILE = 'new file'
export const LOADING_DIFF = 'Loading diff…'
export const DIFF_TRUNCATED = 'Showing the first 2 MB of the diff.'

export const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  lockfile: 'lockfile',
  installed: 'installed',
  'resolved-today': 'resolved today',
  'manifest-only': 'manifest only',
}

export const ROOT_STATUS_TEXTS: Readonly<Record<RootStatusText, string>> = {
  scanning: 'scanning',
  failed: 'failed',
}

export const CHANGE_STEPS: readonly ChangeStepEntry[] = [
  { step: 'changes', number: 1, title: 'Changes' },
  { step: 'preview', number: 2, title: 'Preview' },
  { step: 'apply', number: 3, title: 'Apply' },
]

export const PRIMARY_ACTION_TEXTS: Readonly<Record<PrimaryAction, string>> = {
  preview: 'Preview',
  apply: 'Apply…',
  'preview-again': 'Preview again',
}

export const PREVIEW_PARTS = {
  title: 'Preview',
  goals: 'Goals',
  newIssues: 'New issues',
  warnings: 'Warnings',
  files: 'Files',
} as const

export const GROUPING_NAMES: Readonly<Record<IssueGrouping, string>> = {
  package: 'Package',
  direct: 'Direct dependency',
}

export const ISSUE_COLUMN_TITLES = {
  issue: 'Issue',
  package: 'Package',
  root: 'Root',
  recommended: 'Recommended',
} as const

export const VIA_LABEL = 'Via'
export const VIA_PREFIX = 'via'

export const VIEW_TITLES: Readonly<Record<ViewName, string>> = {
  issues: 'Issues',
  changes: 'Changes',
  explore: 'Explore',
  compare: 'Compare',
}

export const EXPLORE_MODE_NAMES: Readonly<Record<ExploreMode, string>> = {
  trail: DEPENDENTS,
  tree: 'Dependencies',
  graph: 'Graph',
}

export const GRAPH_SCOPE_NAMES: Readonly<Record<GraphScope, string>> = {
  package: 'Around the package',
  'whole-root': 'Whole root',
}

export const LISTED_WORKSPACE_PACKAGE_TEXTS: Readonly<Record<ListedPlacement, string>> = {
  above: 'workspace package, listed above',
  below: 'workspace package, listed below',
}

export const TRAIL_COLUMN_TITLES = {
  importers: WORKSPACE_PACKAGES,
  direct: 'Direct dependencies',
  via: 'Via',
  anchor: 'This package',
  children: 'Depends on',
} as const

export const SHORTCUT_ROWS: readonly ShortcutRow[] = [
  { keys: '⌘K, Ctrl+K, /', action: 'Focus search' },
  { keys: '[', action: 'Collapse or expand the roots panel' },
  { keys: ']', action: 'Collapse or expand the details panel' },
  { keys: '1, 2, 3, 4', action: 'Go to Issues, Changes, Explore, or Compare' },
  { keys: '?', action: 'Show keyboard shortcuts' },
  { keys: 'Esc', action: 'Close the open menu, popover, or dialog' },
]

const RELOCK = 'Re-lock'
const UPDATE = 'Update'
const DEFAULT_CATALOG = 'default'
const SHOWN_UPDATED_PACKAGES = 2
const FIX_CHOICE_NAMES: Readonly<Record<FixChoice, string>> = {
  relock: 'Re-lock',
  chain: 'Update parent packages',
  override: 'Override',
}
const NEEDS_RANGE_CHANGE = 'Needs a range change'
const NO_UPDATE_RECOMMENDATION = 'No update available'
const IN_RANGE_RECOMMENDATION = 'In range'
const SHOWN_SKIPPED_PACKAGES = 3
export const LIST_SEPARATOR = ', '
const CLAUSE_SEPARATOR = '; '
export const OFFLINE_EXPLANATION = 'Offline: started with --offline'
const UNKNOWN_REASON = 'unknown reason'
const EARLIER_CHECK = 'an earlier check'
const CHECK_SOURCE_NAMES: Readonly<Record<CheckSource, string>> = {
  registry: 'Registry',
  osv: 'OSV',
}
const CHECK_TARGETS: Readonly<Record<CheckSource, string>> = {
  registry: 'the registry',
  osv: 'OSV',
}
const SKIPPED_CHECK_TITLES: Readonly<Record<SkipReason, string>> = {
  'private-scope': 'Private scope with a registry in .npmrc; not sent to OSV',
  'non-registry': 'Not from a registry (git, file, or link)',
  'unknown-version': 'The exact version is unknown (manifest only)',
}
const CHECKED_PACKAGES_CLEAN = 'No known issues in the checked packages'
const CHECKED_PACKAGES_CLEAN_OF_SELECTED_TYPES = 'No known issues of the selected types in the checked packages'
const ISSUES_EMPTY_TEXTS: Readonly<Record<Exclude<IssuesEmptyState, 'clean' | 'incomplete'>, string>> = {
  checking: CHECKING_PACKAGES,
  offline: OFFLINE_EXPLANATION,
  filtered: 'No issues of the selected types',
}

const ISSUE_SECTION_TITLES: Readonly<Record<IssueKind, string>> = {
  vulnerability: 'Vulnerabilities',
  deprecated: 'Deprecations',
  outdated: 'Updates',
}

const OVERRIDES_FILE_LABELS: Readonly<Record<OverridesFile, string>> = {
  'pnpm-workspace.yaml': 'pnpm-workspace.yaml',
  'package.json#pnpm.overrides': 'package.json (pnpm.overrides)',
  'package.json#overrides': 'package.json (overrides)',
}

const KNOWN_PROBLEMS_TEXTS: Readonly<Record<'loading' | 'checking' | 'offline', string>> = {
  loading: LOADING,
  checking: CHECKING_PACKAGES,
  offline: OFFLINE_EXPLANATION,
}

const SOURCE_ACCURACY_TEXTS: Readonly<Record<SourceKind, string>> = {
  lockfile: 'Exact versions from the lockfile.',
  installed: 'Versions read from the installed node_modules.',
  'resolved-today': 'Versions are resolved as of today, not read from a lockfile.',
  'manifest-only': 'Only direct dependencies from package.json are known.',
}

const CHANGES_FAILURE_TEXTS: Readonly<Record<ChangesFailure, string>> = {
  load: 'Could not load the changes',
  clear: 'Could not clear the changes',
  undo: 'Could not restore the cleared changes',
  preview: 'Could not start the preview',
  apply: 'Could not apply the changes',
  revert: 'Could not revert the files',
  cancel: 'Could not cancel the job',
  follow: 'Could not get the job status',
  edit: 'Could not open the package',
}
const SHOWN_GOAL_DETAILS = 3
const UPDATE_BADGE = '↑'
const NO_PHASE_TEXT = 'Working…'
const UNKNOWN_ERROR = 'unknown error'
const UNKNOWN_ROOT_ERROR = 'Unknown error'
const JUST_NOW = 'just now'
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3_600
const SECONDS_PER_DAY = 86_400
const MILLISECONDS_PER_SECOND = 1000
const RELATIVE_TIME_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * SECONDS_PER_DAY],
  ['month', 30 * SECONDS_PER_DAY],
  ['week', 7 * SECONDS_PER_DAY],
  ['day', SECONDS_PER_DAY],
  ['hour', SECONDS_PER_HOUR],
  ['minute', SECONDS_PER_MINUTE],
]
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
const HEADING_ADVISORY_LIMIT = 2
const UNMET_FIX_HINT = ' → use an override or add a step'
const INSTALLING_TEXT = 'installing…'
const SEARCH_SHORTCUT_ON_APPLE = '⌘K'
const SEARCH_SHORTCUT_ELSEWHERE = 'Ctrl+K'
const CHANGED_VERB = 'Changed'
const FOLLOW_VERBS: Partial<Record<JobKind, string>> = { apply: 'Applied', revert: 'Reverted' }
const STUB_DIRECTIONS: Readonly<Record<StubSide, { place: string; level: string }>> = {
  up: { place: 'above', level: 'up' },
  down: { place: 'below', level: 'down' },
}

const ROOT_JOB_TEXTS: Readonly<Record<JobKind, string>> = {
  preview: 'previewing…',
  apply: 'applying…',
  revert: 'reverting…',
  collect: 'adding fixes…',
}
const INSTALL_CANCELED = 'Install canceled. Files already written are kept.'
const CODE_QUOTE = '`'

const PHASE_TEXTS: Readonly<Record<JobPhase, string>> = {
  staging: 'Copying the root to a temporary directory…',
  resolving: 'Resolving the lockfile…',
  checking: 'Checking the result…',
  writing: 'Writing files…',
  installing: 'Running install…',
  rescanning: 'Rescanning the root…',
}

const INSTALL_COMMANDS: Readonly<Record<PackageManagerName, string>> = {
  pnpm: 'pnpm install --frozen-lockfile',
  npm: 'npm ci',
}

const INSTALL_NOTES: Readonly<Record<PackageManagerName, string>> = {
  pnpm: 'Runs dependency build scripts that your pnpm settings allow.',
  npm: 'npm ci deletes and recreates node_modules and runs install scripts.',
}

const JOB_TITLES: Readonly<Record<JobKind, string>> = {
  preview: 'Preview',
  apply: 'Apply',
  revert: 'Revert',
  collect: 'Adding fixes',
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US')
const WORKSPACE_PACKAGE = 'workspace package'
const NAMED_CLUSTER_IMPORTERS = 2
const CLUSTER_NAME_SEPARATOR = ' + '

export function scopeLabel(root: string | undefined): string {
  return root === undefined ? ALL_ROOTS : rootLabel(root)
}

export function rootSwitcherName(root: string | undefined): string {
  return `Root: ${scopeLabel(root)}`
}

export function showPanelName(label: string, shortcut: string): string {
  return `Show ${label} (${shortcut})`
}

export function hidePanelName(label: string, shortcut: string): string {
  return `Hide ${label} (${shortcut})`
}

export function issueCountTitle(count: number, scopeName: string): string {
  return `${countLabel(count, 'package', 'packages')} with issues in ${scopeName}`
}

export function selectionPillText(label: string, root: string): string {
  return `${label} in ${rootLabel(root)}`
}

export function focusOnText(packageLabel: string): string {
  return `Focus on ${packageLabel}`
}

export function dependentsFocusHint(packageLabel: string): string {
  return `${packageLabel} is selected. Focus on it to see its dependents.`
}

export function workspacePackageTitle(name: string): string {
  return `${WORKSPACE_PACKAGE} ${name}`
}

export function requiresText(range: string): string {
  return `requires ${range}`
}

function clusterName(importerNames: readonly string[]): string {
  if (importerNames.length === 1) return `Only in ${importerNames[0]}`
  if (importerNames.length <= NAMED_CLUSTER_IMPORTERS) return `Shared by ${importerNames.join(CLUSTER_NAME_SEPARATOR)}`
  return `Shared by ${countLabel(importerNames.length, WORKSPACE_PACKAGE, WORKSPACE_PACKAGES.toLowerCase())}`
}

export function clusterLabelParts(importerNames: readonly string[], count: number): { name: string; suffix: string } {
  return { name: clusterName(importerNames), suffix: ` (${NUMBER_FORMAT.format(count)})` }
}

export function clusterLabel(importerNames: readonly string[], count: number): string {
  const { name, suffix } = clusterLabelParts(importerNames, count)
  return `${name}${suffix}`
}

function namesWithAnd(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(LIST_SEPARATOR)}, and ${names.at(-1)}`
}

export function clusterTitle(importerNames: readonly string[]): string {
  if (importerNames.length === 1) return `Packages only ${importerNames[0]} depends on`
  const quantifier = importerNames.length === NAMED_CLUSTER_IMPORTERS ? 'both' : 'all'
  return `Packages that ${namesWithAnd(importerNames)} ${quantifier} depend on`
}

export function exploreTitle(mode: ExploreMode, packageLabel: string | undefined, rootName: string, graphScope?: GraphScope): string {
  if (mode === 'graph' && graphScope === 'whole-root') return `Graph of ${rootName}`
  if (packageLabel === undefined) return `Overview of ${rootName}`
  if (mode === 'trail') return `Dependents of ${packageLabel} in ${rootName}`
  if (mode === 'tree') return `Dependencies of ${packageLabel}`
  return `Graph around ${packageLabel} in ${rootName}`
}

export function rootHealthLinks(root: RootSummary): HealthLink[] {
  const links: HealthLink[] = []
  const counts = root.issueCounts
  if (counts !== undefined) {
    if (counts.vulnerable > 0) links.push({ kind: 'vulnerability', text: countLabel(counts.vulnerable, 'vulnerable', 'vulnerable') })
    if (counts.deprecated > 0) links.push({ kind: 'deprecated', text: countLabel(counts.deprecated, 'deprecated', 'deprecated') })
    if (counts.outdatedDirect > 0) links.push({ kind: 'outdated', text: countLabel(counts.outdatedDirect, 'update', 'updates') })
  }
  const changeCount = root.actions.changeCount
  if (changeCount > 0) links.push({ kind: 'changes', text: countLabel(changeCount, 'change', 'changes') })
  return links
}

export function rootStatusMark(root: RootSummary): string | undefined {
  if (root.status === 'scanning' || root.status === 'failed') return ROOT_STATUS_TEXTS[root.status]
  if (APPROXIMATE_SOURCES.has(root.source)) return 'approximate'
  return undefined
}

export function kindsChipText(kinds: readonly DepKind[]): string | undefined {
  const shown = new Set(kinds)
  const hidden = DEP_KINDS.filter((kind) => !shown.has(kind))
  if (hidden.length === 0 || hidden.length === DEP_KINDS.length) return undefined
  return `without ${hidden.join(', ')}`
}

export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / MILLISECONDS_PER_SECOND)
  if (seconds < SECONDS_PER_MINUTE) return JUST_NOW
  const [unit, size] = RELATIVE_TIME_UNITS.find(([, candidate]) => seconds >= candidate) ?? RELATIVE_TIME_UNITS[RELATIVE_TIME_UNITS.length - 1]!
  return RELATIVE_TIME_FORMAT.format(-Math.floor(seconds / size), unit)
}

export function checkingProgressText(done: number, total: number): string {
  return `Checking packages: ${NUMBER_FORMAT.format(done)} of ${NUMBER_FORMAT.format(total)}`
}

export function lastCheckText(status: EnrichmentStatus, now: number): string {
  if (status.state === 'offline') return 'Offline'
  if (status.state === 'running') return checkingProgressText(status.registry.done, status.registry.total)
  return status.finishedAt === undefined ? 'Not checked yet' : `Checked ${relativeTime(status.finishedAt, now)}`
}

export function issueSectionTitle(kind: IssueKind): string {
  return ISSUE_SECTION_TITLES[kind]
}

export function typeToggleText(kind: IssueKind, count: number): string {
  return `${issueSectionTitle(kind)} ${NUMBER_FORMAT.format(count)}`
}

function progressCount(done: number, total: number, isRunning: boolean): string {
  return isRunning ? `${NUMBER_FORMAT.format(done)} / ${NUMBER_FORMAT.format(total)}` : NUMBER_FORMAT.format(total)
}

export function checkDetailsTitle(status: EnrichmentStatus): string {
  if (status.state === 'offline') return OFFLINE_EXPLANATION
  const isRunning = status.state === 'running'
  const registry = `Registry ${progressCount(status.registry.done, status.registry.total, isRunning)} packages`
  const osv = `OSV ${progressCount(status.osv.done, status.osv.total, isRunning)} versions, ${NUMBER_FORMAT.format(status.osv.skipped)} skipped`
  return `${registry}${HEALTH_SEPARATOR}${osv}`
}

export function unlistedPathsText(count: number): string {
  return `May be incomplete: not all paths to ${packageCountText(count)} with issues are listed`
}

function checkGapClauses(gaps: CheckGaps): string[] {
  const clauses: string[] = []
  if (gaps.failedChecks > 0) clauses.push(`${countLabel(gaps.failedChecks, 'check', 'checks')} failed`)
  if (gaps.failedRoots.length > 0) clauses.push(`${gaps.failedRoots.map(rootLabel).join(LIST_SEPARATOR)} failed to scan`)
  return clauses
}

function incompleteChecksText(gaps: CheckGaps, narrowedKinds = false): string {
  const checkedLead = narrowedKinds ? CHECKED_PACKAGES_CLEAN_OF_SELECTED_TYPES : CHECKED_PACKAGES_CLEAN
  const lead = gaps.unlistedPaths > 0 ? unlistedPathsText(gaps.unlistedPaths) : checkedLead
  return [lead, ...checkGapClauses(gaps)].join(CLAUSE_SEPARATOR)
}

export function issuesEmptyText(state: IssuesEmptyState, scopeName: string, gaps: CheckGaps, narrowedKinds: boolean): string {
  if (state === 'clean') return `No known issues in ${scopeName}`
  if (state === 'incomplete') return incompleteChecksText(gaps, narrowedKinds)
  return ISSUES_EMPTY_TEXTS[state]
}

export function issuesLoadFailedText(failure: string): string {
  return `Could not load the issues: ${failure}`
}

export function vulnerableRootText(root: string, count: number): string {
  return `${rootLabel(root)} — ${countLabel(count, 'vulnerable package', 'vulnerable packages')}`
}

export function addingFixesText(root: string): string {
  return `Adding fixes to ${rootLabel(root)}…`
}

function addedClause(results: readonly RootCollectResult[]): string {
  const withFixes = results.filter((entry) => (entry.result?.added ?? 0) > 0)
  if (withFixes.length === 0) return 'No fixes added'
  const counts = withFixes.map((entry, position) => {
    const added = entry.result?.added ?? 0
    const count = position === 0 ? countLabel(added, 'fix', 'fixes') : NUMBER_FORMAT.format(added)
    return `${count} to ${rootLabel(entry.root)}`
  })
  return `Added ${counts.join(LIST_SEPARATOR)}`
}

function skippedClause(results: readonly RootCollectResult[]): string | undefined {
  const skipped = results.flatMap((entry) => entry.result?.skipped ?? [])
  if (skipped.length === 0) return undefined
  const listed = skipped.slice(0, SHOWN_SKIPPED_PACKAGES).map((entry) => `${entry.name} (${entry.reason})`)
  const hiddenCount = skipped.length - listed.length
  const list = listed.join(LIST_SEPARATOR)
  return `skipped ${hiddenCount > 0 ? `${list}, and ${NUMBER_FORMAT.format(hiddenCount)} more` : list}`
}

export function collectFailureTexts(results: readonly RootCollectResult[]): string[] {
  return results.flatMap((entry) => (entry.error === undefined ? [] : [`Could not add fixes to ${rootLabel(entry.root)}: ${entry.error}`]))
}

export function collectResultText(results: readonly RootCollectResult[]): string {
  const clauses = [addedClause(results), skippedClause(results)]
  return clauses.filter((clause) => clause !== undefined).join(CLAUSE_SEPARATOR)
}

export function updateRecommendation(row: Pick<IssueRow, 'version' | 'wanted' | 'latest'>): string {
  if (row.wanted !== undefined && row.wanted !== row.version) return `${IN_RANGE_RECOMMENDATION}: ${row.wanted}`
  return row.latest === undefined ? NO_UPDATE_RECOMMENDATION : NEEDS_RANGE_CHANGE
}

export function fixLoadFailedText(failure: string): string {
  return `Could not load the fix: ${failure}`
}

export function fixAddFailedText(failure: string): string {
  return `Could not add the fix: ${failure}`
}

export function addedFixText(name: string, root: string): string {
  return `Added fix for ${name} to ${rootLabel(root)}`
}

export function inRootsText(count: number): string {
  return `in ${countLabel(count, 'root', 'roots')}`
}

export function moreCountText(count: number): string {
  return `+${NUMBER_FORMAT.format(count)} more`
}

const VARIANT_PEERS_SHOWN = 2

function variantPeerText(peer: VariantPeer): string {
  return peer.version === undefined ? `no ${peer.name}` : `${peer.name} ${peer.version}`
}

export function variantBadgeText(variant: PeerVariant): string {
  return `variant ${variant.position} of ${variant.count}`
}

export function peerVariantText(variant: PeerVariant): string {
  const position = variantBadgeText(variant)
  if (variant.peers.length === 0) return position
  const shown = variant.peers.slice(0, VARIANT_PEERS_SHOWN).map(variantPeerText).join(LIST_SEPARATOR)
  const hidden = variant.peers.length - VARIANT_PEERS_SHOWN
  return `${position} (${hidden > 0 ? `${shown} ${moreCountText(hidden)}` : shown})`
}

export function rootNoteText(rootId: string | undefined, reason: string): string {
  return rootId === undefined ? reason : `${rootLabel(rootId)}${ROOT_NOTE_SEPARATOR}${reason}`
}

export function rootVariantText(root: string, variant: PeerVariant): string {
  return `${rootLabel(root)}${LIST_SEPARATOR}${peerVariantText(variant)}`
}

export function packageVariantText(name: string, version: string, variant: PeerVariant | undefined): string {
  const label = `${name} ${version}`
  return variant === undefined ? label : `${label}${LIST_SEPARATOR}${peerVariantText(variant)}`
}

export function moreNotListedText(count: number): string {
  return `${moreCountText(count)} not listed`
}

export function issueLocationName(packageLabel: string, locationLabel: string): string {
  return `${packageLabel} in ${locationLabel}`
}

export function nestedIssueLocationName(packageLabel: string, directLabel: string, locationLabel: string): string {
  return `${packageLabel} under ${directLabel} in ${locationLabel}`
}

export function stepText(step: Step): string {
  switch (step.kind) {
    case 'relock':
      return `${RELOCK} ${step.name} ${step.from} → ${step.to}`
    case 'set-range':
      return step.place === 'catalog'
        ? `${UPDATE} ${step.dependency} in the ${step.catalog ?? DEFAULT_CATALOG} catalog to ${step.to}`
        : `${UPDATE} ${step.dependency} in ${importerLabel(step.importer)} to ${step.to}`
    case 'override':
      return `Override ${step.selector} to ${step.value} in ${OVERRIDES_FILE_LABELS[step.file]}`
  }
}

function andMore(names: readonly string[]): string {
  const hiddenCount = names.length - SHOWN_UPDATED_PACKAGES
  const shown = names.slice(0, SHOWN_UPDATED_PACKAGES).join(', ')
  return hiddenCount > 0 ? `${shown}, and ${hiddenCount} more` : shown
}

function updatedDependencies(steps: readonly Step[]): string[] {
  const names = steps.flatMap((step) => (step.kind === 'set-range' ? [step.dependency] : []))
  return [...new Set(names)]
}

function relockedParents(steps: readonly Step[], goal: FixGoal): string[] {
  const names = steps.flatMap((step) => (step.kind === 'relock' && step.name !== goal.name ? [step.name] : []))
  return [...new Set(names)]
}

function relockTarget(steps: readonly Step[], goal: FixGoal): string | undefined {
  const step = steps.find((candidate) => candidate.kind === 'relock' && candidate.name === goal.name)
  return step?.kind === 'relock' ? step.to : undefined
}

function relocksGoalFirst(steps: readonly Step[], goal: FixGoal): boolean {
  const [first] = steps
  return first?.kind === 'relock' && first.name === goal.name
}

function overrideValue(steps: readonly Step[]): string | undefined {
  const step = steps.find((candidate) => candidate.kind === 'override')
  return step?.kind === 'override' ? step.value : undefined
}

function withTarget(action: string, target: string | undefined): string {
  return target === undefined ? action : `${action} to ${target}`
}

export function fixChoiceName(choice: FixChoice): string {
  return FIX_CHOICE_NAMES[choice]
}

export function unavailableOptionNote(choice: FixChoice, reason: string): string {
  return `${fixChoiceName(choice)}: ${reason}`
}

export function fixOptionTitle(option: Pick<FixOption, 'choice' | 'steps'>, goal: FixGoal): string {
  switch (option.choice) {
    case 'relock': {
      const target = relockTarget(option.steps, goal)
      return target === undefined ? fixChoiceName('relock') : withTarget(RELOCK, target)
    }
    case 'chain': {
      const dependencies = updatedDependencies(option.steps)
      if (dependencies.length > 0) {
        const updated = andMore(dependencies)
        return relocksGoalFirst(option.steps, goal) ? `${RELOCK} and update ${updated}` : `${UPDATE} ${updated}`
      }
      const parents = relockedParents(option.steps, goal)
      return parents.length > 0 ? `${RELOCK} ${andMore(parents)}` : fixChoiceName('chain')
    }
    case 'override': {
      const value = overrideValue(option.steps)
      return value === undefined ? fixChoiceName('override') : withTarget('Override', value)
    }
  }
}

export function whyHereDetailText(range: string, direct: boolean, from: readonly string[]): string {
  const requires = requiresText(range)
  if (direct) return `${requires}${HEALTH_SEPARATOR}${DIRECT_DEPENDENCY}`
  return from.length === 0 ? requires : `${requires}${HEALTH_SEPARATOR}from ${from.join(LIST_SEPARATOR)}`
}

export function alsoInRootText(root: string, version: string): string {
  return `${rootLabel(root)} (${version})`
}

export function updateLabelText(latest: string, level: OutdatedLevel): string {
  return `↑ ${latest} ${level}`
}

export function updateLabelTitle(latest: string, level: OutdatedLevel): string {
  return `Latest: ${latest} (${level} update)`
}

export function updateLevelTitle(level: OutdatedLevel): string {
  return `${level} update`
}

export function updateBadgeTitle(level: OutdatedLevel, version: string, latest: string): string {
  return `${updateLevelTitle(level)}: ${version} → ${latest}`
}

export function vulnerableBelowText(count: number, worst: Severity): string {
  return `${vulnerableBelowShortText(count)}${HEALTH_SEPARATOR}${worst}`
}

export function vulnerableBelowShortText(count: number): string {
  return `${NUMBER_FORMAT.format(count)} vulnerable below`
}

export function vulnerableBelowTitle(count: number, worst: Severity): string {
  return `${countLabel(count, 'vulnerable package', 'vulnerable packages')} below; highest severity: ${worst}`
}

export function knownVulnerabilitiesTitle(count: number, worst: Severity): string {
  return `${countLabel(count, 'known vulnerability', 'known vulnerabilities')}; highest severity: ${worst}`
}

export function skippedCheckTitle(reason: SkipReason | undefined): string {
  return SKIPPED_CHECK_TITLES[reason ?? 'unknown-version']
}

export function failedCheckTitle(source: CheckSource, reason: string | undefined): string {
  return `${CHECK_SOURCE_NAMES[source]} check failed: ${reason ?? UNKNOWN_REASON}`
}

export function notCheckedTitle(reasons: readonly string[]): string {
  return reasons.join(CLAUSE_SEPARATOR)
}

export function staleCheckNotice(source: CheckSource, fetchedAt: string | undefined, now: number): string {
  const when = fetchedAt === undefined ? EARLIER_CHECK : relativeTime(fetchedAt, now)
  return `${CHECK_SOURCE_NAMES[source]} data is from ${when}; the last check failed.`
}

export function failedCheckNotice(source: CheckSource, reason: string | undefined): string {
  return `Could not check ${CHECK_TARGETS[source]}: ${reason ?? UNKNOWN_REASON}.`
}

export function checkedTimeText(source: CheckSource, fetchedAt: string, now: number): string {
  return `${CHECK_SOURCE_NAMES[source]} checked ${relativeTime(fetchedAt, now)}`
}

export function latestText(latest: string): string {
  return `latest ${latest}`
}

export function advisoriesHeading(advisoryCount: number, deprecated: boolean): string {
  if (advisoryCount === 0 && deprecated) return 'Deprecation'
  return advisoryCount === 1 ? 'Vulnerability' : 'Vulnerabilities'
}

export function fixedInText(versions: readonly string[]): string {
  return `Fixed in ${versions.join(LIST_SEPARATOR)}`
}

export function deprecationMessageText(message: string): string {
  return `“${message}”`
}

export function nothingToFixText(latest: string): string {
  return `Up to date: ${latest} is the latest version.`
}

export function updateHeading(name: string, root: string): string {
  return `${UPDATE} ${name} in ${rootLabel(root)}`
}

export function staysInRangeText(target: string): string {
  return `unchanged (${target} is ${IN_RANGE})`
}

export function peerRangeUnchangedText(importer: NodeId, peerRange: string): string {
  return `${importerLabel(importer)}: peerDependencies ${peerRange} unchanged`
}

export function updateChoiceTitle(choice: UpdateChoice, target: string): string {
  return withTarget(choice === 'wanted' ? RELOCK : UPDATE, target)
}

function isFixChoice(choice: Choice): choice is FixChoice {
  return Object.hasOwn(FIX_CHOICE_NAMES, choice)
}

export function changeChoiceTitle(item: Pick<ChangeItem, 'goal' | 'choice' | 'steps'>): string {
  const { goal, choice } = item
  if (goal.kind === 'fix') return isFixChoice(choice) ? fixOptionTitle({ choice, steps: item.steps }, goal) : goalText(goal)
  return isFixChoice(choice) ? goalText(goal) : updateChoiceTitle(choice, goal.target)
}

export function inChangesText(title: string): string {
  return `In changes: ${title}`
}

export function loadingOptionsText(name: string): string {
  return `Loading actions for ${name}…`
}

export function actionsLoadFailedText(failure: string): string {
  return `Could not load actions: ${failure}`
}

export function addToChangesFailedText(failure: string): string {
  return `Could not add to changes: ${failure}`
}

export function replaceChangeFailedText(failure: string): string {
  return `Could not replace the change: ${failure}`
}

export function sourceAccuracyText(source: SourceKind): string {
  return SOURCE_ACCURACY_TEXTS[source]
}

export function packageCountText(count: number): string {
  return countLabel(count, 'package', 'packages')
}

export function directDependencyCountText(count: number): string {
  return countLabel(count, DIRECT_DEPENDENCY, 'direct dependencies')
}

export function changesInRootHeading(root: string): string {
  return `${VIEW_TITLES.changes} in ${rootLabel(root)}`
}

export function vulnerableDependenciesLoadFailedText(failure: string): string {
  return `Could not load the vulnerable dependencies: ${failure}`
}

export function packageChecksFailedText(failure: string): string {
  return `Could not load the package checks: ${failure}`
}

export function knownProblemsText(state: Exclude<KnownProblemsState, 'failed' | 'problems'>, cleanText: string, gaps: CheckGaps): string {
  if (state === 'clean') return cleanText
  if (state === 'incomplete') return incompleteChecksText(gaps)
  return KNOWN_PROBLEMS_TEXTS[state]
}

function shownWithMore(values: readonly string[]): string {
  const shown = values.slice(0, SHOWN_GOAL_DETAILS).join(LIST_SEPARATOR)
  const hiddenCount = values.length - SHOWN_GOAL_DETAILS
  return hiddenCount > 0 ? `${shown} ${moreCountText(hiddenCount)}` : shown
}

function goalDetails(goal: Goal): string[] {
  return goal.kind === 'fix' ? goal.advisoryIds : goal.importers.map(importerLabel)
}

export function changeGoalText(goal: Goal): string {
  const details = goalDetails(goal)
  return details.length === 0 ? goalText(goal) : `${goalText(goal)}${HEALTH_SEPARATOR}${shownWithMore(details)}`
}

export function editChangeName(goal: Goal): string {
  return `${EDIT} ${goalText(goal)}`
}

export function removeChangeName(goal: Goal): string {
  return `Remove ${goalText(goal)}`
}

export function changeStepsText(steps: readonly Step[]): string {
  return steps.map(stepText).join(CLAUSE_SEPARATOR)
}

export function updateSizeBadgeText(level: OutdatedLevel | undefined): string {
  return level === undefined ? UPDATE_BADGE : `${UPDATE_BADGE} ${level}`
}

export function clearedChangesText(count: number): string {
  return `Cleared ${countLabel(count, 'change', 'changes')}.`
}

function skippedChangesText(skipped: RestoreResult['skipped']): string {
  return `Skipped: ${skipped.map((entry) => `${entry.name} (${entry.reason})`).join(LIST_SEPARATOR)}.`
}

export function restoredChangesText(result: RestoreResult): string {
  const restored = `Restored ${countLabel(result.restored, 'change', 'changes')}.`
  return result.skipped.length === 0 ? restored : `${restored} ${skippedChangesText(result.skipped)}`
}

export function changesFailureText(failure: ChangesFailure, reason: string): string {
  return `${CHANGES_FAILURE_TEXTS[failure]}: ${reason}`
}

export function packageNotInRootText(name: string, root: string): string {
  return `${name} is not in ${rootLabel(root)}`
}

export function removeChangeFailedText(goal: Goal, reason: string): string {
  return `Could not remove ${goalText(goal)}: ${reason}`
}

export function phaseText(phase: JobPhase | undefined): string {
  return phase === undefined ? NO_PHASE_TEXT : PHASE_TEXTS[phase]
}

export function jobLogSummary(lineCount: number): string {
  return `Log${HEALTH_SEPARATOR}${countLabel(lineCount, 'line', 'lines')}`
}

export function installCommand(manager: PackageManagerName): string {
  return INSTALL_COMMANDS[manager]
}

export function installNote(manager: PackageManagerName): string {
  return INSTALL_NOTES[manager]
}

export function applyTitle(changeCount: number, rootName: string): string {
  return `Apply ${countLabel(changeCount, 'change', 'changes')} to ${rootName}?`
}

export function unmetGoalsHeading(count: number): string {
  return `${countLabel(count, 'goal', 'goals')} not met:`
}

function writtenFileText(file: Pick<PreviewFile, 'path' | 'sharedWith'>): string {
  if (file.sharedWith === undefined || file.sharedWith.length === 0) return file.path
  return `${file.path} (also in ${file.sharedWith.map(rootLabel).join(LIST_SEPARATOR)})`
}

export function writesSentence(files: readonly Pick<PreviewFile, 'path' | 'sharedWith'>[]): string {
  return `Writes ${files.map(writtenFileText).join(LIST_SEPARATOR)} exactly as previewed.`
}

export function outsideInstallNote(count: number): string {
  return `Install also writes node_modules in ${countLabel(count, 'workspace package', 'workspace packages')} outside the root.`
}

export function sharedRootsText(roots: readonly SharingRoot[]): string {
  const names = roots.map((root) => rootLabel(root.id)).join(LIST_SEPARATOR)
  const managers = [...new Set(roots.map((root) => root.manager))]
  if (roots.length === 1) return `Lockfile not updated: ${names}. Run ${roots[0]!.manager} install there.`
  if (managers.length === 1) return `Lockfiles not updated: ${names}. Run ${managers[0]} install in each.`
  const commands = managers.map((manager) => {
    const where = roots.filter((root) => root.manager === manager).map((root) => rootLabel(root.id)).join(LIST_SEPARATOR)
    return `${manager} install in ${where}`
  })
  return `Lockfiles not updated: ${names}. Run ${commands.join(' and ')}.`
}

export function packageChangesHeading(count: number): string {
  return `Package changes (${NUMBER_FORMAT.format(count)})`
}

export function notCheckedText(reason: string): string {
  return `${NOT_CHECKED}: ${reason}`
}

export function applyOutcomeText(root: string, result: JobResult | undefined, files: readonly string[]): string {
  const goalsMet = `${countLabel(result?.goalsMet ?? 0, 'goal', 'goals')} met`
  const outcome = files.length === 0 ? goalsMet : `${goalsMet}${HEALTH_SEPARATOR}files written: ${files.join(LIST_SEPARATOR)}`
  const shared = result?.sharedRoots !== undefined && result.sharedRoots.length > 0 ? ` ${sharedRootsText(result.sharedRoots)}` : ''
  return `Applied to ${rootLabel(root)}. ${outcome}.${shared}`
}

function quotedCommand(manager: PackageManagerName): string {
  return `${CODE_QUOTE}${INSTALL_COMMANDS[manager]}${CODE_QUOTE}`
}

function installTouchedNodeModules(install: JobResult['install']): boolean {
  return install === 'done' || install === 'failed'
}

export function installHint(
  manager: PackageManagerName,
  root: string,
  phase: 'after-apply' | 'after-revert',
  install: JobResult['install'] | undefined,
): string | undefined {
  const where = rootLabel(root)
  if (phase === 'after-apply') return install === 'not-run' ? `node_modules was not updated. Run ${quotedCommand(manager)} in ${where} when ready.` : undefined
  return installTouchedNodeModules(install) ? `node_modules still has the applied versions. Run ${quotedCommand(manager)} in ${where}.` : undefined
}

export function revertOutcomeText(root: string, result: JobResult | undefined): string {
  const restored = result?.restored ?? 0
  const skipped = result?.skipped ?? []
  const sentences = [`Files restored in ${rootLabel(root)}.`]
  if (restored > 0) sentences.push(`${countLabel(restored, 'change is', 'changes are')} back in the list.`)
  if (skipped.length > 0) sentences.push(skippedChangesText(skipped))
  return sentences.join(' ')
}

export function revertNote(fileCount: number, itemCount: number): string {
  const restores = `Restores ${countLabel(fileCount, 'file', 'files')}`
  return itemCount === 0 ? `${restores}.` : `${restores} and puts ${countLabel(itemCount, 'change', 'changes')} back in the list.`
}

function failedJobText(job: Pick<Job, 'kind' | 'state' | 'error'>, unupdatedRoots: readonly SharingRoot[]): string {
  const shared = job.kind === 'apply' && unupdatedRoots.length > 0 ? ` ${sharedRootsText(unupdatedRoots)}` : ''
  if (job.state === 'failed') return `${JOB_TITLES[job.kind]} failed: ${job.error ?? UNKNOWN_ERROR}${shared}`
  return job.kind === 'apply' ? `${INSTALL_CANCELED}${shared}` : `${JOB_TITLES[job.kind]} canceled.`
}

export function finishedJobText(job: Pick<Job, 'rootId' | 'kind' | 'state' | 'error' | 'result'>, unupdatedRoots: readonly SharingRoot[] = []): JobOutcome | undefined {
  if (job.state === 'running') return undefined
  if (job.state !== 'done') return { text: failedJobText(job, unupdatedRoots), failed: true }
  if (job.kind === 'apply') return { text: applyOutcomeText(job.rootId, job.result, job.result?.files ?? []), failed: false }
  if (job.kind === 'revert') return { text: revertOutcomeText(job.rootId, job.result), failed: false }
  return undefined
}

function applyInstallInterrupted(job: Pick<Job, 'state' | 'error'>): boolean {
  if (job.state === 'cancelled') return true
  return job.state === 'failed' && (job.error?.startsWith(INSTALL_FAILURE_PREFIX) ?? false)
}

export function finishedJobHint(job: Pick<Job, 'rootId' | 'kind' | 'state' | 'error' | 'result'>, manager: PackageManagerName | undefined): string | undefined {
  if (manager === undefined) return undefined
  if (job.kind === 'apply' && applyInstallInterrupted(job)) return `node_modules may be out of date. Run ${quotedCommand(manager)} in ${rootLabel(job.rootId)}.`
  if (job.state !== 'done') return undefined
  if (job.kind === 'apply') return installHint(manager, job.rootId, 'after-apply', job.result?.install)
  if (job.kind === 'revert') return installHint(manager, job.rootId, 'after-revert', job.result?.appliedInstall)
  return undefined
}

export function changeCountText(count: number): string {
  return countLabel(count, 'change', 'changes')
}

function advisoriesText(goal: FixGoal): string {
  const shown = goal.advisoryIds.slice(0, HEADING_ADVISORY_LIMIT)
  if (shown.length === 0) return `${goal.name} ${goal.version}`
  const hiddenCount = goal.advisoryIds.length - shown.length
  const list = shown.join(LIST_SEPARATOR)
  return hiddenCount > 0 ? `${list}, and ${hiddenCount} more` : list
}

export function goalHeading(goal: FixGoal, rootName: string): string {
  return `Fix ${advisoriesText(goal)} in ${rootName}`
}

export function goalLine(goal: Goal, detail: string, met: boolean): string {
  if (goal.kind === 'update') return detail
  return met ? `${goal.name}: ${detail}` : `${goal.name}: ${detail}${UNMET_FIX_HINT}`
}

export function previewGoalLine(entry: PreviewGoal, goal: Goal | undefined): string {
  return goal === undefined ? entry.detail : goalLine(goal, entry.detail, entry.met)
}

export function rootJobText(job: ActionsSummary['job']): string | undefined {
  if (job?.state !== 'running') return undefined
  return job.kind === 'apply' && job.phase === 'installing' ? INSTALLING_TEXT : ROOT_JOB_TEXTS[job.kind]
}

export function followNotice(
  jobKind: JobKind | undefined,
  root: string,
  name: string,
  from: string,
  to: string,
  variants?: { from: PeerVariant; to: PeerVariant },
): string {
  const verb = (jobKind === undefined ? undefined : FOLLOW_VERBS[jobKind]) ?? CHANGED_VERB
  if (variants !== undefined && from === to) {
    return `${verb} in ${rootLabel(root)}: ${name} ${from} ${peerVariantText(variants.from)} → ${peerVariantText(variants.to)}. Showing the new variant.`
  }
  return `${verb} in ${rootLabel(root)}: ${name} ${from} → ${to}. Showing the new version.`
}

export function noLongerInRootText(packageLabel: string, root: string): string {
  return `${packageLabel} is no longer in ${rootLabel(root)}.`
}

export function notInRootSentence(packageLabel: string, root: string): string {
  return `${packageNotInRootText(packageLabel, root)}.`
}

export function notInAnyRootText(name: string): string {
  return `${name} is not in any root.`
}

export function openInRootText(rootName: string): string {
  return `Open in ${rootName}`
}

export function openVariantInRootText(variantLabel: string, rootName: string): string {
  return `Open ${variantLabel} in ${rootName}`
}

export function duplicateVersionsText(entry: DuplicateEntry): string {
  return entry.versions.map((version) => `${version.version} (${version.roots.map(rootLabel).join(LIST_SEPARATOR)})`).join(CLAUSE_SEPARATOR)
}

export function duplicateVersionsLine(versions: string): string {
  return `Versions: ${versions}`
}

export function graphNodeDescription(notes: readonly string[]): string {
  return notes.join('. ')
}

export function scanningMessage(root: string): string {
  return `Scanning ${rootLabel(root)}…`
}

export function stillScanningText(root: string): string {
  return `${rootLabel(root)} is still scanning.`
}

export function notInScanText(root: string): string {
  return `${rootLabel(root)} is not part of this scan.`
}

export function scanFailedText(root: string, error: string | undefined): string {
  return `${rootLabel(root)} failed to scan: ${error ?? UNKNOWN_ERROR}`
}

export function rootErrorText(error: string | undefined): string {
  return error ?? UNKNOWN_ROOT_ERROR
}

export function warningCountText(count: number): string {
  return countLabel(count, 'warning', 'warnings')
}

export function osvProgressText(done: number, skipped: number): string {
  return `Vulnerabilities: ${NUMBER_FORMAT.format(done)} checked, ${NUMBER_FORMAT.format(skipped)} skipped`
}

export function problemLineText(origin: string, message: string, count: number): string {
  return `${origin} ${message}${HEALTH_SEPARATOR}${packageCountText(count)}`
}

export function switchedToText(root: string): string {
  return `Switched to ${rootLabel(root)}`
}

export function scanLoadFailedText(reason: string): string {
  return `Could not load the scan: ${reason}`
}

export function resolveFailedText(root: string, reason: string): string {
  return `Could not start resolving versions for ${rootLabel(root)}: ${reason}`
}

export function rescanFailedText(reason: string): string {
  return `Could not start a rescan: ${reason}`
}

export function refreshChecksFailedText(reason: string): string {
  return `Could not refresh the package checks: ${reason}`
}

export function requestFailedText(status: number): string {
  return `Request failed with status ${status}`
}

export function badgesLoadFailedText(reason: string): string {
  return `Could not load the vulnerability and update badges: ${reason}`
}

export function duplicatesLoadFailedText(reason: string): string {
  return `Could not load the duplicates: ${reason}`
}

export function detailsLoadFailedText(reason: string): string {
  return `Could not load details: ${reason}`
}

export function diffLoadFailedText(reason: string): string {
  return `Could not load the diff: ${reason}`
}

export function searchShortcutHint(onApple: boolean): string {
  return onApple ? SEARCH_SHORTCUT_ON_APPLE : SEARCH_SHORTCUT_ELSEWHERE
}

export function searchFailedText(reason: string): string {
  return `Search failed: ${reason}`
}

export function noSearchMatchText(term: string): string {
  return `No packages match “${term}”`
}

export function searchOptionName(name: string, version: string, root: string, variant: string): string {
  const option = `${name} ${version} in ${rootLabel(root)}`
  return variant === '' ? option : `${option}${LIST_SEPARATOR}${variant}`
}

export function expandName(label: string): string {
  return `Expand ${label}`
}

export function collapseName(label: string): string {
  return `Collapse ${label}`
}

export function hiddenPathsText(count: number): string {
  return `+${countLabel(count, 'path', 'paths')}`
}

export function stubName(side: StubSide, hiddenPaths: string, packageLabel: string): string {
  return `Show ${hiddenPaths} ${STUB_DIRECTIONS[side].place} ${packageLabel}`
}

export function stubTitle(side: StubSide, hiddenPaths: string): string {
  return `${hiddenPaths}: click to show one more level ${STUB_DIRECTIONS[side].level}`
}

export function wholeRootLimitText(total: number, limit: number): string {
  return `Showing ${NUMBER_FORMAT.format(limit)} of ${NUMBER_FORMAT.format(total)} nodes. Narrow the scope to see all nodes.`
}

export function truncatedGraphText(limit: number): string {
  return `Showing the first ${NUMBER_FORMAT.format(limit)} nodes. Reduce the depth to see a complete graph.`
}

export function graphLoadFailedText(subject: string, reason: string): string {
  return `Could not load the graph of ${subject}: ${reason}`
}

export function dependentsLoadFailedText(packageLabel: string, reason: string): string {
  return `Could not load the dependents of ${packageLabel}: ${reason}`
}

export function dependenciesLoadFailedText(packageLabel: string, reason: string | undefined): string {
  return `Could not load the dependencies of ${packageLabel}: ${reason ?? UNKNOWN_ERROR}`
}
