import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createBlobReader, type BlobProcess } from './blob-reader.ts'
import { GIT_COMMANDS, GIT_LIMITS, GIT_TIMEOUTS, mergeBaseArgs, treeArgs } from './git-commands.ts'
import { GitFailure, runGit, startGit, type GitProcessOptions, type GitResult } from './git-process.ts'
import { parseRefs, type RefListing } from './ref-list.ts'
import { parseTree, type TreeIndex } from './tree-index.ts'

export type GitHead = { commit: string; branch?: string }
export type GitUnavailable = { unavailable: string; quiet: boolean }
export type GitRepository = {
  readonly prefix: string
  head(): Promise<GitHead | undefined>
  refs(): Promise<RefListing>
  tree(commit: string): Promise<TreeIndex>
  mergeBase(left: string, right: string): Promise<string | undefined>
  readBlob(blobId: string): Promise<Buffer | null>
  close(): void
}
export type GitRepositoryOptions = GitProcessOptions & {
  redact: (text: string) => string
  listDir?: (directory: string) => Promise<string[]>
}

type GitVersion = [number, number, number]

const QUICK_OUTPUT_BYTES = 1024 * 1024
const MINIMUM_VERSION: GitVersion = [2, 24, 0]
const LAZY_FETCH_VERSION: GitVersion = [2, 44, 0]
const VERSION_PATTERN = /git version (\d+)\.(\d+)(?:\.(\d+))?/
const NOT_A_REPOSITORY = 'not a git repository'
const PROMISOR_SUFFIX = '.promisor'
const NO_MERGE_BASE_EXIT_CODE = 1
const DETECT_LINE_COUNT = 3

export function parseGitVersion(output: string): GitVersion | undefined {
  const match = VERSION_PATTERN.exec(output)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

export function isGitRepository(value: GitRepository | GitUnavailable): value is GitRepository {
  return !('unavailable' in value)
}

function isBelow(version: GitVersion, limit: GitVersion): boolean {
  for (let index = 0; index < limit.length; index++) {
    if (version[index]! !== limit[index]!) return version[index]! < limit[index]!
  }
  return false
}

async function listDirectoryOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function openGitRepository(options: GitRepositoryOptions): Promise<GitRepository | GitUnavailable> {
  const { redact, listDir = listDirectoryOrEmpty, ...processOptions } = options
  const quickLimits = { timeoutMs: GIT_TIMEOUTS.quick, maxBytes: QUICK_OUTPUT_BYTES }
  const failedWith = (result: GitResult): Error => new Error(firstLine(redact(result.stderr)) || `git exited with code ${result.code}`)

  let versionResult: GitResult
  let detectResult: GitResult
  try {
    versionResult = await runGit(processOptions, GIT_COMMANDS.version, quickLimits)
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'not-found') return { unavailable: 'git was not found on the PATH', quiet: false }
    return { unavailable: error instanceof GitFailure ? error.message : redact(failureMessage(error)), quiet: false }
  }
  const version = parseGitVersion(versionResult.stdout.toString('utf8'))
  if (!version) {
    return { unavailable: `Could not read the git version from "${redact(firstLine(versionResult.stdout.toString('utf8')))}"`, quiet: false }
  }
  const versionText = version.join('.')
  if (isBelow(version, MINIMUM_VERSION)) {
    return { unavailable: `git 2.24 or later is required (found ${versionText})`, quiet: false }
  }

  try {
    detectResult = await runGit(processOptions, GIT_COMMANDS.detect, quickLimits)
  } catch (error) {
    return { unavailable: error instanceof GitFailure ? error.message : redact(failureMessage(error)), quiet: false }
  }
  if (detectResult.code !== 0) {
    if (detectResult.stderr.includes(NOT_A_REPOSITORY)) return { unavailable: 'This directory is not in a git repository', quiet: true }
    return { unavailable: firstLine(redact(detectResult.stderr)) || `git exited with code ${detectResult.code}`, quiet: false }
  }

  const lines = detectResult.stdout.toString('utf8').split('\n')
  const prefix = lines[1] ?? ''
  const commonDirectory = path.resolve(processOptions.cwd, lines[2] ?? '')
  if (lines.length < DETECT_LINE_COUNT) return { unavailable: 'git printed an unexpected repository description', quiet: false }

  if (isBelow(version, LAZY_FETCH_VERSION)) {
    const packFiles = await listDir(path.join(commonDirectory, 'objects', 'pack'))
    if (packFiles.some((name) => name.endsWith(PROMISOR_SUFFIX))) {
      return {
        unavailable: `This is a partial clone, and git ${versionText} could download missing objects while reading. Use git 2.44 or later.`,
        quiet: false,
      }
    }
  }

  const blobReader = createBlobReader(() => startGit(processOptions, GIT_COMMANDS.blobs) as BlobProcess, {
    maxBlobBytes: GIT_LIMITS.blobBytes,
    responseTimeoutMs: GIT_TIMEOUTS.blob,
  })

  return {
    prefix,
    async head() {
      const symbolic = await runGit(processOptions, GIT_COMMANDS.symbolicHead, quickLimits)
      const commit = await runGit(processOptions, GIT_COMMANDS.headCommit, quickLimits)
      if (commit.code !== 0) return undefined
      const head: GitHead = { commit: commit.stdout.toString('utf8').trim() }
      if (symbolic.code === 0) head.branch = symbolic.stdout.toString('utf8').trim()
      return head
    },
    async refs() {
      const result = await runGit(processOptions, GIT_COMMANDS.refs, { timeoutMs: GIT_TIMEOUTS.refs, maxBytes: GIT_LIMITS.outputBytes })
      if (result.code !== 0) throw failedWith(result)
      return parseRefs(result.stdout.toString('utf8'))
    },
    async tree(commit) {
      const args = treeArgs(commit)
      const result = await runGit(processOptions, args, { timeoutMs: GIT_TIMEOUTS.slow, maxBytes: GIT_LIMITS.outputBytes })
      if (result.code !== 0) throw failedWith(result)
      return parseTree(result.stdout, prefix, GIT_LIMITS.treeEntries)
    },
    async mergeBase(left, right) {
      const args = mergeBaseArgs(left, right)
      const result = await runGit(processOptions, args, { timeoutMs: GIT_TIMEOUTS.slow, maxBytes: QUICK_OUTPUT_BYTES })
      if (result.code === 0) return result.stdout.toString('utf8').trim()
      if (result.code === NO_MERGE_BASE_EXIT_CODE) return undefined
      throw new Error(firstLine(result.stderr) || `git exited with code ${result.code}`)
    },
    readBlob: (blobId) => blobReader.read(blobId),
    close: () => blobReader.close(),
  }
}
