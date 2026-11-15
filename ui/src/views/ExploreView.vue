<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import type { DepKind, NodeId } from '../../../src/model.ts'
import type { RootSummary } from '../api.ts'
import ExploreOptions from '../components/ExploreOptions.vue'
import type { ExploreMode, Selection } from '../context.ts'
import type { NodeDecorations } from '../decorations.ts'
import { DEFAULT_GRAPH_OPTIONS, graphScopeFor, type ExploreFilterChange, type GraphOptions } from '../explore-options.ts'
import { restoreFocusIfLost } from '../keyboard/lost-focus.ts'
import { nodeIdLabel, rootLabel } from '../labels.ts'
import { rootBlocker } from '../scan-state.ts'
import {
  EXPLORE_MODE_LABEL,
  EXPLORE_MODE_NAMES,
  EXPLORE_REQUIRES_ROOT,
  EXPLORE_REQUIRES_ROOT_HINT,
  EXPLORE_ROOT_CHOICES,
  exploreTitle,
  focusOnText,
} from '../vocabulary.ts'
import GraphView from './GraphView.vue'
import TrailView from './TrailView.vue'
import TreeView from './TreeView.vue'

const props = defineProps<{
  mode: ExploreMode
  root?: string
  roots: readonly string[]
  rootSummary?: RootSummary
  scanLoaded: boolean
  revision: string
  anchor?: NodeId
  selected?: NodeId
  kinds: DepKind[]
  duplicatesOnly: boolean
  duplicateVersions: ReadonlyMap<string, string>
  duplicatesError: string | null
  decorations: NodeDecorations
  up: number
  down: number
}>()

const emit = defineEmits<{
  'mode-change': [mode: ExploreMode]
  select: [selection: Selection]
  'focus-on': []
  'filters-change': [change: ExploreFilterChange]
  'choose-root': [root: string]
  'root-busy': []
}>()

const MODES: readonly ExploreMode[] = ['trail', 'tree', 'graph']
const NEXT_MODE_KEYS = new Set(['ArrowRight', 'ArrowDown'])
const PREVIOUS_MODE_KEYS = new Set(['ArrowLeft', 'ArrowUp'])

const elementId = useId()
const titleHeading = ref<HTMLElement | null>(null)
const graphOptions = ref<GraphOptions>({ ...DEFAULT_GRAPH_OPTIONS })
const shownGraphOptions = computed<GraphOptions>(() => ({ ...graphOptions.value, scope: graphScopeFor(graphOptions.value, props.anchor) }))

const blocker = computed(() => (props.root === undefined ? null : rootBlocker(props.root, props.rootSummary, props.scanLoaded)))
const title = computed(() => {
  if (props.root === undefined) return undefined
  const packageLabel = props.anchor === undefined ? undefined : nodeIdLabel(props.anchor)
  return exploreTitle(props.mode, packageLabel, rootLabel(props.root), shownGraphOptions.value.scope)
})
const focusOnLabel = computed(() => {
  if (props.root === undefined || props.selected === undefined || props.selected === props.anchor) return undefined
  return focusOnText(nodeIdLabel(props.selected))
})

async function focusOnSelection(): Promise<void> {
  emit('focus-on')
  await restoreFocusIfLost(document, focusTitle)
}

function focusTitle(): void {
  titleHeading.value?.focus()
}

defineExpose({ focusTitle })

function changeGraphOptions(change: Partial<GraphOptions>): void {
  graphOptions.value = { ...graphOptions.value, ...change }
}

function modeId(mode: ExploreMode): string {
  return `${elementId}-mode-${mode}`
}

async function moveMode(step: number): Promise<void> {
  const position = (MODES.indexOf(props.mode) + step + MODES.length) % MODES.length
  const next = MODES[position]!
  emit('mode-change', next)
  await nextTick()
  document.getElementById(modeId(next))?.focus()
}

function onModeKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const step = NEXT_MODE_KEYS.has(event.key) ? 1 : PREVIOUS_MODE_KEYS.has(event.key) ? -1 : 0
  if (step === 0) return
  event.preventDefault()
  void moveMode(step)
}

function selectInRoot(node: NodeId): void {
  if (props.root !== undefined) emit('select', { root: props.root, node })
}
</script>

<template>
  <section class="explore">
    <div class="explore__toolbar">
      <div class="explore__modes" role="radiogroup" :aria-label="EXPLORE_MODE_LABEL">
        <button
          v-for="option in MODES"
          :id="modeId(option)"
          :key="option"
          type="button"
          role="radio"
          class="explore__mode"
          :class="{ 'explore__mode--checked': option === mode }"
          :aria-checked="option === mode"
          :tabindex="option === mode ? 0 : -1"
          @click="emit('mode-change', option)"
          @keydown="onModeKeydown"
        >
          {{ EXPLORE_MODE_NAMES[option] }}
        </button>
      </div>
      <h2 v-if="title" ref="titleHeading" class="explore__title" tabindex="-1">{{ title }}</h2>
      <div v-if="root !== undefined" class="explore__actions">
        <button v-if="focusOnLabel" type="button" class="button explore__focus-on" @click="focusOnSelection">{{ focusOnLabel }}</button>
        <ExploreOptions
          :mode="mode"
          :duplicates-only="duplicatesOnly"
          :up="up"
          :down="down"
          :graph="shownGraphOptions"
          :has-anchor="anchor !== undefined"
          @change="(change: ExploreFilterChange) => emit('filters-change', change)"
          @graph-change="changeGraphOptions"
        />
      </div>
    </div>
    <div class="explore__body">
      <div v-if="root === undefined" class="explore__placeholder">
        <p class="explore__placeholder-title">{{ EXPLORE_REQUIRES_ROOT }}</p>
        <p class="muted">{{ EXPLORE_REQUIRES_ROOT_HINT }}</p>
        <div v-if="roots.length > 0" class="explore__root-choices" role="group" :aria-label="EXPLORE_ROOT_CHOICES">
          <button v-for="choice in roots" :key="choice" type="button" class="button explore__root-choice" @click="emit('choose-root', choice)">
            {{ rootLabel(choice) }}
          </button>
        </div>
      </div>
      <div v-else-if="blocker" class="explore__placeholder" data-testid="view-blocker" role="status">
        <p class="muted">{{ blocker }}</p>
      </div>
      <TreeView
        v-else-if="mode === 'tree'"
        :root="root"
        :revision="revision"
        :anchor="anchor"
        :selected="selected"
        :importers="rootSummary?.importers"
        :kinds="kinds"
        :duplicates-only="duplicatesOnly"
        :duplicate-versions="duplicateVersions"
        :duplicates-error="duplicatesError"
        :decorations="decorations"
        @select="selectInRoot"
        @root-busy="emit('root-busy')"
      />
      <TrailView
        v-else-if="mode === 'trail'"
        :root="root"
        :revision="revision"
        :anchor="anchor"
        :selected="selected"
        :kinds="kinds"
        :duplicates-only="duplicatesOnly"
        :duplicate-versions="duplicateVersions"
        :duplicates-error="duplicatesError"
        :decorations="decorations"
        @select="selectInRoot"
        @root-busy="emit('root-busy')"
      />
      <GraphView
        v-else
        :root="root"
        :revision="revision"
        :anchor="anchor"
        :selected="selected"
        :kinds="kinds"
        :duplicates-only="duplicatesOnly"
        :duplicate-versions="duplicateVersions"
        :duplicates-error="duplicatesError"
        :decorations="decorations"
        :up="up"
        :down="down"
        :options="shownGraphOptions"
        @select="selectInRoot"
        @depth-change="(change: ExploreFilterChange) => emit('filters-change', change)"
        @root-busy="emit('root-busy')"
      />
    </div>
  </section>
</template>

<style scoped>
.explore {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.explore__toolbar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}

.explore__modes {
  display: inline-flex;
  flex: none;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
}

.explore__mode {
  height: 30px;
  padding: 0 12px;
  border: 0;
  background: var(--surface-raised);
  cursor: pointer;
  white-space: nowrap;
}

.explore__mode + .explore__mode {
  border-left: 1px solid var(--border-strong);
}

.explore__mode:hover:not(.explore__mode--checked) {
  background: var(--surface-hover);
}

.explore__mode--checked {
  background: var(--surface-selected);
  font-weight: 600;
}

.explore__mode:focus-visible {
  outline-offset: -2px;
}

.explore__title {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 14px;
  font-weight: 600;
}

.explore__title:focus:not(:focus-visible) {
  outline: none;
}

.explore__actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.explore__focus-on {
  height: 32px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.explore__root-choices {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}

.explore__root-choice {
  height: 32px;
}

.explore__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.explore__placeholder {
  display: grid;
  flex: 1;
  place-content: center;
  gap: 4px;
  padding: 24px;
  text-align: center;
}

.explore__placeholder p {
  margin: 0;
}

.explore__placeholder-title {
  font-size: 16px;
  font-weight: 600;
}
</style>
