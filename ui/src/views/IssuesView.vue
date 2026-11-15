<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import type { DepKind } from '../../../src/model.ts'
import type { DirectGroup, IssueKind, IssueRow } from '../../../src/query/issues.ts'
import { createApi } from '../api.ts'
import AddRecommendedDialog from '../components/AddRecommendedDialog.vue'
import IssueDirectGroups from '../components/IssueDirectGroups.vue'
import IssueRootNotes from '../components/IssueRootNotes.vue'
import IssuePackageRows from '../components/IssuePackageRows.vue'
import IssuesToolbar from '../components/IssuesToolbar.vue'
import { checkGaps, directGroupRows, issuesEmptyState, narrowsKinds, packageGroups, rootNotes, typeCounts, vulnerableRoots } from '../issues-model.ts'
import { issuesEmptyText, issuesLoadFailedText, LOADING_ISSUES, scopeLabel, VIEW_TITLES } from '../vocabulary.ts'
import type { FilterChange, IssueGrouping, Selection } from '../context.ts'

const props = defineProps<{
  root?: string
  selection?: Selection
  group: IssueGrouping
  types: IssueKind[]
  kinds: DepKind[]
  revision: string
  rows: readonly IssueRow[] | null
  rowsError?: string
  actionsRevisions: ReadonlyMap<string, string>
  unavailableRoots: ReadonlyMap<string, string>
  status?: EnrichmentStatus
  failedRoots: readonly string[]
  changesHref: (root: string) => string
}>()

const emit = defineEmits<{
  select: [selection: Selection]
  update: [selection: Selection]
  review: [root: string, itemId: string]
  'review-changes': [root: string]
  change: [change: FilterChange]
  'changes-updated': []
}>()

const api = createApi()
const elementId = useId()

const groups = shallowRef<readonly DirectGroup[] | null>(null)
const counts = shallowRef<Record<IssueKind, number>>(typeCounts([]))
const groupsError = ref<string | null>(null)
const toolbar = ref<InstanceType<typeof IssuesToolbar> | null>(null)
const showsAddRecommended = ref(false)
let latestLoad = 0
let loadedSubject = ''

const loadError = computed(() => (props.rowsError !== undefined ? issuesLoadFailedText(props.rowsError) : groupsError.value))
const packageRowGroups = computed(() => packageGroups(props.rows ?? [], props.types, props.root))
const directEntries = computed(() => directGroupRows(groups.value ?? [], props.rows ?? [], props.types))
const notes = computed(() => rootNotes(props.rows ?? [], props.types, props.unavailableRoots, props.root))
const rootsToFix = computed(() => vulnerableRoots(props.rows ?? [], props.root))
const isLoaded = computed(() => props.rows !== null && (props.group === 'package' || groups.value !== null))
const isEmpty = computed(() => (props.group === 'package' ? packageRowGroups.value.length === 0 : directEntries.value.length === 0))
const emptyText = computed(() => {
  const gaps = checkGaps(props.status, { failedRoots: props.failedRoots })
  const state = issuesEmptyState((props.rows?.length ?? 0) > 0, props.kinds, props.status, gaps)
  return issuesEmptyText(state, scopeLabel(props.root), gaps, narrowsKinds(props.kinds))
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadGroups(): Promise<void> {
  const request = ++latestLoad
  if (props.group !== 'direct') return
  try {
    const response = await api.issueGroups(props.root, props.kinds)
    if (request !== latestLoad) return
    groups.value = response.groups
    groupsError.value = null
  } catch (failure) {
    if (request !== latestLoad) return
    groupsError.value = issuesLoadFailedText(messageOf(failure))
  }
}

watch(
  () => props.rows,
  (rows) => {
    if (rows !== null) counts.value = typeCounts(rows)
  },
  { immediate: true },
)

watch(
  [() => props.root, () => props.kinds.join(','), () => props.group, () => props.revision],
  () => {
    const subject = `${props.root ?? ''}\n${props.kinds.join(',')}`
    if (subject !== loadedSubject) {
      loadedSubject = subject
      groups.value = null
    }
    void loadGroups()
  },
  { immediate: true },
)

function openAddRecommended(): void {
  showsAddRecommended.value = true
}

async function closeAddRecommended(): Promise<void> {
  showsAddRecommended.value = false
  await nextTick()
  toolbar.value?.focusAddRecommended()
}

function reviewAddedChanges(root: string): void {
  showsAddRecommended.value = false
  emit('review-changes', root)
}
</script>

<template>
  <section class="issues" :aria-label="VIEW_TITLES.issues">
    <IssuesToolbar
      ref="toolbar"
      :types="types"
      :counts="counts"
      :group="group"
      :kinds="kinds"
      :status="status"
      :can-add-recommended="rootsToFix.length > 0"
      @change="(change: FilterChange) => emit('change', change)"
      @add-recommended="openAddRecommended"
    />

    <IssueRootNotes :notes="notes" :id-prefix="elementId" />

    <p v-if="loadError" class="issues__message issues__message--error" role="alert">{{ loadError }}</p>
    <p v-else-if="!isLoaded" class="issues__message muted">{{ LOADING_ISSUES }}</p>
    <p v-else-if="isEmpty" class="issues__message muted" data-testid="issues-empty">{{ emptyText }}</p>

    <div v-else-if="group === 'package'" class="issues__body">
      <IssuePackageRows
        :groups="packageRowGroups"
        :scope="root"
        :selection="selection"
        :kinds="kinds"
        :actions-revisions="actionsRevisions"
        :unavailable-roots="unavailableRoots"
        :note-id-prefix="elementId"
        @select="(selection: Selection) => emit('select', selection)"
        @update="(selection: Selection) => emit('update', selection)"
        @review="(rootId: string, itemId: string) => emit('review', rootId, itemId)"
        @added="emit('changes-updated')"
      />
    </div>

    <div v-else class="issues__body">
      <IssueDirectGroups
        :entries="directEntries"
        :scope="root"
        :selection="selection"
        :kinds="kinds"
        :actions-revisions="actionsRevisions"
        :unavailable-roots="unavailableRoots"
        :note-id-prefix="elementId"
        @select="(selection: Selection) => emit('select', selection)"
        @update="(selection: Selection) => emit('update', selection)"
        @review="(rootId: string, itemId: string) => emit('review', rootId, itemId)"
        @added="emit('changes-updated')"
      />
    </div>

    <AddRecommendedDialog
      v-if="showsAddRecommended"
      :roots="rootsToFix"
      :kinds="kinds"
      :changes-href="changesHref"
      @close="closeAddRecommended"
      @added="emit('changes-updated')"
      @review="reviewAddedChanges"
    />
  </section>
</template>

<style scoped>
.issues {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.issues__message {
  margin: 0;
  padding: 24px 14px;
}

.issues__message--error {
  color: var(--danger);
}

.issues__body {
  flex: 1;
  min-height: 0;
}
</style>
