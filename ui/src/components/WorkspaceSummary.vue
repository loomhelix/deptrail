<script setup lang="ts">
import { computed, useId } from 'vue'
import type { ChangeItem } from '../../../src/actions/types.ts'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import type { NodeId } from '../../../src/model.ts'
import type { IssueRow } from '../../../src/query/issues.ts'
import { issueProblemBadges, type Badge } from '../badges.ts'
import { itemsTouching } from '../changes-index.ts'
import { checkGaps, knownProblemsState, problemCountOf, unlistedProblemCount, workspaceProblems } from '../issues-model.ts'
import { rootLabel } from '../labels.ts'
import {
  directDependencyCountText,
  EXPLORE_DEPENDENCIES,
  HEALTH_SEPARATOR,
  ISSUES_IN_DEPENDENCIES,
  issuesLoadFailedText,
  knownProblemsText,
  NO_ISSUES_IN_DEPENDENCIES,
  rootSwitcherName,
  unlistedPathsText,
} from '../vocabulary.ts'
import ChangeGoalsList from './ChangeGoalsList.vue'
import NodeBadges from './NodeBadges.vue'

const props = withDefaults(
  defineProps<{
    root: string
    node: NodeId
    name: string
    path: string
    dependencyCount: number
    issueRows: readonly IssueRow[] | null
    issueRowsError?: string
    status?: EnrichmentStatus
    changes: readonly ChangeItem[]
    changesHref: string
    loading?: boolean
  }>(),
  { loading: false },
)

const emit = defineEmits<{ select: [node: NodeId]; 'open-tree': []; 'open-changes': [] }>()

const problemsHeadingId = useId()
const problems = computed(() => (props.issueRows === null ? null : workspaceProblems(props.issueRows, props.root, props.node)))
const unlistedPaths = computed(() => (props.issueRows === null ? 0 : unlistedProblemCount(props.issueRows, props.root, props.node)))
const gaps = computed(() => checkGaps(props.status, { unlistedPaths: unlistedPaths.value }))
const problemsState = computed(() => knownProblemsState(problemCountOf(problems.value, props.issueRowsError), props.status, gaps.value))
const problemsText = computed(() => {
  const state = problemsState.value
  return state === 'problems' || state === 'failed' ? undefined : knownProblemsText(state, NO_ISSUES_IN_DEPENDENCIES, gaps.value)
})
const unlistedNote = computed(() => (problemsState.value === 'problems' && unlistedPaths.value > 0 ? unlistedPathsText(unlistedPaths.value) : undefined))
const touchingChanges = computed(() => itemsTouching(props.changes, props.node))

function badgesOf(row: IssueRow): Badge[] {
  return row.kinds.flatMap((kind) => issueProblemBadges(kind, row))
}
</script>

<template>
  <div class="workspace-summary">
    <header class="workspace-summary__header" :class="{ 'workspace-summary__header--loading': loading }">
      <h2 class="workspace-summary__title"><span class="mono">{{ name }}</span></h2>
      <p class="workspace-summary__place">
        <span class="badge workspace-summary__root" :title="rootSwitcherName(root)" data-testid="root-badge">{{ rootLabel(root) }}</span>
        {{ ' ' }}<span class="mono" data-testid="workspace-path">{{ path }}</span>
      </p>
    </header>
    <section class="workspace-summary__section" :aria-labelledby="problemsHeadingId">
      <h3 :id="problemsHeadingId" class="panel-heading">{{ ISSUES_IN_DEPENDENCIES }}</h3>
      <p v-if="issueRowsError !== undefined" class="workspace-summary__error" role="alert">{{ issuesLoadFailedText(issueRowsError) }}</p>
      <p v-else-if="problemsText !== undefined" class="workspace-summary__muted" data-testid="workspace-problems-state">{{ problemsText }}</p>
      <ul v-else-if="problems !== null" class="workspace-summary__problems">
        <li v-for="problem in problems" :key="problem.key" class="workspace-summary__problem" data-testid="workspace-problem">
          <button type="button" class="workspace-summary__link mono" @click="emit('select', problem.node)">{{ problem.label }}</button>
          <NodeBadges :badges="badgesOf(problem.row)" />
        </li>
      </ul>
      <p v-if="unlistedNote !== undefined" class="workspace-summary__muted" data-testid="workspace-problems-unlisted">{{ unlistedNote }}</p>
    </section>
    <p class="workspace-summary__section workspace-summary__dependencies" data-testid="workspace-dependencies">
      {{ directDependencyCountText(dependencyCount) }}{{ HEALTH_SEPARATOR }}<button
        type="button"
        class="workspace-summary__link"
        @click="emit('open-tree')"
      >{{ EXPLORE_DEPENDENCIES }}</button>
    </p>
    <ChangeGoalsList v-if="touchingChanges.length > 0" :root="root" :items="touchingChanges" :href="changesHref" @review="emit('open-changes')" />
  </div>
</template>

<style scoped>
.workspace-summary__header {
  display: grid;
  gap: 6px;
  padding: 16px 16px 14px;
  border-bottom: 1px solid var(--border);
  transition: opacity 0.15s;
}

.workspace-summary__header--loading {
  opacity: 0.6;
}

.workspace-summary p {
  margin: 0;
}

.workspace-summary__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.workspace-summary__title .mono {
  font-size: 16px;
}

.workspace-summary__place {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.workspace-summary__root {
  margin-right: 4px;
  font-size: 13px;
}

.workspace-summary__section {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.workspace-summary__dependencies {
  display: block;
  color: var(--text-muted);
}

.workspace-summary__muted {
  color: var(--text-muted);
}

.workspace-summary__error {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.workspace-summary__problems {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workspace-summary__problem {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-height: 28px;
  overflow-wrap: anywhere;
}

.workspace-summary__link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.workspace-summary__link:hover {
  text-decoration: underline;
}
</style>
