<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, toRef, useId } from 'vue'
import type { NodeId } from '../../../src/model.ts'
import { createApi, type GitInfo } from '../api.ts'
import { baseLabel, compareSummary, rootsInScope, type SideLabels } from '../compare-model.ts'
import { defaultBase, SHOWN_SOURCE, shortCommit, WORKING_KEY, type ShownSourceState } from '../source.ts'
import { useComparison } from '../use-comparison.ts'
import {
  BASE,
  buildingText,
  CHECKING_RISK,
  COMPARE_LABEL,
  compareFailedText,
  compareUnavailableText,
  COMPARING,
  LOADING_REFS,
  mergeBaseText,
  NO_MERGE_BASE,
  SAME_SOURCE,
  SELECT_BASE,
  SINCE_MERGE_BASE,
  sourceLabel,
  SWAP,
} from '../vocabulary.ts'
import AppIcon from '../components/AppIcon.vue'
import CompareRootSection from '../components/CompareRootSection.vue'
import RefPicker from '../components/RefPicker.vue'

const props = defineProps<{ scope?: string; base?: string; mergeBase: boolean; enrichmentRevision: number }>()

const emit = defineEmits<{
  'change-base': [base: string]
  'change-merge-base': [mergeBase: boolean]
  swap: [base: string]
  select: [root: string, node: NodeId]
}>()

const shown = inject(SHOWN_SOURCE, { source: { kind: 'working' } } satisfies ShownSourceState)
const source = shown.source
const api = createApi()
const elementId = useId()
const pickerId = `${elementId}-picker`
const mergeBaseId = `${elementId}-merge-base`
const info = ref<GitInfo | null>(null)
const picking = ref(false)
const baseButton = ref<HTMLButtonElement | null>(null)
const picker = ref<InstanceType<typeof RefPicker> | null>(null)

const available = computed(() => (info.value?.available === true ? info.value : null))
const baseValue = computed(() => (info.value === null ? undefined : (props.base ?? defaultBase(info.value, source))))
const targetValue = source.kind === 'working' ? WORKING_KEY : source.ref
const isSameSource = computed(() => baseValue.value === targetValue)

const { state } = useComparison(api, {
  target: source,
  base: computed(() => baseValue.value ?? WORKING_KEY),
  mergeBase: toRef(props, 'mergeBase'),
  enrichmentRevision: toRef(props, 'enrichmentRevision'),
  active: computed(() => available.value !== null && baseValue.value !== undefined && !isSameSource.value),
})

const foundMergeBase = computed(() => (state.value.mergeBase.state === 'found' ? { commit: state.value.mergeBase.commit } : undefined))
const labels = computed<SideLabels>(() => ({ base: baseLabel(baseValue.value ?? WORKING_KEY, foundMergeBase.value), target: sourceLabel(source) }))
const targetText = computed(() => (source.kind === 'commit' ? `${sourceLabel(source)} · ${shortCommit(source.commit)}` : sourceLabel(source)))
const roots = computed(() => (state.value.response === undefined ? [] : rootsInScope(state.value.response, props.scope)))
const summary = computed(() => (state.value.response === undefined ? '' : compareSummary(roots.value, labels.value)))
const isBuilding = computed(() => state.value.response?.complete === false)
const isCheckingRisk = computed(() => (state.value.response?.roots ?? []).some((root) => root.riskPending > 0))
const mergeBaseNote = computed(() => {
  const mergeBase = state.value.mergeBase
  if (mergeBase.state === 'found') return mergeBaseText(shortCommit(mergeBase.commit))
  return mergeBase.state === 'none' ? NO_MERGE_BASE : ''
})

async function loadInfo(): Promise<void> {
  try {
    info.value = await api.git()
  } catch (error) {
    info.value = { available: false, reason: error instanceof Error ? error.message : String(error), quiet: false }
  }
}

async function openPicker(): Promise<void> {
  picking.value = true
  await loadInfo()
  await nextTick()
  picker.value?.focus()
}

function closePicker(): void {
  picking.value = false
  void nextTick(() => baseButton.value?.focus())
}

function pickBase(value: string): void {
  closePicker()
  if (value !== baseValue.value) emit('change-base', value)
}

function onPickerFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next !== null && (event.currentTarget as HTMLElement).contains(next)) return
  picking.value = false
}

function selectNode(rootId: string, node: NodeId): void {
  emit('select', rootId, node)
}

onMounted(loadInfo)
</script>

<template>
  <section class="compare" :aria-label="COMPARE_LABEL">
    <p v-if="info === null" class="compare__status muted">{{ LOADING_REFS }}</p>
    <p v-else-if="!info.available" class="compare__status">{{ compareUnavailableText(info.reason) }}</p>
    <template v-else>
      <div class="compare__toolbar">
        <span class="compare__label">{{ BASE }}</span>
        <div class="compare__base" @focusout="onPickerFocusOut">
          <button
            ref="baseButton"
            type="button"
            class="button compare__base-button"
            aria-haspopup="dialog"
            :aria-expanded="picking"
            :aria-controls="picking ? pickerId : undefined"
            :aria-label="`${BASE}: ${baseLabel(baseValue ?? WORKING_KEY, undefined)}`"
            @click="picking ? closePicker() : openPicker()"
          >
            <span class="mono">{{ baseLabel(baseValue ?? WORKING_KEY, undefined) }}</span>
            <AppIcon name="chevron-down" />
          </button>
          <div v-if="picking && available" :id="pickerId" role="dialog" class="compare__picker" :aria-label="SELECT_BASE">
            <RefPicker ref="picker" :info="available" :include-working="true" :current="baseValue" :label="SELECT_BASE" @pick="pickBase" @cancel="closePicker" />
          </div>
        </div>
        <AppIcon class="compare__arrow" name="chevron-right" />
        <span class="compare__target mono">{{ targetText }}</span>
        <label class="compare__merge-base">
          <input type="checkbox" :checked="mergeBase" :aria-describedby="mergeBaseNote ? mergeBaseId : undefined" @change="emit('change-merge-base', ($event.target as HTMLInputElement).checked)" />
          {{ SINCE_MERGE_BASE }}
        </label>
        <span v-if="mergeBase && mergeBaseNote" :id="mergeBaseId" class="compare__merge-base-note muted mono">{{ mergeBaseNote }}</span>
        <button type="button" class="button compare__swap" :disabled="isSameSource || baseValue === undefined" @click="emit('swap', baseValue ?? WORKING_KEY)">{{ SWAP }}</button>
      </div>
      <p v-if="isSameSource" class="compare__status">{{ SAME_SOURCE }}</p>
      <p v-else-if="state.status === 'error'" class="compare__status compare__status--error" role="alert">{{ compareFailedText(state.error ?? '') }}</p>
      <template v-else>
        <p v-if="state.status === 'loading'" class="compare__status muted">{{ COMPARING }}</p>
        <template v-else>
          <p class="compare__summary" role="status">{{ summary }}</p>
          <p v-if="isBuilding" class="compare__status muted">{{ buildingText(labels.base) }}</p>
          <p v-if="isCheckingRisk" class="compare__status muted">{{ CHECKING_RISK }}</p>
        </template>
        <CompareRootSection v-for="root in roots" :key="root.rootId" :root="root" :labels="labels" @select="(node) => selectNode(root.rootId, node)" />
      </template>
    </template>
  </section>
</template>

<style scoped>
.compare {
  min-height: 0;
  overflow-y: auto;
  white-space: normal;
}

.compare__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.compare__label {
  font-weight: 600;
}

.compare__base {
  position: relative;
}

.compare__base-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
}

.compare__base-button .mono {
  overflow: hidden;
  text-overflow: ellipsis;
}

.compare__picker {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.compare__arrow {
  color: var(--text-muted);
}

.compare__target {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.compare__merge-base {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.compare__swap {
  margin-left: auto;
}

.compare__summary {
  margin: 0;
  padding: 10px 16px 4px;
  font-weight: 600;
}

.compare__status {
  margin: 0;
  padding: 8px 16px;
}

.compare__status--error {
  color: var(--danger);
}
</style>
