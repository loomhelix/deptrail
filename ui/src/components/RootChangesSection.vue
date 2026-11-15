<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import type { ChangeItem, ChangesResponse, Goal, Job, RestoreResult } from '../../../src/actions/types.ts'
import type { NodeId } from '../../../src/model.ts'
import { announce } from '../announcer.ts'
import { createApi, type JobStarted, type RootSummary } from '../api.ts'
import { severityTone, type BadgeTone } from '../badges.ts'
import { CHANGES_INDEX } from '../changes-index.ts'
import {
  changeStep,
  directDependencyNode,
  editLookup,
  nodeInRoot,
  primaryAction,
  UNDO_WINDOW_MS,
  updateSize,
  type EditLookup,
} from '../changes-flow.ts'
import { DEP_KINDS, type Selection } from '../context.ts'
import { pollJob } from '../job-poll.ts'
import { hasLostFocus, restoreFocusIfLost } from '../keyboard/lost-focus.ts'
import { useRovingList } from '../keyboard/use-roving-list.ts'
import { rootLabel } from '../labels.ts'
import {
  CHANGE_STEPS,
  CHANGE_STEPS_LABEL,
  CHANGES_EDITED_AFTER_PREVIEW,
  changeCountText,
  changeGoalText,
  changesFailureText,
  changesInRootHeading,
  changeStepsText,
  CLEAR,
  clearedChangesText,
  EDIT,
  editChangeName,
  finishedJobHint,
  finishedJobText,
  LOADING_CHANGES,
  NO_CHANGES_YET,
  packageNotInRootText,
  PRIMARY_ACTION_TEXTS,
  removeChangeFailedText,
  removeChangeName,
  restoredChangesText,
  revertNote,
  UNDO,
  updateSizeBadgeText,
  type ChangeStepEntry,
  type ChangesFailure,
} from '../vocabulary.ts'
import ApplyDialog from './ApplyDialog.vue'
import ChangesJobStatus from './ChangesJobStatus.vue'
import ChangesPreview from './ChangesPreview.vue'

const props = defineProps<{
  root: RootSummary
  revision: string
  focusItem?: string
}>()

const emit = defineEmits<{
  changed: []
  edit: [selection: Selection, itemId: string]
  'item-focused': []
  hold: [held: boolean]
}>()

type ShownJob = { job: Job; log: readonly string[] }
type FollowedJob = { jobId: string; controller: AbortController }
type UndoOffer = { count: number }
type ItemBadge = { label: string; tone: BadgeTone }
type StepState = 'done' | 'current' | 'upcoming'

const ROW_ID_PREFIX = 'changes'
const APPLIED_STEP_INDEX = CHANGE_STEPS.length

const api = createApi()
const changesIndex = inject(CHANGES_INDEX, null)
const headingId = useId()
const sectionElement = ref<HTMLElement | null>(null)
const primaryButton = ref<HTMLButtonElement | null>(null)
const undoButton = ref<HTMLButtonElement | null>(null)
const changes = shallowRef<ChangesResponse | null>(null)
const loadError = ref<string | null>(null)
const shownJob = shallowRef<ShownJob | null>(null)
const followed = shallowRef<FollowedJob | null>(null)
const knownGoals = shallowRef<ReadonlyMap<string, Goal>>(new Map())
const requesting = ref(false)
const actionError = ref<string | null>(null)
const applying = ref(false)
const undoOffer = ref<UndoOffer | null>(null)
let undoTimer: number | undefined
let latestLoad = 0
let handledFocusItem: string | undefined
let focusAfterJobId: string | undefined

const rootId = computed(() => props.root.id)
const items = computed(() => changes.value?.items ?? [])
const preview = computed(() => changes.value?.preview)
const job = computed(() => shownJob.value?.job)
const jobLog = computed(() => shownJob.value?.log ?? [])
const running = computed(() => job.value?.state === 'running')
const busy = computed(() => requesting.value || running.value || followed.value !== null)
const revertable = computed(() => changes.value?.revertable === true)
const outcome = computed(() => (job.value === undefined ? undefined : finishedJobText(job.value, changes.value?.revert?.sharedRoots ?? [])))
const packageManager = computed(() => (props.root.manager === 'unknown' ? undefined : props.root.manager))
const installHintText = computed(() => (job.value === undefined ? undefined : finishedJobHint(job.value, packageManager.value)))
const revertNoteText = computed(() => {
  const revert = changes.value?.revert
  return revert === undefined ? undefined : revertNote(revert.files.length, revert.itemCount)
})
const shownChanges = computed(() => (changes.value === null ? null : { ...changes.value, job: job.value }))
const step = computed(() => (shownChanges.value === null ? 'changes' : changeStep(shownChanges.value)))
const action = computed(() => (shownChanges.value === null ? undefined : primaryAction(shownChanges.value)))
const shownCount = computed(() => (changes.value === null ? props.root.actions.changeCount : items.value.length))
const showsEmpty = computed(() => changes.value !== null && items.value.length === 0 && !running.value && outcome.value === undefined && !revertable.value)
const holdsSection = computed(() => requesting.value || undoOffer.value !== null || items.value.length > 0 || running.value)
const summaryKey = computed(() => {
  const actions = props.root.actions
  return [actions.changeCount, actions.job?.id, actions.job?.state, actions.revertable].join('\n')
})
const indexKey = computed(() => (changesIndex?.index.value.get(rootId.value) ?? []).map((item) => `${item.id}\t${item.choice}`).join('\n'))

function rowId(item: ChangeItem): string {
  return `${ROW_ID_PREFIX}:${rootId.value}:${item.id}`
}

const rovingItems = computed(() => items.value.map((item) => ({ id: rowId(item), expandable: false, expanded: false })))

function itemByRowId(id: string): ChangeItem | undefined {
  return items.value.find((item) => rowId(item) === id)
}

function keepRowsFlat(): void {}

function activateRow(id: string): void {
  const item = itemByRowId(id)
  if (item !== undefined) void editItem(item)
}

const { activeId, tabIndexOf, onKeydown, focusActive } = useRovingList(rovingItems, {
  expand: keepRowsFlat,
  collapse: keepRowsFlat,
  activate: activateRow,
})

function onRowKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  onKeydown(event)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function focusSection(): void {
  if (items.value.length > 0) focusActive()
  else sectionElement.value?.focus()
}

function focusSectionIfLost(): void {
  if (hasLostFocus(document)) focusSection()
}

async function keepFocusInSection(): Promise<void> {
  await restoreFocusIfLost(document, focusSection)
}

function restoreFocusAfterJob(next: ChangesResponse | null): void {
  const finished = next?.job
  if (focusAfterJobId === undefined || finished?.id !== focusAfterJobId || finished.state === 'running') return
  focusAfterJobId = undefined
  focusSectionIfLost()
}

function itemBadge(item: ChangeItem): ItemBadge {
  const { goal } = item
  return goal.kind === 'fix' ? { label: goal.severity, tone: severityTone(goal.severity) } : { label: updateSizeBadgeText(updateSize(item)), tone: 'info' }
}

function stepState(entry: ChangeStepEntry): StepState {
  const currentIndex = step.value === 'applied' ? APPLIED_STEP_INDEX : CHANGE_STEPS.findIndex((candidate) => candidate.step === step.value)
  const index = CHANGE_STEPS.indexOf(entry)
  if (index < currentIndex) return 'done'
  return index === currentIndex ? 'current' : 'upcoming'
}

function rememberGoals(next: readonly ChangeItem[]): void {
  if (next.every((item) => knownGoals.value.has(item.id))) return
  knownGoals.value = new Map([...knownGoals.value, ...next.map((item): [string, Goal] => [item.id, item.goal])])
}

function showJob(next: Job | undefined): void {
  if (followed.value !== null) return
  shownJob.value = next === undefined ? null : { job: next, log: next.log }
  if (next?.state === 'running') void follow(next.id)
}

async function load(): Promise<void> {
  const request = ++latestLoad
  try {
    const next = await api.changes(rootId.value)
    if (request !== latestLoad) return
    changes.value = next
    loadError.value = null
    rememberGoals(next.items)
    showJob(next.job)
  } catch (error) {
    if (request !== latestLoad) return
    loadError.value = messageOf(error)
  }
}

function stopFollowing(): void {
  followed.value?.controller.abort()
  followed.value = null
}

async function follow(jobId: string): Promise<void> {
  stopFollowing()
  const controller = new AbortController()
  followed.value = { jobId, controller }
  const showProgress = (next: Job, log: readonly string[]): void => {
    shownJob.value = { job: next, log }
  }
  try {
    await pollJob(api, jobId, showProgress, { signal: controller.signal })
  } catch (error) {
    if (!controller.signal.aborted) actionError.value = changesFailureText('follow', messageOf(error))
  } finally {
    if (followed.value?.controller === controller) followed.value = null
  }
  if (controller.signal.aborted) return
  await load()
  emit('changed')
}

async function request(action: () => Promise<void>, failureText: (reason: string) => string): Promise<boolean> {
  requesting.value = true
  actionError.value = null
  try {
    await action()
    return true
  } catch (error) {
    actionError.value = failureText(messageOf(error))
    return false
  } finally {
    requesting.value = false
  }
}

function failureOf(failure: ChangesFailure): (reason: string) => string {
  return (reason) => changesFailureText(failure, reason)
}

async function nothingAfterLoad(): Promise<void> {}

function editChanges(edit: () => Promise<void>, failureText: (reason: string) => string, afterLoad: () => Promise<void> = nothingAfterLoad): Promise<boolean> {
  return request(async () => {
    await edit()
    await load()
    await afterLoad()
    await changesIndex?.reload(rootId.value)
    emit('changed')
  }, failureText)
}

function startJob(start: () => Promise<JobStarted>, failure: ChangesFailure): void {
  void request(async () => {
    const { jobId } = await start()
    focusAfterJobId = jobId
    void follow(jobId)
    emit('changed')
  }, failureOf(failure))
}

async function removeItem(item: ChangeItem): Promise<void> {
  if (requesting.value) return
  const removed = await editChanges(() => api.removeChange(rootId.value, item.id), (reason) => removeChangeFailedText(item.goal, reason))
  if (removed) await keepFocusInSection()
}

function stopUndoTimer(): void {
  window.clearTimeout(undoTimer)
  undoTimer = undefined
}

function endUndoOffer(): void {
  stopUndoTimer()
  undoOffer.value = null
}

async function expireUndoOffer(): Promise<void> {
  const hadFocus = undoButton.value !== null && undoButton.value === document.activeElement
  endUndoOffer()
  if (hadFocus) await keepFocusInSection()
}

async function offerUndo(count: number): Promise<void> {
  stopUndoTimer()
  undoOffer.value = { count }
  undoTimer = window.setTimeout(() => void expireUndoOffer(), UNDO_WINDOW_MS)
  announce(clearedChangesText(count))
  await nextTick()
  undoButton.value?.focus()
}

async function clearItems(): Promise<void> {
  if (requesting.value) return
  const count = items.value.length
  await editChanges(() => api.clearChanges(rootId.value), failureOf('clear'), () => offerUndo(count))
}

async function undoClear(): Promise<void> {
  if (requesting.value) return
  let result: RestoreResult | undefined
  const restored = await editChanges(async () => {
    result = await api.restoreCleared(rootId.value)
  }, failureOf('undo'))
  if (!restored) return
  endUndoOffer()
  if (result !== undefined) announce(restoredChangesText(result))
  await keepFocusInSection()
}

function startPreview(): void {
  startJob(() => api.preview(rootId.value), 'preview')
}

function runPrimaryAction(): void {
  if (busy.value) return
  if (action.value === 'apply') applying.value = true
  else if (action.value !== undefined) startPreview()
}

async function closeApplyDialog(): Promise<void> {
  applying.value = false
  await nextTick()
  primaryButton.value?.focus()
}

function cancelApply(): void {
  void closeApplyDialog()
}

function confirmApply(install: boolean): void {
  const previewId = preview.value?.id
  void closeApplyDialog()
  if (previewId !== undefined) startJob(() => api.apply(rootId.value, previewId, install), 'apply')
}

function startRevert(): void {
  startJob(() => api.revert(rootId.value), 'revert')
}

function cancelJob(): void {
  const jobId = job.value?.id
  if (jobId !== undefined) void request(() => api.cancelJob(jobId), failureOf('cancel'))
}

async function nodeOf(lookup: EditLookup): Promise<NodeId | undefined> {
  if (lookup.kind === 'direct') {
    const children = await api.children(rootId.value, lookup.importer, 1, [...DEP_KINDS])
    return directDependencyNode(children.rows, lookup.name)
  }
  const exact = nodeInRoot(await api.search(`${lookup.name}@${lookup.version}`), rootId.value, lookup.name, lookup.version)
  return exact ?? nodeInRoot(await api.search(lookup.name), rootId.value, lookup.name, lookup.version)
}

async function editItem(item: ChangeItem): Promise<void> {
  actionError.value = null
  const lookup = editLookup(item)
  try {
    const node = lookup === undefined ? undefined : await nodeOf(lookup)
    if (node === undefined) {
      actionError.value = changesFailureText('edit', packageNotInRootText(item.goal.name, rootId.value))
      return
    }
    emit('edit', { root: rootId.value, node }, item.id)
  } catch (error) {
    actionError.value = changesFailureText('edit', messageOf(error))
  }
}

async function focusRequestedItem(): Promise<void> {
  const itemId = props.focusItem
  if (itemId === undefined) {
    handledFocusItem = undefined
    return
  }
  const item = items.value.find((candidate) => candidate.id === itemId)
  if (item === undefined || handledFocusItem === itemId) return
  handledFocusItem = itemId
  activeId.value = rowId(item)
  await nextTick()
  focusActive()
  emit('item-focused')
}

watch([() => props.revision, summaryKey, indexKey], () => void load(), { immediate: true })
watch([() => props.focusItem, items], () => void focusRequestedItem(), { flush: 'post' })
watch(holdsSection, (held) => emit('hold', held), { immediate: true })
watch(changes, restoreFocusAfterJob, { flush: 'post' })
watch(action, (next, previous) => {
  if (next === 'preview-again' && previous === 'apply') announce(CHANGES_EDITED_AFTER_PREVIEW)
})

onBeforeUnmount(() => {
  stopFollowing()
  stopUndoTimer()
  if (holdsSection.value) emit('hold', false)
})
</script>

<template>
  <section ref="sectionElement" class="root-changes" :aria-labelledby="headingId" :data-root-changes="rootId" data-testid="root-changes" tabindex="-1">
    <header class="root-changes__header">
      <div class="root-changes__title">
        <h2 :id="headingId" class="root-changes__root">{{ rootLabel(rootId) }}</h2>
        <span class="root-changes__count muted" data-testid="change-count">{{ changeCountText(shownCount) }}</span>
      </div>
      <ol class="root-changes__steps" :aria-label="CHANGE_STEPS_LABEL">
        <li
          v-for="entry in CHANGE_STEPS"
          :key="entry.step"
          class="root-changes__step"
          :class="`root-changes__step--${stepState(entry)}`"
          :aria-current="stepState(entry) === 'current' ? 'step' : undefined"
        >
          {{ entry.number }} {{ entry.title }}
        </li>
      </ol>
      <div class="root-changes__buttons">
        <button
          v-if="items.length > 0"
          type="button"
          class="button root-changes__button"
          :aria-disabled="requesting ? 'true' : undefined"
          @click="clearItems"
        >
          {{ CLEAR }}
        </button>
        <button
          v-if="action"
          ref="primaryButton"
          type="button"
          class="button button--primary root-changes__button"
          :aria-disabled="busy ? 'true' : undefined"
          @click="runPrimaryAction"
        >
          {{ PRIMARY_ACTION_TEXTS[action] }}
        </button>
      </div>
    </header>

    <ChangesJobStatus
      :job="job"
      :log="jobLog"
      :outcome="outcome"
      :hint="installHintText"
      :revert-note="revertNoteText"
      :revertable="revertable"
      :busy="busy"
      :requesting="requesting"
      @cancel="cancelJob"
      @revert="startRevert"
    />

    <p v-if="action === 'preview-again'" class="root-changes__notice">{{ CHANGES_EDITED_AFTER_PREVIEW }}</p>
    <div v-if="undoOffer" class="root-changes__undo">
      <span>{{ clearedChangesText(undoOffer.count) }}</span>
      <button ref="undoButton" type="button" class="button root-changes__button" :aria-disabled="requesting ? 'true' : undefined" @click="undoClear">
        {{ UNDO }}
      </button>
    </div>
    <p v-if="actionError" class="root-changes__message root-changes__message--error" role="alert">{{ actionError }}</p>
    <p v-if="loadError" class="root-changes__message root-changes__message--error" role="alert">{{ changesFailureText('load', loadError) }}</p>
    <p v-if="changes === null && loadError === null" class="root-changes__message muted">{{ LOADING_CHANGES }}</p>
    <p v-else-if="showsEmpty" class="root-changes__message muted" data-testid="changes-empty">{{ NO_CHANGES_YET }}</p>

    <div v-if="items.length > 0" class="root-changes__grid" role="grid" :aria-label="changesInRootHeading(rootId)">
      <div
        v-for="item in items"
        :key="item.id"
        class="root-changes__row"
        role="row"
        data-testid="change-item"
        :data-roving-id="rowId(item)"
        :tabindex="tabIndexOf(rowId(item))"
        @keydown="onRowKeydown"
        @focusin="activeId = rowId(item)"
        @click="activeId = rowId(item)"
      >
        <div class="root-changes__badge-cell" role="gridcell">
          <span class="badge" :class="`badge--${itemBadge(item).tone}`" data-testid="change-badge">{{ itemBadge(item).label }}</span>
        </div>
        <div class="root-changes__item" role="gridcell">
          <p class="root-changes__goal" data-testid="change-goal">{{ changeGoalText(item.goal) }}</p>
          <p v-if="item.steps.length > 0" class="root-changes__item-steps muted" data-testid="change-steps">{{ changeStepsText(item.steps) }}</p>
          <ul v-if="item.warnings.length > 0" class="root-changes__warnings">
            <li v-for="warning in item.warnings" :key="warning" class="root-changes__warning" data-testid="change-warning">{{ warning }}</li>
          </ul>
        </div>
        <div class="root-changes__actions" role="gridcell">
          <button
            type="button"
            class="button root-changes__row-button"
            :aria-label="editChangeName(item.goal)"
            :tabindex="activeId === rowId(item) ? 0 : -1"
            @click.stop="editItem(item)"
          >
            {{ EDIT }}
          </button>
          <button
            type="button"
            class="root-changes__remove"
            :aria-label="removeChangeName(item.goal)"
            :title="removeChangeName(item.goal)"
            :aria-disabled="requesting ? 'true' : undefined"
            :tabindex="activeId === rowId(item) ? 0 : -1"
            @click.stop="removeItem(item)"
          >
            ×
          </button>
        </div>
      </div>
    </div>

    <ChangesPreview v-if="preview && items.length > 0" :root="rootId" :preview="preview" :goals="knownGoals" />
    <ApplyDialog
      v-if="applying && preview"
      :preview="preview"
      :root-name="rootLabel(rootId)"
      :install-by-default="changes?.installByDefault ?? false"
      :goals="knownGoals"
      @cancel="cancelApply"
      @apply="confirmApply"
    />
  </section>
</template>

<style scoped>
.root-changes {
  border-bottom: 1px solid var(--border-strong);
}

.root-changes:focus-visible {
  outline-offset: -2px;
}

.root-changes__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-panel);
}

.root-changes__title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  min-width: 0;
}

.root-changes__root {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.root-changes__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.root-changes__step + .root-changes__step::before {
  content: '→' / '';
  margin-right: 4px;
  color: var(--text-muted);
}

.root-changes__step--done,
.root-changes__step--upcoming {
  color: var(--text-muted);
}

.root-changes__step--done::after {
  content: ' ✓' / '';
  color: var(--badge-ok-fg);
}

.root-changes__step--current {
  color: var(--accent);
  font-weight: 600;
}

.root-changes__buttons {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.root-changes__button {
  height: 32px;
}

.root-changes__button[aria-disabled='true'],
.root-changes__row-button[aria-disabled='true'],
.root-changes__remove[aria-disabled='true'] {
  cursor: default;
  opacity: 0.55;
}

.root-changes__notice {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--badge-warn-bg);
  color: var(--badge-warn-fg);
}

.root-changes__undo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--badge-info-bg);
  color: var(--badge-info-fg);
}

.root-changes__message {
  margin: 0;
  padding: 12px 16px;
  overflow-wrap: anywhere;
}

.root-changes__message--error {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--badge-danger-bg);
  color: var(--badge-danger-fg);
}

.root-changes__row {
  display: grid;
  grid-template-columns: minmax(72px, max-content) minmax(0, 1fr) auto;
  align-items: start;
  gap: 4px 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.root-changes__row:last-child {
  border-bottom: 0;
}

.root-changes__row:hover {
  background: var(--surface-hover);
}

.root-changes__row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.root-changes__badge-cell {
  padding-top: 1px;
}

.root-changes__item {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.root-changes__item p {
  margin: 0;
  overflow-wrap: anywhere;
}

.root-changes__goal {
  font-weight: 600;
}

.root-changes__warnings {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.root-changes__warning {
  color: var(--badge-warn-fg);
  overflow-wrap: anywhere;
}

.root-changes__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.root-changes__row-button {
  height: 28px;
  padding: 0 10px;
}

.root-changes__remove {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.root-changes__remove:hover:not([aria-disabled='true']) {
  border-color: var(--border-strong);
  background: var(--surface-raised);
  color: var(--danger);
}
</style>
