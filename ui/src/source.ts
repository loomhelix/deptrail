import type { InjectionKey } from 'vue'
import { WORKING_KEY } from '../../src/server/source-key.ts'
import type { DeptrailApi, GitInfo } from './api.ts'
import { readableQuery } from './context.ts'

export { WORKING_KEY }

export type ShownSource = { kind: 'working' } | { kind: 'commit'; ref: string; commit: string; committedAt?: string; skippedSubmodules?: string[] }
export type ShownSourceState = { source: ShownSource; notice?: string }
export type ReloadMarkStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const SHOWN_SOURCE: InjectionKey<ShownSourceState> = Symbol('shown-source')

const HEAD_REF = 'HEAD'
const SHORT_COMMIT_LENGTH = 7
const REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/']
const DROPPED_SOURCE_RELOAD_KEY = 'deptrail-dropped-source-reload'
const DROPPED_SOURCE_RELOAD_INTERVAL_MS = 10_000

export function shortRef(ref: string): string {
  const prefix = REF_PREFIXES.find((candidate) => ref.startsWith(candidate))
  return prefix === undefined ? ref : ref.slice(prefix.length)
}

export function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH)
}

export function sourceKey(source: ShownSource): string {
  return source.kind === 'working' ? WORKING_KEY : source.commit
}

export function navigationUrl(pathname: string, search: string, changes: { ref?: string | null; base?: string | null }): string {
  const params = new URLSearchParams(search)
  for (const name of ['ref', 'base'] as const) {
    const value = changes[name]
    if (value === undefined) continue
    if (value === null) params.delete(name)
    else params.set(name, value)
  }
  const query = readableQuery(params)
  return query === '' ? pathname : `${pathname}?${query}`
}

export function defaultBase(info: GitInfo, source: ShownSource): string {
  if (!info.available) return WORKING_KEY
  if (info.defaultBranch !== undefined) {
    return source.kind === 'commit' && source.ref === info.defaultBranch ? WORKING_KEY : info.defaultBranch
  }
  return source.kind === 'working' ? HEAD_REF : WORKING_KEY
}

export function reloadForDroppedSource(storage: ReloadMarkStorage | undefined, now: number, reload: () => void): void {
  try {
    const last = Number(storage?.getItem(DROPPED_SOURCE_RELOAD_KEY) ?? Number.NaN)
    if (Number.isFinite(last) && now - last < DROPPED_SOURCE_RELOAD_INTERVAL_MS) return
    storage?.setItem(DROPPED_SOURCE_RELOAD_KEY, String(now))
  } catch {}
  reload()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function openShownSource(api: Pick<DeptrailApi, 'openSource'>, search: string): Promise<ShownSourceState> {
  const ref = new URLSearchParams(search).get('ref')
  if (ref === null || ref === '') return { source: { kind: 'working' } }
  try {
    const opened = await api.openSource({ ref })
    return {
      source: {
        kind: 'commit',
        ref,
        commit: opened.commit,
        ...(opened.committedAt === undefined ? {} : { committedAt: opened.committedAt }),
        ...(opened.skippedSubmodules === undefined ? {} : { skippedSubmodules: opened.skippedSubmodules }),
      },
    }
  } catch (error) {
    return { source: { kind: 'working' }, notice: `Could not open ${ref}: ${messageOf(error)}. Showing the working tree.` }
  }
}
