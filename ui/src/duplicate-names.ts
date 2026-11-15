import { shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import type { DeptrailApi } from './api.ts'
import { duplicatesLoadFailedText, duplicateVersionsText } from './vocabulary.ts'

export type DuplicateNames = {
  versionsByName: ShallowRef<ReadonlyMap<string, string>>
  error: ShallowRef<string | null>
}

export function useDuplicateNames(api: DeptrailApi, scannedAt: Ref<string | undefined>): DuplicateNames {
  const versionsByName = shallowRef<ReadonlyMap<string, string>>(new Map())
  const error = shallowRef<string | null>(null)
  let latestLoad = 0

  async function load(): Promise<void> {
    const request = ++latestLoad
    try {
      const entries = await api.duplicates()
      if (request !== latestLoad) return
      versionsByName.value = new Map(entries.map((entry) => [entry.name, duplicateVersionsText(entry)]))
      error.value = null
    } catch (failure) {
      if (request !== latestLoad) return
      error.value = duplicatesLoadFailedText(failure instanceof Error ? failure.message : String(failure))
    }
  }

  watch(
    scannedAt,
    (current) => {
      if (current !== undefined) void load()
    },
    { immediate: true },
  )

  return { versionsByName, error }
}
