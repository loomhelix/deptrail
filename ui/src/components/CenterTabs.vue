<script setup lang="ts">
import { computed, nextTick, useId } from 'vue'
import type { ViewName } from '../context.ts'
import { issueCountTitle, scopeLabel, VIEW_TITLES, VIEWS_LABEL } from '../vocabulary.ts'

const props = defineProps<{
  view: ViewName
  scope?: string
  issueCount: number | null
  changeCount?: number
}>()

const emit = defineEmits<{ 'view-change': [view: ViewName] }>()

const VIEWS: readonly ViewName[] = ['issues', 'changes', 'explore', 'compare']

const elementId = useId()
const panelId = `${elementId}-panel`

const issuesTitle = computed(() => (props.issueCount === null ? undefined : issueCountTitle(props.issueCount, scopeLabel(props.scope))))

function tabId(view: ViewName): string {
  return `${elementId}-tab-${view}`
}

function countOf(view: ViewName): number | undefined {
  if (view === 'issues') return props.issueCount ?? undefined
  if (view === 'changes') return props.changeCount
  return undefined
}

function focusTab(view: ViewName): void {
  document.getElementById(tabId(view))?.focus()
}

function focusSelectedTab(): void {
  focusTab(props.view)
}

async function moveSelection(step: number): Promise<void> {
  const position = (VIEWS.indexOf(props.view) + step + VIEWS.length) % VIEWS.length
  const next = VIEWS[position]!
  emit('view-change', next)
  await nextTick()
  focusTab(next)
}

defineExpose({ focusSelectedTab })
</script>

<template>
  <div class="center">
    <div class="center__bar">
      <div class="center__tabs" role="tablist" :aria-label="VIEWS_LABEL">
        <button
          v-for="tabView in VIEWS"
          :id="tabId(tabView)"
          :key="tabView"
          type="button"
          role="tab"
          class="center__tab"
          :class="{ 'center__tab--selected': tabView === view }"
          :aria-selected="tabView === view"
          :aria-controls="tabView === view ? panelId : undefined"
          :tabindex="tabView === view ? 0 : -1"
          :title="tabView === 'issues' ? issuesTitle : undefined"
          @click="emit('view-change', tabView)"
          @keydown.right.prevent="moveSelection(1)"
          @keydown.left.prevent="moveSelection(-1)"
        >
          {{ VIEW_TITLES[tabView] }}
          <span v-if="countOf(tabView) !== undefined" class="center__count" :data-testid="`${tabView}-count`">{{ countOf(tabView) }}</span>
        </button>
      </div>
      <div class="center__end">
        <slot name="end" />
      </div>
    </div>
    <div :id="panelId" class="center__panel" role="tabpanel" :aria-labelledby="tabId(view)">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.center {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.center__bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
}

.center__tabs {
  display: flex;
  flex: none;
  align-self: stretch;
  gap: 4px;
}

.center__tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 0;
  background: none;
  color: var(--text-muted);
  font-weight: 500;
  cursor: pointer;
}

.center__tab:hover,
.center__tab--selected {
  color: var(--text);
}

.center__tab--selected::after {
  position: absolute;
  right: 6px;
  bottom: -1px;
  left: 6px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  content: '';
}

.center__tab:focus-visible {
  outline-offset: -2px;
}

.center__count {
  padding: 0 7px;
  border-radius: 10px;
  background: var(--badge-neutral-bg);
  color: var(--badge-neutral-fg);
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
}

.center__end {
  display: flex;
  flex: 1 1 auto;
  justify-content: flex-end;
  min-width: 0;
}

.center__panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
