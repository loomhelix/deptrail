<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { Goal, NewIssue, Preview } from '../../../src/actions/types.ts'
import { packageChangeText, previewMetaText } from '../actions-text.ts'
import { severityTone, type Badge } from '../badges.ts'
import {
  DEPRECATED,
  knownVulnerabilitiesTitle,
  moreCountText,
  NONE,
  notCheckedText,
  packageChangesHeading,
  PREVIEW_PARTS,
  previewGoalLine,
} from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'
import NodeBadges from './NodeBadges.vue'
import PreviewFileDetails from './PreviewFileDetails.vue'

const props = defineProps<{
  root: string
  preview: Preview
  goals: ReadonlyMap<string, Goal>
}>()

const CLOCK_TICK_MS = 30_000
const SHOWN_PACKAGE_CHANGES = 10

const elementId = useId()
const now = ref(Date.now())
const showsAllPackageChanges = ref(false)

const clock = window.setInterval(() => {
  now.value = Date.now()
}, CLOCK_TICK_MS)

onBeforeUnmount(() => window.clearInterval(clock))

const shownPackageChanges = computed(() =>
  showsAllPackageChanges.value ? props.preview.packageChanges : props.preview.packageChanges.slice(0, SHOWN_PACKAGE_CHANGES),
)
const hiddenPackageChangeCount = computed(() => props.preview.packageChanges.length - shownPackageChanges.value.length)

watch(
  () => props.preview.id,
  () => {
    showsAllPackageChanges.value = false
    now.value = Date.now()
  },
)

function newIssueBadges(issue: NewIssue): Badge[] {
  const badges: Badge[] = []
  if (issue.severity !== undefined) {
    badges.push({ key: 'severity', label: issue.severity, tone: severityTone(issue.severity), outlined: false, title: knownVulnerabilitiesTitle(issue.vulnIds.length, issue.severity) })
  }
  if (issue.deprecated !== undefined) badges.push({ key: 'deprecated', label: DEPRECATED, tone: 'warn', outlined: false, title: issue.deprecated })
  return badges
}
</script>

<template>
  <section class="preview" :aria-labelledby="`${elementId}-title`">
    <div class="preview__bar">
      <h3 :id="`${elementId}-title`" class="preview__title">{{ PREVIEW_PARTS.title }}</h3>
      <span class="preview__meta muted" data-testid="preview-meta">{{ previewMetaText(preview, now) }}</span>
    </div>

    <h4 class="preview__label">{{ PREVIEW_PARTS.goals }}</h4>
    <ul class="preview__list">
      <li v-for="goal in preview.goals" :key="goal.itemId" class="preview__goal" data-testid="preview-goal">
        <span :class="goal.met ? 'preview__met' : 'preview__unmet'">{{ goal.met ? '✓' : '✗' }}</span> {{ previewGoalLine(goal, goals.get(goal.itemId)) }}
      </li>
    </ul>

    <h4 class="preview__label">{{ PREVIEW_PARTS.newIssues }}</h4>
    <ul v-if="preview.newIssues.length > 0" class="preview__list">
      <li v-for="issue in preview.newIssues" :key="`${issue.name}@${issue.version}`" class="preview__issue" data-testid="preview-new-issue">
        <NodeBadges v-if="issue.notChecked === undefined" :badges="newIssueBadges(issue)" />
        <span class="mono">{{ issue.name }} {{ issue.version }}</span>
        <span v-if="issue.notChecked !== undefined" class="muted">{{ notCheckedText(issue.notChecked) }}</span>
        <span v-else-if="issue.vulnIds.length > 0" class="muted">{{ issue.vulnIds.join(' · ') }}</span>
        <span v-else-if="issue.deprecated !== undefined" class="muted">{{ issue.deprecated }}</span>
      </li>
    </ul>
    <p v-else class="preview__none muted">{{ NONE }}</p>

    <template v-if="preview.warnings.length > 0">
      <h4 class="preview__label">{{ PREVIEW_PARTS.warnings }}</h4>
      <ul class="preview__list">
        <li v-for="warning in preview.warnings" :key="warning" class="preview__warning" data-testid="preview-warning">{{ warning }}</li>
      </ul>
    </template>

    <h4 class="preview__label">{{ PREVIEW_PARTS.files }}</h4>
    <div class="preview__files">
      <PreviewFileDetails v-for="(file, index) in preview.files" :key="`${preview.id}\n${file.path}`" :root="root" :file="file" :index="index" />
    </div>

    <details :key="preview.id" class="preview__package-changes" data-testid="preview-package-changes">
      <summary class="preview__summary">
        <AppIcon class="summary-chevron" name="chevron-right" :size="18" />
        <h4 class="preview__label preview__summary-heading">{{ packageChangesHeading(preview.packageChanges.length) }}</h4>
      </summary>
      <ul v-if="preview.packageChanges.length > 0" class="preview__list preview__changes mono">
        <li v-for="change in shownPackageChanges" :key="change.name" data-testid="preview-package-change">{{ packageChangeText(change) }}</li>
      </ul>
      <p v-else class="preview__none muted">{{ NONE }}</p>
      <button v-if="hiddenPackageChangeCount > 0" type="button" class="preview__more" @click="showsAllPackageChanges = true">
        {{ moreCountText(hiddenPackageChangeCount) }}
      </button>
    </details>
  </section>
</template>

<style scoped>
.preview {
  padding: 14px 16px 18px;
  border-top: 1px solid var(--border-strong);
}

.preview__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.preview__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.preview__label {
  margin: 16px 0 6px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.preview__list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.preview__goal,
.preview__warning {
  overflow-wrap: anywhere;
}

.preview__met {
  color: var(--badge-ok-fg);
  font-weight: 700;
}

.preview__unmet {
  color: var(--danger);
  font-weight: 700;
}

.preview__none {
  margin: 0;
}

.preview__issue {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  overflow-wrap: anywhere;
}

.preview__warning {
  color: var(--badge-warn-fg);
}

.preview__files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.preview__package-changes {
  margin-top: 16px;
}

.preview__summary {
  margin: 0 0 6px;
  cursor: pointer;
}

.preview__summary-heading {
  display: inline;
  margin: 0;
}

.preview__changes {
  gap: 2px;
}

.preview__more {
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
}

.preview__more:hover {
  text-decoration: underline;
}
</style>
