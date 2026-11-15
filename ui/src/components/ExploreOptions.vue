<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import type { ExploreMode } from '../context.ts'
import {
  downDepthChange,
  GRAPH_SCOPES,
  parseCount,
  shownDownDepth,
  type ExploreFilterChange,
  type GraphOptions,
  type GraphScope,
} from '../explore-options.ts'
import { DUPLICATES_ONLY, EXPLORE_OPTIONS, exploreOptionsLabel, GRAPH_SCOPE, GRAPH_SCOPE_NAMES, LEVELS_DOWN, LEVELS_UP, NODE_LIMIT } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  mode: ExploreMode
  duplicatesOnly: boolean
  up: number
  down: number
  graph: GraphOptions
  hasAnchor: boolean
}>()

const emit = defineEmits<{
  change: [change: ExploreFilterChange]
  'graph-change': [change: Partial<GraphOptions>]
}>()

const FIRST_CONTROL = 'input:not(:disabled)'

const elementId = useId()
const dialogId = `${elementId}-dialog`
const scopeGroupName = `${elementId}-scope`
const isOpen = ref(false)
const container = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLElement | null>(null)

const downDepth = computed(() => shownDownDepth(props.graph, props.down))
const optionsLabel = computed(() => exploreOptionsLabel(props.duplicatesOnly))
const isWholeRoot = computed(() => props.graph.scope === 'whole-root')

async function open(): Promise<void> {
  isOpen.value = true
  await nextTick()
  dialog.value?.querySelector<HTMLElement>(FIRST_CONTROL)?.focus()
}

function closeAndFocusButton(): void {
  isOpen.value = false
  button.value?.focus()
}

function toggle(): void {
  if (isOpen.value) closeAndFocusButton()
  else void open()
}

function keepFocusWhileOpen(event: MouseEvent): void {
  if (isOpen.value) event.preventDefault()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !isOpen.value) return
  event.preventDefault()
  closeAndFocusButton()
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget
  if (next instanceof Node && container.value?.contains(next)) return
  isOpen.value = false
}

function readCount(event: Event, minimum: number, current: number): number | undefined {
  const input = event.target as HTMLInputElement
  const count = parseCount(input.value, minimum)
  if (count === undefined) input.value = String(current)
  return count
}

function changeDuplicatesOnly(event: Event): void {
  emit('change', { duplicatesOnly: (event.target as HTMLInputElement).checked })
}

function chooseScope(scope: GraphScope): void {
  if (scope !== props.graph.scope) emit('graph-change', { scope })
}

function changeUp(event: Event): void {
  const up = readCount(event, 0, props.up)
  if (up !== undefined && up !== props.up) emit('change', { up })
}

function changeDown(event: Event): void {
  const down = readCount(event, 0, downDepth.value)
  if (down === undefined || down === downDepth.value) return
  const change = downDepthChange(props.graph, down)
  if ('filters' in change) emit('change', change.filters)
  else emit('graph-change', change.graph)
}

function changeNodeLimit(event: Event): void {
  const nodeLimit = readCount(event, 1, props.graph.nodeLimit)
  if (nodeLimit !== undefined && nodeLimit !== props.graph.nodeLimit) emit('graph-change', { nodeLimit })
}
</script>

<template>
  <div ref="container" class="explore-options" @focusout="onFocusOut" @keydown="onKeydown">
    <button
      ref="button"
      type="button"
      class="button explore-options__button"
      aria-haspopup="dialog"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? dialogId : undefined"
      @mousedown="keepFocusWhileOpen"
      @click="toggle"
    >
      {{ optionsLabel }}<AppIcon class="explore-options__caret" name="chevron-down" />
    </button>
    <div v-if="isOpen" :id="dialogId" ref="dialog" role="dialog" tabindex="-1" class="explore-options__popover" :aria-label="EXPLORE_OPTIONS">
      <label class="explore-options__choice">
        <input type="checkbox" :checked="duplicatesOnly" @change="changeDuplicatesOnly" />
        <span>{{ DUPLICATES_ONLY }}</span>
      </label>
      <div v-if="mode === 'graph'" class="explore-options__graph">
        <fieldset class="explore-options__scope">
          <legend class="explore-options__legend">{{ GRAPH_SCOPE }}</legend>
          <label v-for="scope in GRAPH_SCOPES" :key="scope" class="explore-options__choice">
            <input
              type="radio"
              :name="scopeGroupName"
              :checked="graph.scope === scope"
              :disabled="scope === 'package' && !hasAnchor"
              @change="chooseScope(scope)"
            />
            <span>{{ GRAPH_SCOPE_NAMES[scope] }}</span>
          </label>
        </fieldset>
        <label class="explore-options__count">
          <span>{{ LEVELS_UP }}</span>
          <input class="explore-options__number" type="number" min="0" step="1" :value="up" :disabled="isWholeRoot" @change="changeUp" />
        </label>
        <label class="explore-options__count">
          <span>{{ LEVELS_DOWN }}</span>
          <input class="explore-options__number" type="number" min="0" step="1" :value="downDepth" @change="changeDown" />
        </label>
        <label class="explore-options__count">
          <span>{{ NODE_LIMIT }}</span>
          <input class="explore-options__number" type="number" min="1" step="1" :value="graph.nodeLimit" @change="changeNodeLimit" />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.explore-options {
  position: relative;
}

.explore-options__button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
}

.explore-options__caret {
  margin-left: 4px;
  color: var(--text-muted);
}

.explore-options__popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  display: grid;
  min-width: 248px;
  padding: 6px 14px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.explore-options__popover:focus:not(:focus-visible) {
  outline: none;
}

.explore-options__choice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  cursor: pointer;
  white-space: nowrap;
}

.explore-options__choice input {
  margin: 0;
  accent-color: var(--accent);
}

.explore-options__graph {
  display: grid;
  gap: 4px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}

.explore-options__scope {
  display: grid;
  margin: 0;
  padding: 0;
  border: 0;
}

.explore-options__legend {
  float: left;
  width: 100%;
  padding: 4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.explore-options__count {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 36px;
}

.explore-options__number {
  width: 84px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
}

.explore-options__number:disabled {
  opacity: 0.55;
}
</style>
