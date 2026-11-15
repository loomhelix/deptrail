<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NodeActions } from '../../../src/actions/types.ts'
import type { DepKind } from '../../../src/model.ts'
import type { IssueKind, IssueLocation, IssueRow } from '../../../src/query/issues.ts'
import { announce } from '../announcer.ts'
import { createApi } from '../api.ts'
import { CHANGES_INDEX, itemFor, type GoalTarget } from '../changes-index.ts'
import type { Selection } from '../context.ts'
import { recommendedText, rowActionState, type RowActionState } from '../issues-model.ts'
import { createNodeActionsCache, NODE_ACTIONS_CACHE, type NodeActionsKey } from '../node-actions-cache.ts'
import { useVisible } from '../use-visible.ts'
import { ADD_FIX, addedFixText, fixAddFailedText, IN_CHANGES, UPDATE_PACKAGE } from '../vocabulary.ts'

const props = defineProps<{
  kind: IssueKind
  location: IssueLocation
  row: IssueRow
  kinds: DepKind[]
  revision: string
  rootReason?: string
  inActiveRow: boolean
}>()

const emit = defineEmits<{
  added: []
  update: [selection: Selection]
  review: [root: string, itemId: string]
  'root-unavailable': [unavailable: boolean]
}>()

type LoadedActions = { key: string; actions?: NodeActions; failure?: string }

const BUTTON_TEXTS: Readonly<Partial<Record<RowActionState['kind'], string>>> = {
  loading: ADD_FIX,
  add: ADD_FIX,
  update: UPDATE_PACKAGE,
  'in-changes': IN_CHANGES,
}
const EMPHASIZED_STATES: ReadonlySet<RowActionState['kind']> = new Set(['add', 'in-changes'])

const api = createApi()
const nodeActionsCache = inject(NODE_ACTIONS_CACHE, () => createNodeActionsCache(api), true)
const changesIndex = inject(CHANGES_INDEX, null)
const element = ref<HTMLElement | null>(null)
const rowElement = computed(() => element.value?.closest('tr') ?? element.value)
const visible = useVisible(rowElement)
const loaded = shallowRef<LoadedActions | null>(null)
const adding = ref(false)
const addFailure = ref<string | null>(null)

const actionsKey = computed<NodeActionsKey>(() => ({
  root: props.location.rootId,
  node: props.location.nodeId,
  kinds: props.kinds,
  revision: props.revision,
}))
const loadKey = computed(() => [props.location.rootId, props.location.nodeId, props.kinds.join(','), props.revision].join('\n'))
const goalTarget = computed<GoalTarget>(() =>
  props.kind === 'vulnerability' ? { kind: 'fix', name: props.row.name, version: props.row.version } : { kind: 'update', name: props.row.name },
)
const item = computed(() => (changesIndex === null ? undefined : itemFor(changesIndex.index.value, props.location.rootId, goalTarget.value)))
const current = computed(() => (loaded.value?.key === loadKey.value ? loaded.value : undefined))
const state = computed(() =>
  rowActionState(props.kind, props.location, current.value?.actions, current.value?.failure, item.value, props.rootReason),
)
const text = computed(() => recommendedText(state.value, props.row, item.value))
const buttonText = computed(() => BUTTON_TEXTS[state.value.kind])
const needsActions = computed(() => props.kind === 'vulnerability' && item.value === undefined && props.rootReason === undefined && visible.value)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadActions(): Promise<void> {
  const key = loadKey.value
  const request = actionsKey.value
  const cached = nodeActionsCache.peek(request)
  if (cached !== undefined) {
    loaded.value = { key, actions: cached }
    return
  }
  try {
    const actions = await nodeActionsCache.get(request)
    if (key === loadKey.value) loaded.value = { key, actions }
  } catch (error) {
    if (key === loadKey.value) loaded.value = { key, failure: messageOf(error) }
  }
}

async function addFix(): Promise<void> {
  if (adding.value) return
  adding.value = true
  addFailure.value = null
  const root = props.location.rootId
  try {
    await api.addChange(root, { nodeId: props.location.nodeId, choice: 'recommended', kinds: [...props.kinds] })
    await changesIndex?.reload(root)
    announce(addedFixText(props.row.name, root))
    emit('added')
  } catch (error) {
    addFailure.value = fixAddFailedText(messageOf(error))
  } finally {
    adding.value = false
  }
}

function runAction(): void {
  const action = state.value
  if (action.kind === 'add') void addFix()
  else if (action.kind === 'update') emit('update', { root: props.location.rootId, node: props.location.nodeId })
  else if (action.kind === 'in-changes') emit('review', props.location.rootId, action.itemId)
}

watch(
  () => state.value.kind === 'root-unavailable',
  (unavailable) => emit('root-unavailable', unavailable),
  { immediate: true },
)

onBeforeUnmount(() => emit('root-unavailable', false))

watch(
  [needsActions, loadKey],
  ([needed]) => {
    if (needed && current.value === undefined) void loadActions()
  },
  { immediate: true },
)
</script>

<template>
  <div ref="element" class="row-action">
    <span class="row-action__text" :class="{ 'row-action__text--muted': !EMPHASIZED_STATES.has(state.kind) }" data-testid="row-recommended">{{ text }}</span>
    <button
      v-if="buttonText !== undefined"
      type="button"
      class="button row-action__button"
      :class="`row-action__button--${state.kind}`"
      :disabled="state.kind === 'loading'"
      :aria-disabled="adding ? 'true' : undefined"
      :tabindex="inActiveRow ? 0 : -1"
      @click.stop="runAction"
    >
      {{ buttonText }}
    </button>
    <p v-if="addFailure" class="row-action__error" role="alert">{{ addFailure }}</p>
  </div>
</template>

<style scoped>
.row-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  min-width: 180px;
}

.row-action__text {
  min-width: 0;
  overflow-wrap: break-word;
  text-wrap: balance;
}

.row-action__text--muted {
  color: var(--text-muted);
}

.row-action__button {
  grid-column: 2;
  height: 28px;
}

.row-action__button--add {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.row-action__button--in-changes {
  border-color: var(--badge-ok-fg);
  background: var(--badge-ok-bg);
  color: var(--badge-ok-fg);
}

.row-action__button--in-changes:hover:not(:disabled) {
  background: var(--badge-ok-bg);
  text-decoration: underline;
}

.row-action__error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--danger);
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
