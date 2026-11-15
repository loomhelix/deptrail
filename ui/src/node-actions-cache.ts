import type { InjectionKey } from 'vue'
import type { NodeActions } from '../../src/actions/types.ts'
import type { DepKind, NodeId } from '../../src/model.ts'
import type { DeptrailApi } from './api.ts'
import { canonicalKinds } from './context.ts'

export type NodeActionsKey = { root: string; node: NodeId; kinds: readonly DepKind[]; revision: string }
export type NodeActionsCache = {
  get(key: NodeActionsKey): Promise<NodeActions>
  peek(key: NodeActionsKey): NodeActions | undefined
}

type Entry = { promise: Promise<NodeActions>; settled?: NodeActions }
type QueuedStart = () => void

const DEFAULT_MAX_IN_FLIGHT = 4

export const NODE_ACTIONS_CACHE: InjectionKey<NodeActionsCache> = Symbol('node-actions-cache')

export function nodeActionsRevision(rootRevision: string, enrichmentRevision: number): string {
  return `${rootRevision}\n${enrichmentRevision}`
}

function keyText(key: NodeActionsKey): string {
  return JSON.stringify([key.root, key.node, canonicalKinds(key.kinds), key.revision])
}

function revisionlessKeyText(key: NodeActionsKey): string {
  return JSON.stringify([key.root, key.node, canonicalKinds(key.kinds)])
}

export function createNodeActionsCache(api: Pick<DeptrailApi, 'nodeActions'>, maxInFlight = DEFAULT_MAX_IN_FLIGHT): NodeActionsCache {
  const entries = new Map<string, Entry>()
  const newestKeyText = new Map<string, string>()
  const waiting: QueuedStart[] = []
  let inFlight = 0

  function startNext(): void {
    while (inFlight < maxInFlight && waiting.length > 0) waiting.shift()?.()
  }

  function request(key: NodeActionsKey, text: string, entry: Entry): Promise<NodeActions> {
    return new Promise<NodeActions>((resolve, reject) => {
      waiting.push(() => {
        inFlight += 1
        api
          .nodeActions(key.root, key.node, canonicalKinds(key.kinds))
          .then((actions) => {
            entry.settled = actions
            resolve(actions)
          })
          .catch((error: unknown) => {
            if (entries.get(text) === entry) entries.delete(text)
            reject(error)
          })
          .finally(() => {
            inFlight -= 1
            startNext()
          })
      })
      startNext()
    })
  }

  return {
    get(key) {
      const text = keyText(key)
      const existing = entries.get(text)
      if (existing) return existing.promise
      const entry: Entry = { promise: Promise.resolve(undefined as never) }
      entry.promise = request(key, text, entry)
      entries.set(text, entry)
      const revisionless = revisionlessKeyText(key)
      const replaced = newestKeyText.get(revisionless)
      if (replaced !== undefined && replaced !== text) entries.delete(replaced)
      newestKeyText.set(revisionless, text)
      return entry.promise
    },
    peek(key) {
      return entries.get(keyText(key))?.settled
    },
  }
}
