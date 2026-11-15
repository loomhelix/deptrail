<script setup lang="ts">
import { computed, shallowRef, useId } from 'vue'
import type { DepKind } from '../../../src/model.ts'
import { issueProblemBadges, nodeBadges, type Badge } from '../badges.ts'
import type { Selection } from '../context.ts'
import { importerLabels, rootNoteId, type DirectGroupEntry, type DirectIssueEntry, type ViaLabels } from '../issues-model.ts'
import { restoreFocusIfLost } from '../keyboard/lost-focus.ts'
import { useRovingList } from '../keyboard/use-roving-list.ts'
import { rootLabel } from '../labels.ts'
import {
  ISSUE_COLUMN_TITLES,
  ISSUES_BY_DIRECT_LABEL,
  issueLocationName,
  moreNotListedText,
  nestedIssueLocationName,
  VIA_LABEL,
} from '../vocabulary.ts'
import BreakableName from './BreakableName.vue'
import BreakablePath from './BreakablePath.vue'
import AppIcon from './AppIcon.vue'
import IssueRowAction from './IssueRowAction.vue'
import NodeBadges from './NodeBadges.vue'
import ViaList from './ViaList.vue'

const props = defineProps<{
  entries: readonly DirectGroupEntry[]
  scope?: string
  selection?: Selection
  kinds: DepKind[]
  actionsRevisions: ReadonlyMap<string, string>
  unavailableRoots: ReadonlyMap<string, string>
  noteIdPrefix: string
}>()

const emit = defineEmits<{
  select: [selection: Selection]
  update: [selection: Selection]
  review: [root: string, itemId: string]
  added: []
}>()

type DirectGridRow = { kind: 'direct'; id: string; entry: DirectGroupEntry; action?: DirectIssueEntry; via: ViaLabels; expandable: boolean; expanded: boolean }
type IssueGridRow = { kind: 'issue'; id: string; entry: DirectGroupEntry; action: DirectIssueEntry; parentId: string }
type GridRow = DirectGridRow | IssueGridRow
type GroupBlock = { key: string; header: DirectGridRow; issues: IssueGridRow[]; hiddenCount: number }
type CellName = 'problem' | 'via' | 'recommended'

const ROW_ID_PREFIX = 'issues-direct'
const COLUMNS_WITH_ROOT = 4
const COLUMNS_WITHOUT_ROOT = 3
const ADVISORY_SEPARATOR = ' · '

const elementId = useId()
const collapsedGroups = shallowRef<ReadonlySet<string>>(new Set())
const rowsWithRootNote = shallowRef<ReadonlySet<string>>(new Set())

const showsRootColumn = computed(() => props.scope === undefined)
const columnCount = computed(() => (showsRootColumn.value ? COLUMNS_WITH_ROOT : COLUMNS_WITHOUT_ROOT))

function blockOf(entry: DirectGroupEntry): GroupBlock {
  const id = `${ROW_ID_PREFIX}:${entry.key}`
  const expandable = entry.issues.length > 0
  const expanded = expandable && !collapsedGroups.value.has(entry.key)
  const header: DirectGridRow = { kind: 'direct', id, entry, action: entry.own, via: importerLabels(entry.group), expandable, expanded }
  const issues: IssueGridRow[] = expanded ? entry.issues.map((issue) => ({ kind: 'issue', id: `${id}:${issue.key}`, entry, action: issue, parentId: id })) : []
  return { key: entry.key, header, issues, hiddenCount: expanded ? entry.group.issuesTruncated : 0 }
}

const blocks = computed(() => props.entries.map(blockOf))
const gridRows = computed<GridRow[]>(() => blocks.value.flatMap((block) => [block.header, ...block.issues]))
const rovingItems = computed(() =>
  gridRows.value.map((row) => ({
    id: row.id,
    parentId: row.kind === 'issue' ? row.parentId : undefined,
    expandable: row.kind === 'direct' && row.expandable,
    expanded: row.kind === 'direct' && row.expanded,
  })),
)

function rowById(id: string): GridRow | undefined {
  return gridRows.value.find((row) => row.id === id)
}

function setCollapsed(entry: DirectGroupEntry, collapsed: boolean): void {
  const next = new Set(collapsedGroups.value)
  if (collapsed) next.add(entry.key)
  else next.delete(entry.key)
  collapsedGroups.value = next
}

function expandRow(id: string): void {
  const row = rowById(id)
  if (row?.kind === 'direct' && row.expandable) setCollapsed(row.entry, false)
}

function collapseRow(id: string): void {
  const row = rowById(id)
  if (row?.kind === 'direct') setCollapsed(row.entry, true)
}

function selectionOf(row: GridRow): Selection {
  const group = row.entry.group
  return { root: group.rootId, node: row.kind === 'direct' ? group.direct : row.action.location.nodeId }
}

function activateRow(id: string): void {
  const row = rowById(id)
  if (row !== undefined) emit('select', selectionOf(row))
}

const { activeId, tabIndexOf, onKeydown, focusActive } = useRovingList(rovingItems, {
  expand: expandRow,
  collapse: collapseRow,
  activate: activateRow,
})

function onRowKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  onKeydown(event)
}

function onRowClick(row: GridRow): void {
  activeId.value = row.id
  activateRow(row.id)
}

function toggleFromDisclosure(row: DirectGridRow): void {
  activeId.value = row.id
  setCollapsed(row.entry, row.expanded)
}

async function keepFocusAfterAdd(row: GridRow): Promise<void> {
  emit('added')
  await restoreFocusIfLost(document, () => {
    activeId.value = row.id
    focusActive()
  })
}

function isSelected(row: GridRow): boolean {
  const selection = selectionOf(row)
  return props.selection?.root === selection.root && props.selection.node === selection.node
}

function packageLabel(row: GridRow): string {
  if (row.kind === 'issue') return `${row.action.row.name} ${row.action.row.version}`
  return `${row.entry.group.name} ${row.entry.group.version}`
}

function directLabel(row: GridRow): string {
  return `${row.entry.group.name} ${row.entry.group.version}`
}

function rowName(row: GridRow): string {
  const location = rootLabel(row.entry.group.rootId)
  if (row.kind === 'issue') return nestedIssueLocationName(packageLabel(row), directLabel(row), location)
  return issueLocationName(packageLabel(row), location)
}

function problemBadges(row: GridRow): Badge[] {
  return row.action === undefined ? [] : issueProblemBadges(row.action.kind, row.action.row)
}

function belowBadges(row: DirectGridRow): Badge[] {
  const below = row.entry.group.decoration.below
  return below === undefined ? [] : nodeBadges({ below }, { isDirect: true, compact: false, version: row.entry.group.version })
}

function latestOf(row: DirectGridRow): string | undefined {
  return row.action === undefined || row.action.kind === 'vulnerability' ? undefined : row.action.row.latest
}

function advisoryIds(issue: DirectIssueEntry): string[] {
  return issue.kind === 'vulnerability' ? issue.row.vulnIds : []
}

function deprecationMessage(issue: DirectIssueEntry): string | undefined {
  return issue.kind === 'deprecated' ? issue.row.deprecatedMessage : undefined
}

function hiddenNoteId(block: GroupBlock): string {
  return `${elementId}-${block.header.id}-hidden`
}

function headerDescription(block: GroupBlock): string {
  const description = rowDescription(block.header)
  return block.hiddenCount > 0 ? `${description} ${hiddenNoteId(block)}` : description
}

function markRootUnavailable(rowId: string, unavailable: boolean): void {
  const next = new Set(rowsWithRootNote.value)
  if (unavailable) next.add(rowId)
  else next.delete(rowId)
  rowsWithRootNote.value = next
}

function describedBy(row: GridRow, block: GroupBlock): string {
  const description = row.kind === 'direct' ? headerDescription(block) : rowDescription(row)
  return rowsWithRootNote.value.has(row.id) ? `${description} ${rootNoteId(props.noteIdPrefix, row.entry.group.rootId)}` : description
}

function cellId(row: GridRow, cell: CellName): string {
  return `${elementId}-${row.id}-${cell}`
}

function rowDescription(row: GridRow): string {
  const cells: CellName[] = row.kind === 'direct' ? ['problem', 'via', 'recommended'] : ['problem', 'recommended']
  return cells.map((cell) => cellId(row, cell)).join(' ')
}
</script>

<template>
  <table class="direct-rows" role="treegrid" :aria-label="ISSUES_BY_DIRECT_LABEL">
    <colgroup>
      <col class="direct-rows__col-problem" />
      <col />
      <col v-if="showsRootColumn" class="direct-rows__col-root" />
      <col class="direct-rows__col-recommended" />
    </colgroup>
    <thead>
      <tr>
        <th scope="col">{{ ISSUE_COLUMN_TITLES.issue }}</th>
        <th scope="col">{{ ISSUE_COLUMN_TITLES.package }}</th>
        <th v-if="showsRootColumn" scope="col">{{ ISSUE_COLUMN_TITLES.root }}</th>
        <th scope="col">{{ ISSUE_COLUMN_TITLES.recommended }}</th>
      </tr>
    </thead>
    <tbody v-for="block in blocks" :key="block.key" data-testid="issue-group">
      <tr
        v-for="gridRow in [block.header, ...block.issues]"
        :key="gridRow.id"
        class="direct-rows__row"
        :class="{
          'direct-rows__row--direct': gridRow.kind === 'direct',
          'direct-rows__row--child': gridRow.kind === 'issue',
          'direct-rows__row--selected': isSelected(gridRow),
        }"
        :data-testid="gridRow.kind === 'direct' ? 'issue-group-header' : 'issue-group-row'"
        :data-roving-id="gridRow.id"
        :tabindex="tabIndexOf(gridRow.id)"
        :aria-level="gridRow.kind === 'direct' ? 1 : 2"
        :aria-expanded="gridRow.kind === 'direct' && gridRow.expandable ? gridRow.expanded : undefined"
        :aria-selected="isSelected(gridRow)"
        :aria-label="rowName(gridRow)"
        :aria-describedby="describedBy(gridRow, block)"
        @keydown="onRowKeydown"
        @focusin="activeId = gridRow.id"
        @click="onRowClick(gridRow)"
      >
        <td :id="cellId(gridRow, 'problem')">
          <span class="direct-rows__badges"><NodeBadges :badges="problemBadges(gridRow)" /></span>
        </td>
        <td>
          <div v-if="gridRow.kind === 'direct'" class="direct-rows__package">
            <span class="direct-rows__title">
              <span
                v-if="gridRow.expandable"
                class="direct-rows__disclosure"
                aria-hidden="true"
                data-testid="group-disclosure"
                @click.stop="toggleFromDisclosure(gridRow)"
                ><AppIcon :name="gridRow.expanded ? 'chevron-down' : 'chevron-right'" :size="20" /></span
              >
              <span v-else class="direct-rows__disclosure" aria-hidden="true"></span>
              <span class="direct-rows__name mono"><BreakableName :name="gridRow.entry.group.name" :version="gridRow.entry.group.version" /></span>
            </span>
            <span v-if="latestOf(gridRow)" class="direct-rows__latest mono muted">→ {{ latestOf(gridRow) }}</span>
            <NodeBadges :badges="belowBadges(gridRow)" />
          </div>
          <div v-if="gridRow.kind === 'direct'" class="direct-rows__via">
            <ViaList :id="cellId(gridRow, 'via')" :via="gridRow.via" :prefix="VIA_LABEL" />
          </div>
          <template v-else>
            <span class="direct-rows__name mono"><BreakableName :name="gridRow.action.row.name" :version="gridRow.action.row.version" /></span>
            <div v-if="advisoryIds(gridRow.action).length > 0" class="direct-rows__detail muted">
              <template v-for="(id, position) in advisoryIds(gridRow.action)" :key="id">
                <span v-if="position > 0">{{ ADVISORY_SEPARATOR }}</span><span class="direct-rows__advisory">{{ id }}</span>
              </template>
            </div>
            <div v-else-if="deprecationMessage(gridRow.action)" class="direct-rows__detail muted">{{ deprecationMessage(gridRow.action) }}</div>
          </template>
        </td>
        <td v-if="showsRootColumn" class="direct-rows__root">
          <span v-if="gridRow.kind === 'direct'"
            ><BreakablePath :text="rootLabel(gridRow.entry.group.rootId)"
          /></span>
        </td>
        <td :id="cellId(gridRow, 'recommended')">
          <IssueRowAction
            v-if="gridRow.action !== undefined"
            :kind="gridRow.action.kind"
            :location="gridRow.action.location"
            :row="gridRow.action.row"
            :kinds="kinds"
            :revision="actionsRevisions.get(gridRow.entry.group.rootId) ?? ''"
            :root-reason="unavailableRoots.get(gridRow.entry.group.rootId)"
            :in-active-row="activeId === gridRow.id"
            @added="keepFocusAfterAdd(gridRow)"
            @update="(selection: Selection) => emit('update', selection)"
            @review="(rootId: string, itemId: string) => emit('review', rootId, itemId)"
            @root-unavailable="(unavailable: boolean) => markRootUnavailable(gridRow.id, unavailable)"
          />
        </td>
      </tr>
      <tr v-if="block.hiddenCount > 0" class="direct-rows__hidden" aria-level="2">
        <td :id="hiddenNoteId(block)" :colspan="columnCount" class="muted">{{ moreNotListedText(block.hiddenCount) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.direct-rows {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.direct-rows__col-problem {
  width: 96px;
}

.direct-rows__col-recommended {
  width: 30%;
}

.direct-rows thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px;
  border-bottom: 1px solid var(--border-strong);
  background: var(--surface-panel);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.direct-rows td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.direct-rows__row {
  cursor: pointer;
}

.direct-rows__row:hover td {
  background: var(--surface-hover);
}

.direct-rows__row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.direct-rows__row--direct td {
  border-top: 1px solid var(--border-strong);
}

.direct-rows__row--direct .direct-rows__name {
  font-weight: 600;
}

.direct-rows__row--child td {
  border-bottom-color: var(--surface-panel);
}

.direct-rows__row--child td:nth-child(2) {
  padding-left: 32px;
}

.direct-rows__row--selected td,
.direct-rows__row--selected:hover td {
  background: var(--surface-selected);
}

.direct-rows__row--selected td:first-child {
  box-shadow: inset 3px 0 0 var(--accent);
}

.direct-rows__badges {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.direct-rows__package {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
}

.direct-rows__title {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
}

.direct-rows__name {
  overflow-wrap: anywhere;
}

.direct-rows__latest,
.direct-rows__advisory {
  white-space: nowrap;
}

.direct-rows__via {
  margin-top: 2px;
  padding-left: 24px;
  font-size: 13px;
}

.direct-rows__root {
  overflow-wrap: break-word;
}

.direct-rows__disclosure {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-muted);
  vertical-align: middle;
  cursor: pointer;
}

.direct-rows__detail {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.direct-rows__hidden td {
  padding-left: 32px;
}
</style>
