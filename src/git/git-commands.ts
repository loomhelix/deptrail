export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value)
}

export class InvalidObjectIdError extends Error {
  constructor(value: string) {
    super(`not a git object id: ${value}`)
    this.name = 'InvalidObjectIdError'
  }
}

function requireObjectId(value: string): string {
  if (!isObjectId(value)) throw new InvalidObjectIdError(value)
  return value
}

export const REF_FORMAT =
  '%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(committerdate:unix)%00%(*committerdate:unix)%00%(symref)'

export const GIT_COMMANDS: {
  version: readonly string[]
  detect: readonly string[]
  symbolicHead: readonly string[]
  headCommit: readonly string[]
  refs: readonly string[]
  blobs: readonly string[]
} = {
  version: ['--version'],
  detect: ['rev-parse', '--show-toplevel', '--show-prefix', '--git-common-dir'],
  symbolicHead: ['symbolic-ref', '-q', 'HEAD'],
  headCommit: ['rev-parse', '-q', '--verify', 'HEAD^{commit}'],
  refs: ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'],
  blobs: ['cat-file', '--batch'],
}

export function treeArgs(commit: string): string[] {
  return ['ls-tree', '-r', '-t', '-z', '--full-tree', '--end-of-options', requireObjectId(commit)]
}

export function mergeBaseArgs(left: string, right: string): string[] {
  return ['merge-base', '--end-of-options', requireObjectId(left), requireObjectId(right)]
}

export const GIT_TIMEOUTS = { quick: 10_000, refs: 30_000, slow: 120_000, blob: 60_000 } as const

export const GIT_LIMITS = { treeEntries: 2_000_000, blobBytes: 268_435_456, outputBytes: 536_870_912 } as const
