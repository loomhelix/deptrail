import { IMPORTER_PREFIX, type NodeId } from '../../src/model.ts'
import type { ChildrenResult } from '../../src/query/children.ts'
import type { DependentsResult } from '../../src/query/dependents.ts'
import type { NodeView } from '../../src/query/lookup.ts'
import { nodeLabel } from './labels.ts'
import { peerVariantsOf, type PeerVariant } from './node-id.ts'
import { TRAIL_COLUMN_TITLES, workspacePackageTitle } from './vocabulary.ts'

export type TrailChip = {
  id: NodeId
  label: string
  name: string
  version: string
  path: string | undefined
  isImporter: boolean
  isAnchor: boolean
  isDirect: boolean
  variant?: PeerVariant
}
export type TrailColumn = { key: string; title: string; chips: TrailChip[] }
export type TrailPosition = { column: number; chip: number }

const REPOSITORY_ROOT_PATH = '.'

function shownPath(node: NodeView): string | undefined {
  if (!node.isImporter) return undefined
  const path = node.id.slice(IMPORTER_PREFIX.length)
  return path === REPOSITORY_ROOT_PATH || path === node.name ? undefined : path
}

function chipOf(node: NodeView, anchorId: NodeId, variants: ReadonlyMap<NodeId, PeerVariant>, isDirect = false): TrailChip {
  return {
    id: node.id,
    label: nodeLabel(node),
    name: node.name,
    version: node.version,
    path: shownPath(node),
    isImporter: node.isImporter,
    isAnchor: node.id === anchorId,
    isDirect,
    variant: variants.get(node.id),
  }
}

export function chipTitle(chip: TrailChip): string {
  if (chip.isImporter) return workspacePackageTitle(chip.label)
  return chip.variant === undefined ? chip.label : `${chip.label} ${chip.variant.suffix}`
}

export function buildTrailColumns(upward: DependentsResult, downward: ChildrenResult): TrailColumn[] {
  const anchorId = upward.focus.id
  const viewById = new Map<NodeId, NodeView>(upward.nodes.map((entry) => [entry.node.id, entry.node]))
  const variants = peerVariantsOf([...viewById.keys(), upward.focus.id, ...downward.rows.map((row) => row.node.id)])
  const chipsOf = (ids: NodeId[], isDirect = false): TrailChip[] =>
    ids.flatMap((id) => {
      const view = viewById.get(id)
      return view ? [chipOf(view, anchorId, variants, isDirect)] : []
    })

  const importerIds = upward.summary.importers
  const directIds = upward.summary.via.map((entry) => entry.direct).filter((id) => id !== anchorId)
  const placed = new Set<NodeId>([anchorId, ...importerIds, ...directIds])
  const intermediateDepths = new Map<number, NodeId[]>()
  for (const entry of upward.nodes) {
    if (placed.has(entry.node.id) || entry.node.isImporter) continue
    const ids = intermediateDepths.get(entry.depth) ?? []
    ids.push(entry.node.id)
    intermediateDepths.set(entry.depth, ids)
  }
  const intermediateColumns = [...intermediateDepths]
    .sort(([left], [right]) => right - left)
    .map(([depth, ids]): TrailColumn => ({ key: `via-${depth}`, title: TRAIL_COLUMN_TITLES.via, chips: chipsOf(ids.sort()) }))

  const columns: TrailColumn[] = [
    { key: 'importers', title: TRAIL_COLUMN_TITLES.importers, chips: chipsOf(importerIds) },
    { key: 'direct', title: TRAIL_COLUMN_TITLES.direct, chips: chipsOf(directIds, true) },
    ...intermediateColumns,
    { key: 'anchor', title: TRAIL_COLUMN_TITLES.anchor, chips: [chipOf(upward.focus, anchorId, variants)] },
    { key: 'children', title: TRAIL_COLUMN_TITLES.children, chips: downward.rows.map((row) => chipOf(row.node, anchorId, variants)) },
  ]
  return columns.filter((column) => column.chips.length > 0)
}

function reachableFrom(start: NodeId, linksOf: ReadonlyMap<NodeId, readonly NodeId[]>): Set<NodeId> {
  const reached = new Set<NodeId>([start])
  const queue = [start]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const next of linksOf.get(queue[cursor]!) ?? []) {
      if (reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  return reached
}

export function trailPathIds(upward: DependentsResult, chipId: NodeId): ReadonlySet<NodeId> {
  const anchorId = upward.focus.id
  const parentsOf = new Map<NodeId, NodeId[]>([[anchorId, upward.focusParents.map((link) => link.id)]])
  for (const entry of upward.nodes) parentsOf.set(entry.node.id, entry.parents.map((link) => link.id))
  const childrenOf = new Map<NodeId, NodeId[]>()
  for (const [childId, parentIds] of parentsOf) {
    for (const parentId of parentIds) {
      if (!parentsOf.has(parentId)) continue
      const known = childrenOf.get(parentId)
      if (known) known.push(childId)
      else childrenOf.set(parentId, [childId])
    }
  }
  const pathStart = parentsOf.has(chipId) ? chipId : anchorId
  const ids = reachableFrom(pathStart, parentsOf)
  for (const id of reachableFrom(pathStart, childrenOf)) ids.add(id)
  ids.add(chipId)
  return ids
}

function positionInColumn(column: TrailColumn, from: TrailPosition, onPath: ReadonlySet<NodeId>): number {
  const onPathIndex = column.chips.findIndex((chip) => onPath.has(chip.id))
  return onPathIndex === -1 ? Math.min(from.chip, column.chips.length - 1) : onPathIndex
}

export function movedTrailPosition(
  columns: readonly TrailColumn[],
  from: TrailPosition,
  key: string,
  onPath: ReadonlySet<NodeId>,
): TrailPosition | undefined {
  const column = columns[from.column]
  if (!column) return undefined
  const lastChip = column.chips.length - 1
  const within = (chip: number): TrailPosition | undefined =>
    chip === from.chip || chip < 0 || chip > lastChip ? undefined : { column: from.column, chip }
  const across = (step: number): TrailPosition | undefined => {
    const target = columns[from.column + step]
    return target && target.chips.length > 0 ? { column: from.column + step, chip: positionInColumn(target, from, onPath) } : undefined
  }
  switch (key) {
    case 'ArrowDown':
      return within(from.chip + 1)
    case 'ArrowUp':
      return within(from.chip - 1)
    case 'Home':
      return within(0)
    case 'End':
      return within(lastChip)
    case 'ArrowRight':
      return across(1)
    case 'ArrowLeft':
      return across(-1)
    default:
      return undefined
  }
}
