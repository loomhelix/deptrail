<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import type { DepKind, NodeId } from '../../../src/model.ts'
import type { IssueKind, IssueRow } from '../../../src/query/issues.ts'
import { createApi, type DependentsResult, type PackageInsight, type RootSummary, type SearchHit } from '../api.ts'
import { CHANGES_INDEX, type ChangesByRoot } from '../changes-index.ts'
import type { Selection } from '../context.ts'
import type { NodeDecorations } from '../decorations.ts'
import {
  finishedJobOf,
  followLinkAction,
  followLinks,
  followOutcome,
  jobBehindChange,
  missingSelectionText,
  movedVariants,
  shouldFollow,
  type FollowLink,
  type MissingOutcome,
} from '../follow-selection.ts'
import { checksFinishedWithoutFailures } from '../issues-model.ts'
import { nodeActionsRevision } from '../node-actions-cache.ts'
import { packageNameOf, versionOf } from '../node-id.ts'
import { isMissingNode } from '../scan-state.ts'
import {
  detailsLoadFailedText,
  DISMISS,
  followNotice,
  LOADING,
  LOADING_SCAN,
  notInScanText,
  packageChecksFailedText,
  scanFailedText,
  stillScanningText,
  type HealthLink,
} from '../vocabulary.ts'
import { alsoInRoots, checkNotices, headerLabels, variantInRoot, whyHereOf } from '../why-here.ts'
import AdvisoryList from './AdvisoryList.vue'
import AppIcon from './AppIcon.vue'
import DetailsMore from './DetailsMore.vue'
import PackageHeader from './PackageHeader.vue'
import ScopeSummary from './ScopeSummary.vue'
import VulnerableBelow from './VulnerableBelow.vue'
import WhatToDo from './WhatToDo.vue'
import WhyHere from './WhyHere.vue'
import WorkspaceSummary from './WorkspaceSummary.vue'

const props = defineProps<{
  selection?: Selection
  scope?: string
  roots: readonly RootSummary[]
  scanLoaded: boolean
  revision: string
  kinds: DepKind[]
  decorations: NodeDecorations
  decorationsRoot?: string
  enrichmentRevision: number
  status?: EnrichmentStatus
  issueRows: readonly IssueRow[] | null
  issueRowsError?: string
  healthLinkHref: (root: string, kind: HealthLink['kind']) => string
  editing?: { root: string; itemId: string }
  notice?: string
  versionFocus?: Selection
}>()

const emit = defineEmits<{
  select: [selection: Selection]
  changed: []
  follow: [selection: Selection, notice: string]
  choose: [selection: Selection]
  'open-in-root': [selection: Selection]
  'open-trail': []
  'open-tree': []
  'open-issues': [root: string, kind: IssueKind]
  'open-changes': [root: string]
  'dismiss-notice': []
  'version-focused': []
  review: [root: string, itemId: string]
}>()

type LoadedDetails = { rootId: string; revision: string; dependents: DependentsResult; finishedJob: string | null }
type InsightState = { rootId: string; focus: NodeId; revision: string; insight: PackageInsight | null; error: string | null; loadedAt: number }
type HitsState = { rootId: string; focus: NodeId; revision: string; hits: SearchHit[] }
type MissingFocus = { rootId: string; focus: NodeId; revision: string }
type FollowState = MissingFocus & { outcome: MissingOutcome | null; error: string | null }

const UPWARD_DEPTH = 50
const NO_CHANGES: ChangesByRoot = new Map()

const api = createApi()
const changesIndex = inject(CHANGES_INDEX, null)
const whatToDo = ref<InstanceType<typeof WhatToDo> | null>(null)
const loaded = ref<LoadedDetails | null>(null)
const hitsState = ref<HitsState | null>(null)
const insightState = ref<InsightState | null>(null)
const focusRequest = ref<Selection | null>(null)
const missingFocus = ref<MissingFocus | null>(null)
const followState = ref<FollowState | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
let latestLoad = 0
let latestInsightLoad = 0

const selectedNode = computed(() => props.selection?.node)
const selectionRoot = computed(() => props.roots.find((root) => root.id === props.selection?.root))
const readyRoot = computed(() => (selectionRoot.value?.status === 'ready' ? selectionRoot.value : undefined))

const blocker = computed<string | null>(() => {
  if (props.selection === undefined) return null
  if (!props.scanLoaded) return LOADING_SCAN
  const root = selectionRoot.value
  if (!root) return notInScanText(props.selection.root)
  if (root.status === 'scanning') return stillScanningText(root.id)
  if (root.status === 'failed') return scanFailedText(root.id, root.error)
  return null
})

function isCurrent(state: { rootId: string; revision: string }, node: NodeId): boolean {
  return state.rootId === readyRoot.value?.id && state.revision === props.revision && node === selectedNode.value
}

const details = computed(() => {
  const current = loaded.value
  return current !== null && isCurrent(current, current.dependents.focus.id) ? current.dependents : null
})
const searchHits = computed(() => {
  const current = hitsState.value
  return current !== null && isCurrent(current, current.focus) ? current.hits : []
})
const insightResult = computed(() => {
  const current = insightState.value
  return current !== null && isCurrent(current, current.focus) ? current : null
})
const missingNode = computed(() => {
  const current = missingFocus.value
  return current !== null && isCurrent(current, current.focus) ? current : null
})
const canFollow = computed(() => shouldFollow(selectionRoot.value))
const waitsToFollow = computed(() => missingNode.value !== null && !canFollow.value)
const followKey = computed(() => {
  const missing = missingNode.value
  return missing !== null && canFollow.value ? [missing.rootId, missing.focus, missing.revision].join('\n') : ''
})
const followResult = computed(() => {
  const current = followState.value
  return current !== null && isCurrent(current, current.focus) ? current : null
})
const followError = computed(() => followResult.value?.error ?? null)
const missingView = computed(() => {
  const outcome = followResult.value?.outcome
  const selection = props.selection
  if (!outcome || !selection) return null
  return { text: missingSelectionText(selection, outcome), links: followLinks(selection, outcome) }
})
const insight = computed(() => insightResult.value?.insight ?? null)

const isPackage = computed(() => {
  const focus = details.value?.focus
  return focus !== undefined && !focus.isImporter && !focus.isPlaceholder
})
const workspacePackage = computed(() => selectionRoot.value?.importers.find((importer) => importer.id === selectedNode.value))
const changesByRoot = computed(() => changesIndex?.index.value ?? NO_CHANGES)
const selectionRootChanges = computed(() => changesByRoot.value.get(props.selection?.root ?? '') ?? [])

const isDirect = computed(() => {
  const focus = details.value?.focus
  return focus !== undefined && (details.value?.summary.via.some((entry) => entry.direct === focus.id) ?? false)
})

const decoration = computed(() => props.decorations[selectedNode.value ?? ''])
const decorationsLoaded = computed(() => props.decorationsRoot !== undefined && props.decorationsRoot === props.selection?.root)
const checksDone = computed(() => checksFinishedWithoutFailures(props.status))
const labels = computed(() =>
  headerLabels(decoration.value, insight.value, { isDirect: isDirect.value, decorationsLoaded: decorationsLoaded.value, checksDone: checksDone.value }),
)
const checkedAt = computed(() => insightResult.value?.loadedAt ?? 0)
const notices = computed(() => (insight.value === null ? [] : checkNotices(insight.value, checkedAt.value)))
const alsoIn = computed(() => {
  const focus = details.value?.focus
  const root = props.selection?.root
  if (focus === undefined || root === undefined) return { roots: [], more: 0 }
  return alsoInRoots(searchHits.value, focus.name, root, focus.version)
})
const variant = computed(() => {
  const focus = details.value?.focus
  const root = props.selection?.root
  return focus === undefined || root === undefined ? undefined : variantInRoot(searchHits.value, focus.name, root, focus.id)
})
const advisories = computed(() => insight.value?.vulnerabilities.items ?? [])
const deprecationMessage = computed(() => insight.value?.registry.deprecated)
const whyHere = computed(() => (details.value ? whyHereOf(insight.value, details.value) : { rows: [], more: 0 }))
const vulnerableBelow = computed(() => decoration.value?.below)
const insightError = computed(() => insightResult.value?.error ?? null)
const actionsRootId = computed(() => (isPackage.value && readyRoot.value !== undefined ? props.selection?.root : undefined))
const actionsRevision = computed(() => nodeActionsRevision(props.revision, props.enrichmentRevision))
const actionsSelection = computed<Selection | undefined>(() => {
  const root = actionsRootId.value
  const focus = details.value?.focus
  return root === undefined || focus === undefined ? undefined : { root, node: focus.id }
})
const whatToDoEditing = computed(() => (props.editing !== undefined && props.editing.root === actionsRootId.value ? props.editing : undefined))
const focusesWhatToDo = computed(() => {
  const request = focusRequest.value
  const target = actionsSelection.value
  return request !== null && target !== undefined && request.root === target.root && request.node === target.node
})

function isSameSelection(left: Selection, right: Selection | undefined): boolean {
  return right !== undefined && left.root === right.root && left.node === right.node
}

function focusWhatToDo(): void {
  if (props.selection !== undefined) focusRequest.value = { ...props.selection }
}

defineExpose({ focusWhatToDo })

function select(node: NodeId): void {
  if (readyRoot.value) emit('select', { root: readyRoot.value.id, node })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markMissing(rootId: string, focus: NodeId, revision: string): void {
  missingFocus.value = { rootId, focus, revision }
}

function finishedJobAtLastLoad(selection: Selection): string | null | undefined {
  const last = loaded.value
  return last !== null && last.rootId === selection.root && last.dependents.focus.id === selection.node ? last.finishedJob : undefined
}

function movedNotice(selection: Selection, moved: { node: NodeId; version: string }, hits: readonly SearchHit[]): string {
  const root = selectionRoot.value
  const jobKind = root === undefined ? undefined : jobBehindChange(root, finishedJobAtLastLoad(selection))
  const name = packageNameOf(selection.node)
  const variants = movedVariants(hits, name, selection.root, selection.node, moved.node)
  return followNotice(jobKind, selection.root, name, versionOf(selection.node), moved.version, variants)
}

async function followMissingNode(key: string, missing: MissingFocus): Promise<void> {
  const selection: Selection = { root: missing.rootId, node: missing.focus }
  try {
    const hits = await api.search(packageNameOf(missing.focus))
    if (followKey.value !== key) return
    const outcome = followOutcome(selection, hits, { wasShownInRoot: finishedJobAtLastLoad(selection) !== undefined })
    if (outcome.kind === 'moved') emit('follow', { root: selection.root, node: outcome.node }, movedNotice(selection, outcome, hits))
    else followState.value = { ...missing, outcome, error: null }
  } catch (error) {
    if (followKey.value !== key) return
    followState.value = { ...missing, outcome: null, error: messageOf(error) }
  }
}

function openLink(link: FollowLink): void {
  const action = followLinkAction(followState.value?.outcome, link)
  if (action === 'open-in-root') emit('open-in-root', link.selection)
  else if (action === 'choose') emit('choose', link.selection)
  else emit('select', link.selection)
}

async function loadHits(request: number, rootId: string, revision: string, focus: DependentsResult['focus']): Promise<void> {
  try {
    const found = await api.search(focus.name)
    if (request !== latestLoad) return
    hitsState.value = { rootId, focus: focus.id, revision, hits: found }
  } catch {
    if (request !== latestLoad) return
    hitsState.value = { rootId, focus: focus.id, revision, hits: [] }
  }
}

async function load(): Promise<void> {
  const request = ++latestLoad
  const root = readyRoot.value
  const node = selectedNode.value
  const revision = props.revision
  const finishedJob = finishedJobOf(root)
  loadError.value = null
  if (!root || node === undefined) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const dependents = await api.dependents(root.id, node, UPWARD_DEPTH, props.kinds)
    if (request !== latestLoad) return
    loaded.value = { rootId: root.id, revision, dependents, finishedJob }
    loading.value = false
    if (!dependents.focus.isImporter && !dependents.focus.isPlaceholder) await loadHits(request, root.id, revision, dependents.focus)
  } catch (error) {
    if (request !== latestLoad) return
    loading.value = false
    if (isMissingNode(error)) markMissing(root.id, node, revision)
    else loadError.value = messageOf(error)
  }
}

async function loadInsight(): Promise<void> {
  const request = ++latestInsightLoad
  const root = readyRoot.value
  const node = selectedNode.value
  const revision = props.revision
  if (!root || node === undefined) return
  try {
    const loadedInsight = await api.insight(root.id, node, props.kinds)
    if (request !== latestInsightLoad) return
    insightState.value = { rootId: root.id, focus: node, revision, insight: loadedInsight, error: null, loadedAt: Date.now() }
  } catch (error) {
    if (request !== latestInsightLoad) return
    if (isMissingNode(error)) markMissing(root.id, node, revision)
    insightState.value = { rootId: root.id, focus: node, revision, insight: null, error: messageOf(error), loadedAt: Date.now() }
  }
}

const loadKey = computed(() => [readyRoot.value?.id, selectedNode.value, props.kinds.join(','), props.revision].join('\n'))
const insightKey = computed(() => `${loadKey.value}\n${props.enrichmentRevision}`)

watch(loadKey, () => void load(), { immediate: true })
watch(insightKey, () => void loadInsight(), { immediate: true })
watch(
  () => props.versionFocus,
  (request) => {
    if (request !== undefined) focusRequest.value = request
  },
  { immediate: true },
)
watch(
  () => props.selection,
  (selection) => {
    if (focusRequest.value !== null && !isSameSelection(focusRequest.value, selection)) focusRequest.value = null
  },
)
watch(
  [focusRequest, focusesWhatToDo, whatToDo],
  async ([, requested, block]) => {
    if (!requested || block === null) return
    const landed = await block.focusPrimary()
    if (!landed || block !== whatToDo.value || !focusesWhatToDo.value) return
    focusRequest.value = null
    emit('version-focused')
  },
  { flush: 'post' },
)
watch(followKey, (key) => {
  const missing = missingNode.value
  if (key !== '' && missing !== null) void followMissingNode(key, missing)
})
</script>

<template>
  <div class="details" data-testid="details-body">
    <div v-if="notice" class="details__notice" data-testid="follow-notice">
      <p class="details__notice-text">{{ notice }}</p>
      <button type="button" class="details__notice-dismiss" :aria-label="DISMISS" :title="DISMISS" @click="emit('dismiss-notice')"><AppIcon name="x" :size="18" /></button>
    </div>
    <ScopeSummary
      v-if="selection === undefined"
      :scope="scope"
      :roots="roots"
      :scan-loaded="scanLoaded"
      :changes="changesByRoot"
      :status="status"
      :health-link-href="healthLinkHref"
      @open-issues="(root, kind) => emit('open-issues', root, kind)"
      @open-changes="(root) => emit('open-changes', root)"
    />
    <p v-else-if="blocker" class="details__empty muted">{{ blocker }}</p>
    <p v-else-if="waitsToFollow" class="details__empty muted">{{ stillScanningText(selection.root) }}</p>
    <p v-else-if="followError" class="details__error" role="alert">{{ detailsLoadFailedText(followError) }}</p>
    <div v-else-if="missingView" class="details__missing" data-testid="details-missing">
      <p class="muted">{{ missingView.text }}</p>
      <ul v-if="missingView.links.length > 0" class="details__follow-links">
        <li v-for="link in missingView.links" :key="`${link.selection.root}\n${link.selection.node}`">
          <button type="button" class="link" @click="openLink(link)">{{ link.label }}</button>
        </li>
      </ul>
    </div>
    <p v-else-if="missingNode" class="details__empty muted">{{ LOADING }}</p>
    <p v-else-if="loadError" class="details__error" role="alert">{{ detailsLoadFailedText(loadError) }}</p>
    <p v-else-if="!details" class="details__empty muted">{{ LOADING }}</p>

    <WorkspaceSummary
      v-else-if="details.focus.isImporter"
      :root="selection.root"
      :node="details.focus.id"
      :name="details.focus.name"
      :path="workspacePackage?.path ?? details.focus.id"
      :dependency-count="workspacePackage?.dependencyCount ?? 0"
      :issue-rows="issueRows"
      :issue-rows-error="issueRowsError"
      :status="status"
      :changes="selectionRootChanges"
      :changes-href="healthLinkHref(selection.root, 'changes')"
      :loading="loading"
      @select="select"
      @open-tree="emit('open-tree')"
      @open-changes="emit('open-changes', selection.root)"
    />

    <template v-else>
      <PackageHeader
        :node="details.focus"
        :root="selection.root"
        :labels="labels"
        :also-in="alsoIn"
        :variant="variant"
        :notices="notices"
        :loading="loading"
        @open-in-root="(target) => emit('open-in-root', target)"
      />
      <p v-if="insightError" class="details__error" role="alert">{{ packageChecksFailedText(insightError) }}</p>
      <AdvisoryList :advisories="advisories" :deprecated="deprecationMessage" />
      <WhatToDo
        v-if="actionsSelection"
        ref="whatToDo"
        :selection="actionsSelection"
        :kinds="kinds"
        :revision="actionsRevision"
        :editing="whatToDoEditing"
        @changed="emit('changed')"
        @review="(root, itemId) => emit('review', root, itemId)"
      />
      <WhyHere :rows="whyHere.rows" :more="whyHere.more" @select="select" @open-trail="emit('open-trail')" />
      <VulnerableBelow
        v-if="vulnerableBelow"
        :root="selection.root"
        :node="details.focus.id"
        :kinds="kinds"
        :revision="revision"
        :summary="vulnerableBelow"
        :decorations="decorations"
        @select="select"
      />
      <DetailsMore :name="details.focus.name" :insight="insight" :is-direct="isDirect" :now="checkedAt" />
    </template>
  </div>
</template>

<style scoped>
.details {
  overflow-y: auto;
  border-left: 1px solid var(--border);
  background: var(--surface-panel);
}

.details__empty,
.details__error {
  margin: 16px;
}

.details__notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 16px 0;
  padding: 6px 6px 6px 12px;
  border-radius: var(--radius);
  background: var(--badge-info-bg);
  color: var(--badge-info-fg);
}

.details__notice-text {
  flex: 1;
  min-width: 0;
  margin: 3px 0;
  overflow-wrap: anywhere;
}

.details__notice-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.details__notice-dismiss:hover {
  border-color: currentColor;
}

.details__missing {
  display: grid;
  gap: 8px;
  margin: 16px;
}

.details__missing p {
  margin: 0;
}

.details__follow-links {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.details__error {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

@media (max-width: 820px) {
  .details {
    border-top: 1px solid var(--border);
    border-left: 0;
  }
}
</style>
