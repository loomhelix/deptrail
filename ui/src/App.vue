<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import type { NodeId } from '../../src/model.ts'
import type { IssueKind } from '../../src/query/issues.ts'
import { announce } from './announcer.ts'
import { ApiError, createApi, type RootSummary, type ScanSummary } from './api.ts'
import CenterTabs from './components/CenterTabs.vue'
import CollapsiblePanel from './components/CollapsiblePanel.vue'
import DetailsPanel from './components/DetailsPanel.vue'
import LiveRegion from './components/LiveRegion.vue'
import NoticeBanner from './components/NoticeBanner.vue'
import RootsPanel from './components/RootsPanel.vue'
import SourceNotice from './components/SourceNotice.vue'
import { navigationUrl, SHOWN_SOURCE, shortRef, WORKING_KEY, type ShownSourceState } from './source.ts'
import SelectionPill from './components/SelectionPill.vue'
import TopBar from './components/TopBar.vue'
import {
  clearSelection,
  DEP_KINDS,
  exploreAnchor,
  exploreRoot,
  focusOn,
  followSelectionTo,
  openInRoot,
  openRootChanges,
  openRootIssues,
  openTrail,
  openTree,
  openWorkspacePackage,
  pickSearchOption,
  readContext,
  selectInExplore,
  selectPackage,
  setCompareBase,
  setFilters,
  setMergeBase,
  setMode,
  setScope,
  setView,
  writeContext,
  type ExploreMode,
  type FilterChange,
  type Selection,
  type Transition,
  type UiContext,
  type ViewName,
} from './context.ts'
import { CHANGES_INDEX, useChangesIndex } from './changes-index.ts'
import { useDecorations } from './decorations.ts'
import { useDuplicateNames } from './duplicate-names.ts'
import { useIssueRows } from './issue-rows.ts'
import { restoreFocusIfLost } from './keyboard/lost-focus.ts'
import { useShortcuts } from './keyboard/use-shortcuts.ts'
import { createNodeActionsCache, NODE_ACTIONS_CACHE, nodeActionsRevision } from './node-actions-cache.ts'
import { readPanelState, writePanelState, type PanelState } from './panel-state.ts'
import { rescanProgress, startRescanWait, type PendingRescan } from './rescan-wait.ts'
import { changeCountInScope, rootRevision, scanRevision } from './scan-state.ts'
import ChangesView from './views/ChangesView.vue'
import ExploreView from './views/ExploreView.vue'
import CompareView from './views/CompareView.vue'
import IssuesView from './views/IssuesView.vue'
import {
  DETAILS_HEADING,
  DETAILS_PANEL,
  DETAILS_PANEL_SHORTCUT,
  PACKAGE_DETAILS,
  ROOTS_HEADING,
  ROOTS_PANEL,
  refreshChecksFailedText,
  RESCAN_DID_NOT_FINISH,
  rescanFailedText,
  resolveFailedText,
  ROOTS_PANEL_SHORTCUT,
  scanLoadFailedText,
  SESSION_REJECTED,
  switchedToText,
  type HealthLink,
  BACK_TO_WORKING_TREE,
  CHANGES_ON_COMMIT,
} from './vocabulary.ts'

const POLL_INTERVAL_MS = 1000

type FollowedSelection = { selection: Selection; notice: string }
type EditRequest = { root: string; itemId: string; node: NodeId }
type ChangesFocus = { root: string; itemId: string }

function panelStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const api = createApi()
const shown = inject(SHOWN_SOURCE, { source: { kind: 'working' } } satisfies ShownSourceState)
const commitSource = shown.source.kind === 'commit' ? shown.source : undefined
const panels = reactive<PanelState>(readPanelState(panelStorage(), window.innerWidth))
const context = reactive<UiContext>(readContext(window.location.search))
const scan = ref<ScanSummary | null>(null)
const scanError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busyRetries = ref(0)
const followed = ref<FollowedSelection | null>(null)
const versionFocusRequest = ref<Selection | null>(null)
const editing = ref<EditRequest | null>(null)
const changesFocus = ref<ChangesFocus | null>(null)
const topBar = ref<InstanceType<typeof TopBar> | null>(null)
const centerTabs = ref<InstanceType<typeof CenterTabs> | null>(null)
const detailsPanel = ref<InstanceType<typeof DetailsPanel> | null>(null)
const detailsLandmark = ref<InstanceType<typeof CollapsiblePanel> | null>(null)
const exploreView = ref<InstanceType<typeof ExploreView> | null>(null)
let pollTimer: number | undefined
let latestScanRequest = 0
let pendingRescan: PendingRescan | null = null

const { versionsByName: duplicateVersions, error: duplicatesError } = useDuplicateNames(
  api,
  computed(() => scanRevision(scan.value)),
)

const shownRootId = computed(() => exploreRoot(context))
const shownRoot = computed(() => scan.value?.roots.find((root) => root.id === shownRootId.value))
const shownAnchor = computed(() => exploreAnchor(context))
const rootIds = computed(() => (scan.value?.roots ?? []).map((root) => root.id))
const failedRootsInScope = computed(() =>
  (scan.value?.roots ?? []).filter((root) => root.status === 'failed' && (context.root === undefined || root.id === context.root)).map((root) => root.id),
)
const changeCount = computed(() => (scan.value === null ? undefined : changeCountInScope(scan.value.roots, context.root)))
function rootRevisionOf(root: RootSummary | undefined): string {
  return `${rootRevision(scan.value?.scannedAt, root)}\n${busyRetries.value}`
}

const shownRootRevision = computed(() => rootRevisionOf(shownRoot.value))
const rootRevisions = computed<ReadonlyMap<string, string>>(() => new Map((scan.value?.roots ?? []).map((root) => [root.id, rootRevisionOf(root)])))
const selectionRoot = computed(() => scan.value?.roots.find((root) => root.id === context.selection?.root))
const selectionRootRevision = computed(() => rootRevisionOf(selectionRoot.value))
const enrichmentRevision = computed(() => scan.value?.enrichment.revision ?? 0)
const rowActionsRevisions = computed<ReadonlyMap<string, string>>(
  () => new Map((scan.value?.roots ?? []).map((root) => [root.id, nodeActionsRevision(rootRevisionOf(root), enrichmentRevision.value)])),
)
const unavailableRoots = computed<ReadonlyMap<string, string>>(
  () =>
    new Map(
      (scan.value?.roots ?? []).flatMap((root): [string, string][] =>
        !root.actions.available && root.actions.reason !== undefined ? [[root.id, root.actions.reason]] : [],
      ),
    ),
)
const decorationsRevision = computed(() => `${shownRootRevision.value}\n${enrichmentRevision.value}`)
const { nodes: decorations, loadedRoot: decorationsRoot, error: decorationsError } = useDecorations(
  api,
  shownRootId,
  computed(() => context.kinds),
  decorationsRevision,
)
const issuesRevision = computed(() => {
  if (scan.value === null) return undefined
  return context.root !== undefined ? decorationsRevision.value : `${scanRevision(scan.value) ?? ''}\n${enrichmentRevision.value}`
})
const { rows: issueRows, count: issueCount, error: issueRowsError } = useIssueRows(
  api,
  computed(() => context.root),
  computed(() => context.kinds),
  issuesRevision,
)
const changesIndex = useChangesIndex(
  api,
  computed(() => scan.value?.roots ?? []),
  computed(() => `${scanRevision(scan.value) ?? ''}\n${busyRetries.value}`),
)
provide(NODE_ACTIONS_CACHE, createNodeActionsCache(api))
provide(CHANGES_INDEX, changesIndex)
const notices = computed(() => [shown.notice ?? null, actionError.value, scanError.value, decorationsError.value].filter((message) => message !== null))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assignContext(next: UiContext): void {
  for (const key of Object.keys(context)) {
    if (!(key in next)) Reflect.deleteProperty(context, key)
  }
  Object.assign(context, next)
}

function run(transition: Transition): void {
  assignContext(transition.context)
  const url = `${window.location.pathname}${writeContext(context)}`
  const isNewEntry = transition.history === 'push' && url !== `${window.location.pathname}${window.location.search}`
  if (isNewEntry) window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
}

function restoreFromUrl(): void {
  assignContext(readContext(window.location.search))
}

function select(selection: Selection): void {
  run(selectPackage(context, selection))
}

function selectInExploreView(selection: Selection): void {
  run(selectInExplore(context, selection))
}

function isSameSelection(left: Selection, right: Selection | undefined): boolean {
  return right !== undefined && left.root === right.root && left.node === right.node
}

function followSelection(selection: Selection, notice: string): void {
  run(followSelectionTo(context, selection))
  followed.value = { selection, notice }
  announce(notice)
}

function chooseVersion(selection: Selection): void {
  run(followSelectionTo(context, selection))
}

function dismissFollowNotice(): void {
  followed.value = null
}

function dismissFollowNoticeOnRequest(): void {
  detailsLandmark.value?.focusLandmark()
  dismissFollowNotice()
}

function openSelectionInRoot(selection: Selection): void {
  run(openInRoot(context, selection))
}

watch(
  () => context.selection,
  (selection) => {
    if (followed.value !== null && !isSameSelection(followed.value.selection, selection)) dismissFollowNotice()
    if (versionFocusRequest.value !== null && !isSameSelection(versionFocusRequest.value, selection)) versionFocusRequest.value = null
    if (editing.value !== null && !isSameSelection(editing.value, selection)) editing.value = null
  },
)

watch(
  () => context.view,
  (view) => {
    if (view !== 'changes') changesFocus.value = null
  },
)

function updateFromIssues(selection: Selection): void {
  run(selectPackage(context, selection))
  panels.detailsCollapsed = false
  versionFocusRequest.value = selection
}

function finishVersionFocus(): void {
  versionFocusRequest.value = null
}

function pickSearchResult(selection: Selection): void {
  const transition = pickSearchOption(context, selection)
  run(transition)
  if (transition.switchedTo !== undefined) announce(switchedToText(transition.switchedTo))
}

function openWorkspace(selection: Selection): void {
  run(openWorkspacePackage(context, selection))
}

function openIssuesOfRoot(root: string, kind: IssueKind): void {
  run(openRootIssues(context, root, kind))
}

function openChangesOfRoot(root: string): void {
  run(openRootChanges(context, root))
}

function healthLinkTarget(root: string, kind: HealthLink['kind']): Transition {
  return kind === 'changes' ? openRootChanges(context, root) : openRootIssues(context, root, kind)
}

function healthLinkHref(root: string, kind: HealthLink['kind']): string {
  return `${window.location.pathname}${writeContext(healthLinkTarget(root, kind).context)}`
}

function changeScope(root: string | undefined): void {
  run(setScope(context, root))
}

function showView(view: ViewName): void {
  run(setView(context, view))
}

function showMode(mode: ExploreMode): void {
  run(setMode(context, mode))
}

async function focusExploreTitle(): Promise<void> {
  await nextTick()
  exploreView.value?.focusTitle()
}

function showTrail(): void {
  run(openTrail(context))
  void focusExploreTitle()
}

function showTree(): void {
  run(openTree(context))
  void focusExploreTitle()
}

function focusOnSelection(): void {
  run(focusOn(context))
}

async function keepFocusOnTabs(): Promise<void> {
  await restoreFocusIfLost(document, () => centerTabs.value?.focusSelectedTab())
}

function showViewFromKeyboard(view: ViewName): void {
  showView(view)
  void keepFocusOnTabs()
}

function reviewChange(root: string, itemId: string): void {
  run(setView(context, 'changes'))
  changesFocus.value = { root, itemId }
  void keepFocusOnTabs()
}

function reviewChangesOfRoot(root: string): void {
  const firstItem = changesIndex.index.value.get(root)?.[0]
  if (firstItem !== undefined) {
    reviewChange(root, firstItem.id)
    return
  }
  run(setView(context, 'changes'))
  void keepFocusOnTabs()
}

function changesHref(): string {
  return `${window.location.pathname}${writeContext(setView(context, 'changes').context)}`
}

function finishChangesFocus(): void {
  changesFocus.value = null
}

async function editChange(selection: Selection, itemId: string): Promise<void> {
  editing.value = { root: selection.root, itemId, node: selection.node }
  run(selectPackage(context, selection))
  panels.detailsCollapsed = false
  await nextTick()
  detailsPanel.value?.focusWhatToDo()
}

function clearSelectedPackage(): void {
  run(clearSelection(context))
  void keepFocusOnTabs()
}

useShortcuts({
  search: () => topBar.value?.focusSearch(),
  'toggle-roots': () => {
    panels.rootsCollapsed = !panels.rootsCollapsed
  },
  'toggle-details': () => {
    panels.detailsCollapsed = !panels.detailsCollapsed
  },
  'view-issues': () => showViewFromKeyboard('issues'),
  'view-changes': () => showViewFromKeyboard('changes'),
  'view-explore': () => showViewFromKeyboard('explore'),
  'view-compare': () => showViewFromKeyboard('compare'),
  help: () => topBar.value?.openShortcuts(),
  escape: () => topBar.value?.dismissPopups() ?? false,
})

function changeFilters(change: FilterChange): void {
  run(setFilters(context, change))
}

function showAllKinds(): void {
  changeFilters({ kinds: [...DEP_KINDS] })
}

function isScanSettling(): boolean {
  const current = scan.value
  if (current === null || pendingRescan !== null) return true
  return (
    current.roots.some((root) => root.status === 'scanning' || root.actions.job?.state === 'running') || current.enrichment.state === 'running'
  )
}

function settlePendingRescan(): void {
  if (pendingRescan === null) return
  const progress = rescanProgress(pendingRescan, scan.value?.scannedAt, Date.now())
  if (progress === 'waiting') return
  pendingRescan = null
  if (progress === 'timed-out') actionError.value = RESCAN_DID_NOT_FINISH
}

async function refreshScan(): Promise<void> {
  window.clearTimeout(pollTimer)
  const request = ++latestScanRequest
  try {
    const next = await api.scan()
    if (request !== latestScanRequest) return
    scan.value = next
    scanError.value = null
  } catch (error) {
    if (request !== latestScanRequest) return
    if (error instanceof ApiError && error.status === 401) {
      scanError.value = SESSION_REJECTED
      return
    }
    scanError.value = scanLoadFailedText(messageOf(error))
  }
  settlePendingRescan()
  if (isScanSettling()) pollTimer = window.setTimeout(refreshScan, POLL_INTERVAL_MS)
}

async function refreshAfterRootBusy(): Promise<void> {
  await refreshScan()
  busyRetries.value += 1
}

async function buildMoreAccurately(rootId: string): Promise<void> {
  actionError.value = null
  try {
    await api.resolve(rootId)
  } catch (error) {
    actionError.value = resolveFailedText(rootId, messageOf(error))
    return
  }
  await refreshScan()
}

async function rescan(): Promise<void> {
  actionError.value = null
  const previousScan = scan.value?.scannedAt ?? null
  try {
    await api.rescan()
  } catch (error) {
    actionError.value = rescanFailedText(messageOf(error))
    return
  }
  pendingRescan = startRescanWait(previousScan, Date.now())
  await refreshScan()
}

async function refreshEnrichment(): Promise<void> {
  actionError.value = null
  try {
    await api.refreshEnrichment()
  } catch (error) {
    actionError.value = refreshChecksFailedText(messageOf(error))
    return
  }
  await refreshScan()
}

watch(panels, (state) => writePanelState(panelStorage(), state))

function backToWorkingTree(): void {
  window.location.assign(navigationUrl(window.location.pathname, window.location.search, { ref: null }))
}

function swapCompareSides(base: string): void {
  const ref = base === WORKING_KEY ? null : base
  window.location.assign(navigationUrl(window.location.pathname, window.location.search, { ref, base: commitSource?.ref ?? WORKING_KEY }))
}

onMounted(() => {
  window.addEventListener('popstate', restoreFromUrl)
  if (commitSource) document.title = `${shortRef(commitSource.ref)} · ${document.title}`
  void refreshScan()
})

onBeforeUnmount(() => {
  window.removeEventListener('popstate', restoreFromUrl)
  window.clearTimeout(pollTimer)
})
</script>

<template>
  <div class="shell" :class="{ 'shell--roots-collapsed': panels.rootsCollapsed, 'shell--details-collapsed': panels.detailsCollapsed }">
    <LiveRegion />
    <TopBar
      ref="topBar"
      class="shell__top"
      :repo-path="scan?.repoPath"
      :scope="context.root"
      :roots="scan?.roots ?? []"
      :kinds="context.kinds"
      :enrichment="scan?.enrichment"
      @pick="pickSearchResult"
      @choose-root="changeScope"
      @show-all-kinds="showAllKinds"
      @rescan="rescan"
      @check-again="refreshEnrichment"
    />
    <CollapsiblePanel
      v-model:collapsed="panels.rootsCollapsed"
      class="shell__roots"
      side="left"
      landmark="nav"
      :landmark-label="ROOTS_HEADING"
      :label="ROOTS_PANEL"
      :shortcut="ROOTS_PANEL_SHORTCUT"
    >
      <template #header>
        <h2 class="panel-heading">{{ ROOTS_HEADING }}</h2>
      </template>
      <RootsPanel
        :scan="scan"
        :scan-failed="scanError !== null"
        :scope="context.root"
        :selection="context.selection"
        :health-link-href="healthLinkHref"
        @choose-root="changeScope"
        @open-workspace-package="openWorkspace"
        @open-issues="openIssuesOfRoot"
        @open-changes="openChangesOfRoot"
        @resolve="buildMoreAccurately"
      />
    </CollapsiblePanel>
    <main class="shell__center">
      <SourceNotice v-if="commitSource" :source="commitSource" @back="backToWorkingTree" />
      <NoticeBanner :messages="notices" />
      <CenterTabs
        ref="centerTabs"
        :view="context.view"
        :scope="context.root"
        :issue-count="issueCount"
        :change-count="commitSource ? undefined : changeCount"
        @view-change="showView"
      >
        <template #end>
          <SelectionPill v-if="context.selection" :selection="context.selection" @clear="clearSelectedPackage" />
        </template>
        <IssuesView
          v-if="context.view === 'issues'"
          :root="context.root"
          :selection="context.selection"
          :group="context.group"
          :types="context.types"
          :kinds="context.kinds"
          :revision="issuesRevision ?? ''"
          :rows="issueRows"
          :rows-error="issueRowsError ?? undefined"
          :actions-revisions="rowActionsRevisions"
          :unavailable-roots="unavailableRoots"
          :status="scan?.enrichment"
          :failed-roots="failedRootsInScope"
          :changes-href="changesHref"
          @select="select"
          @update="updateFromIssues"
          @review="reviewChange"
          @review-changes="reviewChangesOfRoot"
          @change="changeFilters"
          @changes-updated="refreshScan"
        />
        <div v-else-if="context.view === 'changes' && commitSource" class="commit-changes">
          <p class="commit-changes__text">{{ CHANGES_ON_COMMIT }}</p>
          <button type="button" class="button" @click="backToWorkingTree">{{ BACK_TO_WORKING_TREE }}</button>
        </div>
        <ChangesView
          v-else-if="context.view === 'changes'"
          :scope="context.root"
          :roots="scan?.roots ?? []"
          :scan-loaded="scan !== null"
          :revisions="rootRevisions"
          :focus="changesFocus ?? undefined"
          @changed="refreshScan"
          @edit="editChange"
          @item-focused="finishChangesFocus"
        />
        <ExploreView
          v-else-if="context.view === 'explore'"
          ref="exploreView"
          :mode="context.mode"
          :root="shownRootId"
          :roots="rootIds"
          :root-summary="shownRoot"
          :scan-loaded="scan !== null"
          :revision="shownRootRevision"
          :anchor="shownAnchor"
          :selected="context.selection?.node"
          :kinds="context.kinds"
          :duplicates-only="context.duplicatesOnly"
          :duplicate-versions="duplicateVersions"
          :duplicates-error="duplicatesError"
          :decorations="decorations"
          :up="context.up"
          :down="context.down"
          @mode-change="showMode"
          @select="selectInExploreView"
          @focus-on="focusOnSelection"
          @filters-change="changeFilters"
          @choose-root="changeScope"
          @root-busy="refreshAfterRootBusy"
        />
        <CompareView
          v-else-if="context.view === 'compare'"
          :scope="context.root"
          :base="context.base"
          :merge-base="context.mergeBase"
          :enrichment-revision="enrichmentRevision"
          @change-base="(base) => run(setCompareBase(context, base))"
          @change-merge-base="(mergeBase) => run(setMergeBase(context, mergeBase))"
          @swap="swapCompareSides"
          @select="(root, node) => select({ root, node })"
        />
      </CenterTabs>
    </main>
    <CollapsiblePanel
      ref="detailsLandmark"
      v-model:collapsed="panels.detailsCollapsed"
      class="shell__details"
      side="right"
      landmark="aside"
      :landmark-label="PACKAGE_DETAILS"
      focusable
      :label="DETAILS_PANEL"
      :shortcut="DETAILS_PANEL_SHORTCUT"
    >
      <template #header>
        <h2 class="panel-heading">{{ DETAILS_HEADING }}</h2>
      </template>
      <DetailsPanel
        ref="detailsPanel"
        :selection="context.selection"
        :scope="context.root"
        :roots="scan?.roots ?? []"
        :scan-loaded="scan !== null"
        :revision="selectionRootRevision"
        :kinds="context.kinds"
        :decorations="decorations"
        :decorations-root="decorationsRoot"
        :enrichment-revision="enrichmentRevision"
        :status="scan?.enrichment"
        :issue-rows="issueRows"
        :issue-rows-error="issueRowsError ?? undefined"
        :health-link-href="healthLinkHref"
        :notice="followed?.notice"
        :version-focus="versionFocusRequest ?? undefined"
        :editing="editing ?? undefined"
        @select="select"
        @changed="refreshScan"
        @follow="followSelection"
        @choose="chooseVersion"
        @open-in-root="openSelectionInRoot"
        @open-trail="showTrail"
        @open-tree="showTree"
        @open-issues="openIssuesOfRoot"
        @open-changes="openChangesOfRoot"
        @dismiss-notice="dismissFollowNoticeOnRequest"
        @version-focused="finishVersionFocus"
        @review="reviewChange"
      />
    </CollapsiblePanel>
  </div>
</template>

<style>
:root {
  color-scheme: light dark;
  --surface: #ffffff;
  --surface-panel: #f1f3f6;
  --surface-raised: #ffffff;
  --surface-hover: rgba(31, 35, 40, 0.06);
  --surface-selected: #dbe6f9;
  --border: #d9dee4;
  --border-strong: #b9c0c9;
  --text: #1f2328;
  --text-muted: #525a63;
  --text-faint: #5f6770;
  --accent: #2560c4;
  --accent-text: #ffffff;
  --danger: #b8342a;
  --badge-neutral-bg: #eceff2;
  --badge-neutral-fg: #424a53;
  --badge-ok-bg: #e2f2e7;
  --badge-ok-fg: #1d6537;
  --badge-info-bg: #e2ebf9;
  --badge-info-fg: #1c4b93;
  --badge-warn-bg: #faefd6;
  --badge-warn-fg: #6f4b00;
  --badge-danger-bg: #fae3e1;
  --badge-danger-fg: #962a21;
  --source-commit-bg: #faefd6;
  --source-commit-border: #b07d12;
  --source-commit-fg: #5c3e00;
  --workspace-bg: #efe7fb;
  --workspace-fg: #5b3aa6;
  --workspace-border: #8f6fd1;
  --font-ui: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  --radius: 4px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface: #141619;
    --surface-panel: #1d2024;
    --surface-raised: #252a30;
    --surface-hover: rgba(255, 255, 255, 0.07);
    --surface-selected: #243858;
    --border: #31363d;
    --border-strong: #464d56;
    --text: #e6e9ec;
    --text-muted: #a8b0ba;
    --text-faint: #8e97a1;
    --accent: #78a8f4;
    --accent-text: #0e1116;
    --danger: #f08a80;
    --badge-neutral-bg: #2a2f35;
    --badge-neutral-fg: #c2c8cf;
    --badge-ok-bg: #1c3425;
    --badge-ok-fg: #8fd3a5;
    --badge-info-bg: #1d2e47;
    --badge-info-fg: #9fc1f3;
    --badge-warn-bg: #382d14;
    --badge-warn-fg: #edc474;
    --badge-danger-bg: #41201d;
    --badge-danger-fg: #f3a49c;
    --source-commit-bg: #382d14;
    --source-commit-border: #c99a3a;
    --source-commit-fg: #f2d08a;
    --workspace-bg: #2c2442;
    --workspace-fg: #c9b3f4;
    --workspace-border: #937bd3;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
  margin: 0;
}

body {
  background: var(--surface);
  color: var(--text);
  font: 14px/1.5 var(--font-ui);
  -webkit-font-smoothing: antialiased;
}

button,
input {
  font: inherit;
  color: inherit;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

summary {
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

.summary-chevron {
  margin: -2px 4px 0 0;
  color: var(--text-muted);
}

details[open] > summary > .summary-chevron {
  transform: rotate(90deg);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
  font-size: 13px;
}

.muted {
  color: var(--text-muted);
}

.panel-heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  background: var(--badge-neutral-bg);
  color: var(--badge-neutral-fg);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.badge--ok {
  background: var(--badge-ok-bg);
  color: var(--badge-ok-fg);
}

.badge--info {
  background: var(--badge-info-bg);
  color: var(--badge-info-fg);
}

.badge--warn {
  background: var(--badge-warn-bg);
  color: var(--badge-warn-fg);
}

.badge--danger {
  background: var(--badge-danger-bg);
  color: var(--badge-danger-fg);
}

.badge--outline {
  border: 1px solid currentColor;
  background: transparent;
}

.button {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  cursor: pointer;
  white-space: nowrap;
}

.button:hover:not(:disabled) {
  background: var(--surface-hover);
}

.button:disabled {
  cursor: default;
  opacity: 0.55;
}

.button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-text);
}

.button--primary:hover:not(:disabled) {
  background: var(--accent);
  filter: brightness(1.08);
}

.shell {
  --roots-width: 304px;
  --details-width: 400px;
  --details-height: minmax(0, 1fr);
  display: grid;
  height: 100vh;
  grid-template-columns: var(--roots-width) minmax(0, 1fr) var(--details-width);
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas:
    'top top top'
    'roots center details';
}

.shell__top {
  grid-area: top;
}

.shell__roots {
  grid-area: roots;
}

.shell__center {
  display: flex;
  flex-direction: column;
  grid-area: center;
  min-width: 0;
  min-height: 0;
}

.shell__details {
  grid-area: details;
}

@media (max-width: 1366px) {
  .shell {
    --roots-width: 264px;
    --details-width: 340px;
  }
}

@media (max-width: 820px) {
  .shell {
    --roots-width: 240px;
    grid-template-columns: var(--roots-width) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) var(--details-height);
    grid-template-areas:
      'top top'
      'roots center'
      'roots details';
  }
}

.shell.shell--roots-collapsed {
  --roots-width: 36px;
}

.shell.shell--details-collapsed {
  --details-width: 36px;
  --details-height: 48px;
}

.commit-changes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 24px;
  white-space: normal;
}

.commit-changes__text {
  margin: 0;
}
</style>
