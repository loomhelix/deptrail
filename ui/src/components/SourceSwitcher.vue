<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, useId } from 'vue'
import { createApi, type GitInfo } from '../api.ts'
import { navigationUrl, SHOWN_SOURCE, shortCommit, shortRef, WORKING_KEY, type ShownSourceState } from '../source.ts'
import { BRANCHES_UNAVAILABLE, detachedText, LOADING_REFS, SELECT_SOURCE, sourceButtonName, sourceLabel, WORKING_TREE } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'
import RefPicker from './RefPicker.vue'

const shown = inject(SHOWN_SOURCE, { source: { kind: 'working' } } satisfies ShownSourceState)
const source = shown.source

const api = createApi()
const elementId = useId()
const buttonId = `${elementId}-button`
const panelId = `${elementId}-panel`
const reasonId = `${elementId}-reason`
const container = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
const picker = ref<InstanceType<typeof RefPicker> | null>(null)
const info = ref<GitInfo | null>(null)
const isOpen = ref(false)

const available = computed(() => (info.value?.available === true ? info.value : null))
const unavailableReason = computed(() => (info.value?.available === false && !info.value.quiet ? info.value.reason : null))
const hidden = computed(() => source.kind === 'working' && (info.value === null || (info.value.available === false && info.value.quiet)))
const label = computed(() => sourceLabel(source))
const currentValue = computed(() => (source.kind === 'working' ? WORKING_KEY : source.ref))

const detail = computed(() => {
  if (source.kind === 'commit') return shortCommit(source.commit)
  const head = available.value?.head
  if (head === undefined) return ''
  return head.branch === undefined ? detachedText(shortCommit(head.commit)) : shortRef(head.branch)
})

async function load(): Promise<void> {
  try {
    info.value = await api.git()
  } catch (error) {
    info.value = { available: false, reason: error instanceof Error ? error.message : String(error), quiet: false }
  }
}

async function open(): Promise<void> {
  isOpen.value = true
  await load()
  await nextTick()
  picker.value?.focus()
}

function close(returnFocus: boolean): void {
  isOpen.value = false
  if (returnFocus) void nextTick(() => button.value?.focus())
}

function toggle(): void {
  if (isOpen.value) close(false)
  else void open()
}

function pick(value: string): void {
  if (value === currentValue.value) {
    close(true)
    return
  }
  window.location.assign(navigationUrl(window.location.pathname, window.location.search, { ref: value === WORKING_KEY ? null : value }))
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next !== null && container.value?.contains(next)) return
  isOpen.value = false
}

function dismiss(): boolean {
  if (!isOpen.value) return false
  close(true)
  return true
}

onMounted(load)

defineExpose({ dismiss })
</script>

<template>
  <span v-if="unavailableReason !== null && source.kind === 'working'" class="source-switcher__none" tabindex="0" :title="unavailableReason" :aria-describedby="reasonId">
    {{ BRANCHES_UNAVAILABLE }}<span :id="reasonId" class="sr-only">{{ unavailableReason }}</span>
  </span>
  <div v-else-if="!hidden" ref="container" class="source-switcher" @focusout="onFocusOut">
    <button
      :id="buttonId"
      ref="button"
      type="button"
      class="source-switcher__button"
      :class="{ 'source-switcher--commit': source.kind === 'commit' }"
      aria-haspopup="dialog"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? panelId : undefined"
      :aria-label="sourceButtonName(label)"
      @click="toggle"
    >
      <AppIcon v-if="source.kind === 'commit'" name="git-branch" />
      <span class="source-switcher__label" :class="{ mono: source.kind === 'commit' }">{{ source.kind === 'commit' ? label : WORKING_TREE }}</span>
      <span v-if="detail" class="source-switcher__detail mono">{{ detail }}</span>
      <AppIcon class="source-switcher__caret" name="chevron-down" />
    </button>
    <div v-if="isOpen" :id="panelId" role="dialog" class="source-switcher__panel" :aria-label="SELECT_SOURCE">
      <RefPicker v-if="available" ref="picker" :info="available" :include-working="true" :current="currentValue" :label="SELECT_SOURCE" @pick="pick" @cancel="close(true)" />
      <p v-else-if="info === null" class="source-switcher__message">{{ LOADING_REFS }}</p>
      <p v-else class="source-switcher__message">{{ info.available ? '' : info.reason }}</p>
    </div>
  </div>
</template>

<style scoped>
.source-switcher {
  position: relative;
  flex: none;
}

.source-switcher__button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  height: 32px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  cursor: pointer;
}

.source-switcher__button:hover {
  background: var(--surface-hover);
}

.source-switcher--commit,
.source-switcher--commit:hover {
  border-color: var(--source-commit-border);
  background: var(--source-commit-bg);
  color: var(--source-commit-fg);
}

.source-switcher__label {
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-switcher__detail {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-switcher--commit .source-switcher__detail {
  color: inherit;
}

.source-switcher__caret {
  color: var(--text-muted);
}

.source-switcher__panel {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  max-height: min(70vh, 560px);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.source-switcher__message {
  margin: 0;
  padding: 12px 14px;
  color: var(--text-muted);
  white-space: normal;
}

.source-switcher__none {
  flex: none;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
