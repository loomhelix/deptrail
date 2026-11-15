<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import type { DepKind, NodeId } from '../../../src/model.ts'
import type { NodeView } from '../../../src/query/lookup.ts'
import { createApi, type ChildrenResult, type RootSummary } from '../api.ts'
import AppIcon from '../components/AppIcon.vue'
import NodeBadges from '../components/NodeBadges.vue'
import WorkspaceName from '../components/WorkspaceName.vue'
import { nodeBadges, type Badge } from '../badges.ts'
import type { NodeDecorations } from '../decorations.ts'
import type { RovingItem } from '../keyboard/roving-list.ts'
import { useRovingList } from '../keyboard/use-roving-list.ts'
import { nodeIdLabel, nodeLabel } from '../labels.ts'
import { isMissingNode, isRootBusy } from '../scan-state.ts'
import { flattenVisible, overviewRows, rangeText, ROW_HEIGHT, windowRange, type VisibleRow } from '../visible-tree.ts'
import {
  collapseName,
  dependenciesLoadFailedText,
  DUPLICATE_BADGE,
  expandName,
  EXPLORE_MODE_NAMES,
  FAILED_TO_LOAD,
  LISTED_WORKSPACE_PACKAGE_TEXTS,
  NO_DUPLICATES_BELOW_ROW,
  notInRootSentence,
  scanningMessage,
  SHOWN_ABOVE,
} from '../vocabulary.ts'

const props = defineProps<{
  root: string
  revision: string
  anchor?: NodeId
  selected?: NodeId
  importers?: RootSummary['importers']
  kinds: DepKind[]
  duplicatesOnly: boolean
  duplicateVersions: ReadonlyMap<string, string>
  duplicatesError: string | null
  decorations: NodeDecorations
}>()

const emit = defineEmits<{ select: [nodeId: NodeId]; 'root-busy': [] }>()

type ChildrenFailure = { reason: string; isMissing: boolean }

const FALLBACK_VIEWPORT_HEIGHT = 600
const INDENT_PX = 16
const BASE_INDENT_PX = 6
const OVERVIEW_KEY_PREFIX = 'overview\u0000'
const NO_CHILDREN: ReadonlyMap<NodeId, ChildrenResult['rows']> = new Map()
const NOTHING_EXPANDED: ReadonlySet<NodeId> = new Set()

const api = createApi()
const elementId = useId()

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(FALLBACK_VIEWPORT_HEIGHT)
const startView = shallowRef<NodeView | null>(null)
const childrenById = shallowRef<ReadonlyMap<NodeId, ChildrenResult['rows']>>(new Map())
const expandedIds = shallowRef<ReadonlySet<NodeId>>(new Set())
const loadError = ref<string | null>(null)
const rootBusy = ref(false)
const failures = shallowRef<ReadonlyMap<NodeId, ChildrenFailure>>(new Map())
const inflight = new Map<NodeId, Promise<ChildrenResult | undefined>>()
let generation = 0
let lastStart: string | undefined
let resizeObserver: ResizeObserver | undefined

const kindsKey = computed(() => props.kinds.join(','))
const duplicateNames = computed(() => (props.duplicatesOnly ? new Set(props.duplicateVersions.keys()) : null))
const overviewIds = computed(() => overviewRows(props.importers ?? [], NO_CHILDREN, NOTHING_EXPANDED).map((row) => row.node.id))
const startKey = computed(() => props.anchor ?? `${OVERVIEW_KEY_PREFIX}${overviewIds.value.join('\n')}`)

const visibleRows = computed(() => {
  if (props.anchor === undefined) return overviewRows(props.importers ?? [], childrenById.value, expandedIds.value, duplicateNames.value)
  return startView.value === null ? [] : flattenVisible(startView.value, childrenById.value, expandedIds.value, duplicateNames.value)
})
const rowsByRovingId = computed(() => new Map(visibleRows.value.map((row, index) => [rovingIdOf(row.key), { row, index }])))
const rovingItems = computed<RovingItem[]>(() =>
  visibleRows.value.map((row) => ({
    id: rovingIdOf(row.key),
    parentId: row.parentKey === undefined ? undefined : rovingIdOf(row.parentKey),
    expandable: row.hasChildren,
    expanded: row.expanded,
  })),
)

const { activeId, tabIndexOf, onKeydown, focusActive } = useRovingList(rovingItems, {
  expand: expandRow,
  collapse: collapseRow,
  activate: activateRow,
})

const activeIndex = computed(() => (activeId.value === undefined ? -1 : (rowsByRovingId.value.get(activeId.value)?.index ?? -1)))
const range = computed(() => windowRange(scrollTop.value, viewportHeight.value, visibleRows.value.length))
const windowRows = computed(() => {
  const { start, end } = range.value
  const shown = visibleRows.value.slice(start, end).map((row, offset) => ({ row, index: start + offset }))
  const active = activeIndex.value
  if (active >= 0 && (active < start || active >= end)) shown.push({ row: visibleRows.value[active]!, index: active })
  return shown
})
const spacerHeight = computed(() => `${visibleRows.value.length * ROW_HEIGHT}px`)
const isEmptyFiltered = computed(
  () => props.anchor !== undefined && props.duplicatesOnly && visibleRows.value.length === 1 && startView.value !== null,
)

function rovingIdOf(rowKey: string): string {
  return `${elementId}:${rowKey}`
}

function labelId(index: number): string {
  return `${elementId}-label-${index}`
}

function rowOf(rovingId: string): VisibleRow | undefined {
  return rowsByRovingId.value.get(rovingId)?.row
}

function expandRow(rovingId: string): void {
  const row = rowOf(rovingId)
  if (row?.hasChildren && !row.expanded) void toggle(row.node.id)
}

function collapseRow(rovingId: string): void {
  const row = rowOf(rovingId)
  if (row?.expanded) void toggle(row.node.id)
}

function activateRow(rovingId: string): void {
  const row = rowOf(rovingId)
  if (row) emit('select', row.node.id)
}

function onRowClick(row: VisibleRow): void {
  activeId.value = rovingIdOf(row.key)
  emit('select', row.node.id)
}

async function toggleFromPointer(row: VisibleRow): Promise<void> {
  activeId.value = rovingIdOf(row.key)
  const toggled = toggle(row.node.id)
  await nextTick()
  focusActive()
  await toggled
}

function scrollRowIntoView(index: number): void {
  const element = scroller.value
  if (!element) return
  const top = index * ROW_HEIGHT
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  scrollTop.value = element.scrollTop
}

async function revealActiveRow(): Promise<void> {
  if (activeIndex.value < 0) return
  scrollRowIntoView(activeIndex.value)
  await nextTick()
  focusActive()
}

function onRowKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  const before = activeId.value
  onKeydown(event)
  if (activeId.value !== before) void revealActiveRow()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rememberChildren(id: NodeId, rows: ChildrenResult['rows']): void {
  childrenById.value = new Map(childrenById.value).set(id, rows)
}

function recordFailure(id: NodeId, failure: ChildrenFailure | undefined): void {
  const next = new Map(failures.value)
  if (failure === undefined) next.delete(id)
  else next.set(id, failure)
  failures.value = next
}

function failureOf(id: NodeId, error: unknown): ChildrenFailure {
  if (isMissingNode(error)) return { reason: notInRootSentence(nodeIdLabel(id), props.root), isMissing: true }
  return { reason: messageOf(error), isMissing: false }
}

function anchorFailureText(anchor: NodeId): string {
  const failure = failures.value.get(anchor)
  return failure?.isMissing === true ? failure.reason : dependenciesLoadFailedText(nodeIdLabel(anchor), failure?.reason)
}

function markRootBusy(): void {
  if (rootBusy.value) return
  rootBusy.value = true
  emit('root-busy')
}

function fetchChildren(id: NodeId): Promise<ChildrenResult | undefined> {
  const pending = inflight.get(id)
  if (pending) return pending
  const current = generation
  recordFailure(id, undefined)
  const request = (async () => {
    try {
      const result = await api.children(props.root, id, 1, props.kinds)
      if (current !== generation) return undefined
      rememberChildren(id, result.rows)
      return result
    } catch (error) {
      if (current !== generation) return undefined
      if (isRootBusy(error)) markRootBusy()
      else recordFailure(id, failureOf(id, error))
      return undefined
    } finally {
      if (current === generation) inflight.delete(id)
    }
  })()
  inflight.set(id, request)
  return request
}

function startIdentity(): string {
  return [props.root, startKey.value, kindsKey.value].join('\n')
}

function expansionToKeep(): ReadonlySet<NodeId> | undefined {
  const identity = startIdentity()
  const keeps = identity === lastStart
  lastStart = identity
  return keeps ? expandedIds.value : undefined
}

async function restart(): Promise<void> {
  const keptExpansion = expansionToKeep()
  generation += 1
  loadError.value = null
  rootBusy.value = false
  startView.value = null
  inflight.clear()
  failures.value = new Map()
  childrenById.value = new Map()
  scrollTop.value = 0
  if (scroller.value) scroller.value.scrollTop = 0
  const anchor = props.anchor
  if (anchor === undefined) {
    const initiallyExpanded = keptExpansion ?? (overviewIds.value.length === 1 ? overviewIds.value : [])
    expandedIds.value = new Set(initiallyExpanded)
    for (const id of initiallyExpanded) void fetchChildren(id)
    return
  }
  expandedIds.value = new Set([anchor, ...(keptExpansion ?? [])])
  const current = generation
  const result = await fetchChildren(anchor)
  if (current !== generation) return
  if (!result) {
    if (!rootBusy.value) loadError.value = anchorFailureText(anchor)
    return
  }
  startView.value = result.node
  for (const id of expandedIds.value) if (id !== anchor) void fetchChildren(id)
}

async function toggle(id: NodeId): Promise<void> {
  const next = new Set(expandedIds.value)
  if (next.delete(id)) {
    expandedIds.value = next
    return
  }
  next.add(id)
  expandedIds.value = next
  if (!childrenById.value.has(id)) await fetchChildren(id)
}

function onScroll(): void {
  scrollTop.value = scroller.value?.scrollTop ?? 0
}

function measureViewport(): void {
  const height = scroller.value?.clientHeight ?? 0
  if (height > 0) viewportHeight.value = height
}

function duplicateTitle(name: string): string | undefined {
  return props.duplicateVersions.get(name)
}

function badgesOf(row: VisibleRow): Badge[] {
  return nodeBadges(props.decorations[row.node.id], { isDirect: row.parentIsImporter, compact: false, version: row.node.version })
}

function indentOf(depth: number): string {
  return `${BASE_INDENT_PX + depth * INDENT_PX}px`
}

watch([() => props.root, () => props.revision, startKey, kindsKey], () => void restart(), { immediate: true })

onMounted(() => {
  measureViewport()
  if (scroller.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measureViewport)
    resizeObserver.observe(scroller.value)
  }
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="tree">
    <p v-if="rootBusy" class="tree__notice" role="status">{{ scanningMessage(root) }}</p>
    <p v-if="loadError" class="tree__notice tree__notice--error" role="alert">{{ loadError }}</p>
    <p v-if="duplicatesError" class="tree__notice" role="status">{{ duplicatesError }}</p>
    <p v-if="isEmptyFiltered" class="tree__notice" role="status">{{ NO_DUPLICATES_BELOW_ROW }}</p>
    <div ref="scroller" class="tree__scroller" data-testid="tree-scroller" @scroll.passive="onScroll">
      <div class="tree__spacer" role="tree" :aria-label="EXPLORE_MODE_NAMES.tree" :style="{ height: spacerHeight }">
        <div
          v-for="{ row, index } in windowRows"
          :key="row.key"
          class="tree__row"
          :class="{ 'tree__row--selected': row.node.id === selected }"
          data-testid="tree-row"
          role="treeitem"
          :data-roving-id="rovingIdOf(row.key)"
          :tabindex="tabIndexOf(rovingIdOf(row.key))"
          :aria-selected="row.node.id === selected"
          :aria-level="row.depth + 1"
          :aria-posinset="row.position"
          :aria-setsize="row.setSize"
          :aria-expanded="row.hasChildren ? row.expanded : undefined"
          :aria-labelledby="labelId(index)"
          :style="{ top: `${index * ROW_HEIGHT}px`, paddingLeft: indentOf(row.depth) }"
          @click="onRowClick(row)"
          @keydown="onRowKeydown"
          @focus="activeId = rovingIdOf(row.key)"
        >
          <button
            v-if="row.hasChildren"
            type="button"
            tabindex="-1"
            class="tree__toggle"
            :aria-label="row.expanded ? collapseName(row.node.name) : expandName(row.node.name)"
            @click.stop="toggleFromPointer(row)"
          >
            <template v-if="row.loading && !failures.has(row.node.id)">…</template>
            <AppIcon v-else :name="row.expanded ? 'chevron-down' : 'chevron-right'" :size="20" />
          </button>
          <span v-else class="tree__toggle tree__toggle--empty" aria-hidden="true"></span>
          <span :id="labelId(index)" class="tree__label">
            <span class="tree__name mono"><WorkspaceName v-if="row.node.isImporter" :name="nodeLabel(row.node)" /><template v-else>{{ nodeLabel(row.node) }}</template></span>
            <span v-if="row.kind && row.kind !== 'prod'" class="badge">{{ row.kind }}</span>
            <span v-if="rangeText(row.range, row.node.version)" class="tree__range muted mono">{{ rangeText(row.range, row.node.version) }}</span>
            <span v-if="!row.node.isImporter && duplicateTitle(row.node.name)" class="badge badge--warn" :title="duplicateTitle(row.node.name)">{{ DUPLICATE_BADGE }}</span>
            <NodeBadges :badges="badgesOf(row)" />
            <span v-if="row.shownAbove" class="tree__shown-above muted">{{ SHOWN_ABOVE }}</span>
            <span v-if="row.listed" class="tree__shown-above muted" data-testid="tree-listed">{{ LISTED_WORKSPACE_PACKAGE_TEXTS[row.listed] }}</span>
            <span v-if="failures.has(row.node.id)" class="tree__failed" :title="failures.get(row.node.id)?.reason">{{ FAILED_TO_LOAD }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.tree__notice {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
}

.tree__notice--error {
  color: var(--danger);
}

.tree__scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.tree__spacer {
  position: relative;
  min-width: 100%;
  width: max-content;
}

.tree__row {
  position: absolute;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding-right: 14px;
  white-space: nowrap;
  cursor: pointer;
}

.tree__row:focus-visible {
  outline-offset: -2px;
}

.tree__row:hover {
  background: var(--surface-hover);
}

.tree__label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.tree__row--selected {
  background: var(--surface-selected);
  box-shadow: inset 3px 0 0 var(--accent);
}

.tree__toggle {
  display: inline-grid;
  flex: none;
  place-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.tree__toggle:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.tree__toggle--empty {
  cursor: default;
}

.tree__row:hover .tree__name {
  color: var(--accent);
  text-decoration: underline;
}

.tree__range,
.tree__shown-above {
  font-size: 12px;
}

.tree__shown-above {
  font-style: italic;
}

.tree__failed {
  color: var(--danger);
  font-size: 12px;
}
</style>
