import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChangeItem, FixGoal, Job, OverrideStep, Step, UpdateGoal } from '../src/actions/types.ts'
import type { DuplicateEntry } from '../src/query/duplicates.ts'
import type { RootSummary } from '../ui/src/api.ts'
import { offlineStatus } from '../src/enrich/enrichment-status.ts'
import type { EnrichmentStatus } from '../src/enrich/types.ts'
import * as vocabulary from '../ui/src/vocabulary.ts'
import {
  CLEAR_SELECTION,
  rootNoteText,
  DETAILS_PANEL,
  DETAILS_PANEL_SHORTCUT,
  LEVELS_DOWN,
  DUPLICATES_ONLY,
  EXPLORE_MODE_NAMES,
  EXPLORE_REQUIRES_ROOT,
  EXPLORE_REQUIRES_ROOT_HINT,
  EXPLORE_OPTIONS,
  exploreOptionsLabel,
  EXPLORE_ROOT_CHOICES,
  exploreTitle,
  variantBadgeText,
  focusOnText,
  GRAPH_HINT,
  GRAPH_SCOPE,
  GRAPH_SCOPE_NAMES,
  requiresText,
  CLICK_TO_EXPAND,
  clusterLabel,
  clusterTitle,
  GRAPH_ANCHOR_NOTE,
  GRAPH_CLUSTERS,
  GRAPH_NODE_HINT,
  LISTED_WORKSPACE_PACKAGE_TEXTS,
  TRAIL_COLUMN_TITLES,
  DEPENDENTS_NEED_PACKAGE,
  dependentsFocusHint,
  workspacePackageTitle,
  NODE_LIMIT,
  LEVELS_UP,
  fixChoiceName,
  fixOptionTitle,
  hidePanelName,
  issueCountTitle,
  issueSectionTitle,
  kindsChipText,
  lastCheckText,
  rootHealthLinks,
  rootStatusMark,
  ROOTS_PANEL,
  ROOTS_PANEL_SHORTCUT,
  rootSwitcherName,
  scopeLabel,
  selectionPillText,
  SHORTCUT_ROWS,
  showPanelName,
  stepText,
  unavailableOptionNote,
  updateRecommendation,
  VIEW_TITLES,
  addedFixText,
  fixAddFailedText,
  fixLoadFailedText,
  inRootsText,
  issueLocationName,
  nestedIssueLocationName,
  moreCountText,
  moreNotListedText,
  typeToggleText,
  checkDetailsTitle,
  issuesEmptyText,
  collectResultText,
  collectFailureTexts,
  vulnerableRootText,
  addingFixesText,
  advisoriesHeading,
  deprecationMessageText,
  alsoInRootText,
  checkedTimeText,
  failedCheckNotice,
  failedCheckTitle,
  fixedInText,
  knownVulnerabilitiesTitle,
  latestText,
  notCheckedTitle,
  skippedCheckTitle,
  staleCheckNotice,
  updateLabelText,
  updateLabelTitle,
  vulnerableBelowText,
  vulnerableBelowTitle,
  whyHereDetailText,
  ADD_TO_CHANGES,
  ADDED_TO_CHANGES,
  addToChangesFailedText,
  changeChoiceTitle,
  IN_CHANGES_REVIEW,
  inChangesText,
  loadingOptionsText,
  NO_UPDATE_AVAILABLE,
  nothingToFixText,
  actionsLoadFailedText,
  peerRangeUnchangedText,
  REPLACE_IN_CHANGES,
  replaceChangeFailedText,
  REPLACED_IN_CHANGES,
  SAVE_CHANGE,
  staysInRangeText,
  updateChoiceTitle,
  updateHeading,
  ACTIONS_HEADING,
  changesInRootHeading,
  directDependencyCountText,
  CHECKING_PACKAGES,
  EXPLORE_DEPENDENCIES,
  knownProblemsText,
  unlistedPathsText,
  LOADING,
  LOADING_SCAN,
  NO_KNOWN_ISSUES_STATUS,
  NO_ISSUES_IN_DEPENDENCIES,
  packageChecksFailedText,
  packageCountText,
  SELECT_ISSUE_PROMPT,
  ISSUES_IN_DEPENDENCIES,
  sourceAccuracyText,
  VULNERABLE_DEPENDENCIES,
  vulnerableDependenciesLoadFailedText,
  CHANGE_STEPS,
  CHANGE_STEPS_LABEL,
  CHANGES_EDITED_AFTER_PREVIEW,
  changeGoalText,
  changesFailureText,
  changeStepsText,
  CLEAR,
  clearedChangesText,
  EDIT,
  editChangeName,
  LOADING_CHANGES,
  NO_CHANGES_YET,
  packageNotInRootText,
  PRIMARY_ACTION_TEXTS,
  removeChangeFailedText,
  removeChangeName,
  restoredChangesText,
  UNDO,
  updateSizeBadgeText,
  APPLY,
  applyOutcomeText,
  applyTitle,
  finishedJobHint,
  finishedJobText,
  installCommand,
  installHint,
  installNote,
  jobLogSummary,
  LAST_JOB,
  NO_OUTPUT_YET,
  NONE,
  notCheckedText,
  packageChangesHeading,
  phaseText,
  PREVIEW_PARTS,
  REVERT_FILES,
  revertNote,
  revertOutcomeText,
  RUN_INSTALL,
  RUNNING_JOB,
  unmetGoalsHeading,
  writesSentence,
  outsideInstallNote,
  sharedRootsText,
  RESOLVE_VERSIONS,
  changeCountText,
  checkingProgressText,
  collapseName,
  CREDENTIALS_HINT,
  dependenciesLoadFailedText,
  detailsLoadFailedText,
  diffLoadFailedText,
  DIFF_TRUNCATED,
  DISMISS,
  duplicatesLoadFailedText,
  DUPLICATE_BADGE,
  duplicateVersionsLine,
  graphNodeDescription,
  duplicateVersionsText,
  badgesLoadFailedText,
  expandName,
  FAILED_TO_LOAD,
  followNotice,
  goalHeading,
  goalLine,
  GRAPH_LABEL,
  graphLoadFailedText,
  hiddenPathsText,
  LOADING_DIFF,
  LOADING_ROOTS,
  NEW_FILE,
  NO_DUPLICATES_BELOW_ROW,
  NO_ROOTS_FOUND,
  noLongerInRootText,
  noSearchMatchText,
  notInAnyRootText,
  notInRootSentence,
  notInScanText,
  openInRootText,
  openVariantInRootText,
  osvProgressText,
  PACKAGE_CHECKS,
  PACKAGE_DETAILS,
  previewGoalLine,
  PRODUCT_NAME,
  problemLineText,
  refreshChecksFailedText,
  REGISTRY_CHECKS,
  relativeTime,
  requestFailedText,
  RESCAN_DID_NOT_FINISH,
  rescanFailedText,
  resolveFailedText,
  rootErrorText,
  rootJobText,
  ROOT_STATUS_TEXTS,
  scanFailedText,
  scanLoadFailedText,
  scanningMessage,
  SEARCH_PACKAGES,
  SEARCH_PLACEHOLDER,
  SEARCH_RESULTS,
  searchFailedText,
  SEARCHING,
  searchOptionName,
  peerVariantText,
  searchShortcutHint,
  SESSION_REJECTED,
  SHOWN_ABOVE,
  SOURCE_LABELS,
  stillScanningText,
  stubName,
  stubTitle,
  switchedToText,
  dependentsLoadFailedText,
  truncatedGraphText,
  updateBadgeTitle,
  updateLevelTitle,
  vulnerableBelowShortText,
  warningCountText,
  wholeRootLimitText,
  BACK_TO_WORKING_TREE,
  CHANGES_ON_COMMIT,
  commitNoticeText,
  noRootsInText,
  RELOAD_BRANCH,
} from '../ui/src/vocabulary.ts'

const NOW = Date.parse('2026-10-26T12:00:00.000Z')

function rootSummary(id: string, overrides: Partial<RootSummary> = {}): RootSummary {
  return {
    id,
    path: id,
    manager: 'pnpm',
    source: 'lockfile',
    status: 'ready',
    warnings: [],
    importers: [],
    packageCount: 0,
    duplicateCount: 0,
    hasAuth: false,
    actions: { available: true, changeCount: 0, revertable: false },
    ...overrides,
  }
}

function withChanges(changeCount: number): RootSummary['actions'] {
  return { available: true, changeCount, revertable: false }
}

function enrichment(overrides: Partial<EnrichmentStatus>): EnrichmentStatus {
  return {
    state: 'done',
    revision: 3,
    registry: { total: 400, done: 400, failed: 0 },
    osv: { total: 380, done: 380, skipped: 20, failed: 0 },
    problems: [],
    ...overrides,
  }
}

describe('rootHealthLinks', () => {
  it('lists vulnerable, deprecated, updates and changes in that order', () => {
    const root = rootSummary('legacy/admin', {
      issueCounts: { vulnerable: 1, worst: 'high', deprecated: 2, outdatedDirect: 3 },
      actions: withChanges(1),
    })
    assert.deepEqual(rootHealthLinks(root), [
      { kind: 'vulnerability', text: '1 vulnerable' },
      { kind: 'deprecated', text: '2 deprecated' },
      { kind: 'outdated', text: '3 updates' },
      { kind: 'changes', text: '1 change' },
    ])
  })

  it('leaves out kinds with nothing to report and counts in the singular and plural', () => {
    const root = rootSummary('shop-npm', {
      issueCounts: { vulnerable: 0, deprecated: 0, outdatedDirect: 1 },
      actions: withChanges(2),
    })
    assert.deepEqual(rootHealthLinks(root), [
      { kind: 'outdated', text: '1 update' },
      { kind: 'changes', text: '2 changes' },
    ])
  })

  it('reports only the changes while the root has no issue counts', () => {
    assert.deepEqual(rootHealthLinks(rootSummary('legacy/admin', { status: 'scanning', actions: withChanges(2) })), [
      { kind: 'changes', text: '2 changes' },
    ])
    assert.deepEqual(rootHealthLinks(rootSummary('legacy/admin', { status: 'scanning' })), [])
  })

  it('formats large counts with separators', () => {
    const root = rootSummary('legacy/admin', { issueCounts: { vulnerable: 1234, deprecated: 0, outdatedDirect: 0 } })
    assert.deepEqual(rootHealthLinks(root), [{ kind: 'vulnerability', text: '1,234 vulnerable' }])
  })
})

describe('rootStatusMark', () => {
  it('marks a scanning or failed root', () => {
    assert.equal(rootStatusMark(rootSummary('legacy/admin', { status: 'scanning' })), 'scanning')
    assert.equal(rootStatusMark(rootSummary('legacy/admin', { status: 'failed', error: 'broken lockfile' })), 'failed')
  })

  it('marks a root resolved today or read from manifests only as approximate', () => {
    assert.equal(rootStatusMark(rootSummary('legacy/admin', { source: 'resolved-today' })), 'approximate')
    assert.equal(rootStatusMark(rootSummary('legacy/admin', { source: 'manifest-only' })), 'approximate')
  })

  it('prefers the scan state over the accuracy of the source', () => {
    assert.equal(rootStatusMark(rootSummary('legacy/admin', { source: 'manifest-only', status: 'scanning' })), 'scanning')
  })

  it('leaves a ready root from a lockfile or node_modules unmarked', () => {
    assert.equal(rootStatusMark(rootSummary('legacy/admin')), undefined)
    assert.equal(rootStatusMark(rootSummary('legacy/admin', { source: 'installed' })), undefined)
  })
})

describe('kindsChipText', () => {
  it('names the kinds that are left out, in the canonical order', () => {
    assert.equal(kindsChipText(['prod', 'optional', 'peer']), 'without dev')
    assert.equal(kindsChipText(['optional', 'prod']), 'without dev, peer')
  })

  it('says nothing while every kind is shown', () => {
    assert.equal(kindsChipText(['prod', 'dev', 'optional', 'peer']), undefined)
    assert.equal(kindsChipText(['peer', 'optional', 'dev', 'prod']), undefined)
    assert.equal(kindsChipText([]), undefined)
  })
})

describe('lastCheckText', () => {
  it('says when the last check finished', () => {
    assert.equal(lastCheckText(enrichment({ finishedAt: '2026-10-26T11:58:00.000Z' }), NOW), 'Checked 2 minutes ago')
    assert.equal(lastCheckText(enrichment({ finishedAt: '2026-10-26T11:59:40.000Z' }), NOW), 'Checked just now')
  })

  it('counts the registry checks while they run', () => {
    assert.equal(
      lastCheckText(enrichment({ state: 'running', registry: { total: 400, done: 120, failed: 0 } }), NOW),
      'Checking packages: 120 of 400',
    )
    assert.equal(
      lastCheckText(enrichment({ state: 'running', registry: { total: 3980, done: 2470, failed: 0 } }), NOW),
      'Checking packages: 2,470 of 3,980',
    )
  })

  it('says Offline when deptrail started with --offline', () => {
    assert.equal(lastCheckText(offlineStatus(0), NOW), 'Offline')
  })

  it('says that nothing was checked before the first check finishes', () => {
    assert.equal(lastCheckText(enrichment({}), NOW), 'Not checked yet')
  })
})

describe('scope words', () => {
  it('names All roots and single roots, including the repository root', () => {
    assert.equal(scopeLabel(undefined), 'All roots')
    assert.equal(scopeLabel('legacy/admin'), 'legacy/admin')
    assert.equal(scopeLabel('.'), 'repository root')
  })

  it('names the root switcher after the scope it shows', () => {
    assert.equal(rootSwitcherName(undefined), 'Root: All roots')
    assert.equal(rootSwitcherName('legacy/admin'), 'Root: legacy/admin')
  })
})

describe('panel toggle names', () => {
  it('names the toggles after the panel and its key', () => {
    assert.equal(hidePanelName(ROOTS_PANEL, ROOTS_PANEL_SHORTCUT), 'Hide roots panel ([)')
    assert.equal(showPanelName(ROOTS_PANEL, ROOTS_PANEL_SHORTCUT), 'Show roots panel ([)')
    assert.equal(hidePanelName(DETAILS_PANEL, DETAILS_PANEL_SHORTCUT), 'Hide details panel (])')
    assert.equal(showPanelName(DETAILS_PANEL, DETAILS_PANEL_SHORTCUT), 'Show details panel (])')
  })
})

describe('SHORTCUT_ROWS', () => {
  it('is the keyboard table of the spec', () => {
    assert.deepEqual(SHORTCUT_ROWS, [
      { keys: '⌘K, Ctrl+K, /', action: 'Focus search' },
      { keys: '[', action: 'Collapse or expand the roots panel' },
      { keys: ']', action: 'Collapse or expand the details panel' },
      { keys: '1, 2, 3, 4', action: 'Go to Issues, Changes, Explore, or Compare' },
      { keys: '?', action: 'Show keyboard shortcuts' },
      { keys: 'Esc', action: 'Close the open menu, popover, or dialog' },
    ])
  })
})

describe('center words', () => {
  it('names the four tabs', () => {
    assert.deepEqual(VIEW_TITLES, { issues: 'Issues', changes: 'Changes', explore: 'Explore', compare: 'Compare' })
  })

  it('explains the issue count as packages with issues in the scope', () => {
    assert.equal(issueCountTitle(4, 'All roots'), '4 packages with issues in All roots')
    assert.equal(issueCountTitle(1, 'shop-npm'), '1 package with issues in shop-npm')
    assert.equal(issueCountTitle(0, 'legacy/admin'), '0 packages with issues in legacy/admin')
    assert.equal(issueCountTitle(1234, 'All roots'), '1,234 packages with issues in All roots')
  })

  it('names the selection pill after the package and its root', () => {
    assert.equal(selectionPillText('child-lib 1.0.0', 'shop-npm'), 'child-lib 1.0.0 in shop-npm')
    assert.equal(selectionPillText('web', 'legacy/admin'), 'web in legacy/admin')
    assert.equal(selectionPillText('web', '.'), 'web in repository root')
  })

  it('names the button that clears the selection', () => {
    assert.equal(CLEAR_SELECTION, 'Clear selection')
  })
})

describe('Explore words', () => {
  it('names the three modes', () => {
    assert.deepEqual(EXPLORE_MODE_NAMES, { trail: 'Dependents', tree: 'Dependencies', graph: 'Graph' })
  })

  it('states the question each mode answers about the package', () => {
    assert.equal(exploreTitle('trail', 'child-lib 1.0.0', 'shop-npm'), 'Dependents of child-lib 1.0.0 in shop-npm')
    assert.equal(exploreTitle('tree', 'child-lib 1.0.0', 'shop-npm'), 'Dependencies of child-lib 1.0.0')
    assert.equal(exploreTitle('graph', 'child-lib 1.0.0', 'shop-npm'), 'Graph around child-lib 1.0.0 in shop-npm')
  })

  it('gives an overview of the root without a package', () => {
    for (const mode of ['trail', 'tree', 'graph'] as const) {
      assert.equal(exploreTitle(mode, undefined, 'shop-npm'), 'Overview of shop-npm')
    }
    assert.equal(exploreTitle('tree', undefined, 'repository root'), 'Overview of repository root')
  })

  it('titles the whole-root graph by the root', () => {
    assert.equal(exploreTitle('graph', 'react 18.3.1', 'shop', 'whole-root'), 'Graph of shop')
    assert.equal(exploreTitle('graph', undefined, 'shop', 'whole-root'), 'Graph of shop')
    assert.equal(exploreTitle('graph', 'react 18.3.1', 'shop', 'package'), 'Graph around react 18.3.1 in shop')
    assert.equal(exploreTitle('tree', 'react 18.3.1', 'shop', 'whole-root'), 'Dependencies of react 18.3.1')
  })

  it('names the variant badge by position and count', () => {
    assert.equal(variantBadgeText({ position: 2, count: 3, peers: [], suffix: '' }), 'variant 2 of 3')
  })

  it('offers to focus on the selected package', () => {
    assert.equal(focusOnText('helper 1.0.0'), 'Focus on helper 1.0.0')
    assert.equal(focusOnText('repository root'), 'Focus on repository root')
  })

  it('names the options of Explore', () => {
    assert.equal(EXPLORE_OPTIONS, 'Options')
    assert.equal(DUPLICATES_ONLY, 'Duplicates only')
    assert.equal(LEVELS_UP, 'Levels up')
    assert.equal(LEVELS_DOWN, 'Levels down')
    assert.equal(NODE_LIMIT, 'Node limit')
    assert.equal(GRAPH_SCOPE, 'Scope')
    assert.deepEqual(GRAPH_SCOPE_NAMES, { package: 'Around the package', 'whole-root': 'Whole root' })
  })

  it('asks for one root in All roots and says how to use the graph', () => {
    assert.equal(EXPLORE_REQUIRES_ROOT, 'Explore requires a single root')
    assert.equal(EXPLORE_REQUIRES_ROOT_HINT, 'Select a root or search for a package.')
    assert.equal(EXPLORE_ROOT_CHOICES, 'Roots to explore')
    assert.equal(GRAPH_HINT, 'Click a package to select it. Drag to pan, scroll to zoom.')
  })

  it('titles the trail columns with fixed names and calls the anchor column This package', () => {
    assert.deepEqual(TRAIL_COLUMN_TITLES, {
      importers: 'Workspace packages',
      direct: 'Direct dependencies',
      via: 'Via',
      anchor: 'This package',
      children: 'Depends on',
    })
  })

  it('asks for a package before the trail, and points to Focus on when a package is selected but not the anchor', () => {
    assert.equal(DEPENDENTS_NEED_PACKAGE, 'Select a package to see its dependents.')
    assert.equal(dependentsFocusHint('helper 1.0.0'), 'helper 1.0.0 is selected. Focus on it to see its dependents.')
  })

  it('names a workspace package in tooltips without its node id', () => {
    assert.equal(workspacePackageTitle('api'), 'workspace package api')
  })

  it('says where the tree overview lists a workspace package that another one depends on', () => {
    assert.deepEqual(LISTED_WORKSPACE_PACKAGE_TEXTS, {
      above: 'workspace package, listed above',
      below: 'workspace package, listed below',
    })
  })

  it('labels a range as what it requires', () => {
    assert.equal(requiresText('^2.0.0'), 'requires ^2.0.0')
  })

  it('tells how to select a graph node and marks the anchor', () => {
    assert.equal(GRAPH_NODE_HINT, 'Click to select')
    assert.equal(GRAPH_ANCHOR_NOTE, 'Explore is built around this package')
    assert.equal(CLICK_TO_EXPAND, 'Click to expand')
    assert.equal(GRAPH_CLUSTERS, 'Clusters')
  })
})

describe('clusterLabel', () => {
  it('names the two workspace packages that share the packages, with the count', () => {
    assert.equal(clusterLabel(['api', 'web'], 2), 'Shared by api + web (2)')
  })

  it('says when only one workspace package pulls the packages in', () => {
    assert.equal(clusterLabel(['admin'], 3), 'Only in admin (3)')
  })

  it('counts three or more workspace packages instead of naming them', () => {
    assert.equal(clusterLabel(['a', 'b', 'c'], 1234), 'Shared by 3 workspace packages (1,234)')
  })
})

describe('clusterTitle', () => {
  it('explains what the cluster holds', () => {
    assert.equal(clusterTitle(['api', 'web']), 'Packages that api and web both depend on')
    assert.equal(clusterTitle(['admin']), 'Packages only admin depends on')
    assert.equal(clusterTitle(['a', 'b', 'c']), 'Packages that a, b, and c all depend on')
  })
})

const GOAL: FixGoal = { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: ['GHSA-1'], severity: 'high' }
const RELOCK_CHILD: Step = { kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'helper accepts it' }
const UPDATE_PARENT: Step = {
  kind: 'set-range',
  importer: 'importer:web',
  dependency: 'parent-lib',
  field: 'dependencies',
  place: 'manifest',
  from: '1.0.0',
  to: '1.1.0',
  reason: '1.1.0 requires child-lib ^1.0.1',
}
const OVERRIDE_CHILD: OverrideStep = { kind: 'override', selector: 'child-lib@<1.0.1', value: '1.0.1', file: 'pnpm-workspace.yaml', reason: 'pins the fixed version' }

describe('stepText', () => {
  it('describes a re-lock', () => {
    assert.equal(stepText(RELOCK_CHILD), 'Re-lock child-lib 1.0.0 → 1.0.1')
  })

  it('describes a range update in an importer', () => {
    assert.equal(stepText(UPDATE_PARENT), 'Update parent-lib in web to 1.1.0')
    assert.equal(stepText({ ...UPDATE_PARENT, importer: 'importer:.' }), 'Update parent-lib in the root package to 1.1.0')
  })

  it('describes a range update in a catalog', () => {
    assert.equal(stepText({ ...UPDATE_PARENT, place: 'catalog', to: '^1.1.0' }), 'Update parent-lib in the default catalog to ^1.1.0')
    assert.equal(stepText({ ...UPDATE_PARENT, place: 'catalog', catalog: 'react18', to: '^1.1.0' }), 'Update parent-lib in the react18 catalog to ^1.1.0')
  })

  it('describes an override in each file', () => {
    assert.equal(stepText(OVERRIDE_CHILD), 'Override child-lib@<1.0.1 to 1.0.1 in pnpm-workspace.yaml')
    assert.equal(stepText({ ...OVERRIDE_CHILD, file: 'package.json#pnpm.overrides' }), 'Override child-lib@<1.0.1 to 1.0.1 in package.json (pnpm.overrides)')
    assert.equal(stepText({ ...OVERRIDE_CHILD, file: 'package.json#overrides' }), 'Override child-lib@<1.0.1 to 1.0.1 in package.json (overrides)')
  })
})

describe('fixOptionTitle', () => {
  it('names a re-lock by its target version', () => {
    assert.equal(fixOptionTitle({ choice: 'relock', steps: [RELOCK_CHILD] }, GOAL), 'Re-lock to 1.0.1')
  })

  it('names an override by its value', () => {
    assert.equal(fixOptionTitle({ choice: 'override', steps: [OVERRIDE_CHILD] }, GOAL), 'Override to 1.0.1')
  })

  it('names a chain that re-locks the vulnerable package first', () => {
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [RELOCK_CHILD, UPDATE_PARENT] }, GOAL), 'Re-lock and update parent-lib')
  })

  it('names a chain that starts with another step', () => {
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [UPDATE_PARENT] }, GOAL), 'Update parent-lib')
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [{ ...RELOCK_CHILD, name: 'parent-lib' }, UPDATE_PARENT] }, GOAL), 'Update parent-lib')
  })

  it('lists each updated dependency once, two at most', () => {
    const other: Step = { ...UPDATE_PARENT, dependency: 'other-lib' }
    const third: Step = { ...UPDATE_PARENT, dependency: 'third-lib' }
    const importerTwin: Step = { ...UPDATE_PARENT, importer: 'importer:api' }
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [UPDATE_PARENT, importerTwin] }, GOAL), 'Update parent-lib')
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [UPDATE_PARENT, other] }, GOAL), 'Update parent-lib, other-lib')
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [RELOCK_CHILD, UPDATE_PARENT, other, third] }, GOAL), 'Re-lock and update parent-lib, other-lib, and 1 more')
  })

  it('names a chain that only re-locks by the parent packages it re-locks', () => {
    const semverGoal = { ...GOAL, name: 'semver', version: '5.7.2' }
    const relockSemver: Step = { kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'in range' }
    const relockPlugin: Step = { kind: 'relock', name: 'eslint-plugin-vue', from: '9.32.0', to: '9.33.0', reason: 'allows semver 5.7.3' }
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [relockSemver, relockPlugin] }, semverGoal), 'Re-lock eslint-plugin-vue')
  })

  it('lists each re-locked parent once, two at most', () => {
    const relockOf = (name: string): Step => ({ kind: 'relock', name, from: '1.0.0', to: '1.1.0', reason: 'allows child-lib 1.0.1' })
    const steps = [RELOCK_CHILD, relockOf('alpha'), relockOf('beta'), relockOf('alpha'), relockOf('gamma')]
    assert.equal(fixOptionTitle({ choice: 'chain', steps }, GOAL), 'Re-lock alpha, beta, and 1 more')
  })
})

describe('options without steps', () => {
  it('names each choice by itself', () => {
    assert.deepEqual((['relock', 'chain', 'override'] as const).map(fixChoiceName), ['Re-lock', 'Update parent packages', 'Override'])
  })

  it('titles an option with no steps by its choice', () => {
    assert.equal(fixOptionTitle({ choice: 'relock', steps: [] }, GOAL), 'Re-lock')
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [] }, GOAL), 'Update parent packages')
    assert.equal(fixOptionTitle({ choice: 'override', steps: [] }, GOAL), 'Override')
    assert.equal(fixOptionTitle({ choice: 'chain', steps: [RELOCK_CHILD] }, GOAL), 'Update parent packages')
  })

  it('writes the note of an unavailable option without a dangling title', () => {
    assert.equal(unavailableOptionNote('chain', 'no parent accepts it'), 'Update parent packages: no parent accepts it')
    assert.equal(unavailableOptionNote('override', 'npm roots only'), 'Override: npm roots only')
  })
})

describe('issueSectionTitle', () => {
  it('names the three sections', () => {
    assert.deepEqual((['vulnerability', 'deprecated', 'outdated'] as const).map(issueSectionTitle), ['Vulnerabilities', 'Deprecations', 'Updates'])
  })
})

describe('updateRecommendation', () => {
  it('says in range when the wanted version differs from the current one', () => {
    assert.equal(updateRecommendation({ version: '2.0.0', wanted: '2.1.0' }), 'In range: 2.1.0')
  })

  it('asks for a range change when a newer version is outside the range', () => {
    assert.equal(updateRecommendation({ version: '2.0.0', wanted: '2.0.0', latest: '3.0.0' }), 'Needs a range change')
    assert.equal(updateRecommendation({ version: '2.0.0', latest: '3.0.0' }), 'Needs a range change')
  })

  it('says that no update is available when no newer version is known', () => {
    assert.equal(updateRecommendation({ version: '2.0.0', wanted: '2.0.0' }), 'No update available')
    assert.equal(updateRecommendation({ version: '2.0.0' }), 'No update available')
  })
})

describe('typeToggleText', () => {
  it('names the type and counts its packages', () => {
    assert.equal(typeToggleText('vulnerability', 1), 'Vulnerabilities 1')
    assert.equal(typeToggleText('deprecated', 0), 'Deprecations 0')
    assert.equal(typeToggleText('outdated', 3), 'Updates 3')
    assert.equal(typeToggleText('outdated', 1234), 'Updates 1,234')
  })
})

describe('checkDetailsTitle', () => {
  it('counts the registry, OSV and skipped checks after they finish', () => {
    assert.equal(
      checkDetailsTitle(enrichment({ registry: { total: 1234, done: 1234, failed: 0 }, osv: { total: 5678, done: 5464, skipped: 214, failed: 0 } })),
      'Registry 1,234 packages · OSV 5,678 versions, 214 skipped',
    )
  })

  it('counts the progress while the checks run', () => {
    assert.equal(
      checkDetailsTitle(enrichment({ state: 'running', registry: { total: 400, done: 120, failed: 0 }, osv: { total: 50, done: 10, skipped: 2, failed: 0 } })),
      'Registry 120 / 400 packages · OSV 10 / 50 versions, 2 skipped',
    )
  })

  it('explains offline', () => {
    assert.equal(checkDetailsTitle(offlineStatus(0)), 'Offline: started with --offline')
  })
})

describe('issuesEmptyText', () => {
  const NO_GAPS = { failedChecks: 0, failedRoots: [], unlistedPaths: 0 }

  it('says why Issues is empty', () => {
    assert.equal(issuesEmptyText('checking', 'All roots', NO_GAPS, false), 'Checking packages…')
    assert.equal(issuesEmptyText('offline', 'All roots', NO_GAPS, false), 'Offline: started with --offline')
    assert.equal(issuesEmptyText('clean', 'shop-npm', NO_GAPS, false), 'No known issues in shop-npm')
    assert.equal(issuesEmptyText('clean', 'All roots', NO_GAPS, false), 'No known issues in All roots')
    assert.equal(issuesEmptyText('filtered', 'shop', NO_GAPS, false), 'No issues of the selected types')
  })

  it('limits the claim to the packages that were checked and says what failed', () => {
    assert.equal(
      issuesEmptyText('incomplete', 'All roots', { ...NO_GAPS, failedChecks: 2 }, false),
      'No known issues in the checked packages; 2 checks failed',
    )
    assert.equal(
      issuesEmptyText('incomplete', 'All roots', { ...NO_GAPS, failedRoots: ['legacy'] }, false),
      'No known issues in the checked packages; legacy failed to scan',
    )
    assert.equal(
      issuesEmptyText('incomplete', 'All roots', { ...NO_GAPS, failedChecks: 1, failedRoots: ['legacy', '.'] }, false),
      'No known issues in the checked packages; 1 check failed; legacy, repository root failed to scan',
    )
  })

  it('names the selected types when the dependency kinds are narrowed', () => {
    assert.equal(
      issuesEmptyText('incomplete', 'All roots', { ...NO_GAPS, failedChecks: 2 }, true),
      'No known issues of the selected types in the checked packages; 2 checks failed',
    )
    assert.equal(
      issuesEmptyText('incomplete', 'All roots', { ...NO_GAPS, unlistedPaths: 3 }, true),
      issuesEmptyText('incomplete', 'All roots', { ...NO_GAPS, unlistedPaths: 3 }, false),
    )
    assert.equal(issuesEmptyText('clean', 'shop', NO_GAPS, true), 'No known issues in shop')
  })
})

describe('collectResultText', () => {
  it('counts the added fixes per root', () => {
    assert.equal(
      collectResultText([
        { root: 'shop', result: { added: 2, skipped: [] } },
        { root: 'shop-npm', result: { added: 1 } },
      ]),
      'Added 2 fixes to shop, 1 to shop-npm',
    )
    assert.equal(collectResultText([{ root: '.', result: { added: 1 } }]), 'Added 1 fix to repository root')
  })

  it('leaves out roots that got no fix and lists the skipped packages', () => {
    assert.equal(
      collectResultText([
        { root: 'shop', result: { added: 2, skipped: [{ name: 'parent-lib', reason: 'no fixed version yet' }] } },
        { root: 'shop-npm', result: { added: 0 } },
      ]),
      'Added 2 fixes to shop; skipped parent-lib (no fixed version yet)',
    )
  })

  it('says when no fix was added', () => {
    assert.equal(
      collectResultText([{ root: 'shop', result: { added: 0, skipped: [{ name: 'child-lib 1.0.0', reason: 'already in the changes of shop' }] } }]),
      'No fixes added; skipped child-lib 1.0.0 (already in the changes of shop)',
    )
    assert.equal(collectResultText([]), 'No fixes added')
  })

  it('shows the first three skipped packages and counts the rest', () => {
    const skipped = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, reason: `why ${name}` }))
    assert.equal(
      collectResultText([{ root: 'shop', result: { added: 3, skipped: skipped.slice(0, 2) } }, { root: 'docs', result: { added: 0, skipped: skipped.slice(2) } }]),
      'Added 3 fixes to shop; skipped a (why a), b (why b), c (why c), and 2 more',
    )
  })

  it('leaves the roots that failed to collectFailureTexts', () => {
    const results = [
      { root: 'shop', result: { added: 1 } },
      { root: 'shop-npm', result: undefined, error: 'Server error' },
      { root: '.', result: undefined, error: 'Job failed' },
    ]
    assert.equal(collectResultText(results), 'Added 1 fix to shop')
    assert.deepEqual(collectFailureTexts(results), ['Could not add fixes to shop-npm: Server error', 'Could not add fixes to repository root: Job failed'])
    assert.deepEqual(collectFailureTexts([{ root: 'shop', result: { added: 1 } }]), [])
  })
})

describe('Add recommended fixes texts', () => {
  it('names a root with its vulnerable packages', () => {
    assert.equal(vulnerableRootText('shop', 1), 'shop — 1 vulnerable package')
    assert.equal(vulnerableRootText('shop-npm', 2), 'shop-npm — 2 vulnerable packages')
    assert.equal(vulnerableRootText('.', 3), 'repository root — 3 vulnerable packages')
  })

  it('says which root gets its fixes', () => {
    assert.equal(addingFixesText('shop-npm'), 'Adding fixes to shop-npm…')
  })
})

describe('Issues row texts', () => {
  it('announces an added fix with the root label', () => {
    assert.equal(addedFixText('child-lib', 'shop-npm'), 'Added fix for child-lib to shop-npm')
    assert.equal(addedFixText('child-lib', '.'), 'Added fix for child-lib to repository root')
  })

  it('counts roots and hidden names', () => {
    assert.equal(inRootsText(2), 'in 2 roots')
    assert.equal(inRootsText(1), 'in 1 root')
    assert.equal(moreCountText(1200), '+1,200 more')
    assert.equal(moreNotListedText(3), '+3 more not listed')
  })

  it('names a location row and explains failures', () => {
    assert.equal(issueLocationName('child-lib 1.0.0', 'shop-npm'), 'child-lib 1.0.0 in shop-npm')
    assert.equal(nestedIssueLocationName('ms 2.0.0', 'debug 2.6.9', 'shop'), 'ms 2.0.0 under debug 2.6.9 in shop')
    assert.equal(fixLoadFailedText('Server error'), 'Could not load the fix: Server error')
    assert.equal(fixAddFailedText('already in the changes'), 'Could not add the fix: already in the changes')
  })
})

describe('details texts', () => {
  it('says what a parent requires and where it comes from', () => {
    assert.equal(whyHereDetailText('^1.0.0', true, []), 'requires ^1.0.0 · direct dependency')
    assert.equal(whyHereDetailText('^1.0.0', false, ['api', 'web']), 'requires ^1.0.0 · from api, web')
    assert.equal(whyHereDetailText('(none)', false, []), 'requires (none)')
  })

  it('names another root with its version', () => {
    assert.equal(alsoInRootText('shop', '1.0.0'), 'shop (1.0.0)')
    assert.equal(alsoInRootText('.', '2.0.0'), 'repository root (2.0.0)')
  })

  it('writes the header labels and their titles', () => {
    assert.equal(updateLabelText('1.1.0', 'minor'), '↑ 1.1.0 minor')
    assert.equal(updateLabelTitle('1.1.0', 'minor'), 'Latest: 1.1.0 (minor update)')
    assert.equal(vulnerableBelowText(1200, 'high'), '1,200 vulnerable below · high')
    assert.equal(vulnerableBelowTitle(1, 'high'), '1 vulnerable package below; highest severity: high')
    assert.equal(vulnerableBelowTitle(2, 'low'), '2 vulnerable packages below; highest severity: low')
    assert.equal(knownVulnerabilitiesTitle(1, 'critical'), '1 known vulnerability; highest severity: critical')
    assert.equal(knownVulnerabilitiesTitle(3, 'moderate'), '3 known vulnerabilities; highest severity: moderate')
  })

  it('explains why a package was not checked', () => {
    assert.equal(skippedCheckTitle('private-scope'), 'Private scope with a registry in .npmrc; not sent to OSV')
    assert.equal(skippedCheckTitle('non-registry'), 'Not from a registry (git, file, or link)')
    assert.equal(skippedCheckTitle('unknown-version'), 'The exact version is unknown (manifest only)')
    assert.equal(skippedCheckTitle(undefined), 'The exact version is unknown (manifest only)')
    assert.equal(failedCheckTitle('osv', 'HTTP 503'), 'OSV check failed: HTTP 503')
    assert.equal(failedCheckTitle('registry', undefined), 'Registry check failed: unknown reason')
    assert.equal(notCheckedTitle(['first', 'second']), 'first; second')
  })

  it('writes the check notices and times', () => {
    assert.equal(staleCheckNotice('registry', '2026-10-26T10:00:00.000Z', NOW), 'Registry data is from 2 hours ago; the last check failed.')
    assert.equal(staleCheckNotice('osv', undefined, NOW), 'OSV data is from an earlier check; the last check failed.')
    assert.equal(failedCheckNotice('registry', 'timeout'), 'Could not check the registry: timeout.')
    assert.equal(failedCheckNotice('osv', undefined), 'Could not check OSV: unknown reason.')
    assert.equal(checkedTimeText('registry', '2026-10-26T11:59:30.000Z', NOW), 'Registry checked just now')
    assert.equal(checkedTimeText('osv', '2026-10-26T11:55:00.000Z', NOW), 'OSV checked 5 minutes ago')
    assert.equal(latestText('1.1.0'), 'latest 1.1.0')
  })

  it('heads the advisories and lists the fixed versions', () => {
    assert.equal(advisoriesHeading(1, false), 'Vulnerability')
    assert.equal(advisoriesHeading(2, true), 'Vulnerabilities')
    assert.equal(advisoriesHeading(0, true), 'Deprecation')
    assert.equal(fixedInText(['1.0.1', '2.0.0']), 'Fixed in 1.0.1, 2.0.0')
    assert.equal(deprecationMessageText('Use other-lib'), '“Use other-lib”')
  })
})

describe('summary texts', () => {
  const NO_CHECK_GAPS = { failedChecks: 0, failedRoots: [], unlistedPaths: 0 }

  it('asks to select an issue, says when a root has none and says what is loading', () => {
    assert.equal(SELECT_ISSUE_PROMPT, 'Select an issue to see available actions.')
    assert.equal(NO_KNOWN_ISSUES_STATUS, 'No known issues')
    assert.equal(LOADING, 'Loading…')
    assert.equal(LOADING_SCAN, 'Loading scan…')
  })

  it('says what is known about the issues instead of claiming none before the checks are done', () => {
    assert.equal(CHECKING_PACKAGES, 'Checking packages…')
    assert.equal(knownProblemsText('loading', 'No known issues', NO_CHECK_GAPS), 'Loading…')
    assert.equal(knownProblemsText('checking', 'No known issues', NO_CHECK_GAPS), 'Checking packages…')
    assert.equal(knownProblemsText('offline', 'No known issues', NO_CHECK_GAPS), 'Offline: started with --offline')
    assert.equal(knownProblemsText('clean', 'No known issues in dependencies', NO_CHECK_GAPS), 'No known issues in dependencies')
  })

  it('never claims no known issues when checks failed or some paths were not listed', () => {
    assert.equal(
      knownProblemsText('incomplete', 'No known issues', { ...NO_CHECK_GAPS, failedChecks: 3 }),
      'No known issues in the checked packages; 3 checks failed',
    )
    assert.equal(
      knownProblemsText('incomplete', 'No known issues in dependencies', { ...NO_CHECK_GAPS, unlistedPaths: 2 }),
      'May be incomplete: not all paths to 2 packages with issues are listed',
    )
    assert.equal(
      knownProblemsText('incomplete', 'No known issues in dependencies', { ...NO_CHECK_GAPS, unlistedPaths: 1, failedChecks: 1 }),
      'May be incomplete: not all paths to 1 package with issues are listed; 1 check failed',
    )
    assert.equal(unlistedPathsText(1), 'May be incomplete: not all paths to 1 package with issues are listed')
  })

  it('says how accurate the versions of a source are', () => {
    assert.equal(sourceAccuracyText('lockfile'), 'Exact versions from the lockfile.')
    assert.equal(sourceAccuracyText('installed'), 'Versions read from the installed node_modules.')
    assert.equal(sourceAccuracyText('resolved-today'), 'Versions are resolved as of today, not read from a lockfile.')
    assert.equal(sourceAccuracyText('manifest-only'), 'Only direct dependencies from package.json are known.')
  })

  it('counts packages and direct dependencies', () => {
    assert.equal(packageCountText(1), '1 package')
    assert.equal(packageCountText(1200), '1,200 packages')
    assert.equal(directDependencyCountText(1), '1 direct dependency')
    assert.equal(directDependencyCountText(2), '2 direct dependencies')
  })

  it('names the workspace package sections', () => {
    assert.equal(ISSUES_IN_DEPENDENCIES, 'Issues in dependencies')
    assert.equal(NO_ISSUES_IN_DEPENDENCIES, 'No known issues in dependencies')
    assert.equal(EXPLORE_DEPENDENCIES, 'Explore dependencies')
    assert.equal(changesInRootHeading('shop'), 'Changes in shop')
    assert.equal(changesInRootHeading('.'), 'Changes in repository root')
  })

  it('names the collapsed list of vulnerable dependencies and its failures', () => {
    assert.equal(VULNERABLE_DEPENDENCIES, 'Vulnerable dependencies')
    assert.equal(vulnerableDependenciesLoadFailedText('Server error'), 'Could not load the vulnerable dependencies: Server error')
    assert.equal(packageChecksFailedText('Server error'), 'Could not load the package checks: Server error')
  })
})

describe('Actions texts', () => {
  it('names the block and its buttons', () => {
    assert.equal(ACTIONS_HEADING, 'Actions')
    assert.equal(ADD_TO_CHANGES, 'Add to changes')
    assert.equal(IN_CHANGES_REVIEW, '✓ In changes · Review')
    assert.equal(REPLACE_IN_CHANGES, 'Replace in changes')
    assert.equal(SAVE_CHANGE, 'Save change')
    assert.equal(ADDED_TO_CHANGES, 'Added to changes')
    assert.equal(REPLACED_IN_CHANGES, 'Replaced in changes')
  })

  it('says when there is nothing to do', () => {
    assert.equal(nothingToFixText('1.1.0'), 'Up to date: 1.1.0 is the latest version.')
    assert.equal(NO_UPDATE_AVAILABLE, 'No update available.')
  })

  it('heads the update of a package in a root', () => {
    assert.equal(updateHeading('toolkit', 'shop'), 'Update toolkit in shop')
    assert.equal(updateHeading('toolkit', '.'), 'Update toolkit in repository root')
  })

  it('says that a range stays for a re-lock', () => {
    assert.equal(staysInRangeText('1.1.0'), 'unchanged (1.1.0 is in range)')
  })

  it('names a workspace package whose peerDependencies range stays', () => {
    assert.equal(peerRangeUnchangedText('importer:web', '^2'), 'web: peerDependencies ^2 unchanged')
    assert.equal(peerRangeUnchangedText('importer:.', '>=2'), 'the root package: peerDependencies >=2 unchanged')
  })

  it('titles an update choice by what it does', () => {
    assert.equal(updateChoiceTitle('wanted', '2.1.0'), 'Re-lock to 2.1.0')
    assert.equal(updateChoiceTitle('latest', '3.0.0'), 'Update to 3.0.0')
    assert.equal(updateChoiceTitle('version', '2.0.5'), 'Update to 2.0.5')
  })

  it('titles the choice of a change with the words of its option', () => {
    const fixChange: ChangeItem = { id: 'fix-1', goal: GOAL, choice: 'override', steps: [OVERRIDE_CHILD], warnings: [] }
    const chainChange: ChangeItem = { id: 'fix-2', goal: GOAL, choice: 'chain', steps: [RELOCK_CHILD, UPDATE_PARENT], warnings: [] }
    const updateChange: ChangeItem = {
      id: 'update-1',
      goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '3.0.0' },
      choice: 'latest',
      steps: [],
      warnings: [],
    }
    assert.equal(changeChoiceTitle(fixChange), 'Override to 1.0.1')
    assert.equal(changeChoiceTitle(chainChange), 'Re-lock and update parent-lib')
    assert.equal(changeChoiceTitle(updateChange), 'Update to 3.0.0')
    const relockChange: ChangeItem = { ...updateChange, choice: 'wanted', goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '2.1.0' } }
    assert.equal(changeChoiceTitle(relockChange), 'Re-lock to 2.1.0')
  })

  it('says which choice is already in changes', () => {
    assert.equal(inChangesText('Override to 1.0.1'), 'In changes: Override to 1.0.1')
  })

  it('explains loading and failures', () => {
    assert.equal(loadingOptionsText('toolkit'), 'Loading actions for toolkit…')
    assert.equal(actionsLoadFailedText('Server error'), 'Could not load actions: Server error')
    assert.equal(addToChangesFailedText('already in the changes'), 'Could not add to changes: already in the changes')
    assert.equal(replaceChangeFailedText('Unknown change'), 'Could not replace the change: Unknown change')
  })
})

describe('Changes texts', () => {
  const fixGoal: FixGoal = { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: ['GHSA-e2e0-chld-0001'], severity: 'high' }

  it('names the steps of a root and its buttons', () => {
    assert.deepEqual(
      CHANGE_STEPS.map((entry) => `${entry.number} ${entry.title}`),
      ['1 Changes', '2 Preview', '3 Apply'],
    )
    assert.deepEqual(
      CHANGE_STEPS.map((entry) => entry.step),
      ['changes', 'preview', 'apply'],
    )
    assert.equal(CHANGE_STEPS_LABEL, 'Steps')
    assert.deepEqual(PRIMARY_ACTION_TEXTS, { preview: 'Preview', apply: 'Apply…', 'preview-again': 'Preview again' })
    assert.equal(CHANGES_EDITED_AFTER_PREVIEW, 'Changes were edited after this preview')
    assert.equal(CLEAR, 'Clear')
    assert.equal(UNDO, 'Undo')
    assert.equal(EDIT, 'Edit')
  })

  it('says that there are no changes yet without the old change set wording', () => {
    assert.equal(NO_CHANGES_YET, 'No changes yet. Add fixes from Issues or the details panel.')
    assert.equal(LOADING_CHANGES, 'Loading changes…')
  })

  it('names a fix goal with its advisories', () => {
    assert.equal(changeGoalText(fixGoal), 'Fix child-lib 1.0.0 · GHSA-e2e0-chld-0001')
    assert.equal(changeGoalText({ ...fixGoal, advisoryIds: [] }), 'Fix child-lib 1.0.0')
    assert.equal(
      changeGoalText({ ...fixGoal, advisoryIds: ['GHSA-1', 'GHSA-2', 'GHSA-3', 'GHSA-4'] }),
      'Fix child-lib 1.0.0 · GHSA-1, GHSA-2, GHSA-3 +1 more',
    )
  })

  it('names an update goal with its workspace packages', () => {
    assert.equal(changeGoalText({ kind: 'update', name: 'helper', importers: ['importer:api'], target: '1.1.0' }), 'Update helper to 1.1.0 · api')
    assert.equal(
      changeGoalText({ kind: 'update', name: 'toolkit', importers: ['importer:api', 'importer:.'], target: '2.1.0' }),
      'Update toolkit to 2.1.0 · api, the root package',
    )
    assert.equal(changeGoalText({ kind: 'update', name: 'toolkit', importers: [], target: '2.1.0' }), 'Update toolkit to 2.1.0')
  })

  it('names the Edit and remove buttons of an item by its goal', () => {
    assert.equal(removeChangeName(fixGoal), 'Remove Fix child-lib 1.0.0')
    assert.equal(editChangeName(fixGoal), 'Edit Fix child-lib 1.0.0')
  })

  it('puts the steps of an item on one line', () => {
    assert.equal(changeStepsText([RELOCK_CHILD, UPDATE_PARENT]), 'Re-lock child-lib 1.0.0 → 1.0.1; Update parent-lib in web to 1.1.0')
    assert.equal(changeStepsText([]), '')
  })

  it('labels the size of an update', () => {
    assert.equal(updateSizeBadgeText('minor'), '↑ minor')
    assert.equal(updateSizeBadgeText(undefined), '↑')
  })

  it('reports Clear and Undo', () => {
    assert.equal(clearedChangesText(2), 'Cleared 2 changes.')
    assert.equal(clearedChangesText(1), 'Cleared 1 change.')
    assert.equal(restoredChangesText({ restored: 2, skipped: [] }), 'Restored 2 changes.')
    assert.equal(
      restoredChangesText({ restored: 1, skipped: [{ name: 'Fix child-lib 1.0.0', reason: 'already in the changes' }] }),
      'Restored 1 change. Skipped: Fix child-lib 1.0.0 (already in the changes).',
    )
  })

  it('explains failures', () => {
    assert.equal(changesFailureText('load', 'Server error'), 'Could not load the changes: Server error')
    assert.equal(changesFailureText('clear', 'Server error'), 'Could not clear the changes: Server error')
    assert.equal(changesFailureText('undo', 'Server error'), 'Could not restore the cleared changes: Server error')
    assert.equal(changesFailureText('preview', 'busy'), 'Could not start the preview: busy')
    assert.equal(changesFailureText('apply', 'busy'), 'Could not apply the changes: busy')
    assert.equal(changesFailureText('revert', 'busy'), 'Could not revert the files: busy')
    assert.equal(changesFailureText('cancel', 'busy'), 'Could not cancel the job: busy')
    assert.equal(changesFailureText('follow', 'offline'), 'Could not get the job status: offline')
    assert.equal(changesFailureText('edit', packageNotInRootText('toolkit', 'shop-npm')), 'Could not open the package: toolkit is not in shop-npm')
    assert.equal(packageNotInRootText('toolkit', '.'), 'toolkit is not in repository root')
    assert.equal(removeChangeFailedText(fixGoal, 'Unknown change'), 'Could not remove Fix child-lib 1.0.0: Unknown change')
  })
})

describe('apply and revert outcome texts', () => {
  it('reports an apply with the goals met and the files written', () => {
    assert.equal(
      applyOutcomeText('shop-npm', { goalsMet: 2, install: 'not-run' }, ['package-lock.json', 'web/package.json']),
      'Applied to shop-npm. 2 goals met · files written: package-lock.json, web/package.json.',
    )
    assert.equal(applyOutcomeText('shop', { goalsMet: 1, install: 'done' }, ['pnpm-lock.yaml']), 'Applied to shop. 1 goal met · files written: pnpm-lock.yaml.')
    assert.equal(applyOutcomeText('.', { goalsMet: 1 }, ['package-lock.json']), 'Applied to repository root. 1 goal met · files written: package-lock.json.')
  })

  it('leaves out the files when none are known and counts no goals without a result', () => {
    assert.equal(applyOutcomeText('shop', { goalsMet: 2 }, []), 'Applied to shop. 2 goals met.')
    assert.equal(applyOutcomeText('shop', undefined, []), 'Applied to shop. 0 goals met.')
  })

  it('hints at the install after an apply only when the apply did not run it', () => {
    assert.equal(installHint('npm', 'shop-npm', 'after-apply', 'not-run'), 'node_modules was not updated. Run `npm ci` in shop-npm when ready.')
    assert.equal(installHint('pnpm', 'shop', 'after-apply', 'not-run'), 'node_modules was not updated. Run `pnpm install --frozen-lockfile` in shop when ready.')
    assert.equal(installHint('npm', 'shop-npm', 'after-apply', 'done'), undefined)
    assert.equal(installHint('npm', 'shop-npm', 'after-apply', 'failed'), undefined)
    assert.equal(installHint('npm', 'shop-npm', 'after-apply', undefined), undefined)
  })

  it('hints at the install after a revert only when the apply had run it', () => {
    assert.equal(installHint('npm', 'shop-npm', 'after-revert', 'done'), 'node_modules still has the applied versions. Run `npm ci` in shop-npm.')
    assert.equal(installHint('pnpm', '.', 'after-revert', 'failed'), 'node_modules still has the applied versions. Run `pnpm install --frozen-lockfile` in repository root.')
    assert.equal(installHint('npm', 'shop-npm', 'after-revert', 'not-run'), undefined)
    assert.equal(installHint('npm', 'shop-npm', 'after-revert', undefined), undefined)
  })

  it('reports how many changes a revert put back in the list', () => {
    assert.equal(revertOutcomeText('shop-npm', { restored: 2, skipped: [], appliedInstall: 'not-run' }), 'Files restored in shop-npm. 2 changes are back in the list.')
    assert.equal(revertOutcomeText('shop-npm', { restored: 1, skipped: [], appliedInstall: 'done' }), 'Files restored in shop-npm. 1 change is back in the list.')
    assert.equal(revertOutcomeText('shop', { restored: 0, skipped: [] }), 'Files restored in shop.')
    assert.equal(revertOutcomeText('shop', undefined), 'Files restored in shop.')
  })

  it('names the skipped changes of a revert by the goal text the server sends', () => {
    const skipped = [{ name: 'Fix parent-lib 1.0.0', reason: 'Conflicts with "Fix child-lib 1.0.0": the override also matches' }]
    assert.equal(
      revertOutcomeText('shop-npm', { restored: 0, skipped }),
      'Files restored in shop-npm. Skipped: Fix parent-lib 1.0.0 (Conflicts with "Fix child-lib 1.0.0": the override also matches).',
    )
    assert.equal(
      revertOutcomeText('shop-npm', { restored: 1, skipped: [{ name: 'Fix parent-lib 1.0.0', reason: 'already in the changes' }, { name: 'Update helper to 1.1.0', reason: 'conflict' }] }),
      'Files restored in shop-npm. 1 change is back in the list. Skipped: Fix parent-lib 1.0.0 (already in the changes), Update helper to 1.1.0 (conflict).',
    )
  })

  it('says what Revert files restores', () => {
    assert.equal(REVERT_FILES, 'Revert files')
    assert.equal(revertNote(2, 2), 'Restores 2 files and puts 2 changes back in the list.')
    assert.equal(revertNote(1, 1), 'Restores 1 file and puts 1 change back in the list.')
    assert.equal(revertNote(2, 0), 'Restores 2 files.')
  })
})

function finishedJob(fields: Partial<Job> & Pick<Job, 'kind' | 'state'>): Job {
  return { id: 'job-1', rootId: 'shop-npm', log: [], firstLine: 0, ...fields }
}

describe('finished job texts', () => {
  it('reports a finished apply with its root, goals and written files', () => {
    assert.deepEqual(
      finishedJobText(finishedJob({ kind: 'apply', state: 'done', result: { goalsMet: 1, install: 'not-run', files: ['web/package.json', 'package-lock.json'] } })),
      { text: 'Applied to shop-npm. 1 goal met · files written: web/package.json, package-lock.json.', failed: false },
    )
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'apply', state: 'done', result: { goalsMet: 1, install: 'not-run' } })), {
      text: 'Applied to shop-npm. 1 goal met.',
      failed: false,
    })
  })

  it('reports a finished revert with the changes it put back', () => {
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'revert', state: 'done', result: { restored: 2, skipped: [], appliedInstall: 'not-run' } })), {
      text: 'Files restored in shop-npm. 2 changes are back in the list.',
      failed: false,
    })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'revert', state: 'failed', error: 'Files changed since they were applied: web/package.json' })), {
      text: 'Revert failed: Files changed since they were applied: web/package.json',
      failed: true,
    })
  })

  it('reports failed and canceled jobs', () => {
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'apply', state: 'failed', error: 'install failed: exit code 1' })), {
      text: 'Apply failed: install failed: exit code 1',
      failed: true,
    })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'apply', state: 'cancelled' })), { text: 'Install canceled. Files already written are kept.', failed: true })
    const libs = [{ id: 'libs', manager: 'pnpm' as const }]
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'apply', state: 'failed', error: 'install failed: exit code 1' }), libs), {
      text: 'Apply failed: install failed: exit code 1 Lockfile not updated: libs. Run pnpm install there.',
      failed: true,
    })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'apply', state: 'cancelled' }), libs), {
      text: 'Install canceled. Files already written are kept. Lockfile not updated: libs. Run pnpm install there.',
      failed: true,
    })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'preview', state: 'cancelled' }), libs), { text: 'Preview canceled.', failed: true })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'preview', state: 'failed', error: 'pnpm exited with code 1' })), {
      text: 'Preview failed: pnpm exited with code 1',
      failed: true,
    })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'preview', state: 'cancelled' })), { text: 'Preview canceled.', failed: true })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'collect', state: 'failed', error: 'boom' })), { text: 'Adding fixes failed: boom', failed: true })
    assert.deepEqual(finishedJobText(finishedJob({ kind: 'preview', state: 'failed' })), { text: 'Preview failed: unknown error', failed: true })
  })

  it('has no text for a running job, a finished preview or a finished collect', () => {
    assert.equal(finishedJobText(finishedJob({ kind: 'apply', state: 'running', phase: 'installing' })), undefined)
    assert.equal(finishedJobText(finishedJob({ kind: 'preview', state: 'done', result: { previewId: 'preview-1' } })), undefined)
    assert.equal(finishedJobText(finishedJob({ kind: 'collect', state: 'done', result: { added: 1, skipped: [] } })), undefined)
  })

  it('hints at the install of a finished apply or revert with the package manager of the root', () => {
    assert.equal(
      finishedJobHint(finishedJob({ kind: 'apply', state: 'done', result: { goalsMet: 1, install: 'not-run' } }), 'npm'),
      'node_modules was not updated. Run `npm ci` in shop-npm when ready.',
    )
    assert.equal(finishedJobHint(finishedJob({ kind: 'apply', state: 'done', result: { goalsMet: 1, install: 'done' } }), 'npm'), undefined)
    assert.equal(
      finishedJobHint(finishedJob({ kind: 'apply', state: 'failed', error: 'install failed: exit code 1' }), 'npm'),
      'node_modules may be out of date. Run `npm ci` in shop-npm.',
    )
    assert.equal(
      finishedJobHint(finishedJob({ rootId: '.', kind: 'apply', state: 'failed', error: 'install failed: exit code 1' }), 'pnpm'),
      'node_modules may be out of date. Run `pnpm install --frozen-lockfile` in repository root.',
    )
    assert.equal(
      finishedJobHint(finishedJob({ kind: 'apply', state: 'cancelled' }), 'npm'),
      'node_modules may be out of date. Run `npm ci` in shop-npm.',
    )
    assert.equal(finishedJobHint(finishedJob({ kind: 'revert', state: 'failed', error: 'install failed: x' }), 'npm'), undefined)
    assert.equal(
      finishedJobHint(finishedJob({ kind: 'revert', state: 'done', result: { restored: 1, skipped: [], appliedInstall: 'done' } }), 'npm'),
      'node_modules still has the applied versions. Run `npm ci` in shop-npm.',
    )
    assert.equal(finishedJobHint(finishedJob({ kind: 'revert', state: 'done', result: { restored: 1, skipped: [], appliedInstall: 'not-run' } }), 'npm'), undefined)
  })

  it('has no install hint without a known package manager or a finished apply or revert', () => {
    assert.equal(finishedJobHint(finishedJob({ kind: 'apply', state: 'done', result: { goalsMet: 1, install: 'not-run' } }), undefined), undefined)
    assert.equal(finishedJobHint(finishedJob({ kind: 'apply', state: 'running' }), 'npm'), undefined)
    assert.equal(finishedJobHint(finishedJob({ kind: 'apply', state: 'failed', error: 'EACCES: permission denied' }), 'npm'), undefined)
    assert.equal(finishedJobHint(finishedJob({ kind: 'preview', state: 'done', result: { previewId: 'preview-1' } }), 'npm'), undefined)
  })
})

describe('running job texts', () => {
  it('describes every phase', () => {
    assert.equal(phaseText('staging'), 'Copying the root to a temporary directory…')
    assert.equal(phaseText('resolving'), 'Resolving the lockfile…')
    assert.equal(phaseText('checking'), 'Checking the result…')
    assert.equal(phaseText('writing'), 'Writing files…')
    assert.equal(phaseText('installing'), 'Running install…')
    assert.equal(phaseText('rescanning'), 'Rescanning the root…')
  })

  it('has a neutral text before the first phase', () => {
    assert.equal(phaseText(undefined), 'Working…')
  })

  it('counts the lines of the job log', () => {
    assert.equal(jobLogSummary(0), 'Log · 0 lines')
    assert.equal(jobLogSummary(1), 'Log · 1 line')
    assert.equal(jobLogSummary(1200), 'Log · 1,200 lines')
    assert.equal(NO_OUTPUT_YET, 'No output yet.')
    assert.equal(RUNNING_JOB, 'Running job')
    assert.equal(LAST_JOB, 'Last job')
  })
})

describe('preview and apply dialog texts', () => {
  it('names the parts of a preview', () => {
    assert.deepEqual(PREVIEW_PARTS, { title: 'Preview', goals: 'Goals', newIssues: 'New issues', warnings: 'Warnings', files: 'Files' })
    assert.equal(NONE, 'None')
    assert.equal(packageChangesHeading(3), 'Package changes (3)')
    assert.equal(packageChangesHeading(1200), 'Package changes (1,200)')
    assert.equal(notCheckedText('offline'), 'not checked: offline')
  })

  it('names the install command of each package manager and what it runs', () => {
    assert.equal(installCommand('pnpm'), 'pnpm install --frozen-lockfile')
    assert.equal(installCommand('npm'), 'npm ci')
    assert.equal(installNote('pnpm'), 'Runs dependency build scripts that your pnpm settings allow.')
    assert.equal(installNote('npm'), 'npm ci deletes and recreates node_modules and runs install scripts.')
    assert.equal(RUN_INSTALL, 'Run install:')
    assert.equal(APPLY, 'Apply')
  })

  it('asks to apply the counted changes to the root', () => {
    assert.equal(applyTitle(1, 'shop'), 'Apply 1 change to shop?')
    assert.equal(applyTitle(3, 'frontend'), 'Apply 3 changes to frontend?')
  })

  it('counts the unmet goals', () => {
    assert.equal(unmetGoalsHeading(1), '1 goal not met:')
    assert.equal(unmetGoalsHeading(2), '2 goals not met:')
  })

  it('lists the files to write', () => {
    assert.equal(writesSentence([{ path: 'web/package.json' }, { path: 'pnpm-lock.yaml' }]), 'Writes web/package.json, pnpm-lock.yaml exactly as previewed.')
    assert.equal(writesSentence([{ path: 'package-lock.json' }]), 'Writes package-lock.json exactly as previewed.')
  })

  it('marks files that other roots share', () => {
    assert.equal(
      writesSentence([{ path: 'pnpm-lock.yaml' }, { path: '../../npm-package/commerce-ui/package.json', sharedWith: ['npm-package', '.'] }]),
      'Writes pnpm-lock.yaml, ../../npm-package/commerce-ui/package.json (also in npm-package, repository root) exactly as previewed.',
    )
  })

  it('says that install writes outside the root', () => {
    assert.equal(outsideInstallNote(1), 'Install also writes node_modules in 1 workspace package outside the root.')
    assert.equal(outsideInstallNote(10), 'Install also writes node_modules in 10 workspace packages outside the root.')
  })

  it('names the lockfiles that were not updated', () => {
    assert.equal(sharedRootsText([{ id: 'npm-package', manager: 'pnpm' }]), 'Lockfile not updated: npm-package. Run pnpm install there.')
    assert.equal(
      sharedRootsText([{ id: 'npm-package', manager: 'pnpm' }, { id: '.', manager: 'pnpm' }]),
      'Lockfiles not updated: npm-package, repository root. Run pnpm install in each.',
    )
    assert.equal(
      sharedRootsText([{ id: 'npm-package', manager: 'pnpm' }, { id: 'tools', manager: 'npm' }]),
      'Lockfiles not updated: npm-package, tools. Run pnpm install in npm-package and npm install in tools.',
    )
  })

  it('appends the lockfiles that were not updated to a finished apply', () => {
    assert.equal(
      finishedJobText(finishedJob({ kind: 'apply', state: 'done', result: { goalsMet: 1, install: 'not-run', sharedRoots: [{ id: 'libs', manager: 'pnpm' }] } }))?.text,
      'Applied to shop-npm. 1 goal met. Lockfile not updated: libs. Run pnpm install there.',
    )
  })
})

const CHILD_FIX_GOAL: FixGoal = { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: ['GHSA-e2e0-chld-0001'], severity: 'high' }


describe('goalHeading', () => {
  it('lists up to two advisory ids and counts the rest', () => {
    assert.equal(goalHeading(CHILD_FIX_GOAL, 'shop'), 'Fix GHSA-e2e0-chld-0001 in shop')
    assert.equal(goalHeading({ ...CHILD_FIX_GOAL, advisoryIds: ['GHSA-1', 'GHSA-2'] }, 'frontend'), 'Fix GHSA-1, GHSA-2 in frontend')
    assert.equal(goalHeading({ ...CHILD_FIX_GOAL, advisoryIds: ['GHSA-1', 'GHSA-2', 'GHSA-3'] }, 'shop'), 'Fix GHSA-1, GHSA-2, and 1 more in shop')
    assert.equal(goalHeading({ ...CHILD_FIX_GOAL, advisoryIds: ['GHSA-1', 'GHSA-2', 'GHSA-3', 'GHSA-4', 'GHSA-5'] }, 'shop'), 'Fix GHSA-1, GHSA-2, and 3 more in shop')
  })

  it('names the package when the goal has no advisory id', () => {
    assert.equal(goalHeading({ ...CHILD_FIX_GOAL, advisoryIds: [] }, 'shop'), 'Fix child-lib 1.0.0 in shop')
  })
})

const TOOLKIT_UPDATE_GOAL: UpdateGoal = { kind: 'update', name: 'toolkit', importers: ['importer:web', 'importer:api'], target: '3.0.0' }

describe('goalLine', () => {
  it('names the package of a met fix goal', () => {
    assert.equal(goalLine(CHILD_FIX_GOAL, 'no affected version left (1.0.1)', true), 'child-lib: no affected version left (1.0.1)')
  })

  it('suggests the next step for an unmet fix goal', () => {
    assert.equal(
      goalLine({ ...CHILD_FIX_GOAL, name: 'braces', version: '2.3.1' }, '2.3.1 is still required by micromatch 4.0.5', false),
      'braces: 2.3.1 is still required by micromatch 4.0.5 → use an override or add a step',
    )
  })

  it('uses the detail of an update goal as it is', () => {
    assert.equal(goalLine(TOOLKIT_UPDATE_GOAL, 'toolkit 3.0.0 in web and api', true), 'toolkit 3.0.0 in web and api')
    assert.equal(goalLine(TOOLKIT_UPDATE_GOAL, 'web resolves toolkit 2.1.0, below 3.0.0', false), 'web resolves toolkit 2.1.0, below 3.0.0')
  })
})

describe('previewGoalLine', () => {
  it('builds the goal line when the goal is known and falls back to the detail otherwise', () => {
    const entry = { itemId: 'item-1', met: true, detail: 'no affected version left (1.0.1)' }
    assert.equal(previewGoalLine(entry, CHILD_FIX_GOAL), 'child-lib: no affected version left (1.0.1)')
    assert.equal(previewGoalLine(entry, undefined), 'no affected version left (1.0.1)')
  })
})

describe('rootJobText', () => {
  it('describes a running job by its kind', () => {
    assert.equal(rootJobText({ id: 'job-1', kind: 'preview', state: 'running', phase: 'resolving' }), 'previewing…')
    assert.equal(rootJobText({ id: 'job-1', kind: 'apply', state: 'running', phase: 'installing' }), 'installing…')
    assert.equal(rootJobText({ id: 'job-1', kind: 'apply', state: 'running', phase: 'writing' }), 'applying…')
    assert.equal(rootJobText({ id: 'job-1', kind: 'apply', state: 'running', phase: 'rescanning' }), 'applying…')
    assert.equal(rootJobText({ id: 'job-1', kind: 'apply', state: 'running' }), 'applying…')
    assert.equal(rootJobText({ id: 'job-1', kind: 'revert', state: 'running', phase: 'writing' }), 'reverting…')
    assert.equal(rootJobText({ id: 'job-1', kind: 'collect', state: 'running' }), 'adding fixes…')
  })

  it('has no text without a running job', () => {
    assert.equal(rootJobText(undefined), undefined)
    assert.equal(rootJobText({ id: 'job-1', kind: 'preview', state: 'done' }), undefined)
    assert.equal(rootJobText({ id: 'job-1', kind: 'apply', state: 'failed', phase: 'installing' }), undefined)
    assert.equal(rootJobText({ id: 'job-1', kind: 'apply', state: 'cancelled', phase: 'installing' }), undefined)
  })
})

describe('changeCountText', () => {
  it('counts changes', () => {
    assert.equal(changeCountText(1), '1 change')
    assert.equal(changeCountText(3), '3 changes')
    assert.equal(changeCountText(0), '0 changes')
  })
})

describe('followNotice', () => {
  it('says the package was applied after an apply', () => {
    assert.equal(followNotice('apply', 'shop-npm', 'helper', '1.0.0', '1.1.0'), 'Applied in shop-npm: helper 1.0.0 → 1.1.0. Showing the new version.')
  })

  it('says the package was reverted after a revert', () => {
    assert.equal(followNotice('revert', 'shop-npm', 'helper', '1.1.0', '1.0.0'), 'Reverted in shop-npm: helper 1.1.0 → 1.0.0. Showing the new version.')
  })

  it('says the package changed after any other job or without one', () => {
    const changed = 'Changed in shop-npm: helper 1.0.0 → 1.1.0. Showing the new version.'
    assert.equal(followNotice('preview', 'shop-npm', 'helper', '1.0.0', '1.1.0'), changed)
    assert.equal(followNotice('collect', 'shop-npm', 'helper', '1.0.0', '1.1.0'), changed)
    assert.equal(followNotice(undefined, 'shop-npm', 'helper', '1.0.0', '1.1.0'), changed)
  })

  it('names the variants when the version stays and the peer variant changes', () => {
    const from = { position: 1, count: 2, peers: [{ name: 'react', version: '18.2.0' }], suffix: '(react@18.2.0)' }
    const to = { position: 2, count: 2, peers: [{ name: 'react', version: '18.3.1' }], suffix: '(react@18.3.1)' }
    assert.equal(
      followNotice(undefined, 'shop', 'react-dom', '18.3.1', '18.3.1', { from, to }),
      'Changed in shop: react-dom 18.3.1 variant 1 of 2 (react 18.2.0) → variant 2 of 2 (react 18.3.1). Showing the new variant.',
    )
    assert.equal(followNotice(undefined, 'shop', 'react-dom', '18.3.1', '18.3.1'), 'Changed in shop: react-dom 18.3.1 → 18.3.1. Showing the new version.')
    assert.equal(followNotice(undefined, 'shop', 'react-dom', '18.3.0', '18.3.1', { from, to }), 'Changed in shop: react-dom 18.3.0 → 18.3.1. Showing the new version.')
  })

  it('names the repository root', () => {
    assert.equal(followNotice('apply', '.', 'helper', '1.0.0', '1.1.0'), 'Applied in repository root: helper 1.0.0 → 1.1.0. Showing the new version.')
  })
})

describe('duplicateVersionsText', () => {
  const SEMVER: DuplicateEntry = {
    name: 'semver',
    versions: [
      { version: '7.6.3', roots: ['npm-package'] },
      { version: '6.3.1', roots: ['legacy/admin'] },
    ],
  }

  it('lists each version with its roots', () => {
    assert.equal(duplicateVersionsText(SEMVER), '7.6.3 (npm-package); 6.3.1 (legacy/admin)')
  })

  it('names the repository root by its label', () => {
    assert.equal(duplicateVersionsText({ name: 'semver', versions: [{ version: '7.6.3', roots: ['.', 'shop'] }] }), '7.6.3 (repository root, shop)')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-10-25T12:00:00Z')

  function ago(milliseconds: number): string {
    return new Date(now - milliseconds).toISOString()
  }

  it('uses just now, minutes and hours', () => {
    assert.equal(relativeTime('2026-10-25T11:59:30Z', now), 'just now')
    assert.equal(relativeTime('2026-10-25T11:55:00Z', now), '5 minutes ago')
    assert.equal(relativeTime('2026-10-25T09:00:00Z', now), '3 hours ago')
  })

  it('rolls hours over into days, weeks, months and years', () => {
    assert.equal(relativeTime(ago(50 * 3_600_000), now), '2 days ago')
    assert.equal(relativeTime(ago(86_400_000), now), 'yesterday')
    assert.equal(relativeTime(ago(3 * 86_400_000), now), '3 days ago')
    assert.equal(relativeTime(ago(14 * 86_400_000), now), '2 weeks ago')
    assert.equal(relativeTime(ago(61 * 86_400_000), now), '2 months ago')
    assert.equal(relativeTime(ago(800 * 86_400_000), now), '2 years ago')
  })
})

describe('badge texts', () => {
  it('reads the roll-up as how many are vulnerable below, shortened only by the severity', () => {
    assert.equal(vulnerableBelowText(1, 'high'), '1 vulnerable below · high')
    assert.equal(vulnerableBelowShortText(1), '1 vulnerable below')
    assert.equal(vulnerableBelowShortText(1200), '1,200 vulnerable below')
  })

  it('reads an update with its size and explains it in the title', () => {
    assert.equal(updateLabelText('1.1.0', 'minor'), '↑ 1.1.0 minor')
    assert.equal(updateBadgeTitle('minor', '1.0.0', '1.1.0'), 'minor update: 1.0.0 → 1.1.0')
    assert.equal(updateLevelTitle('major'), 'major update')
  })

  it('marks a package that has several versions', () => {
    assert.equal(DUPLICATE_BADGE, 'dup')
    assert.equal(duplicateVersionsLine('7.6.3 (shop); 6.3.1 (docs)'), 'Versions: 7.6.3 (shop); 6.3.1 (docs)')
  })

  it('describes a graph node by its notes, the anchor note included', () => {
    assert.equal(graphNodeDescription([GRAPH_ANCHOR_NOTE, GRAPH_NODE_HINT]), 'Explore is built around this package. Click to select')
    assert.equal(graphNodeDescription([GRAPH_NODE_HINT]), 'Click to select')
  })
})

describe('roots panel texts', () => {
  it('uses the source badge copy', () => {
    assert.deepEqual(SOURCE_LABELS, {
      lockfile: 'lockfile',
      installed: 'installed',
      'resolved-today': 'resolved today',
      'manifest-only': 'manifest only',
    })
  })

  it('says what the panel is loading or found', () => {
    assert.equal(LOADING_ROOTS, 'Loading roots…')
    assert.equal(NO_ROOTS_FOUND, 'No package.json roots were found.')
    assert.equal(RESOLVE_VERSIONS, 'Resolve versions')
    assert.deepEqual(ROOT_STATUS_TEXTS, { scanning: 'scanning', failed: 'failed' })
    assert.equal(rootErrorText('broken lockfile'), 'broken lockfile')
    assert.equal(rootErrorText(undefined), 'Unknown error')
    assert.equal(warningCountText(1), '1 warning')
    assert.equal(warningCountText(3), '3 warnings')
  })

  it('reports the progress and problems of the package checks', () => {
    assert.equal(PACKAGE_CHECKS, 'Package checks')
    assert.equal(REGISTRY_CHECKS, 'Registry checks')
    assert.equal(checkingProgressText(2470, 3980), 'Checking packages: 2,470 of 3,980')
    assert.equal(osvProgressText(1234, 20), 'Vulnerabilities: 1,234 checked, 20 skipped')
    assert.equal(problemLineText('npm.example.com', 'rejected credentials (401)', 37), 'npm.example.com rejected credentials (401) · 37 packages')
    assert.equal(CREDENTIALS_HINT, 'Check the token for this registry in .npmrc.')
  })
})

describe('scan texts', () => {
  it('names the root in every scan state, including the repository root', () => {
    assert.equal(scanningMessage('.'), 'Scanning repository root…')
    assert.equal(stillScanningText('.'), 'repository root is still scanning.')
    assert.equal(notInScanText('app'), 'app is not part of this scan.')
    assert.equal(scanFailedText('app', 'boom'), 'app failed to scan: boom')
    assert.equal(scanFailedText('.', undefined), 'repository root failed to scan: unknown error')
  })

  it('explains what the app could not do', () => {
    assert.equal(SESSION_REJECTED, 'The session token was rejected. Open the URL that deptrail printed in the terminal.')
    assert.equal(RESCAN_DID_NOT_FINISH, 'Rescan did not finish. Check the terminal for errors.')
    assert.equal(switchedToText('.'), 'Switched to repository root')
    assert.equal(scanLoadFailedText('boom'), 'Could not load the scan: boom')
    assert.equal(resolveFailedText('.', 'boom'), 'Could not start resolving versions for repository root: boom')
    assert.equal(rescanFailedText('boom'), 'Could not start a rescan: boom')
    assert.equal(refreshChecksFailedText('boom'), 'Could not refresh the package checks: boom')
    assert.equal(requestFailedText(502), 'Request failed with status 502')
    assert.equal(badgesLoadFailedText('boom'), 'Could not load the vulnerability and update badges: boom')
    assert.equal(duplicatesLoadFailedText('boom'), 'Could not load the duplicates: boom')
    assert.equal(detailsLoadFailedText('boom'), 'Could not load details: boom')
  })
})

describe('search texts', () => {
  it('names the search box, its results and its shortcut', () => {
    assert.equal(PRODUCT_NAME, 'deptrail')
    assert.equal(SEARCH_PACKAGES, 'Search packages')
    assert.equal(SEARCH_PLACEHOLDER, 'Search packages or name@range')
    assert.equal(SEARCH_RESULTS, 'Search results')
    assert.equal(searchShortcutHint(true), '⌘K')
    assert.equal(searchShortcutHint(false), 'Ctrl+K')
  })

  it('says what the search is doing or found', () => {
    assert.equal(SEARCHING, 'Searching…')
    assert.equal(searchFailedText('boom'), 'Search failed: boom')
    assert.equal(noSearchMatchText('lodash'), 'No packages match “lodash”')
  })

  it('names an option by package, version, root and peer variant', () => {
    assert.equal(searchOptionName('react-dom', '18.2.0', '.', 'variant 1 of 2 (react 18.2.0)'), 'react-dom 18.2.0 in repository root, variant 1 of 2 (react 18.2.0)')
    assert.equal(searchOptionName('helper', '1.0.0', 'shop', ''), 'helper 1.0.0 in shop')
  })
})

describe('Explore view texts', () => {
  it('marks tree rows', () => {
    assert.equal(SHOWN_ABOVE, 'shown above')
    assert.equal(FAILED_TO_LOAD, 'failed to load')
    assert.equal(NO_DUPLICATES_BELOW_ROW, 'No duplicated packages below this row.')
    assert.equal(expandName('web'), 'Expand web')
    assert.equal(collapseName('web'), 'Collapse web')
  })

  it('names the graph and its stubs with readable package labels', () => {
    assert.equal(GRAPH_LABEL, 'Dependency graph')
    assert.equal(hiddenPathsText(1), '+1 path')
    assert.equal(hiddenPathsText(2), '+2 paths')
    assert.equal(stubName('up', '+2 paths', 'helper 1.0.0'), 'Show +2 paths above helper 1.0.0')
    assert.equal(stubName('down', '+1 path', 'repository root'), 'Show +1 path below repository root')
    assert.equal(stubTitle('up', '+2 paths'), '+2 paths: click to show one more level up')
    assert.equal(stubTitle('down', '+1 path'), '+1 path: click to show one more level down')
  })

  it('says when the graph shows only part of the root', () => {
    assert.equal(wholeRootLimitText(4000, 300), 'Showing 300 of 4,000 nodes. Narrow the scope to see all nodes.')
    assert.equal(truncatedGraphText(1200), 'Showing the first 1,200 nodes. Reduce the depth to see a complete graph.')
  })

  it('names the package in load failures by its label, never its node id', () => {
    assert.equal(graphLoadFailedText('helper 1.0.0', 'boom'), 'Could not load the graph of helper 1.0.0: boom')
    assert.equal(dependentsLoadFailedText('helper 1.0.0', 'boom'), 'Could not load the dependents of helper 1.0.0: boom')
    assert.equal(dependenciesLoadFailedText('repository root', 'boom'), 'Could not load the dependencies of repository root: boom')
    assert.equal(dependenciesLoadFailedText('helper 1.0.0', undefined), 'Could not load the dependencies of helper 1.0.0: unknown error')
  })
})

describe('details panel texts', () => {
  it('names the panel and its notice button', () => {
    assert.equal(PACKAGE_DETAILS, 'Package details')
    assert.equal(DISMISS, 'Dismiss')
  })

  it('says where a missing package went', () => {
    assert.equal(noLongerInRootText('helper 1.0.0', '.'), 'helper 1.0.0 is no longer in repository root.')
    assert.equal(notInRootSentence('helper 1.0.0', 'shop'), 'helper 1.0.0 is not in shop.')
    assert.equal(notInAnyRootText('helper'), 'helper is not in any root.')
    assert.equal(openInRootText('shop'), 'Open in shop')
    assert.equal(openVariantInRootText('helper 1.1.0', 'repository root'), 'Open helper 1.1.0 in repository root')
  })
})

describe('preview file texts', () => {
  it('marks a new file and explains the diff state', () => {
    assert.equal(NEW_FILE, 'new file')
    assert.equal(LOADING_DIFF, 'Loading diff…')
    assert.equal(DIFF_TRUNCATED, 'Showing the first 2 MB of the diff.')
    assert.equal(diffLoadFailedText('boom'), 'Could not load the diff: boom')
  })
})

describe('retired words', () => {
  const RETIRED = /monolith|wanted|importer:|Outdated direct|change set|\b\d+ below\b|^Focus$/

  function wordsOf(value: unknown): string[] {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(wordsOf)
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(wordsOf)
    return []
  }

  it('never appear in an exported word', () => {
    const words = Object.values(vocabulary).flatMap(wordsOf)
    assert.ok(words.length > 100)
    assert.deepEqual(words.filter((word) => RETIRED.test(word)), [])
  })

  it('never appear in the badge texts', () => {
    const texts = [vulnerableBelowText(1, 'high'), vulnerableBelowShortText(1), updateLabelText('1.1.0', 'minor'), updateBadgeTitle('minor', '1.0.0', '1.1.0')]
    assert.deepEqual(texts.filter((text) => RETIRED.test(text)), [])
  })
})

describe('peerVariantText', () => {
  it('numbers the variant and lists at most two of the peers that tell it apart', () => {
    assert.equal(peerVariantText({ position: 2, count: 3, peers: [], suffix: '(0b3c96a5f311dc6b591f670b3b7dbfa4)' }), 'variant 2 of 3')
    assert.equal(
      peerVariantText({ position: 2, count: 2, peers: [{ name: 'confbox', version: '0.2.4' }, { name: 'srvx', version: undefined }], suffix: '(confbox@0.2.4)' }),
      'variant 2 of 2 (confbox 0.2.4, no srvx)',
    )
    assert.equal(
      peerVariantText({
        position: 1,
        count: 2,
        peers: [
          { name: 'a', version: '1.0.0' },
          { name: 'b', version: '2.0.0' },
          { name: 'c', version: '3.0.0' },
        ],
        suffix: '(a@1.0.0)(b@2.0.0)(c@3.0.0)',
      }),
      'variant 1 of 2 (a 1.0.0, b 2.0.0 +1 more)',
    )
  })
})

describe('rootNoteText', () => {
  it('prefixes the root label in the all-roots scope', () => {
    assert.equal(rootNoteText('.', 'Waiting for the scan'), 'repository root: Waiting for the scan')
    assert.equal(rootNoteText('tools', 'Waiting for the scan'), 'tools: Waiting for the scan')
  })

  it('gives the bare reason without a root', () => {
    assert.equal(rootNoteText(undefined, 'Waiting for the scan'), 'Waiting for the scan')
  })
})

describe('exploreOptionsLabel', () => {
  it('names only Options while Duplicates only is off', () => {
    assert.equal(exploreOptionsLabel(false), 'Options')
  })

  it('adds Duplicates only while it is on', () => {
    assert.equal(exploreOptionsLabel(true), 'Options · Duplicates only')
  })
})

describe('commit source copy', () => {
  const NOW = Date.parse('2026-10-27T12:00:00.000Z')
  const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'

  it('describes the commit being viewed', () => {
    assert.equal(
      commitNoticeText({ kind: 'commit', ref: 'refs/heads/maintenance/6.1', commit: COMMIT, committedAt: new Date(NOW - 3 * 86_400_000).toISOString() }, NOW),
      'Viewing maintenance/6.1 at abcdef1, committed 3 days ago. Read-only: changes and actions apply to the working tree.',
    )
    assert.equal(
      commitNoticeText({ kind: 'commit', ref: 'HEAD', commit: COMMIT }, NOW),
      'Viewing HEAD at abcdef1. Read-only: changes and actions apply to the working tree.',
    )
    assert.equal(
      commitNoticeText({ kind: 'commit', ref: 'HEAD', commit: COMMIT, skippedSubmodules: ['vendor/sub', 'themes'] }, NOW),
      'Viewing HEAD at abcdef1. Read-only: changes and actions apply to the working tree. Files inside git submodules are not read: vendor/sub, themes.',
    )
  })

  it('names the commit when it has no roots', () => {
    assert.equal(noRootsInText('refs/tags/v1'), 'No roots in v1')
    assert.equal(BACK_TO_WORKING_TREE, 'Back to working tree')
    assert.equal(CHANGES_ON_COMMIT, 'Changes apply to the working tree.')
    assert.equal(RELOAD_BRANCH, 'Reload branch')
  })
})
