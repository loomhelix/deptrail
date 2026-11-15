import type { RootGraph } from '../model.ts'
import { ActionError } from './action-error.ts'
import type { WrittenFiles } from './apply.ts'
import type { FileScope } from './file-scope.ts'
import { findConflict, sameGoal } from './edit-plan.ts'
import { goalText, rootLabel } from './labels.ts'
import type { ChangeItem, JobResult, Preview, RestoreResult, SharingRoot } from './types.ts'

export type PreviewRecord = {
  preview: Preview
  graph: RootGraph
  changeRevision: number
  itemIds: string[]
  written: Map<string, string>
  originals: Map<string, string | null>
  sources: Map<string, string | null>
  lockfileDiff: { diff: string; truncated: boolean }
  scope: FileScope
  lockfile: string
  sharedRoots: SharingRoot[]
}

export type RevertRecord = { scope: FileScope; files: WrittenFiles; items: ChangeItem[]; install?: NonNullable<JobResult['install']>; sharedRoots?: SharingRoot[] }

export type AppliedFiles = Pick<RevertRecord, 'scope' | 'files'>

export type RootChanges = { items: ChangeItem[]; revision: number; cleared: ChangeItem[]; preview?: PreviewRecord; revert?: RevertRecord }

export type ChangeSets = {
  of(rootId: string): RootChanges
  add(rootId: string, item: ChangeItem): ChangeItem
  remove(rootId: string, itemId: string): void
  replace(rootId: string, itemId: string, item: ChangeItem): ChangeItem
  clear(rootId: string): void
  restore(rootId: string, items: readonly ChangeItem[]): RestoreResult
  restoreCleared(rootId: string): RestoreResult
  storePreview(rootId: string, record: PreviewRecord): void
  storeRevert(rootId: string, revert: RevertRecord): void
  applied(rootId: string, record: PreviewRecord, written: AppliedFiles): RevertRecord
  reverted(rootId: string, record: RevertRecord): void
  isStale(rootId: string, record: PreviewRecord): boolean
  preview(rootId: string): Preview | undefined
}

function unknownChange(itemId: string): ActionError {
  return new ActionError(404, `Unknown change ${itemId}`)
}

function rejectionOf(rootId: string, items: readonly ChangeItem[], item: ChangeItem): ActionError | undefined {
  const duplicate = items.find((existing) => sameGoal(existing.goal, item.goal))
  if (duplicate !== undefined) return new ActionError(409, `${goalText(duplicate.goal)} is already in the changes of ${rootLabel(rootId)}`)
  const conflict = findConflict(items, item)
  if (conflict !== undefined) return new ActionError(409, `Conflicts with "${goalText(conflict.item.goal)}": ${conflict.reason}`, conflict.item.id)
  return undefined
}

export function createChangeSets(currentGraph: (rootId: string) => RootGraph | undefined): ChangeSets {
  const roots = new Map<string, RootChanges>()

  function of(rootId: string): RootChanges {
    let changes = roots.get(rootId)
    if (changes === undefined) {
      changes = { items: [], revision: 0, cleared: [] }
      roots.set(rootId, changes)
    }
    return changes
  }

  function edited(changes: RootChanges, items: ChangeItem[]): void {
    changes.items = items
    changes.revision++
  }

  function editedByUser(changes: RootChanges, items: ChangeItem[]): void {
    edited(changes, items)
    changes.cleared = []
  }

  function restore(rootId: string, items: readonly ChangeItem[]): RestoreResult {
    const changes = of(rootId)
    const kept = [...changes.items]
    const skipped: RestoreResult['skipped'] = []
    for (const item of items) {
      const rejection = rejectionOf(rootId, kept, item)
      if (rejection === undefined) kept.push(item)
      else skipped.push({ name: goalText(item.goal), reason: rejection.message })
    }
    const restored = kept.length - changes.items.length
    if (restored > 0) edited(changes, kept)
    return { restored, skipped }
  }

  function isStale(rootId: string, record: PreviewRecord): boolean {
    return of(rootId).revision !== record.changeRevision || currentGraph(rootId) !== record.graph
  }

  return {
    of,
    add(rootId, item) {
      const changes = of(rootId)
      const rejection = rejectionOf(rootId, changes.items, item)
      if (rejection !== undefined) throw rejection
      editedByUser(changes, [...changes.items, item])
      return item
    },
    remove(rootId, itemId) {
      const changes = of(rootId)
      if (!changes.items.some((item) => item.id === itemId)) throw unknownChange(itemId)
      editedByUser(changes, changes.items.filter((item) => item.id !== itemId))
    },
    replace(rootId, itemId, item) {
      const changes = of(rootId)
      if (!changes.items.some((existing) => existing.id === itemId)) throw unknownChange(itemId)
      const rejection = rejectionOf(rootId, changes.items.filter((existing) => existing.id !== itemId), item)
      if (rejection !== undefined) throw rejection
      editedByUser(changes, changes.items.map((existing) => (existing.id === itemId ? item : existing)))
      return item
    },
    clear(rootId) {
      const changes = of(rootId)
      changes.cleared = changes.items
      edited(changes, [])
    },
    restore,
    restoreCleared(rootId) {
      const changes = of(rootId)
      const cleared = changes.cleared
      changes.cleared = []
      return restore(rootId, cleared)
    },
    storePreview(rootId, record) {
      of(rootId).preview = record
    },
    storeRevert(rootId, revert) {
      of(rootId).revert = revert
    },
    applied(rootId, record, written) {
      const changes = of(rootId)
      const previewed = new Set(record.itemIds)
      const revert: RevertRecord = { ...written, items: changes.items.filter((item) => previewed.has(item.id)), sharedRoots: record.sharedRoots }
      edited(changes, changes.items.filter((item) => !previewed.has(item.id)))
      changes.preview = undefined
      changes.revert = revert
      return revert
    },
    reverted(rootId, record) {
      const changes = of(rootId)
      if (changes.revert === record) changes.revert = undefined
    },
    isStale,
    preview(rootId) {
      const record = roots.get(rootId)?.preview
      return record === undefined ? undefined : { ...record.preview, stale: isStale(rootId, record) }
    },
  }
}
