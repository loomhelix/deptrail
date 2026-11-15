import type { DepKind, NodeId } from '../../src/model.ts'
import type { ChildRow } from '../../src/query/children.ts'
import type { NodeView } from '../../src/query/lookup.ts'
import type { RootSummary } from './api.ts'
import { requiresText } from './vocabulary.ts'

export const ROW_HEIGHT = 28
export const ROW_OVERSCAN = 10

export type ListedPlacement = 'above' | 'below'

export type VisibleRow = {
  key: string
  parentKey: string | undefined
  node: NodeView
  kind: DepKind | undefined
  range: string | undefined
  depth: number
  position: number
  setSize: number
  hasChildren: boolean
  expanded: boolean
  loading: boolean
  shownAbove: boolean
  listed: ListedPlacement | undefined
  parentIsImporter: boolean
}

export type WindowRange = { start: number; end: number }

type VisitEntry = Pick<ChildRow, 'node' | 'hasChildren' | 'repeated'> & Partial<Pick<ChildRow, 'kind' | 'range'>>
type Placement = { key: string; parentKey: string | undefined; depth: number; position: number; setSize: number; parentIsImporter: boolean }

const ROOT_IMPORTER_ID = 'importer:.'
const KEY_SEPARATOR = '/'
const NO_TOP_LEVEL_ROWS: ReadonlyMap<NodeId, number> = new Map()

function createRowCollector(
  childrenById: ReadonlyMap<NodeId, readonly ChildRow[]>,
  expandedIds: ReadonlySet<NodeId>,
  duplicateNames: ReadonlySet<string> | null,
  topLevelIndexById: ReadonlyMap<NodeId, number> = NO_TOP_LEVEL_ROWS,
) {
  const rows: VisibleRow[] = []
  const expandedAbove = new Set<NodeId>()

  function visit(entry: VisitEntry, placement: Placement, topLevelIndex: number): void {
    const id = entry.node.id
    const listedIndex = placement.depth > 0 ? topLevelIndexById.get(id) : undefined
    if (listedIndex !== undefined) {
      rows.push({
        ...placement,
        node: entry.node,
        kind: entry.kind,
        range: entry.range,
        hasChildren: false,
        expanded: false,
        loading: false,
        shownAbove: false,
        listed: listedIndex <= topLevelIndex ? 'above' : 'below',
      })
      return
    }
    const shownAbove = entry.repeated || expandedAbove.has(id)
    const expanded = !shownAbove && expandedIds.has(id)
    const loadedChildren = childrenById.get(id)
    rows.push({
      ...placement,
      node: entry.node,
      kind: entry.kind,
      range: entry.range,
      hasChildren: entry.hasChildren && !shownAbove,
      expanded,
      loading: expanded && loadedChildren === undefined,
      shownAbove,
      listed: undefined,
    })
    if (!expanded) return
    expandedAbove.add(id)
    const shownChildren = (loadedChildren ?? [])
      .map((child, index) => ({ child, index }))
      .filter(({ child }) => !isHiddenByDuplicateFilter(child, duplicateNames, expandedIds, expandedAbove, topLevelIndexById))
    shownChildren.forEach(({ child, index }, position) =>
      visit(
        child,
        {
          key: `${placement.key}${KEY_SEPARATOR}${index}:${child.node.id}`,
          parentKey: placement.key,
          depth: placement.depth + 1,
          position: position + 1,
          setSize: shownChildren.length,
          parentIsImporter: entry.node.isImporter,
        },
        topLevelIndex,
      ),
    )
  }

  return { rows, visit }
}

export function flattenVisible(
  start: NodeView,
  childrenById: ReadonlyMap<NodeId, readonly ChildRow[]>,
  expandedIds: ReadonlySet<NodeId>,
  duplicateNames: ReadonlySet<string> | null,
): VisibleRow[] {
  const collector = createRowCollector(childrenById, expandedIds, duplicateNames)
  collector.visit(
    { node: start, hasChildren: true, repeated: false },
    { key: start.id, parentKey: undefined, depth: 0, position: 1, setSize: 1, parentIsImporter: false },
    0,
  )
  return collector.rows
}

function workspacePackageView(workspacePackage: RootSummary['importers'][number]): NodeView {
  return { id: workspacePackage.id, name: workspacePackage.name, version: '', isImporter: true, isPlaceholder: false }
}

export function overviewRows(
  importers: RootSummary['importers'],
  childrenById: ReadonlyMap<NodeId, readonly ChildRow[]>,
  expanded: ReadonlySet<NodeId>,
  duplicateNames: ReadonlySet<string> | null = null,
): VisibleRow[] {
  const shown = importers.filter((workspacePackage) => workspacePackage.id !== ROOT_IMPORTER_ID || workspacePackage.dependencyCount > 0)
  const topLevelIndexById = new Map(shown.map((workspacePackage, index) => [workspacePackage.id, index]))
  const collector = createRowCollector(childrenById, expanded, duplicateNames, topLevelIndexById)
  shown.forEach((workspacePackage, index) =>
    collector.visit(
      { node: workspacePackageView(workspacePackage), hasChildren: workspacePackage.dependencyCount > 0, repeated: false },
      { key: workspacePackage.id, parentKey: undefined, depth: 0, position: index + 1, setSize: shown.length, parentIsImporter: false },
      index,
    ),
  )
  return collector.rows
}

export function rangeText(range: string | undefined, childVersion: string): string | undefined {
  if (range === undefined || range === '' || range === childVersion) return undefined
  return requiresText(range)
}

function isHiddenByDuplicateFilter(
  child: ChildRow,
  duplicateNames: ReadonlySet<string> | null,
  expandedIds: ReadonlySet<NodeId>,
  expandedAbove: ReadonlySet<NodeId>,
  topLevelIndexById: ReadonlyMap<NodeId, number>,
): boolean {
  if (duplicateNames === null) return false
  if (topLevelIndexById.has(child.node.id)) return true
  if (duplicateNames.has(child.node.name)) return false
  return !(expandedIds.has(child.node.id) && !expandedAbove.has(child.node.id) && !child.repeated)
}

export function windowRange(scrollTop: number, viewportHeight: number, total: number, overscan: number = ROW_OVERSCAN): WindowRange {
  const first = Math.floor(scrollTop / ROW_HEIGHT)
  const last = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT)
  return { start: Math.max(0, first - overscan), end: Math.min(total, last + overscan) }
}
