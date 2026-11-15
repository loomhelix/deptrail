<script setup lang="ts">
import { computed, shallowRef, useId } from 'vue'
import type { DepKind } from '../../../src/model.ts'
import type { IssueKind, IssueRow } from '../../../src/query/issues.ts'
import { issueProblemBadges, type Badge } from '../badges.ts'
import type { Selection } from '../context.ts'
import { ISSUE_KINDS, rootNoteId, viaLabels, type LocationRow, type PackageGroup, type ViaLabels } from '../issues-model.ts'
import { restoreFocusIfLost } from '../keyboard/lost-focus.ts'
import { useRovingList } from '../keyboard/use-roving-list.ts'
import {
  inRootsText,
  ISSUE_COLUMN_TITLES,
  issueLocationName,
  issueSectionTitle,
  ISSUES_TABLE_LABEL,
  VIA_LABEL,
  VIA_PREFIX,
} from '../vocabulary.ts'
import BreakableName from './BreakableName.vue'
import BreakablePath from './BreakablePath.vue'
import AppIcon from './AppIcon.vue'
import IssueRowAction from './IssueRowAction.vue'
import NodeBadges from './NodeBadges.vue'
import ViaList from './ViaList.vue'

const props = defineProps<{
  groups: readonly PackageGroup[]
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

type PackageGridRow = { kind: 'package'; id: string; group: PackageGroup; expanded: boolean }
type LocationGridRow = { kind: 'location'; id: string; group: PackageGroup; entry: LocationRow; via: ViaLabels; parentId?: string }
type GridRow = PackageGridRow | LocationGridRow
type Section = { kind: IssueKind; title: string; rows: GridRow[] }
type CellName = 'problem' | 'via' | 'recommended'

const ROW_ID_PREFIX = 'issues-row'
const COLUMNS_WITH_ROOT = 4
const COLUMNS_WITHOUT_ROOT = 3
const ADVISORY_SEPARATOR = ' · '

const elementId = useId()
const collapsedGroups = shallowRef<ReadonlySet<string>>(new Set())
const rowsWithRootNote = shallowRef<ReadonlySet<string>>(new Set())

const showsRootColumn = computed(() => props.scope === undefined)
const columnCount = computed(() => (showsRootColumn.value ? COLUMNS_WITH_ROOT : COLUMNS_WITHOUT_ROOT))

function packageRowId(group: PackageGroup): string {
  return `${ROW_ID_PREFIX}:${group.key}`
}

function locationGridRow(group: PackageGroup, entry: LocationRow, parentId?: string): LocationGridRow {
  return { kind: 'location', id: `${ROW_ID_PREFIX}:${group.key}:${entry.key}`, group, entry, via: viaLabels(entry.location), parentId }
}

function gridRowsOf(group: PackageGroup): GridRow[] {
  const [onlyLocation] = group.locations
  if (group.locations.length === 1 && onlyLocation !== undefined) return [locationGridRow(group, onlyLocation)]
  const id = packageRowId(group)
  const expanded = !collapsedGroups.value.has(group.key)
  const header: PackageGridRow = { kind: 'package', id, group, expanded }
  return expanded ? [header, ...group.locations.map((entry) => locationGridRow(group, entry, id))] : [header]
}

const sections = computed<Section[]>(() =>
  ISSUE_KINDS.flatMap((kind) => {
    const groups = props.groups.filter((group) => group.kind === kind)
    return groups.length === 0 ? [] : [{ kind, title: issueSectionTitle(kind), rows: groups.flatMap(gridRowsOf) }]
  }),
)
const gridRows = computed(() => sections.value.flatMap((section) => section.rows))
const rovingItems = computed(() =>
  gridRows.value.map((row) => ({
    id: row.id,
    parentId: row.kind === 'location' ? row.parentId : undefined,
    expandable: row.kind === 'package',
    expanded: row.kind === 'package' && row.expanded,
  })),
)

function rowById(id: string): GridRow | undefined {
  return gridRows.value.find((row) => row.id === id)
}

function setCollapsed(group: PackageGroup, collapsed: boolean): void {
  const next = new Set(collapsedGroups.value)
  if (collapsed) next.add(group.key)
  else next.delete(group.key)
  collapsedGroups.value = next
}

function expandRow(id: string): void {
  const row = rowById(id)
  if (row?.kind === 'package') setCollapsed(row.group, false)
}

function collapseRow(id: string): void {
  const row = rowById(id)
  if (row?.kind === 'package') setCollapsed(row.group, true)
}

function activateRow(id: string): void {
  const row = rowById(id)
  if (row === undefined) return
  if (row.kind === 'package') setCollapsed(row.group, row.expanded)
  else emit('select', { root: row.entry.location.rootId, node: row.entry.location.nodeId })
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

async function keepFocusAfterAdd(row: GridRow): Promise<void> {
  emit('added')
  await restoreFocusIfLost(document, () => {
    activeId.value = row.id
    focusActive()
  })
}

function isMergedRow(row: GridRow): row is LocationGridRow {
  return row.kind === 'location' && row.parentId === undefined
}

function showsPackage(row: GridRow): boolean {
  return row.kind === 'package' || isMergedRow(row)
}

function isSelected(entry: LocationRow): boolean {
  return props.selection?.root === entry.location.rootId && props.selection.node === entry.location.nodeId
}

function packageLabel(row: IssueRow): string {
  return `${row.name} ${row.version}`
}

function rootCount(group: PackageGroup): number {
  return new Set(group.locations.map((entry) => entry.location.rootId)).size
}

function problemBadges(group: PackageGroup): Badge[] {
  return issueProblemBadges(group.kind, group.row)
}

function advisoryIds(group: PackageGroup): string[] {
  return group.kind === 'vulnerability' ? group.row.vulnIds : []
}

function deprecationMessage(group: PackageGroup): string | undefined {
  return group.kind === 'deprecated' ? group.row.deprecatedMessage : undefined
}

function showsLatest(group: PackageGroup): boolean {
  return group.row.latest !== undefined && group.kind !== 'vulnerability'
}

function cellId(section: IssueKind, index: number, cell: CellName): string {
  return `${elementId}-${section}-${index}-${cell}`
}

function markRootUnavailable(rowId: string, unavailable: boolean): void {
  const next = new Set(rowsWithRootNote.value)
  if (unavailable) next.add(rowId)
  else next.delete(rowId)
  rowsWithRootNote.value = next
}

function locationDescription(section: IssueKind, index: number, row: LocationGridRow): string {
  const cells: CellName[] = isMergedRow(row) ? ['problem', 'via', 'recommended'] : ['via', 'recommended']
  const ids = cells.map((cell) => cellId(section, index, cell))
  if (rowsWithRootNote.value.has(row.id)) ids.push(rootNoteId(props.noteIdPrefix, row.entry.location.rootId))
  return ids.join(' ')
}

function locationName(row: LocationGridRow): string {
  return issueLocationName(packageLabel(row.group.row), row.entry.label)
}

</script>

<template>
  <table class="issue-rows" role="treegrid" :aria-label="ISSUES_TABLE_LABEL">
    <colgroup>
      <col class="issue-rows__col-problem" />
      <col />
      <col v-if="showsRootColumn" class="issue-rows__col-root" />
      <col class="issue-rows__col-recommended" />
    </colgroup>
    <thead>
      <tr>
        <th scope="col">{{ ISSUE_COLUMN_TITLES.issue }}</th>
        <th scope="col">{{ ISSUE_COLUMN_TITLES.package }}</th>
        <th v-if="showsRootColumn" scope="col">{{ ISSUE_COLUMN_TITLES.root }}</th>
        <th scope="col">{{ ISSUE_COLUMN_TITLES.recommended }}</th>
      </tr>
    </thead>
    <tbody v-for="section in sections" :key="section.kind" data-testid="issues-section">
      <tr class="issue-rows__section">
        <th :colspan="columnCount" scope="colgroup"><h3 class="issue-rows__section-title">{{ section.title }}</h3></th>
      </tr>
      <tr
        v-for="(gridRow, index) in section.rows"
        :key="gridRow.id"
        class="issue-rows__row"
        :class="{
          'issue-rows__row--package': gridRow.kind === 'package',
          'issue-rows__row--child': gridRow.kind === 'location' && gridRow.parentId !== undefined,
          'issue-rows__row--selected': gridRow.kind === 'location' && isSelected(gridRow.entry),
        }"
        :data-testid="gridRow.kind === 'package' ? 'issue-package' : 'issue-row'"
        :data-roving-id="gridRow.id"
        :tabindex="tabIndexOf(gridRow.id)"
        :aria-level="gridRow.kind === 'location' && gridRow.parentId !== undefined ? 2 : 1"
        :aria-expanded="gridRow.kind === 'package' ? gridRow.expanded : undefined"
        :aria-selected="gridRow.kind === 'location' ? isSelected(gridRow.entry) : undefined"
        :aria-label="gridRow.kind === 'location' ? locationName(gridRow) : undefined"
        :aria-describedby="gridRow.kind === 'location' ? locationDescription(section.kind, index, gridRow) : undefined"
        @keydown="onRowKeydown"
        @focusin="activeId = gridRow.id"
        @click="onRowClick(gridRow)"
      >
        <td :id="cellId(section.kind, index, 'problem')">
          <NodeBadges v-if="showsPackage(gridRow)" :badges="problemBadges(gridRow.group)" />
        </td>
        <template v-if="showsPackage(gridRow)">
        <td>
            <div class="issue-rows__package">
              <span class="issue-rows__title">
                <span v-if="gridRow.kind === 'package'" class="issue-rows__disclosure" aria-hidden="true"
                  ><AppIcon :name="gridRow.expanded ? 'chevron-down' : 'chevron-right'" :size="20"
                /></span>
                <span class="issue-rows__name mono"><BreakableName :name="gridRow.group.row.name" :version="gridRow.group.row.version" /></span>
              </span>
              <span v-if="showsLatest(gridRow.group)" class="issue-rows__latest mono muted">→ {{ gridRow.group.row.latest }}</span>
            </div>
            <div v-if="advisoryIds(gridRow.group).length > 0" class="issue-rows__detail muted">
              <template v-for="(id, position) in advisoryIds(gridRow.group)" :key="id">
                <span v-if="position > 0">{{ ADVISORY_SEPARATOR }}</span><span class="issue-rows__advisory">{{ id }}</span>
              </template>
            </div>
            <div v-else-if="deprecationMessage(gridRow.group)" class="issue-rows__detail muted">{{ deprecationMessage(gridRow.group) }}</div>
            <div v-if="gridRow.kind === 'location'" class="issue-rows__via">
              <ViaList :id="cellId(section.kind, index, 'via')" :via="gridRow.via" :prefix="VIA_LABEL" />
            </div>
        </td>
        <td v-if="showsRootColumn" class="issue-rows__root">
          <span v-if="gridRow.kind === 'package'" class="issue-rows__in-roots muted">{{ rootCount(gridRow.group) > 1 ? inRootsText(rootCount(gridRow.group)) : '' }}</span>
          <span v-else :title="gridRow.entry.title"><BreakablePath :text="gridRow.entry.label" /></span>
        </td>
        </template>
        <td v-else-if="gridRow.kind === 'location'" :colspan="showsRootColumn ? 2 : 1">
          <div class="issue-rows__location" data-testid="issue-location">
            <span class="issue-rows__location-label" data-testid="location-label" :title="gridRow.entry.title"><BreakablePath :text="gridRow.entry.label" /></span>
            <span class="issue-rows__location-via"><ViaList :id="cellId(section.kind, index, 'via')" :via="gridRow.via" :prefix="VIA_PREFIX" /></span>
          </div>
        </td>
        <td :id="cellId(section.kind, index, 'recommended')">
          <IssueRowAction
            v-if="gridRow.kind === 'location'"
            :kind="gridRow.group.kind"
            :location="gridRow.entry.location"
            :row="gridRow.group.row"
            :kinds="kinds"
            :revision="actionsRevisions.get(gridRow.entry.location.rootId) ?? ''"
            :root-reason="unavailableRoots.get(gridRow.entry.location.rootId)"
            :in-active-row="activeId === gridRow.id"
            @added="keepFocusAfterAdd(gridRow)"
            @update="(selection: Selection) => emit('update', selection)"
            @review="(rootId: string, itemId: string) => emit('review', rootId, itemId)"
            @root-unavailable="(unavailable: boolean) => markRootUnavailable(gridRow.id, unavailable)"
          />
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.issue-rows {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.issue-rows__col-problem {
  width: 96px;
}

.issue-rows__col-recommended {
  width: 30%;
}

.issue-rows thead th {
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

.issue-rows td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.issue-rows__section th {
  padding: 6px 12px;
  border-top: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border);
  background: var(--surface-panel);
  text-align: left;
}

.issue-rows__section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.issue-rows__row {
  cursor: pointer;
}

.issue-rows__row:hover td {
  background: var(--surface-hover);
}

.issue-rows__row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.issue-rows__row--package .issue-rows__name {
  font-weight: 600;
}

.issue-rows__row--child td {
  border-bottom-color: var(--surface-panel);
}

.issue-rows__location {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  padding-left: 24px;
}

.issue-rows__location-label {
  flex: 0 1 9rem;
  overflow-wrap: break-word;
}

.issue-rows__location-via {
  flex: 1 1 10rem;
  min-width: 0;
}

.issue-rows__via {
  margin-top: 2px;
  font-size: 13px;
}

.issue-rows__row--selected td,
.issue-rows__row--selected:hover td {
  background: var(--surface-selected);
}

.issue-rows__row--selected td:first-child {
  box-shadow: inset 3px 0 0 var(--accent);
}

.issue-rows__package {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
}

.issue-rows__title {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
}

.issue-rows__name {
  overflow-wrap: anywhere;
}

.issue-rows__latest,
.issue-rows__advisory {
  white-space: nowrap;
}

.issue-rows__disclosure {
  display: inline-flex;
  flex: none;
  align-self: center;
  width: 24px;
  color: var(--text-muted);
}

.issue-rows__detail {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.issue-rows__root {
  overflow-wrap: break-word;
}

.issue-rows__in-roots {
  white-space: nowrap;
}
</style>
