<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import type { PreviewFile } from '../../../src/actions/types.ts'
import { diffLines, fileStats } from '../actions-text.ts'
import { createApi } from '../api.ts'
import { DIFF_TRUNCATED, diffLoadFailedText, LOADING_DIFF, NEW_FILE } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  root: string
  file: PreviewFile
  index: number
}>()

type LoadedDiff = { state: 'loading' } | { state: 'loaded'; diff: string; truncated: boolean } | { state: 'failed'; error: string }

const api = createApi()
const requested = shallowRef<LoadedDiff | null>(null)

const shown = computed<LoadedDiff | null>(() =>
  props.file.diff === undefined ? requested.value : { state: 'loaded', diff: props.file.diff, truncated: props.file.diffTruncated === true },
)
const lines = computed(() => (shown.value?.state === 'loaded' ? diffLines(shown.value.diff) : []))
const truncated = computed(() => shown.value?.state === 'loaded' && (shown.value.truncated || props.file.diffTruncated === true))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadDiff(): Promise<void> {
  requested.value = { state: 'loading' }
  try {
    requested.value = { state: 'loaded', ...(await api.previewFileDiff(props.root, props.index)) }
  } catch (error) {
    requested.value = { state: 'failed', error: messageOf(error) }
  }
}

function toggle(event: Event): void {
  const opened = (event.currentTarget as HTMLDetailsElement).open
  if (opened && (shown.value === null || shown.value.state === 'failed')) void loadDiff()
}
</script>

<template>
  <details class="file" data-testid="preview-file" @toggle="toggle">
    <summary class="file__summary">
      <AppIcon class="file__chevron" name="chevron-right" :size="18" />
      <span class="file__path mono">{{ file.path }}</span>
      <span v-if="file.change === 'created'" class="badge badge--info">{{ NEW_FILE }}</span>
      <span class="file__stats mono" data-testid="file-stats">{{ fileStats(file) }}</span>
    </summary>
    <p v-if="shown === null || shown.state === 'loading'" class="file__message muted">{{ LOADING_DIFF }}</p>
    <p v-else-if="shown.state === 'failed'" class="file__message file__message--error" role="alert">{{ diffLoadFailedText(shown.error) }}</p>
    <template v-else>
      <p v-if="truncated" class="file__message muted">{{ DIFF_TRUNCATED }}</p>
      <pre class="file__diff mono" data-testid="file-diff"><span v-for="(line, position) in lines" :key="position" class="diff-line" :class="`diff-line--${line.tone}`">{{ line.text }}</span></pre>
    </template>
  </details>
</template>

<style scoped>
.file + .file {
  border-top: 1px solid var(--border);
}

.file__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  list-style: none;
}

.file__summary::-webkit-details-marker {
  display: none;
}

.file__summary:hover {
  background: var(--surface-hover);
}

.file__chevron {
  color: var(--text-muted);
}

.file[open] > .file__summary .file__chevron {
  transform: rotate(90deg);
}

.file__path {
  min-width: 0;
  overflow-wrap: anywhere;
}

.file__stats {
  margin-left: auto;
  color: var(--text-faint);
  white-space: nowrap;
}

.file__message {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
}

.file__message--error {
  color: var(--danger);
}

.file__diff {
  max-height: 420px;
  margin: 0;
  padding: 6px 0;
  overflow: auto;
  border-top: 1px solid var(--border);
  background: var(--surface-panel);
  line-height: 1.45;
}

.diff-line {
  display: block;
  min-width: max-content;
  padding: 0 10px;
  white-space: pre;
}

.diff-line--added {
  background: var(--badge-ok-bg);
}

.diff-line--removed {
  background: var(--badge-danger-bg);
}

.diff-line--meta {
  color: var(--text-faint);
}
</style>
