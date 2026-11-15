<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { AddChangeRequest, ChangeItem, Choice, FixActions, FixChoice, NodeActions, UpdateActions, UpdateGoal } from '../../../src/actions/types.ts'
import type { DepKind, NodeId } from '../../../src/model.ts'
import { announce } from '../announcer.ts'
import { createApi } from '../api.ts'
import { CHANGES_INDEX, changeState, itemFor, type ChangeState } from '../changes-index.ts'
import type { Selection } from '../context.ts'
import { createNodeActionsCache, NODE_ACTIONS_CACHE } from '../node-actions-cache.ts'
import { packageNameOf } from '../node-id.ts'
import { defaultUpdateVersion, newerVersions, nothingToDoText, selectableVersions, updateChoiceFor } from '../update-choice.ts'
import {
  ACTIONS_HEADING,
  actionsLoadFailedText,
  ADD_TO_CHANGES,
  ADDED_TO_CHANGES,
  addToChangesFailedText,
  changeChoiceTitle,
  IN_CHANGES_REVIEW,
  inChangesText,
  loadingOptionsText,
  REPLACE_IN_CHANGES,
  replaceChangeFailedText,
  REPLACED_IN_CHANGES,
  SAVE_CHANGE,
} from '../vocabulary.ts'
import FixChoices from './FixChoices.vue'
import UpdateChoice from './UpdateChoice.vue'

const props = defineProps<{
  selection: Selection
  kinds: DepKind[]
  revision: string
  editing?: { itemId: string }
}>()

const emit = defineEmits<{ changed: []; review: [root: string, itemId: string] }>()

type Block = 'fix' | 'update'
type LoadedActions = { nodeKey: string; actions: NodeActions | null; error: string | null }
type ChangingAction = { kind: 'replace' | 'save'; itemId: string }
type CommitAction = { kind: 'add' } | { kind: 'review'; itemId: string } | ChangingAction
type Footer = { action: CommitAction; inChanges?: string; ready: boolean }
type Failure = { nodeKey: string; block: Block; text: string }
type Commit = { nodeKey: string; block: Block }
type PendingFocus = { nodeKey: string; settle: (landed: boolean) => void }

const COMMIT_TEXTS: Readonly<Record<CommitAction['kind'], string>> = {
  add: ADD_TO_CHANGES,
  review: IN_CHANGES_REVIEW,
  replace: REPLACE_IN_CHANGES,
  save: SAVE_CHANGE,
}

const api = createApi()
const nodeActionsCache = inject(NODE_ACTIONS_CACHE, () => createNodeActionsCache(api), true)
const changesIndex = inject(CHANGES_INDEX, null)
const elementId = useId()
const section = ref<HTMLElement | null>(null)
const fixChoices = ref<InstanceType<typeof FixChoices> | null>(null)
const updateChoice = ref<InstanceType<typeof UpdateChoice> | null>(null)
const loaded = ref<LoadedActions | null>(null)
const selectedFix = ref<FixChoice | null>(null)
const selectedVersion = ref('')
const selectedImporters = ref<NodeId[]>([])
const showPrereleases = ref(false)
const commit = ref<Commit | null>(null)
const failure = ref<Failure | null>(null)
const editedItemId = ref(props.editing?.itemId)
let pendingFocus: PendingFocus | null = null
let preselectedEditing: string | null = null
let latestLoad = 0

const nodeKey = computed(() => [props.selection.root, props.selection.node, props.kinds.join(',')].join('\n'))
const loadKey = computed(() => `${nodeKey.value}\n${props.revision}`)
const current = computed(() => (loaded.value?.nodeKey === nodeKey.value ? loaded.value : null))
const actions = computed(() => current.value?.actions ?? null)
const loadError = computed(() => current.value?.error ?? null)
const fix = computed(() => actions.value?.fix)
const update = computed(() => actions.value?.update)
const packageName = computed(() => packageNameOf(props.selection.node))
const offersUpdate = computed(() => (update.value === undefined ? false : newerVersions(update.value).length > 0))
const selectable = computed(() => (update.value === undefined ? [] : selectableVersions(update.value, showPrereleases.value)))
const updateChoiceKind = computed(() => (update.value !== undefined && selectedVersion.value !== '' ? updateChoiceFor(update.value, selectedVersion.value) : null))
const relocksOnly = computed(() => updateChoiceKind.value === 'wanted')

const nothingToDo = computed(() => (actions.value === null ? undefined : nothingToDoText(actions.value)))

const rootItems = computed(() => changesIndex?.index.value.get(props.selection.root) ?? [])
const editedItem = computed(() => (editedItemId.value === undefined ? undefined : rootItems.value.find((item) => item.id === editedItemId.value)))

function isFixItemOf(item: ChangeItem | undefined, value: FixActions | undefined): item is ChangeItem {
  return item !== undefined && value !== undefined && item.goal.kind === 'fix' && item.goal.name === value.goal.name && item.goal.version === value.goal.version
}

function isUpdateItemOf(item: ChangeItem | undefined, value: UpdateActions | undefined): item is ChangeItem {
  return item !== undefined && value !== undefined && item.goal.kind === 'update' && item.goal.name === value.name
}

const editedFixItem = computed(() => (isFixItemOf(editedItem.value, fix.value) ? editedItem.value : undefined))
const editedUpdateItem = computed(() => (isUpdateItemOf(editedItem.value, update.value) ? editedItem.value : undefined))

const fixState = computed<ChangeState>(() => {
  const value = fix.value
  if (value === undefined || changesIndex === null || selectedFix.value === null) return { kind: 'absent' }
  const item = itemFor(changesIndex.index.value, props.selection.root, { kind: 'fix', name: value.goal.name, version: value.goal.version })
  return changeState(item, selectedFix.value)
})

const updateState = computed<ChangeState>(() => {
  const value = update.value
  if (value === undefined || changesIndex === null || updateChoiceKind.value === null) return { kind: 'absent' }
  const item = itemFor(changesIndex.index.value, props.selection.root, { kind: 'update', name: value.name })
  return changeState(item, updateChoiceKind.value, selectedVersion.value)
})

function commitActionOf(state: ChangeState, edited: ChangeItem | undefined): CommitAction {
  if (edited !== undefined) return { kind: 'save', itemId: edited.id }
  if (state.kind === 'absent') return { kind: 'add' }
  return state.kind === 'same' ? { kind: 'review', itemId: state.item.id } : { kind: 'replace', itemId: state.item.id }
}

function footerOf(state: ChangeState, edited: ChangeItem | undefined, ready: boolean): Footer {
  const action = commitActionOf(state, edited)
  const inChanges = state.kind === 'different' ? inChangesText(changeChoiceTitle(state.item)) : undefined
  return { action, inChanges, ready: action.kind === 'review' || ready }
}

const fixFooter = computed(() => footerOf(fixState.value, editedFixItem.value, selectedFix.value !== null))
const updateFooter = computed(() =>
  footerOf(updateState.value, editedUpdateItem.value, updateChoiceKind.value !== null && (relocksOnly.value || selectedImporters.value.length > 0)),
)
const fixFailure = computed(() => failureOf('fix'))
const updateFailure = computed(() => failureOf('update'))

function failureOf(block: Block): string | undefined {
  const value = failure.value
  return value !== null && value.block === block && value.nodeKey === nodeKey.value ? value.text : undefined
}

function clearFailure(block: Block): void {
  if (failure.value?.block === block) failure.value = null
}

function isCommitting(block: Block): boolean {
  return commit.value !== null && commit.value.block === block && commit.value.nodeKey === nodeKey.value
}

function defaultFix(value: FixActions | undefined, previous: FixChoice | null): FixChoice | null {
  const options = value?.options ?? []
  if (previous !== null && options.some((option) => option.choice === previous)) return previous
  return (options.find((option) => option.recommended) ?? options[0])?.choice ?? null
}

function editableImporters(value: UpdateActions | undefined): NodeId[] {
  return (value?.importers ?? []).filter((importer) => importer.editable).map((importer) => importer.id)
}

function resetSelection(next: NodeActions, sameNode: boolean): void {
  selectedFix.value = defaultFix(next.fix, sameNode ? selectedFix.value : null)
  if (!sameNode) showPrereleases.value = false
  const editable = editableImporters(next.update)
  selectedImporters.value = sameNode ? selectedImporters.value.filter((id) => editable.includes(id)) : editable
  if (next.update === undefined) {
    selectedVersion.value = ''
    return
  }
  const nextSelectable = selectableVersions(next.update, showPrereleases.value)
  const keepsVersion = sameNode && nextSelectable.some((entry) => entry.version === selectedVersion.value)
  if (!keepsVersion) selectedVersion.value = defaultUpdateVersion(next.update, nextSelectable)
}

function preselectFix(choice: Choice): void {
  const option = fix.value?.options.find((candidate) => candidate.choice === choice)
  if (option !== undefined) selectedFix.value = option.choice
}

function preselectUpdate(goal: UpdateGoal): void {
  const value = update.value
  if (value === undefined) return
  const target = newerVersions(value).find((entry) => entry.version === goal.target)
  if (target === undefined) return
  if (target.prerelease) showPrereleases.value = true
  selectedVersion.value = target.version
  const editable = editableImporters(value)
  const chosen = goal.importers.filter((id) => editable.includes(id))
  if (chosen.length > 0) selectedImporters.value = chosen
}

function preselectEditedItem(): void {
  const item = editedFixItem.value ?? editedUpdateItem.value
  if (item === undefined) return
  const key = `${item.id}\n${nodeKey.value}`
  if (preselectedEditing === key) return
  preselectedEditing = key
  if (item.goal.kind === 'fix') preselectFix(item.choice)
  else preselectUpdate(item.goal)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  const request = ++latestLoad
  const key = nodeKey.value
  const sameNode = loaded.value?.nodeKey === key && loaded.value.actions !== null
  try {
    const next = await nodeActionsCache.get({ root: props.selection.root, node: props.selection.node, kinds: props.kinds, revision: props.revision })
    if (request !== latestLoad) return
    loaded.value = { nodeKey: key, actions: next, error: null }
    resetSelection(next, sameNode)
    preselectEditedItem()
  } catch (error) {
    if (request !== latestLoad) return
    loaded.value = { nodeKey: key, actions: null, error: messageOf(error) }
  }
}

function fixRequest(): AddChangeRequest | undefined {
  if (selectedFix.value === null) return undefined
  return { nodeId: props.selection.node, choice: selectedFix.value, kinds: [...props.kinds] }
}

function updateRequest(): AddChangeRequest | undefined {
  const choice = updateChoiceKind.value
  if (choice === null) return undefined
  const base = { nodeId: props.selection.node, choice, kinds: [...props.kinds] }
  if (choice === 'wanted') return base
  return { ...base, ...(choice === 'version' ? { version: selectedVersion.value } : {}), importers: [...selectedImporters.value] }
}

async function addChange(root: string, request: AddChangeRequest): Promise<void> {
  await api.addChange(root, request)
  await changesIndex?.reload(root)
  announce(ADDED_TO_CHANGES)
}

async function replaceChange(root: string, action: ChangingAction, request: AddChangeRequest): Promise<void> {
  const replacement = await api.replaceChange(root, action.itemId, request)
  await changesIndex?.reload(root)
  if (editedItemId.value === action.itemId) editedItemId.value = replacement.id
  announce(REPLACED_IN_CHANGES)
}

async function sendChange(block: Block, action: { kind: 'add' } | ChangingAction, request: AddChangeRequest): Promise<void> {
  const key = nodeKey.value
  const root = props.selection.root
  commit.value = { nodeKey: key, block }
  failure.value = null
  try {
    if (action.kind === 'add') await addChange(root, request)
    else await replaceChange(root, action, request)
    emit('changed')
  } catch (error) {
    const text = action.kind === 'add' ? addToChangesFailedText(messageOf(error)) : replaceChangeFailedText(messageOf(error))
    failure.value = { nodeKey: key, block, text }
  } finally {
    commit.value = null
  }
}

function runAction(block: Block): void {
  const footer = block === 'fix' ? fixFooter.value : updateFooter.value
  const { action } = footer
  if (action.kind === 'review') {
    emit('review', props.selection.root, action.itemId)
    return
  }
  if (!footer.ready || commit.value !== null) return
  const request = block === 'fix' ? fixRequest() : updateRequest()
  if (request !== undefined) void sendChange(block, action, request)
}

function focusPrimaryControl(): void {
  const showsUpdate = update.value !== undefined && offersUpdate.value
  const prefersFix = editedFixItem.value !== undefined || !showsUpdate
  if (prefersFix && fixChoices.value?.focusSelected()) return
  if (updateChoice.value?.focusVersion()) return
  if (fixChoices.value?.focusSelected()) return
  section.value?.focus()
}

function hasFocusInside(): boolean {
  const focused = document.activeElement
  return focused !== null && (section.value?.contains(focused) ?? false)
}

function settlePendingFocus(landed: boolean): void {
  const pending = pendingFocus
  pendingFocus = null
  pending?.settle(landed)
}

async function focusWhenReady(): Promise<void> {
  const pending = pendingFocus
  if (pending === null) return
  if (pending.nodeKey !== nodeKey.value) {
    settlePendingFocus(false)
    return
  }
  if (current.value === null) return
  pendingFocus = null
  await nextTick()
  focusPrimaryControl()
  pending.settle(hasFocusInside())
}

function focusPrimary(): Promise<boolean> {
  settlePendingFocus(false)
  return new Promise((settle) => {
    pendingFocus = { nodeKey: nodeKey.value, settle }
    void focusWhenReady()
  })
}

defineExpose({ focusPrimary })

watch(loadKey, () => void load(), { immediate: true })
watch(current, () => void focusWhenReady())
watch(
  () => props.editing,
  (editing) => {
    editedItemId.value = editing?.itemId
    preselectedEditing = null
    preselectEditedItem()
  },
)
onBeforeUnmount(() => settlePendingFocus(false))
watch([editedFixItem, editedUpdateItem], () => preselectEditedItem())
watch(selectedFix, () => clearFailure('fix'))
watch([selectedVersion, selectedImporters], () => clearFailure('update'))
watch(selectable, (entries) => {
  const value = update.value
  if (value === undefined || entries.some((entry) => entry.version === selectedVersion.value)) return
  selectedVersion.value = defaultUpdateVersion(value, entries)
})
</script>

<template>
  <section ref="section" class="what-to-do" :aria-labelledby="`${elementId}-heading`" tabindex="-1">
    <h3 :id="`${elementId}-heading`" class="panel-heading">{{ ACTIONS_HEADING }}</h3>
    <p v-if="loadError" class="what-to-do__error" role="alert">{{ actionsLoadFailedText(loadError) }}</p>
    <p v-else-if="!actions" class="muted">{{ loadingOptionsText(packageName) }}</p>
    <p v-else-if="actions.unavailable" class="muted">{{ actions.unavailable }}</p>
    <p v-else-if="nothingToDo" class="muted" data-testid="nothing-to-do">{{ nothingToDo }}</p>
    <template v-else>
      <div v-if="fix" class="what-to-do__block" data-testid="actions-fix">
        <FixChoices ref="fixChoices" v-model="selectedFix" :fix="fix" :root="selection.root" />
        <div v-if="fix.options.length > 0" class="what-to-do__footer">
          <p v-if="fixFooter.inChanges" :id="`${elementId}-fix-in-changes`" class="what-to-do__in-changes">{{ fixFooter.inChanges }}</p>
          <button
            type="button"
            class="button what-to-do__commit"
            :class="`what-to-do__commit--${fixFooter.action.kind}`"
            :disabled="!fixFooter.ready"
            :aria-disabled="isCommitting('fix') ? 'true' : undefined"
            :aria-describedby="fixFooter.inChanges ? `${elementId}-fix-in-changes` : undefined"
            @click="runAction('fix')"
          >
            {{ COMMIT_TEXTS[fixFooter.action.kind] }}
          </button>
          <p v-if="fixFailure" class="what-to-do__error" role="alert">{{ fixFailure }}</p>
        </div>
      </div>

      <div v-if="update && offersUpdate" class="what-to-do__block" data-testid="actions-update">
        <UpdateChoice
          ref="updateChoice"
          v-model:version="selectedVersion"
          v-model:importers="selectedImporters"
          v-model:show-prereleases="showPrereleases"
          :update="update"
          :root="selection.root"
        />
        <div class="what-to-do__footer">
          <p v-if="updateFooter.inChanges" :id="`${elementId}-update-in-changes`" class="what-to-do__in-changes">{{ updateFooter.inChanges }}</p>
          <button
            type="button"
            class="button what-to-do__commit"
            :class="`what-to-do__commit--${updateFooter.action.kind}`"
            :disabled="!updateFooter.ready"
            :aria-disabled="isCommitting('update') ? 'true' : undefined"
            :aria-describedby="updateFooter.inChanges ? `${elementId}-update-in-changes` : undefined"
            @click="runAction('update')"
          >
            {{ COMMIT_TEXTS[updateFooter.action.kind] }}
          </button>
          <p v-if="updateFailure" class="what-to-do__error" role="alert">{{ updateFailure }}</p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.what-to-do {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.what-to-do p {
  margin: 0;
}

.what-to-do__block {
  display: grid;
  gap: 8px;
}

.what-to-do__block + .what-to-do__block {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.what-to-do__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 2px;
}

.what-to-do__in-changes {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.what-to-do__commit {
  height: 32px;
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.what-to-do__commit--review {
  border-color: var(--badge-ok-fg);
  background: var(--badge-ok-bg);
  color: var(--badge-ok-fg);
  font-weight: 500;
}

.what-to-do__commit--review:hover:not(:disabled) {
  background: var(--badge-ok-bg);
  text-decoration: underline;
}

.what-to-do__error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
