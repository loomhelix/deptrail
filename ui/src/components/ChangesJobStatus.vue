<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Job } from '../../../src/actions/types.ts'
import { codeSegments } from '../actions-text.ts'
import { CANCEL, jobLogSummary, LAST_JOB, NO_OUTPUT_YET, phaseText, REVERT_FILES, RUNNING_JOB, type JobOutcome } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  job?: Job
  log: readonly string[]
  outcome?: JobOutcome
  hint?: string
  revertNote?: string
  revertable: boolean
  busy: boolean
  requesting: boolean
}>()

const emit = defineEmits<{ cancel: []; revert: [] }>()

const logOpen = ref(false)
const logLines = ref<HTMLElement | null>(null)

const running = computed(() => props.job?.state === 'running')
const cancellable = computed(() => running.value && (props.job?.kind === 'preview' || (props.job?.kind === 'apply' && props.job.phase === 'installing')))
const offersRevert = computed(() => props.revertable && !running.value)
const showsFinishedLog = computed(() => props.outcome !== undefined && props.log.length > 0)
const hintSegments = computed(() => (props.hint === undefined ? [] : codeSegments(props.hint)))

function toggleLog(event: Event): void {
  logOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

async function scrollLogToEnd(): Promise<void> {
  await nextTick()
  const element = logLines.value
  if (element !== null) element.scrollTop = element.scrollHeight
}

watch(
  [() => props.job?.id, () => props.job?.state],
  ([, state]) => {
    logOpen.value = state === 'failed'
  },
  { immediate: true },
)
watch(() => props.log.length, () => void scrollLogToEnd())
watch(logOpen, (open) => {
  if (open) void scrollLogToEnd()
})
</script>

<template>
  <section v-if="job && running" class="job" :aria-label="RUNNING_JOB" data-testid="changes-job">
    <div class="job__head">
      <span class="job__pulse" aria-hidden="true" />
      <span class="job__phase" role="status">{{ phaseText(job.phase) }}</span>
      <button v-if="cancellable" type="button" class="button job__cancel job__button" :disabled="requesting" @click="emit('cancel')">{{ CANCEL }}</button>
    </div>
    <details class="job__log" data-testid="job-log" :open="logOpen" @toggle="toggleLog">
      <summary><AppIcon class="summary-chevron" name="chevron-right" />{{ jobLogSummary(log.length) }}</summary>
      <pre v-if="log.length > 0" ref="logLines" class="job__lines mono" data-testid="job-lines">{{ log.join('\n') }}</pre>
      <p v-else class="job__empty muted">{{ NO_OUTPUT_YET }}</p>
    </details>
  </section>

  <section v-else-if="outcome || offersRevert" class="job" :aria-label="LAST_JOB" data-testid="changes-outcome">
    <p
      v-if="outcome"
      class="job__outcome"
      :class="{ 'job__outcome--failed': outcome.failed }"
      :role="outcome.failed ? 'alert' : 'status'"
      data-testid="job-outcome"
    >
      {{ outcome.text }}
    </p>
    <p v-if="hint" class="job__hint" data-testid="install-hint">
      <template v-for="(segment, position) in hintSegments" :key="position">
        <code v-if="segment.code" class="job__command mono">{{ segment.text }}</code>
        <template v-else>{{ segment.text }}</template>
      </template>
    </p>
    <div v-if="offersRevert" class="job__revert">
      <button type="button" class="button job__button" :disabled="busy" @click="emit('revert')">{{ REVERT_FILES }}</button>
      <span v-if="revertNote" class="muted" data-testid="revert-note">{{ revertNote }}</span>
    </div>
    <details v-if="showsFinishedLog" class="job__log" data-testid="job-log" :open="logOpen" @toggle="toggleLog">
      <summary><AppIcon class="summary-chevron" name="chevron-right" />{{ jobLogSummary(log.length) }}</summary>
      <pre ref="logLines" class="job__lines mono" data-testid="job-lines">{{ log.join('\n') }}</pre>
    </details>
  </section>
</template>

<style scoped>
.job {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.job__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.job__pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: job-pulse 1s ease-in-out infinite alternate;
}

@keyframes job-pulse {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.25;
  }
}

.job__phase {
  font-weight: 600;
}

.job__cancel {
  margin-left: auto;
}

.job__log summary {
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
}

.job__lines {
  max-height: 240px;
  margin: 6px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-panel);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.job__empty {
  margin: 6px 0 0;
  font-size: 13px;
}

.job__outcome {
  margin: 0;
  color: var(--badge-ok-fg);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.job__outcome--failed {
  color: var(--danger);
}

.job__hint {
  margin: 0;
  overflow-wrap: anywhere;
}

.job__command {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-panel);
  color: var(--text);
}

.job__button {
  height: 32px;
}

.job__revert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}
</style>
