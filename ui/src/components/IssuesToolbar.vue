<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import type { DepKind } from '../../../src/model.ts'
import type { IssueKind } from '../../../src/query/issues.ts'
import { DEP_KINDS, type FilterChange, type IssueGrouping } from '../context.ts'
import { ISSUE_KINDS, toggledKinds, toggledTypes } from '../issues-model.ts'
import { useMenuButton } from '../keyboard/use-menu-button.ts'
import {
  ADD_RECOMMENDED_FIXES,
  checkDetailsTitle,
  DEPENDENCY_TYPES,
  GROUP_BY,
  GROUPING_NAMES,
  ISSUE_TYPES_LABEL,
  lastCheckText,
  typeToggleText,
  VIEW_MENU,
} from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  types: IssueKind[]
  counts: Readonly<Record<IssueKind, number>>
  group: IssueGrouping
  kinds: DepKind[]
  status?: EnrichmentStatus
  canAddRecommended: boolean
}>()

const emit = defineEmits<{ change: [change: FilterChange]; 'add-recommended': [] }>()

type ViewItem = {
  key: string
  role: 'menuitemradio' | 'menuitemcheckbox'
  label: string
  checked: boolean
  disabled: boolean
  keepsOpen: boolean
  run: () => void
}
type ViewSection = { key: string; label: string; entries: { item: ViewItem; index: number }[] }

const CLOCK_TICK_MS = 30_000
const GROUPINGS: readonly IssueGrouping[] = ['package', 'direct']

const elementId = useId()
const viewButtonId = `${elementId}-view-button`
const viewMenuId = `${elementId}-view-menu`
const checkTextId = `${elementId}-check-text`
const checkDetailsId = `${elementId}-check-details`
const addButton = ref<HTMLButtonElement | null>(null)
const now = ref(Date.now())
const clock = window.setInterval(() => {
  now.value = Date.now()
}, CLOCK_TICK_MS)

onBeforeUnmount(() => window.clearInterval(clock))

const checkText = computed(() => (props.status === undefined ? '' : lastCheckText(props.status, now.value)))
const checkTitle = computed(() => (props.status === undefined ? undefined : checkDetailsTitle(props.status)))

function toggleType(kind: IssueKind): void {
  const types = toggledTypes(props.types, kind, props.counts)
  if (types !== undefined) emit('change', { types })
}

function chooseGroup(group: IssueGrouping): void {
  if (group !== props.group) emit('change', { group })
}

function toggleKind(kind: DepKind): void {
  const kinds = toggledKinds(props.kinds, kind)
  if (kinds !== undefined) emit('change', { kinds })
}

const groupItems = computed<ViewItem[]>(() =>
  GROUPINGS.map((group) => ({
    key: `group-${group}`,
    role: 'menuitemradio',
    label: GROUPING_NAMES[group],
    checked: props.group === group,
    disabled: false,
    keepsOpen: false,
    run: () => chooseGroup(group),
  })),
)
const kindItems = computed<ViewItem[]>(() =>
  DEP_KINDS.map((kind) => ({
    key: `kind-${kind}`,
    role: 'menuitemcheckbox',
    label: kind,
    checked: props.kinds.includes(kind),
    disabled: toggledKinds(props.kinds, kind) === undefined,
    keepsOpen: true,
    run: () => toggleKind(kind),
  })),
)
const viewItems = computed(() => [...groupItems.value, ...kindItems.value])
const viewSections = computed<ViewSection[]>(() => [
  { key: 'group', label: GROUP_BY, entries: groupItems.value.map((item, index) => ({ item, index })) },
  { key: 'kinds', label: DEPENDENCY_TYPES, entries: kindItems.value.map((item, index) => ({ item, index: groupItems.value.length + index })) },
])

const {
  isOpen,
  container,
  button,
  menu,
  choose,
  onButtonMousedown,
  onButtonClick,
  onButtonKeydown,
  onButtonKeyup,
  onMenuKeydown,
  onFocusOut,
} = useMenuButton({
  labels: () => viewItems.value.map((item) => item.label),
  isDisabled: (index) => viewItems.value[index]?.disabled ?? true,
  keepsOpen: (index) => viewItems.value[index]?.keepsOpen ?? false,
  onChoose: (index) => viewItems.value[index]?.run(),
})

function focusAddRecommended(): void {
  addButton.value?.focus()
}

defineExpose({ focusAddRecommended })
</script>

<template>
  <div class="issues-toolbar">
    <div class="issues-toolbar__types" role="group" :aria-label="ISSUE_TYPES_LABEL">
      <button
        v-for="kind in ISSUE_KINDS"
        :key="kind"
        type="button"
        class="issues-toolbar__type"
        :class="{ 'issues-toolbar__type--on': types.includes(kind) }"
        :aria-pressed="types.includes(kind)"
        :disabled="counts[kind] === 0"
        @click="toggleType(kind)"
      >
        {{ typeToggleText(kind, counts[kind]) }}
      </button>
    </div>
    <span v-if="checkText" :id="checkTextId" class="issues-toolbar__check" tabindex="0" role="group" :aria-labelledby="checkTextId" :aria-describedby="checkDetailsId" :title="checkTitle">{{ checkText }}</span>
    <span v-if="checkTitle" :id="checkDetailsId" hidden>{{ checkTitle }}</span>
    <div class="issues-toolbar__end">
      <div ref="container" class="view-menu" @focusout="onFocusOut">
        <button
          :id="viewButtonId"
          ref="button"
          type="button"
          class="button view-menu__button"
          aria-haspopup="menu"
          :aria-expanded="isOpen"
          :aria-controls="isOpen ? viewMenuId : undefined"
          @mousedown="onButtonMousedown"
          @click="onButtonClick"
          @keydown="onButtonKeydown"
          @keyup="onButtonKeyup"
        >
          {{ VIEW_MENU }}<AppIcon class="view-menu__caret" name="chevron-down" />
        </button>
        <div
          v-if="isOpen"
          :id="viewMenuId"
          ref="menu"
          role="menu"
          class="view-menu__popover"
          :aria-labelledby="viewButtonId"
          @keydown="onMenuKeydown"
          @mousedown.prevent
        >
          <div v-for="section in viewSections" :key="section.key" role="group" class="view-menu__section" :aria-label="section.label">
            <div class="view-menu__heading" aria-hidden="true">{{ section.label }}</div>
            <div
              v-for="{ item, index } in section.entries"
              :key="item.key"
              :role="item.role"
              tabindex="-1"
              data-menu-item
              class="view-menu__item"
              :aria-checked="item.checked"
              :aria-disabled="item.disabled ? 'true' : undefined"
              @click="choose(index)"
            >
              <span class="view-menu__check" aria-hidden="true"><AppIcon v-if="item.checked" name="check" /></span>
              <span>{{ item.label }}</span>
            </div>
          </div>
        </div>
      </div>
      <button ref="addButton" type="button" class="button issues-toolbar__add" :disabled="!canAddRecommended" @click="emit('add-recommended')">
        {{ ADD_RECOMMENDED_FIXES }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.issues-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.issues-toolbar__types {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
}

.issues-toolbar__type {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
}

.issues-toolbar__type:hover:not(:disabled) {
  background: var(--surface-hover);
}

.issues-toolbar__type--on,
.issues-toolbar__type--on:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--surface-selected);
  color: var(--text);
  font-weight: 600;
}

.issues-toolbar__type:disabled {
  cursor: default;
  opacity: 0.55;
}

.issues-toolbar__check {
  color: var(--text-muted);
  white-space: nowrap;
}

.issues-toolbar__end {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.issues-toolbar__add,
.view-menu__button {
  height: 32px;
}

.view-menu {
  position: relative;
}

.view-menu__button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.view-menu__caret {
  margin-left: 4px;
  color: var(--text-muted);
}

.view-menu__popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  min-width: 220px;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.view-menu__section + .view-menu__section {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.view-menu__heading {
  padding: 4px 14px 2px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.view-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
}

.view-menu__item:hover {
  background: var(--surface-hover);
}

.view-menu__item:focus {
  outline: none;
  background: var(--surface-selected);
}

.view-menu__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.view-menu__item[aria-disabled='true'] {
  color: var(--text-muted);
  cursor: default;
}

.view-menu__item[aria-disabled='true']:hover {
  background: none;
}

.view-menu__check {
  display: inline-flex;
  width: 16px;
  color: var(--accent);
  text-align: center;
}
</style>
