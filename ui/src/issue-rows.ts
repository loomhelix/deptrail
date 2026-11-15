import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { DepKind } from '../../src/model.ts'
import type { IssueRow } from '../../src/query/issues.ts'
import type { DeptrailApi } from './api.ts'
import { isRootBusy } from './scan-state.ts'

export type IssueRows = { rows: ShallowRef<readonly IssueRow[] | null>; count: ComputedRef<number | null>; error: ShallowRef<string | null> }

export function useIssueRows(api: DeptrailApi, root: Ref<string | undefined>, kinds: Ref<DepKind[]>, revision: Ref<string | undefined>): IssueRows {
  const rows = shallowRef<readonly IssueRow[] | null>(null)
  const error = shallowRef<string | null>(null)
  let latestLoad = 0
  let currentSubject = ''

  async function load(rootId: string | undefined, kindList: DepKind[]): Promise<void> {
    const request = ++latestLoad
    try {
      const response = await api.issueRows(rootId, kindList)
      if (request !== latestLoad) return
      rows.value = response.rows
      error.value = null
    } catch (failure) {
      if (request !== latestLoad) return
      if (isRootBusy(failure)) return
      rows.value = null
      error.value = failure instanceof Error ? failure.message : String(failure)
    }
  }

  watch(
    [root, () => kinds.value.join(','), revision],
    ([rootId, kindsKey, currentRevision]) => {
      const subject = `${rootId ?? ''}\n${kindsKey}`
      if (subject !== currentSubject) {
        currentSubject = subject
        rows.value = null
        error.value = null
      }
      if (currentRevision !== undefined) void load(rootId, kinds.value)
    },
    { immediate: true },
  )

  return { rows, count: computed(() => rows.value?.length ?? null), error }
}
