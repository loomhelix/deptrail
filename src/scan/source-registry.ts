import type { RootGraph } from '../model.ts'
import type { ScanSession } from './scan-session.ts'

export const COMMIT_SOURCE_LIMIT = 4

export type CommitSource = { commit: string; session: ScanSession }

export type SourceRegistryOptions = {
  working: ScanSession
  openSession(commit: string): Promise<ScanSession>
  onRootsChanged(roots: readonly RootGraph[]): void
  limit?: number
}

export type SourceRegistry = {
  readonly working: ScanSession
  openCommit(commit: string): Promise<CommitSource>
  commit(commit: string): CommitSource | undefined
  allRoots(): RootGraph[]
  rootsChanged(): void
  close(): void
}

export function createSourceRegistry(options: SourceRegistryOptions): SourceRegistry {
  const { working } = options
  const limit = options.limit ?? COMMIT_SOURCE_LIMIT
  const open = new Map<string, CommitSource>()
  const opening = new Map<string, Promise<CommitSource>>()

  function markUsed(source: CommitSource): CommitSource {
    open.delete(source.commit)
    open.set(source.commit, source)
    return source
  }

  function allRoots(): RootGraph[] {
    return [...working.scan.roots, ...[...open.values()].flatMap((source) => source.session.scan.roots)]
  }

  function rootsChanged(): void {
    options.onRootsChanged(allRoots())
  }

  function dropBeyondLimit(): void {
    for (const commit of open.keys()) {
      if (open.size <= limit) return
      open.delete(commit)
    }
  }

  async function startOpening(commit: string): Promise<CommitSource> {
    const source = markUsed({ commit, session: await options.openSession(commit) })
    dropBeyondLimit()
    rootsChanged()
    return source
  }

  return {
    working,
    openCommit(commit) {
      const known = open.get(commit)
      if (known !== undefined) return Promise.resolve(markUsed(known))
      let pending = opening.get(commit)
      if (pending === undefined) {
        pending = startOpening(commit).finally(() => opening.delete(commit))
        opening.set(commit, pending)
      }
      return pending
    },
    commit(commit) {
      const known = open.get(commit)
      return known === undefined ? undefined : markUsed(known)
    },
    allRoots,
    rootsChanged,
    close() {
      open.clear()
      opening.clear()
    },
  }
}
