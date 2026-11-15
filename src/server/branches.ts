import { isObjectId } from '../git/git-commands.ts'
import { isGitRepository, type GitHead, type GitRepository, type GitUnavailable } from '../git/git-repository.ts'
import type { GitRef } from '../git/ref-list.ts'
import type { ScanSession } from '../scan/scan-session.ts'
import type { CommitSource, SourceRegistry } from '../scan/source-registry.ts'
import { WORKING_KEY } from './source-key.ts'

export { WORKING_KEY }

export const COMMIT_ACTIONS_REASON = 'Actions apply to the working tree. Switch to it to change files.'
export const COMMIT_RESOLVE_REASON = "Resolve versions runs the package manager with the branch's own configuration, so it is available only in the working tree."

export type GitInfo = { available: false; reason: string; quiet: boolean } | { available: true; head?: GitHead; defaultBranch?: string; refs: GitRef[] }
export type OpenSourceRequest = { ref: string } | { mergeBase: { base: string; target: string } }
export type OpenedSource = { key: string; commit: string; ref?: string; committedAt?: string; skippedSubmodules?: string[] }

export type BranchErrorStatus = 400 | 404 | 409

export class BranchError extends Error {
  readonly status: BranchErrorStatus
  constructor(status: BranchErrorStatus, message: string) {
    super(message)
    this.name = 'BranchError'
    this.status = status
  }
}

export type Branches = {
  info(): Promise<GitInfo>
  open(request: OpenSourceRequest): Promise<OpenedSource>
  sessionOf(key: string): ScanSession | undefined
}

const HEAD_REF = 'HEAD'
const REF_PREFIX = 'refs/'
const OPTION_PREFIX = '-'

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function isAcceptableRefName(ref: string): boolean {
  return !ref.startsWith(OPTION_PREFIX) && (ref === HEAD_REF || ref.startsWith(REF_PREFIX))
}

export function createBranches(git: GitRepository | GitUnavailable, sources: SourceRegistry): Branches {
  function requireRepository(): GitRepository {
    if (!isGitRepository(git)) throw new BranchError(409, git.unavailable)
    return git
  }

  async function headCommit(repository: GitRepository): Promise<string> {
    const head = await repository.head()
    if (head === undefined) throw new BranchError(409, 'The repository has no commits yet')
    return head.commit
  }

  async function openCommit(commit: string): Promise<{ skippedSubmodules?: string[] }> {
    let source: CommitSource
    try {
      source = await sources.openCommit(commit)
    } catch (failure) {
      throw new BranchError(409, messageOf(failure))
    }
    const skipped = source.session.scan.skippedSubmodules ?? []
    return skipped.length === 0 ? {} : { skippedSubmodules: [...skipped] }
  }

  async function openRef(repository: GitRepository, ref: string): Promise<OpenedSource> {
    if (!isAcceptableRefName(ref)) throw new BranchError(400, 'Invalid ref')
    if (ref === HEAD_REF) {
      const commit = await headCommit(repository)
      return { key: commit, commit, ref, ...(await openCommit(commit)) }
    }
    const listed = (await repository.refs()).refs.find((candidate) => candidate.name === ref)
    if (listed === undefined) throw new BranchError(404, `Unknown ref ${ref}`)
    const skipped = await openCommit(listed.commit)
    return { key: listed.commit, commit: listed.commit, ref, committedAt: listed.committedAt, ...skipped }
  }

  async function commitOfKey(repository: GitRepository, key: string): Promise<string> {
    if (key === WORKING_KEY) return headCommit(repository)
    if (isObjectId(key) && sources.commit(key) !== undefined) return key
    throw new BranchError(404, `Unknown source ${key}`)
  }

  async function openMergeBase(repository: GitRepository, base: string, target: string): Promise<OpenedSource> {
    const baseCommit = await commitOfKey(repository, base)
    const targetCommit = await commitOfKey(repository, target)
    const commit = await repository.mergeBase(baseCommit, targetCommit)
    if (commit === undefined) throw new BranchError(409, 'No merge base')
    await openCommit(commit)
    return { key: commit, commit }
  }

  return {
    async info() {
      if (!isGitRepository(git)) return { available: false, reason: git.unavailable, quiet: git.quiet }
      try {
        const [head, listing] = await Promise.all([git.head(), git.refs()])
        return {
          available: true,
          ...(head === undefined ? {} : { head }),
          ...(listing.defaultBranch === undefined ? {} : { defaultBranch: listing.defaultBranch }),
          refs: listing.refs,
        }
      } catch (failure) {
        return { available: false, reason: messageOf(failure), quiet: false }
      }
    },
    async open(request) {
      const repository = requireRepository()
      if ('ref' in request) return openRef(repository, request.ref)
      return openMergeBase(repository, request.mergeBase.base, request.mergeBase.target)
    },
    sessionOf(key) {
      if (key === WORKING_KEY) return sources.working
      return isObjectId(key) ? sources.commit(key)?.session : undefined
    },
  }
}
