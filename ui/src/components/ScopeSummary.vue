<script setup lang="ts">
import { computed, useId } from 'vue'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import type { IssueKind } from '../../../src/query/issues.ts'
import type { RootSummary } from '../api.ts'
import type { ChangesByRoot } from '../changes-index.ts'
import { checkGaps, knownProblemsState, rootProblemCount } from '../issues-model.ts'
import { rootLabel } from '../labels.ts'
import {
  ALL_ROOTS,
  HEALTH_SEPARATOR,
  knownProblemsText,
  LOADING_SCAN,
  NO_KNOWN_ISSUES_STATUS,
  packageCountText,
  rootHealthLinks,
  rootStatusMark,
  SELECT_ISSUE_PROMPT,
  sourceAccuracyText,
  type HealthLink,
} from '../vocabulary.ts'
import ChangeGoalsList from './ChangeGoalsList.vue'

const props = defineProps<{
  scope?: string
  roots: readonly RootSummary[]
  scanLoaded: boolean
  changes: ChangesByRoot
  status?: EnrichmentStatus
  healthLinkHref: (root: string, kind: HealthLink['kind']) => string
}>()

const emit = defineEmits<{ 'open-issues': [root: string, kind: IssueKind]; 'open-changes': [root: string] }>()

const headingId = useId()
const scopeRoot = computed(() => (props.scope === undefined ? undefined : props.roots.find((root) => root.id === props.scope)))
const listedRoots = computed(() => {
  if (props.scope === undefined) return props.roots
  return scopeRoot.value === undefined ? [] : [scopeRoot.value]
})
const scopeChanges = computed(() => (scopeRoot.value === undefined ? [] : (props.changes.get(scopeRoot.value.id) ?? [])))
const title = computed(() => (props.scope === undefined ? ALL_ROOTS : rootLabel(props.scope)))

function isBusy(root: RootSummary): boolean {
  return root.status !== 'ready'
}

const gaps = computed(() => checkGaps(props.status))

function problemsTextOf(root: RootSummary): string | undefined {
  const state = knownProblemsState(rootProblemCount(root), props.status, gaps.value)
  return state === 'problems' || state === 'failed' ? undefined : knownProblemsText(state, NO_KNOWN_ISSUES_STATUS, gaps.value)
}

function followHealthLink(event: MouseEvent, root: string, kind: HealthLink['kind']): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  if (kind === 'changes') emit('open-changes', root)
  else emit('open-issues', root, kind)
}
</script>

<template>
  <section class="scope-summary" :aria-labelledby="headingId">
    <p class="scope-summary__prompt">{{ SELECT_ISSUE_PROMPT }}</p>
    <h2 :id="headingId" class="scope-summary__title" :class="{ mono: scope !== undefined }">{{ title }}</h2>
    <p v-if="!scanLoaded" class="scope-summary__muted">{{ LOADING_SCAN }}</p>
    <ul v-if="listedRoots.length > 0" class="scope-summary__roots">
      <li v-for="root in listedRoots" :key="root.id" class="scope-summary__root" data-testid="scope-root">
        <span v-if="scope === undefined" class="scope-summary__name mono">{{ rootLabel(root.id) }}</span>
        <span v-if="isBusy(root)" class="scope-summary__muted">{{ rootStatusMark(root) }}</span>
        <span v-else class="scope-summary__health">
          <span v-if="problemsTextOf(root) !== undefined">{{ problemsTextOf(root) }}</span>
          <template v-for="(link, position) in rootHealthLinks(root)" :key="link.kind">
            <span v-if="position > 0 || problemsTextOf(root) !== undefined" aria-hidden="true">{{ HEALTH_SEPARATOR }}</span>
            <a
              class="scope-summary__link"
              :class="`scope-summary__link--${link.kind}`"
              :href="healthLinkHref(root.id, link.kind)"
              @click="followHealthLink($event, root.id, link.kind)"
            >{{ link.text }}</a>
          </template>
        </span>
      </li>
    </ul>
    <p v-if="scopeRoot" class="scope-summary__source" data-testid="scope-source">
      {{ scopeRoot.manager }}{{ HEALTH_SEPARATOR }}{{ packageCountText(scopeRoot.packageCount) }}{{ HEALTH_SEPARATOR }}{{ sourceAccuracyText(scopeRoot.source) }}
    </p>
  </section>
  <ChangeGoalsList
    v-if="scopeRoot && scopeChanges.length > 0"
    :root="scopeRoot.id"
    :items="scopeChanges"
    :href="healthLinkHref(scopeRoot.id, 'changes')"
    @review="emit('open-changes', scopeRoot.id)"
  />
</template>

<style scoped>
.scope-summary {
  display: grid;
  gap: 8px;
  padding: 16px 16px 14px;
  border-bottom: 1px solid var(--border);
}

.scope-summary p {
  margin: 0;
}

.scope-summary__prompt {
  color: var(--text-muted);
}

.scope-summary__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.scope-summary__title.mono {
  font-size: 16px;
}

.scope-summary__roots {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.scope-summary__root {
  display: grid;
  gap: 2px;
  overflow-wrap: anywhere;
}

.scope-summary__name {
  font-weight: 600;
}

.scope-summary__muted {
  color: var(--text-muted);
}

.scope-summary__health {
  color: var(--text-muted);
}

.scope-summary__link {
  color: var(--accent);
}

.scope-summary__link--vulnerability {
  color: var(--danger);
}

.scope-summary__source {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
</style>
