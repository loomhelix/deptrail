<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import type { GitInfo } from '../api.ts'
import { pickerModel, type PickerOption } from '../ref-picker-model.ts'
import { FILTER_REFS_PLACEHOLDER, moreRefsText, noRefMatchText } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ info: Extract<GitInfo, { available: true }>; includeWorking: boolean; current?: string; label: string }>()

const emit = defineEmits<{ pick: [value: string]; cancel: [] }>()

const elementId = useId()
const listId = `${elementId}-list`
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const filter = ref('')
const now = Date.now()

const model = computed(() => pickerModel(props.info, filter.value, { includeWorking: props.includeWorking, now }))
const options = computed<PickerOption[]>(() => model.value.groups.flatMap((group) => group.options))
const activeIndex = ref(initialIndex())

function initialIndex(): number {
  const position = options.value.findIndex((option) => option.value === props.current)
  return position === -1 ? 0 : position
}

function optionId(index: number): string {
  return `${elementId}-option-${index}`
}

function indexOf(option: PickerOption): number {
  return options.value.indexOf(option)
}

const activeId = computed(() => (options.value.length === 0 ? undefined : optionId(activeIndex.value)))

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const active = list.value?.querySelector<HTMLElement>(`#${CSS.escape(optionId(activeIndex.value))}`)
    active?.scrollIntoView({ block: 'nearest' })
  })
}

function moveTo(index: number): void {
  if (options.value.length === 0) return
  activeIndex.value = Math.min(Math.max(index, 0), options.value.length - 1)
  scrollActiveIntoView()
}

function pickActive(): void {
  const option = options.value[activeIndex.value]
  if (option !== undefined) emit('pick', option.value)
}

function onKeydown(event: KeyboardEvent): void {
  const moves: Record<string, () => void> = {
    ArrowDown: () => moveTo(activeIndex.value + 1),
    ArrowUp: () => moveTo(activeIndex.value - 1),
    Home: () => moveTo(0),
    End: () => moveTo(options.value.length - 1),
    Enter: pickActive,
    Escape: () => emit('cancel'),
  }
  const move = moves[event.key]
  if (move === undefined) return
  event.preventDefault()
  event.stopPropagation()
  move()
}

watch(filter, () => {
  activeIndex.value = 0
  scrollActiveIntoView()
})

function focus(): void {
  input.value?.focus()
  scrollActiveIntoView()
}

defineExpose({ focus })
</script>

<template>
  <div class="ref-picker">
    <input
      ref="input"
      v-model="filter"
      class="ref-picker__filter"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      aria-expanded="true"
      :aria-label="label"
      :aria-controls="listId"
      :aria-activedescendant="activeId"
      :placeholder="FILTER_REFS_PLACEHOLDER"
      @keydown="onKeydown"
    />
    <div :id="listId" ref="list" role="listbox" class="ref-picker__list" :aria-label="label">
      <div v-for="group in model.groups" :key="group.label" role="group" :aria-label="group.label" class="ref-picker__group">
        <div class="ref-picker__group-label" aria-hidden="true">{{ group.label }}</div>
        <div
          v-for="option in group.options"
          :id="optionId(indexOf(option))"
          :key="option.key"
          role="option"
          class="ref-picker__option"
          :class="{ 'ref-picker__option--active': indexOf(option) === activeIndex }"
          :aria-selected="indexOf(option) === activeIndex"
          @mousedown.prevent
          @mousemove="activeIndex = indexOf(option)"
          @click="emit('pick', option.value)"
        >
          <span class="ref-picker__check" aria-hidden="true"><AppIcon v-if="option.value === current" name="check" /></span>
          <span class="ref-picker__label mono">{{ option.label }}</span>
          <span v-if="option.detail" class="ref-picker__detail">{{ option.detail }}</span>
        </div>
      </div>
    </div>
    <p v-if="model.optionCount === 0" class="ref-picker__note">{{ noRefMatchText(filter.trim()) }}</p>
    <p v-if="model.hiddenCount > 0" class="ref-picker__note">{{ moreRefsText(model.hiddenCount) }}</p>
  </div>
</template>

<style scoped>
.ref-picker {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-height: inherit;
}

.ref-picker__filter {
  height: 32px;
  margin: 8px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}

.ref-picker__list {
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 4px;
}

.ref-picker__group-label {
  padding: 8px 14px 4px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.ref-picker__option {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  padding: 6px 14px 6px 10px;
  cursor: pointer;
}

.ref-picker__option--active {
  background: var(--surface-selected);
}

.ref-picker__check {
  color: var(--accent);
}

.ref-picker__label {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: normal;
}

.ref-picker__detail {
  color: var(--text-muted);
  font-size: 13px;
}

.ref-picker__note {
  margin: 0;
  padding: 8px 14px;
  color: var(--text-muted);
  font-size: 13px;
  white-space: normal;
}
</style>
