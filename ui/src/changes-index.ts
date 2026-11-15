import { onScopeDispose, shallowRef, watch, type InjectionKey, type Ref, type ShallowRef } from 'vue'
import type { ChangeItem, Choice } from '../../src/actions/types.ts'
import type { NodeId } from '../../src/model.ts'
import type { DeptrailApi, RootSummary } from './api.ts'

export type GoalTarget = { kind: 'fix'; name: string; version: string } | { kind: 'update'; name: string }
export type ChangeState = { kind: 'absent' } | { kind: 'same'; item: ChangeItem } | { kind: 'different'; item: ChangeItem }
export type ChangesByRoot = ReadonlyMap<string, readonly ChangeItem[]>
export type ChangesIndex = { index: ShallowRef<ChangesByRoot>; reload(...alsoRoots: string[]): Promise<void> }

export const CHANGES_INDEX: InjectionKey<ChangesIndex> = Symbol('changes-index')

export function itemFor(index: ChangesByRoot, root: string, target: GoalTarget): ChangeItem | undefined {
  return index.get(root)?.find(({ goal }) => {
    if (goal.kind !== target.kind || goal.name !== target.name) return false
    return goal.kind === 'fix' && target.kind === 'fix' ? goal.version === target.version : true
  })
}

export function changeState(item: ChangeItem | undefined, choice: Choice, version?: string): ChangeState {
  if (item === undefined) return { kind: 'absent' }
  const sameVersion = choice !== 'version' || (item.goal.kind === 'update' && item.goal.target === version)
  return item.choice === choice && sameVersion ? { kind: 'same', item } : { kind: 'different', item }
}

function touchesImporter(item: ChangeItem, importer: NodeId): boolean {
  if (item.goal.kind === 'update' && item.goal.importers.includes(importer)) return true
  return item.steps.some((step) => step.kind === 'set-range' && step.importer === importer)
}

export function itemsTouching(items: readonly ChangeItem[], importer: NodeId): ChangeItem[] {
  return items.filter((item) => touchesImporter(item, importer))
}

function changeCountsSignature(roots: readonly RootSummary[]): string {
  return JSON.stringify(roots.map((root) => [root.id, root.actions.changeCount]))
}

export function useChangesIndex(
  api: Pick<DeptrailApi, 'changes'>,
  roots: Ref<readonly RootSummary[]>,
  revision: Ref<string>,
): ChangesIndex {
  const index = shallowRef<ChangesByRoot>(new Map())
  let latestLoad = 0

  async function loadRoot(id: string, previous: readonly ChangeItem[] | undefined): Promise<readonly ChangeItem[] | undefined> {
    try {
      return (await api.changes(id)).items
    } catch {
      return previous
    }
  }

  function rootsToLoad(alsoRoots: readonly string[]): string[] {
    const withChanges = roots.value.filter((root) => root.actions.changeCount > 0).map((root) => root.id)
    return [...new Set([...withChanges, ...alsoRoots])]
  }

  async function reload(...alsoRoots: string[]): Promise<void> {
    const request = ++latestLoad
    const previous = index.value
    const loaded = await Promise.all(rootsToLoad(alsoRoots).map(async (id) => [id, await loadRoot(id, previous.get(id))] as const))
    if (request !== latestLoad) return
    const next = new Map<string, readonly ChangeItem[]>()
    for (const [id, items] of loaded) {
      if (items !== undefined && items.length > 0) next.set(id, items)
    }
    index.value = next
  }

  const stop = watch([() => changeCountsSignature(roots.value), revision], () => void reload(), { immediate: true })
  onScopeDispose(stop)

  return { index, reload }
}
