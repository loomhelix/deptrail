<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { Severity } from '../../../src/enrich/types.ts'
import type { DepKind, NodeId } from '../../../src/model.ts'
import { createApi, type ChildrenResult } from '../api.ts'
import { vulnerabilityTone } from '../badges.ts'
import type { NodeDecorations } from '../decorations.ts'
import { knownVulnerabilitiesTitle, LOADING, MALICIOUS, VULNERABLE_DEPENDENCIES, vulnerableDependenciesLoadFailedText } from '../vocabulary.ts'
import { vulnerableBelowRows } from '../why-here.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  root: string
  node: NodeId
  kinds: DepKind[]
  revision: string
  summary: { count: number; worst: Severity }
  decorations: NodeDecorations
}>()

const emit = defineEmits<{ select: [node: NodeId] }>()

type LoadedBelow = { key: string; result: ChildrenResult | null; error: string | null }

const VULNERABLE_BELOW_DEPTH = 100

const api = createApi()
const isOpen = ref(false)
const loaded = shallowRef<LoadedBelow | null>(null)
let latestLoad = 0

const loadKey = computed(() => [props.root, props.node, props.kinds.join(','), props.revision, props.summary.count].join('\n'))
const current = computed(() => (loaded.value?.key === loadKey.value ? loaded.value : null))
const rows = computed(() => (current.value?.result ? vulnerableBelowRows(current.value.result, props.decorations) : null))
const loadError = computed(() => current.value?.error ?? null)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  const request = ++latestLoad
  const key = loadKey.value
  try {
    const result = await api.children(props.root, props.node, VULNERABLE_BELOW_DEPTH, props.kinds)
    if (request !== latestLoad) return
    loaded.value = { key, result, error: null }
  } catch (error) {
    if (request !== latestLoad) return
    loaded.value = { key, result: null, error: messageOf(error) }
  }
}

function onToggle(event: Event): void {
  isOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

watch([isOpen, loadKey], ([open]) => {
  if (open && current.value === null) void load()
})
</script>

<template>
  <details class="vulnerable-below" data-testid="vulnerable-below" @toggle="onToggle">
    <summary class="vulnerable-below__summary"><AppIcon class="summary-chevron" name="chevron-right" :size="18" />{{ VULNERABLE_DEPENDENCIES }}</summary>
    <div class="vulnerable-below__body">
      <p v-if="loadError" class="vulnerable-below__error" role="alert">{{ vulnerableDependenciesLoadFailedText(loadError) }}</p>
      <p v-else-if="rows === null" class="vulnerable-below__muted">{{ LOADING }}</p>
      <ul v-else class="vulnerable-below__rows">
        <li v-for="row in rows" :key="row.node" class="vulnerable-below__row">
          <button type="button" class="vulnerable-below__link mono" @click="emit('select', row.node)">{{ row.label }}</button>
          <span class="badge" :class="`badge--${vulnerabilityTone(row.vuln)}`" :title="knownVulnerabilitiesTitle(row.vuln.count, row.vuln.severity)">
            {{ row.vuln.malicious ? MALICIOUS : row.vuln.severity }}
          </span>
        </li>
      </ul>
    </div>
  </details>
</template>

<style scoped>
.vulnerable-below {
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
}

.vulnerable-below__summary {
  min-height: 32px;
  padding: 5px 0;
  font-weight: 600;
  cursor: pointer;
}

.vulnerable-below__body {
  display: grid;
  gap: 6px;
  padding: 4px 0 8px;
}

.vulnerable-below__body p {
  margin: 0;
}

.vulnerable-below__muted {
  color: var(--text-muted);
}

.vulnerable-below__error {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.vulnerable-below__rows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.vulnerable-below__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-height: 28px;
  overflow-wrap: anywhere;
}

.vulnerable-below__link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.vulnerable-below__link:hover {
  text-decoration: underline;
}
</style>
