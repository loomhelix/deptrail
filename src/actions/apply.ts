import { randomUUID } from 'node:crypto'
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { messageOf } from '../scan/build-root.ts'
import { OutsideScopeError, hashSources, leavesRoot, resolveInScope, sha256Hex, type FileScope } from './file-scope.ts'

export class RevertConflictError extends Error {
  readonly paths: string[]
  constructor(paths: string[]) {
    super(`Files changed since deptrail wrote them: ${paths.join(', ')}`)
    this.paths = paths
  }
}

export type WrittenFiles = { originals: Map<string, string | null>; hashes: Map<string, string> }

export class PartialWriteError extends Error {
  readonly unrestored: WrittenFiles
  constructor(message: string, unrestored: WrittenFiles) {
    super(message)
    this.name = 'PartialWriteError'
    this.unrestored = unrestored
  }
}

const NEW_FILE_MODE = 0o644

function isMissing(failure: unknown): boolean {
  return (failure as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function changedSources(scope: FileScope, sources: ReadonlyMap<string, string | null>): Promise<string[]> {
  const current = await hashSources(scope, [...sources.keys()])
  return [...sources].filter(([relative, hash]) => current.get(relative) !== hash).map(([relative]) => relative)
}

async function existingMode(target: string): Promise<number> {
  try {
    return (await stat(target)).mode & 0o7777
  } catch (failure) {
    if (isMissing(failure)) return NEW_FILE_MODE
    throw failure
  }
}

async function replaceFile(target: string, text: string): Promise<void> {
  const mode = await existingMode(target)
  const temporary = path.join(path.dirname(target), `${path.basename(target)}.deptrail-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, text, { mode })
    await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (failure) {
    await rm(temporary, { force: true })
    throw failure
  }
}

async function restoreFile(target: string, original: string | null): Promise<void> {
  if (original === null) await rm(target, { force: true })
  else await replaceFile(target, original)
}

function partialWriteMessage(failedPath: string, failure: unknown, unrestored: readonly string[]): string {
  return `could not write ${failedPath}: ${messageOf(failure)}; could not restore ${unrestored.join(', ')}`
}

function requireOutsideOriginals(paths: readonly string[], originals: ReadonlyMap<string, string | null>): void {
  for (const relative of paths) {
    if (leavesRoot(relative) && (originals.get(relative) ?? null) === null) {
      throw new OutsideScopeError(`${relative} does not exist; deptrail never creates a file outside the root directory`)
    }
  }
}

function writeOrder(paths: Iterable<string>, lockfile: string): string[] {
  const all = [...paths]
  return [...all.filter((relative) => relative !== lockfile).sort(), ...all.filter((relative) => relative === lockfile)]
}

export async function writePreviewFiles(
  scope: FileScope,
  written: ReadonlyMap<string, string>,
  lockfile: string,
  originals: ReadonlyMap<string, string | null>,
): Promise<WrittenFiles> {
  const order = writeOrder(written.keys(), lockfile)
  requireOutsideOriginals(order, originals)
  const targets = new Map<string, string>()
  for (const relative of order) targets.set(relative, await resolveInScope(scope, relative))
  const done: string[] = []
  let writing: string | undefined
  try {
    for (const relative of order) {
      writing = relative
      await replaceFile(targets.get(relative) as string, written.get(relative) as string)
      done.push(relative)
    }
  } catch (failure) {
    const failedRestores = new Map<string, string | null>()
    for (const relative of [...done].reverse()) {
      const original = originals.get(relative) ?? null
      await restoreFile(targets.get(relative) as string, original).catch(() => failedRestores.set(relative, original))
    }
    if (failedRestores.size === 0) throw failure
    const unrestoredPaths = done.filter((relative) => failedRestores.has(relative))
    const unrestored: WrittenFiles = {
      originals: new Map(unrestoredPaths.map((relative) => [relative, failedRestores.get(relative) ?? null] as const)),
      hashes: new Map(unrestoredPaths.map((relative) => [relative, sha256Hex(written.get(relative) as string)] as const)),
    }
    throw new PartialWriteError(partialWriteMessage(writing as string, failure, unrestoredPaths), unrestored)
  }
  return {
    originals: new Map(originals),
    hashes: new Map(order.map((relative) => [relative, sha256Hex(written.get(relative) as string)] as const)),
  }
}

export async function changedSinceWrite(scope: FileScope, files: WrittenFiles): Promise<string[]> {
  const current = await hashSources(scope, [...files.hashes.keys()])
  return [...files.hashes].filter(([relative, hash]) => current.get(relative) !== hash).map(([relative]) => relative)
}

export async function revertWrittenFiles(scope: FileScope, files: WrittenFiles): Promise<void> {
  const targets = new Map<string, string>()
  for (const relative of files.hashes.keys()) targets.set(relative, await resolveInScope(scope, relative))
  const conflicts = await changedSinceWrite(scope, files)
  if (conflicts.length > 0) throw new RevertConflictError(conflicts)
  for (const [relative, target] of targets) await restoreFile(target, files.originals.get(relative) ?? null)
}
