<script setup lang="ts">
import { computed, inject, reactive, ref, useId, watch } from 'vue'
import { SHOWN_SOURCE, type ShownSourceState } from '../source.ts'
import type { SourceKind } from '../../../src/model.ts'
import type { IssueKind } from '../../../src/query/issues.ts'
import type { RootSummary, ScanSummary } from '../api.ts'
import { problemHint, problemLine, progressLine } from '../insight-text.ts'
import { useRovingList } from '../keyboard/use-roving-list.ts'
import { APPROXIMATE_SOURCES, pathFromRoot, rootLabel } from '../labels.ts'
import type { Selection } from '../context.ts'
import {
  ALL_ROOTS,
  HEALTH_SEPARATOR,
  LOADING_ROOTS,
  NO_ROOTS_FOUND,
  noRootsInText,
  osvProgressText,
  PACKAGE_CHECKS,
  REGISTRY_CHECKS,
  RESOLVE_VERSIONS,
  ROOT_PACKAGE,
  ROOT_STATUS_TEXTS,
  rootErrorText,
  rootHealthLinks,
  rootJobText,
  ROOTS_HEADING,
  SOURCE_LABELS,
  sourceAccuracyText,
  warningCountText,
  type HealthLink,
} from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'
import BreakablePath from './BreakablePath.vue'

type WorkspacePackage = RootSummary['importers'][number]
type TreeRow =
  | { kind: 'all'; id: string; level: 1; position: number; setSize: number }
  | { kind: 'root'; id: string; level: 1; position: number; setSize: number; root: RootSummary; expandable: boolean; expanded: boolean }
  | { kind: 'package'; id: string; level: 2; position: number; setSize: number; root: RootSummary; parentId: string; workspacePackage: WorkspacePackage }

const props = defineProps<{
  scan: ScanSummary | null
  scanFailed: boolean
  scope?: string
  selection?: Selection
  healthLinkHref: (root: string, kind: HealthLink['kind']) => string
}>()

const emit = defineEmits<{
  'choose-root': [root: string | undefined]
  'open-workspace-package': [selection: Selection]
  'open-issues': [root: string, kind: IssueKind]
  'open-changes': [root: string]
  resolve: [rootId: string]
}>()

const shown = inject(SHOWN_SOURCE, { source: { kind: 'working' } } satisfies ShownSourceState)

const SOURCE_TONES: Record<SourceKind, string> = {
  lockfile: 'badge--ok',
  installed: 'badge--info',
  'resolved-today': 'badge--warn',
  'manifest-only': 'badge--warn',
}

const ALL_ROOTS_ROW_ID = 'roots:all'

const elementId = useId()
const expandedRoots = reactive(new Set<string>())
const tree = ref<HTMLElement | null>(null)

const enrichment = computed(() => props.scan?.enrichment)
const showsProgress = computed(() => enrichment.value !== undefined && (enrichment.value.state === 'running' || enrichment.value.problems.length > 0))
const progressFraction = computed(() => {
  const { done, total } = enrichment.value?.registry ?? { done: 0, total: 0 }
  return total === 0 ? 0 : Math.min(1, done / total)
})
const osvLine = computed(() => {
  const osv = enrichment.value?.osv
  return osv === undefined ? '' : osvProgressText(osv.done, osv.skipped)
})

function rootTitleParts(rootId: string): { parentSegments: string[]; leaf: string } {
  const label = rootLabel(rootId)
  const leafStart = label === rootId ? label.lastIndexOf('/') + 1 : 0
  const parentSegments = label.slice(0, leafStart).split(/(?<=\/)/).filter((segment) => segment !== '')
  return { parentSegments, leaf: label.slice(leafStart) }
}

function isRootPackage(root: RootSummary, workspacePackage: WorkspacePackage): boolean {
  return workspacePackage.path === root.path
}

function pathInsideRoot(root: RootSummary, workspacePackage: WorkspacePackage): string {
  if (isRootPackage(root, workspacePackage)) return ''
  return pathFromRoot(root.path, workspacePackage.path)
}

function packageLabel(root: RootSummary, workspacePackage: WorkspacePackage): string {
  return isRootPackage(root, workspacePackage) ? ROOT_PACKAGE : workspacePackage.name
}

function packagePathHint(root: RootSummary, workspacePackage: WorkspacePackage): string | undefined {
  const pathInside = pathInsideRoot(root, workspacePackage)
  return pathInside === '' || pathInside === workspacePackage.name ? undefined : pathInside
}

function listedPackages(root: RootSummary): WorkspacePackage[] {
  return root.importers.filter((workspacePackage) => !isRootPackage(root, workspacePackage) || workspacePackage.dependencyCount > 0)
}

function rootRowId(root: string): string {
  return `roots:root:${root}`
}

function packageRowId(root: string, node: string): string {
  return `roots:package:${root}\n${node}`
}

function rowPartId(index: number, part: 'name' | 'meta'): string {
  return `${elementId}-row-${index}-${part}`
}

const rows = computed<TreeRow[]>(() => {
  const roots = props.scan?.roots ?? []
  const topLevelCount = roots.length + 1
  const result: TreeRow[] = [{ kind: 'all', id: ALL_ROOTS_ROW_ID, level: 1, position: 1, setSize: topLevelCount }]
  roots.forEach((root, index) => {
    const packages = listedPackages(root)
    const expanded = packages.length > 0 && expandedRoots.has(root.id)
    const id = rootRowId(root.id)
    result.push({ kind: 'root', id, level: 1, position: index + 2, setSize: topLevelCount, root, expandable: packages.length > 0, expanded })
    if (!expanded) return
    packages.forEach((workspacePackage, packageIndex) => {
      result.push({
        kind: 'package',
        id: packageRowId(root.id, workspacePackage.id),
        level: 2,
        position: packageIndex + 1,
        setSize: packages.length,
        root,
        parentId: id,
        workspacePackage,
      })
    })
  })
  return result
})

const rovingItems = computed(() =>
  rows.value.map((row) => ({
    id: row.id,
    parentId: row.kind === 'package' ? row.parentId : undefined,
    expandable: row.kind === 'root' && row.expandable,
    expanded: row.kind === 'root' && row.expanded,
  })),
)

function rowById(id: string): TreeRow | undefined {
  return rows.value.find((row) => row.id === id)
}

function expandRoot(id: string): void {
  const row = rowById(id)
  if (row?.kind === 'root') expandedRoots.add(row.root.id)
}

function collapseRoot(id: string): void {
  const row = rowById(id)
  if (row?.kind === 'root') expandedRoots.delete(row.root.id)
}

function activateRow(id: string): void {
  const row = rowById(id)
  if (row === undefined) return
  if (row.kind === 'all') emit('choose-root', undefined)
  else if (row.kind === 'root') emit('choose-root', row.root.id)
  else emit('open-workspace-package', { root: row.root.id, node: row.workspacePackage.id })
}

const { activeId, tabIndexOf, onKeydown } = useRovingList(rovingItems, {
  expand: expandRoot,
  collapse: collapseRoot,
  activate: activateRow,
})

function scopeRowId(scope: string | undefined): string {
  return scope === undefined ? ALL_ROOTS_ROW_ID : rootRowId(scope)
}

function hasFocusInTree(): boolean {
  const focused = document.activeElement
  return focused !== null && (tree.value?.contains(focused) ?? false)
}

function moveActiveRowToScope(scope: string | undefined): void {
  if (hasFocusInTree()) return
  const scopeRow = scopeRowId(scope)
  if (props.scan === null || rows.value.some((row) => row.id === scopeRow)) activeId.value = scopeRow
}

watch(
  () => props.scope,
  (scope) => {
    expandedRoots.clear()
    if (scope !== undefined) expandedRoots.add(scope)
    moveActiveRowToScope(scope)
  },
  { immediate: true },
)

function onRowKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  onKeydown(event)
}

function onRowClick(row: TreeRow): void {
  activeId.value = row.id
  activateRow(row.id)
}

function toggleRoot(row: TreeRow): void {
  activeId.value = row.id
  if (row.kind !== 'root') return
  if (row.expanded) collapseRoot(row.id)
  else expandRoot(row.id)
}

function innerTabIndex(row: TreeRow): 0 | -1 {
  return tabIndexOf(row.id)
}

function isScopeRow(row: TreeRow): boolean {
  if (row.kind === 'all') return props.scope === undefined
  return row.kind === 'root' && props.scope === row.root.id
}

function isSelectedPackage(row: TreeRow): boolean {
  return row.kind === 'package' && props.selection?.root === row.root.id && props.selection.node === row.workspacePackage.id
}

function resolveRoot(row: TreeRow): void {
  activeId.value = row.id
  if (row.kind === 'root') emit('resolve', row.root.id)
}

function followHealthLink(event: MouseEvent, row: TreeRow, kind: HealthLink['kind']): void {
  activeId.value = row.id
  if (row.kind !== 'root') return
  const root = row.root.id
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  if (kind === 'changes') emit('open-changes', root)
  else emit('open-issues', root, kind)
}

function showsSourceBadge(root: RootSummary): boolean {
  return root.source !== 'lockfile'
}
</script>

<template>
  <div class="roots">
    <section v-if="enrichment && showsProgress" class="progress" :aria-label="PACKAGE_CHECKS" data-testid="enrichment-progress">
      <template v-if="enrichment.state === 'running'">
        <p class="progress__line">{{ progressLine(enrichment) }}</p>
        <div
          class="progress__bar"
          role="progressbar"
          :aria-label="REGISTRY_CHECKS"
          :aria-valuemin="0"
          :aria-valuemax="enrichment.registry.total"
          :aria-valuenow="enrichment.registry.done"
        >
          <span class="progress__fill" :style="{ width: `${progressFraction * 100}%` }" />
        </div>
        <p class="progress__detail muted">{{ osvLine }}</p>
      </template>
      <div v-for="problem in enrichment.problems" :key="`${problem.source}\n${problem.origin}\n${problem.message}`" class="progress__problem">
        <p data-testid="enrichment-problem">{{ problemLine(problem) }}</p>
        <p v-if="problemHint(problem)" class="muted" data-testid="enrichment-problem-hint">{{ problemHint(problem) }}</p>
      </div>
    </section>

    <p v-if="!scan && !scanFailed" class="roots__empty muted">{{ LOADING_ROOTS }}</p>
    <p v-else-if="scan && scan.roots.length === 0" class="roots__empty muted">{{ shown.source.kind === 'commit' ? noRootsInText(shown.source.ref) : NO_ROOTS_FOUND }}</p>

    <div v-if="scan && scan.roots.length > 0" ref="tree" role="tree" class="tree" :aria-label="ROOTS_HEADING">
      <div
        v-for="(row, index) in rows"
        :key="row.id"
        role="treeitem"
        class="tree__row"
        :class="[`tree__row--${row.kind}`, { 'tree__row--scope': isScopeRow(row), 'tree__row--selected': isSelectedPackage(row) }]"
        :data-roving-id="row.id"
        :tabindex="tabIndexOf(row.id)"
        :aria-level="row.level"
        :aria-posinset="row.position"
        :aria-setsize="row.setSize"
        :aria-expanded="row.kind === 'root' && row.expandable ? row.expanded : undefined"
        :aria-current="isScopeRow(row) ? 'true' : undefined"
        :aria-selected="row.kind === 'package' ? isSelectedPackage(row) : undefined"
        :aria-labelledby="rowPartId(index, 'name')"
        :aria-describedby="row.kind === 'root' ? rowPartId(index, 'meta') : undefined"
        :title="row.kind === 'package' ? row.workspacePackage.path : undefined"
        @keydown="onRowKeydown"
        @focus="activeId = row.id"
        @click="onRowClick(row)"
      >
        <span v-if="row.kind === 'all'" :id="rowPartId(index, 'name')" class="tree__all">{{ ALL_ROOTS }}</span>

        <template v-else-if="row.kind === 'root'">
          <span class="root__disclosure" aria-hidden="true" @click.stop="toggleRoot(row)">
            <AppIcon v-if="row.expandable" class="root__chevron" :name="row.expanded ? 'chevron-down' : 'chevron-right'" :size="20" />
          </span>
          <div class="root__body">
            <div class="root__heading">
              <span :id="rowPartId(index, 'name')" class="root__title mono" :title="row.root.path">
                <span class="root__parent"><template v-for="(segment, position) in rootTitleParts(row.root.id).parentSegments" :key="position">{{ segment }}<wbr /></template></span>
                <span class="root__leaf">{{ rootTitleParts(row.root.id).leaf }}</span>
              </span>
              <span :id="rowPartId(index, 'meta')" class="root__meta">
                <span class="root__manager">{{ row.root.manager }}</span>
                <span v-if="showsSourceBadge(row.root)" class="badge" :class="SOURCE_TONES[row.root.source]" :title="sourceAccuracyText(row.root.source)">{{ SOURCE_LABELS[row.root.source] }}</span>
                <span v-if="row.root.status === 'scanning'" class="badge badge--info"><span class="root__pulse" />{{ ROOT_STATUS_TEXTS.scanning }}</span>
                <span v-else-if="row.root.status === 'failed'" class="badge badge--danger">{{ ROOT_STATUS_TEXTS.failed }}</span>
                <span v-if="rootJobText(row.root.actions.job)" class="badge badge--info" data-testid="root-job"><span class="root__pulse" />{{ rootJobText(row.root.actions.job) }}</span>
              </span>
            </div>
            <p v-if="row.root.status === 'failed'" class="root__error">{{ rootErrorText(row.root.error) }}</p>
            <p v-if="rootHealthLinks(row.root).length > 0" class="root__health">
              <template v-for="(link, linkIndex) in rootHealthLinks(row.root)" :key="link.kind">
                <span v-if="linkIndex > 0" class="root__separator" aria-hidden="true">{{ HEALTH_SEPARATOR }}</span>
                <a
                  class="root__link"
                  :class="`root__link--${link.kind}`"
                  :href="healthLinkHref(row.root.id, link.kind)"
                  :tabindex="innerTabIndex(row)"
                  @click.stop="followHealthLink($event, row, link.kind)"
                >{{ link.text }}</a>
              </template>
            </p>
            <button
              v-if="APPROXIMATE_SOURCES.has(row.root.source) && shown.source.kind === 'working'"
              type="button"
              class="button root__resolve"
              :title="sourceAccuracyText(row.root.source)"
              :disabled="row.root.status === 'scanning'"
              :tabindex="innerTabIndex(row)"
              @click.stop="resolveRoot(row)"
            >
              {{ RESOLVE_VERSIONS }}
            </button>
            <details v-if="row.root.warnings.length > 0" class="root__warnings" @click.stop>
              <summary :tabindex="innerTabIndex(row)"><AppIcon class="summary-chevron" name="chevron-right" />{{ warningCountText(row.root.warnings.length) }}</summary>
              <ul>
                <li v-for="(warning, position) in row.root.warnings" :key="position">{{ warning }}</li>
              </ul>
            </details>
          </div>
        </template>

        <template v-else>
          <span :id="rowPartId(index, 'name')" class="package__name mono">{{ packageLabel(row.root, row.workspacePackage) }}</span>
          <span v-if="packagePathHint(row.root, row.workspacePackage)" class="package__path muted"
            ><BreakablePath :text="packagePathHint(row.root, row.workspacePackage) ?? ''"
          /></span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.roots {
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--surface-panel);
}

.progress {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}

.progress p {
  margin: 0;
  overflow-wrap: anywhere;
}

.progress__line {
  font-weight: 600;
}

.progress__detail {
  font-size: 13px;
}

.progress__bar {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--badge-neutral-bg);
}

.progress__fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}

.progress__problem {
  display: grid;
  gap: 2px;
  color: var(--badge-warn-fg);
  font-size: 13px;
}

.roots__empty {
  margin: 12px;
}

.tree {
  display: grid;
  padding: 6px 0 12px;
}

.tree__row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  padding: 6px 14px 6px 6px;
  cursor: pointer;
}

.tree__row:hover {
  background: var(--surface-hover);
}

.tree__row:focus {
  outline: none;
}

.tree__row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.tree__row--scope {
  background: var(--surface-raised);
  box-shadow: inset 3px 0 0 var(--accent);
}

.tree__row--scope:hover {
  background: var(--surface-raised);
}

.tree__row--all {
  align-items: center;
  min-height: 36px;
  padding-left: 14px;
}

.tree__all {
  font-weight: 600;
}

.tree__row--root {
  padding-top: 8px;
  padding-bottom: 8px;
}

.tree__row--package {
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  min-height: 32px;
  padding: 5px 14px 5px 34px;
}

.tree__row--selected,
.tree__row--selected:hover {
  background: var(--surface-selected);
}

.root__disclosure {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius);
}

.root__disclosure:hover {
  background: var(--surface-hover);
}

.root__chevron {
  color: var(--text-muted);
}

.root__body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr);
  justify-items: start;
  gap: 4px;
  min-width: 0;
}

.root__body p {
  margin: 0;
}

.root__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  max-width: 100%;
}

.root__title {
  min-width: 0;
  font-size: 14px;
  line-height: 24px;
}

.root__parent {
  color: var(--text-muted);
}

.root__leaf {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.root__meta {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 13px;
}

.root__manager {
  color: var(--text-muted);
}

.root__error {
  color: var(--danger);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.root__health {
  font-size: 13px;
}

.root__separator {
  color: var(--text-muted);
}

.root__link {
  display: inline-block;
  min-height: 24px;
  line-height: 24px;
  color: var(--accent);
  text-underline-offset: 2px;
}

.root__link:hover {
  text-decoration-thickness: 2px;
}

.root__link--vulnerability {
  color: var(--danger);
}

.root__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1s ease-in-out infinite alternate;
}

@keyframes pulse {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.25;
  }
}

.root__resolve {
  height: 28px;
  margin-top: 2px;
  font-size: 13px;
}

.root__warnings {
  font-size: 13px;
  color: var(--text-muted);
}

.root__warnings summary {
  cursor: pointer;
}

.root__warnings ul {
  margin: 4px 0 0;
  padding-left: 16px;
  overflow-wrap: anywhere;
}

.package__name,
.package__path {
  max-width: 100%;
  overflow-wrap: break-word;
}

.package__path {
  font-size: 12px;
}
</style>
