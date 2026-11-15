<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { DepKind, NodeId } from '../../../src/model.ts'
import { createApi, type DependentsResult } from '../api.ts'
import NodeBadges from '../components/NodeBadges.vue'
import WorkspaceName from '../components/WorkspaceName.vue'
import { nodeBadges, type Badge } from '../badges.ts'
import type { NodeDecorations } from '../decorations.ts'
import { nodeIdLabel } from '../labels.ts'
import { isMissingNode, isRootBusy } from '../scan-state.ts'
import {
  buildTrailColumns,
  chipTitle,
  movedTrailPosition,
  trailPathIds,
  type TrailChip,
  type TrailColumn,
  type TrailPosition,
} from '../trail-columns.ts'
import { DEPENDENTS_NEED_PACKAGE, dependentsFocusHint, dependentsLoadFailedText, DUPLICATE_BADGE, notInRootSentence, peerVariantText, scanningMessage } from '../vocabulary.ts'

const props = defineProps<{
  root: string
  revision: string
  anchor?: NodeId
  selected?: NodeId
  kinds: DepKind[]
  duplicatesOnly: boolean
  duplicateVersions: ReadonlyMap<string, string>
  duplicatesError: string | null
  decorations: NodeDecorations
}>()

const emit = defineEmits<{ select: [nodeId: NodeId]; 'root-busy': [] }>()

type LoadedTrail = { root: string; revision: string; anchor: NodeId; kindsKey: string; upward: DependentsResult; columns: TrailColumn[] }

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
const SELECT_KEYS = new Set(['Enter', ' '])
const NO_PATH: ReadonlySet<NodeId> = new Set()

const api = createApi()
const elementId = useId()
const loaded = ref<LoadedTrail | null>(null)
const loadError = ref<string | null>(null)
const rootBusy = ref(false)
const activeChipKey = ref<string | undefined>()
const hoveredChipId = ref<NodeId | undefined>()
const focusedChipId = ref<NodeId | undefined>()
let latestLoad = 0

const kindsKey = computed(() => props.kinds.join(','))

const currentTrail = computed(() => {
  const current = loaded.value
  if (
    !current ||
    current.root !== props.root ||
    current.revision !== props.revision ||
    current.anchor !== props.anchor ||
    current.kindsKey !== kindsKey.value
  ) {
    return null
  }
  return current
})

const columns = computed(() =>
  (currentTrail.value?.columns ?? []).map((column) =>
    column.key === 'children' && props.duplicatesOnly
      ? { ...column, chips: column.chips.filter((chip) => !chip.isImporter && props.duplicateVersions.has(chip.name)) }
      : column,
  ),
)

const emptyText = computed(() => (props.selected === undefined ? DEPENDENTS_NEED_PACKAGE : dependentsFocusHint(nodeIdLabel(props.selected))))

const chipKeys = computed(() => new Set(columns.value.flatMap((column) => column.chips.map((chip) => chipKey(column, chip)))))
const shownChipIds = computed(() => new Set(columns.value.flatMap((column) => column.chips.map((chip) => chip.id))))

const tabStopKey = computed(() => {
  if (activeChipKey.value !== undefined && chipKeys.value.has(activeChipKey.value)) return activeChipKey.value
  const allChips = columns.value.flatMap((column) => column.chips.map((chip) => ({ column, chip })))
  const preferred =
    allChips.find(({ chip }) => chip.id === props.selected) ?? allChips.find(({ chip }) => chip.isAnchor) ?? allChips[0]
  return preferred ? chipKey(preferred.column, preferred.chip) : undefined
})

const pathIds = computed<ReadonlySet<NodeId>>(() => {
  const trail = currentTrail.value
  const chipId = hoveredChipId.value ?? focusedChipId.value
  if (!trail || chipId === undefined || !shownChipIds.value.has(chipId)) return NO_PATH
  return trailPathIds(trail.upward, chipId)
})

function chipKey(column: TrailColumn, chip: TrailChip): string {
  return `${column.key}\u0000${chip.id}`
}

function titleId(columnIndex: number): string {
  return `${elementId}-column-${columnIndex}`
}

function chipElementId(position: TrailPosition): string {
  return `${elementId}-chip-${position.column}-${position.chip}`
}

function selectChip(column: TrailColumn, chip: TrailChip): void {
  activeChipKey.value = chipKey(column, chip)
  emit('select', chip.id)
}

function onChipFocus(column: TrailColumn, chip: TrailChip): void {
  activeChipKey.value = chipKey(column, chip)
  focusedChipId.value = chip.id
}

function onChipBlur(chip: TrailChip): void {
  if (focusedChipId.value === chip.id) focusedChipId.value = undefined
}

function onChipLeave(chip: TrailChip): void {
  if (hoveredChipId.value === chip.id) hoveredChipId.value = undefined
}

function onChipKeydown(event: KeyboardEvent, position: TrailPosition): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const column = columns.value[position.column]
  const chip = column?.chips[position.chip]
  if (!column || !chip) return
  if (SELECT_KEYS.has(event.key)) {
    event.preventDefault()
    selectChip(column, chip)
    return
  }
  if (!NAVIGATION_KEYS.has(event.key)) return
  event.preventDefault()
  const trail = currentTrail.value
  const onPath = trail ? trailPathIds(trail.upward, chip.id) : NO_PATH
  const target = movedTrailPosition(columns.value, position, event.key, onPath)
  if (target) document.getElementById(chipElementId(target))?.focus()
}

function badgesOf(chip: TrailChip): Badge[] {
  return nodeBadges(props.decorations[chip.id], { isDirect: chip.isDirect, compact: true, version: chip.version })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  const request = ++latestLoad
  const { root, revision, anchor } = props
  loadError.value = null
  rootBusy.value = false
  if (anchor === undefined) return
  try {
    const [upward, downward] = await Promise.all([
      api.dependents(root, anchor, 50, props.kinds),
      api.children(root, anchor, 1, props.kinds),
    ])
    if (request !== latestLoad) return
    loaded.value = { root, revision, anchor, kindsKey: kindsKey.value, upward, columns: buildTrailColumns(upward, downward) }
  } catch (error) {
    if (request !== latestLoad) return
    if (isRootBusy(error)) {
      rootBusy.value = true
      emit('root-busy')
      return
    }
    loadError.value = isMissingNode(error) ? notInRootSentence(nodeIdLabel(anchor), root) : dependentsLoadFailedText(nodeIdLabel(anchor), messageOf(error))
  }
}

watch([() => props.root, () => props.revision, () => props.anchor, kindsKey], () => void load(), { immediate: true })
</script>

<template>
  <div class="trail">
    <p v-if="rootBusy" class="trail__notice" role="status">{{ scanningMessage(root) }}</p>
    <p v-if="loadError" class="trail__notice trail__notice--error" role="alert">{{ loadError }}</p>
    <p v-if="duplicatesError" class="trail__notice" role="status">{{ duplicatesError }}</p>
    <p v-if="anchor === undefined" class="trail__notice" role="status">{{ emptyText }}</p>
    <div class="trail__columns">
      <div v-for="(column, columnIndex) in columns" :key="column.key" class="trail__column" data-testid="trail-column">
        <h3 :id="titleId(columnIndex)" class="panel-heading trail__title">{{ column.title }}</h3>
        <div class="trail__chips" role="listbox" :aria-labelledby="titleId(columnIndex)">
          <div
            v-for="(chip, chipIndex) in column.chips"
            :id="chipElementId({ column: columnIndex, chip: chipIndex })"
            :key="chip.id"
            role="option"
            class="trail__chip"
            :class="{
              'trail__chip--anchor': chip.isAnchor,
              'trail__chip--selected': chip.id === selected,
              'trail__chip--on-path': pathIds.has(chip.id),
            }"
            data-testid="trail-chip"
            :aria-selected="chip.id === selected ? 'true' : 'false'"
            :tabindex="chipKey(column, chip) === tabStopKey ? 0 : -1"
            :title="chipTitle(chip)"
            @click="selectChip(column, chip)"
            @keydown="onChipKeydown($event, { column: columnIndex, chip: chipIndex })"
            @focus="onChipFocus(column, chip)"
            @blur="onChipBlur(chip)"
            @mouseenter="hoveredChipId = chip.id"
            @mouseleave="onChipLeave(chip)"
          >
            <WorkspaceName v-if="chip.isImporter" :name="chip.label" />
            <span v-else class="mono">{{ chip.label }}</span>
            <span v-if="chip.path" class="trail__path muted">{{ chip.path }}</span>
            <span v-if="chip.variant" class="trail__path muted">{{ peerVariantText(chip.variant) }}</span>
            <span v-if="!chip.isImporter && duplicateVersions.has(chip.name)" class="badge badge--warn" :title="duplicateVersions.get(chip.name)">{{ DUPLICATE_BADGE }}</span>
            <NodeBadges :badges="badgesOf(chip)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.trail__notice {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
}

.trail__notice--error {
  color: var(--danger);
}

.trail__columns {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

.trail__column {
  display: flex;
  flex: 1 0 176px;
  flex-direction: column;
  max-width: 320px;
  min-height: 0;
  border-right: 1px solid var(--border);
}

.trail__title {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-panel);
}

.trail__chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  padding: 8px;
  overflow-y: auto;
}

.trail__chip {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  overflow-wrap: anywhere;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  text-align: left;
  cursor: pointer;
}

.trail__chip:hover {
  background: var(--surface-hover);
}

.trail__chip--anchor {
  font-weight: 600;
}

.trail__chip--on-path {
  border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
}

.trail__chip--selected {
  border-color: var(--accent);
  background: var(--surface-selected);
}

.trail__chip--selected:hover {
  background: var(--surface-selected);
}

.trail__path {
  font-size: 12px;
}
</style>
