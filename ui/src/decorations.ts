import { shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import type { DepKind, NodeId } from '../../src/model.ts'
import type { NodeDecoration } from '../../src/query/decorations.ts'
import type { DeptrailApi } from './api.ts'
import { isRootBusy } from './scan-state.ts'
import { badgesLoadFailedText } from './vocabulary.ts'

export type NodeDecorations = Readonly<Record<NodeId, NodeDecoration>>

export type Decorations = {
  nodes: ShallowRef<NodeDecorations>
  loadedRoot: ShallowRef<string | undefined>
  error: ShallowRef<string | null>
}

const NO_DECORATIONS: NodeDecorations = {}

export function useDecorations(
  api: DeptrailApi,
  root: Ref<string | undefined>,
  kinds: Ref<DepKind[]>,
  revision: Ref<string>,
): Decorations {
  const nodes = shallowRef<NodeDecorations>(NO_DECORATIONS)
  const loadedRoot = shallowRef<string | undefined>(undefined)
  const error = shallowRef<string | null>(null)
  let latestLoad = 0
  let currentSubject = ''

  async function load(rootId: string, kindList: DepKind[]): Promise<void> {
    const request = ++latestLoad
    try {
      const response = await api.decorations(rootId, kindList)
      if (request !== latestLoad) return
      nodes.value = response.nodes
      loadedRoot.value = rootId
      error.value = null
    } catch (failure) {
      if (request !== latestLoad) return
      if (isRootBusy(failure)) return
      nodes.value = NO_DECORATIONS
      loadedRoot.value = undefined
      error.value = badgesLoadFailedText(failure instanceof Error ? failure.message : String(failure))
    }
  }

  watch(
    [root, () => kinds.value.join(','), revision],
    ([rootId, kindsKey]) => {
      const subject = `${rootId ?? ''}\n${kindsKey}`
      if (subject !== currentSubject) {
        currentSubject = subject
        nodes.value = NO_DECORATIONS
        loadedRoot.value = undefined
      }
      if (rootId === undefined) {
        latestLoad += 1
        error.value = null
        return
      }
      void load(rootId, kinds.value)
    },
    { immediate: true },
  )

  return { nodes, loadedRoot, error }
}
