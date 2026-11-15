import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path, { posix } from 'node:path'
import { compileWorkspacePatterns } from '../config/glob.ts'
import { IMPORTER_PREFIX, type RootGraph } from '../model.ts'

export type FileScope = { rootDir: string; repoDir: string; outsideManifests: readonly string[] }
export type OutsideImporterProblem = { kind: 'outside-repository' | 'npm' | 'undeclared'; path: string }
export type OutsideImporters = { declared: string[]; problem?: OutsideImporterProblem }

export class OutsideScopeError extends Error {}

const PARENT_SEGMENT = '..'
const PARENT_PREFIX = '../'
const PACKAGE_MANIFEST = 'package.json'

const UNREACHABLE_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

function isMissing(failure: unknown): boolean {
  return (failure as NodeJS.ErrnoException).code === 'ENOENT'
}

function isUnreachable(failure: unknown): boolean {
  return UNREACHABLE_CODES.has((failure as NodeJS.ErrnoException).code ?? '')
}

function isInside(realBase: string, candidate: string): boolean {
  return candidate === realBase || candidate.startsWith(realBase + path.sep)
}

export function leavesRoot(relative: string): boolean {
  const normalized = posix.normalize(relative)
  return normalized === PARENT_SEGMENT || normalized.startsWith(PARENT_PREFIX) || posix.isAbsolute(normalized)
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function outsideScopeError(relative: string): OutsideScopeError {
  return new OutsideScopeError(`${relative} is outside the root directory and its declared workspace packages`)
}

function unresolvedManifestError(relative: string): OutsideScopeError {
  return new OutsideScopeError(`${relative} is missing or resolves outside its workspace package`)
}

export function outsideImporters(root: Pick<RootGraph, 'manager' | 'importers' | 'config'>): OutsideImporters {
  const isDeclared = compileWorkspacePatterns(root.config?.workspacePatterns ?? [])
  const declared: string[] = []
  for (const importer of root.importers) {
    const rootRelative = posix.normalize(importer.id.slice(IMPORTER_PREFIX.length))
    if (!leavesRoot(rootRelative)) continue
    if (leavesRoot(importer.path)) {
      return { declared, problem: { kind: 'outside-repository', path: rootRelative } }
    }
    if (root.manager === 'npm') return { declared, problem: { kind: 'npm', path: rootRelative } }
    if (!isDeclared(rootRelative)) return { declared, problem: { kind: 'undeclared', path: rootRelative } }
    declared.push(rootRelative)
  }
  return { declared }
}

export function fileScopeOf(repoPath: string, root: RootGraph): FileScope {
  const { declared } = outsideImporters(root)
  return {
    rootDir: path.join(repoPath, root.path),
    repoDir: repoPath,
    outsideManifests: declared.map((declaredPath) => `${declaredPath}/${PACKAGE_MANIFEST}`),
  }
}

async function resolveInsideRoot(scope: FileScope, relative: string, normalized: string): Promise<string> {
  const realRoot = await realpath(scope.rootDir)
  const requested = path.resolve(realRoot, ...normalized.split('/'))
  if (!isInside(realRoot, requested)) throw outsideScopeError(relative)
  let resolved: string
  try {
    resolved = await realpath(requested)
  } catch (failure) {
    if (!isMissing(failure)) throw failure
    resolved = path.join(await realpath(path.dirname(requested)), path.basename(requested))
  }
  if (!isInside(realRoot, resolved)) throw outsideScopeError(relative)
  return resolved
}

async function resolveDeclaredManifest(scope: FileScope, relative: string, normalized: string): Promise<string> {
  if (!scope.outsideManifests.includes(normalized)) throw outsideScopeError(relative)
  const requested = path.resolve(scope.rootDir, ...normalized.split('/'))
  let real: [string, string, string]
  try {
    real = await Promise.all([realpath(scope.repoDir), realpath(path.dirname(requested)), realpath(requested)])
  } catch (failure) {
    if (isUnreachable(failure)) throw unresolvedManifestError(relative)
    throw failure
  }
  const [realRepo, realPackageDir, realFile] = real
  if (!isInside(realRepo, realPackageDir) || !realFile.startsWith(realPackageDir + path.sep)) throw unresolvedManifestError(relative)
  return realFile
}

export async function resolveInScope(scope: FileScope, relative: string): Promise<string> {
  if (posix.isAbsolute(relative) || path.isAbsolute(relative)) throw outsideScopeError(relative)
  const normalized = posix.normalize(relative)
  if (leavesRoot(normalized)) return resolveDeclaredManifest(scope, relative, normalized)
  return resolveInsideRoot(scope, relative, normalized)
}

export async function readInScope(scope: FileScope, relative: string): Promise<Buffer | null> {
  try {
    return await readFile(await resolveInScope(scope, relative))
  } catch {
    return null
  }
}

export async function hashSources(scope: FileScope, paths: readonly string[]): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    paths.map(async (relative) => {
      const content = await readInScope(scope, relative)
      return [relative, content === null ? null : sha256Hex(content)] as const
    }),
  )
  return new Map(entries)
}
