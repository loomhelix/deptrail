import { posix } from 'node:path'
import { buildManifestOnly } from '../adapters/manifest-only.ts'
import { parseNpmLock } from '../adapters/npm-lock.ts'
import { readManifest } from '../adapters/package-manifest.ts'
import { parsePnpmLock } from '../adapters/pnpm-lock.ts'
import { walkNodeModules } from '../adapters/node-modules.ts'
import { resolveToday } from '../adapters/resolve-today.ts'
import type { CommandRunner } from '../adapters/command-runner.ts'
import { RootGraphBuilder } from '../graph/root-graph-builder.ts'
import type { RootDescriptor, RootGraph, SourceKind } from '../model.ts'
import type { FileReader } from '../sources/file-reader.ts'

export type BuildRootDeps = { reader: FileReader; runner: CommandRunner; allowResolve: boolean; allowInstalled?: boolean }

type LockfileParser = (text: string, builder: RootGraphBuilder) => { supported: boolean }
type LockfileAttempt = { graph: RootGraph | null; reason: string }

const LOCKFILE_PARSERS: Record<string, LockfileParser> = {
  'pnpm-lock.yaml': parsePnpmLock,
  'package-lock.json': parseNpmLock,
  'npm-shrinkwrap.json': parseNpmLock,
}

function newBuilder(root: RootDescriptor, source: SourceKind): RootGraphBuilder {
  return new RootGraphBuilder({ id: root.id, path: root.path, manager: root.manager, source })
}

export function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

export function failedRootGraph(root: RootDescriptor, error: string, warnings: string[] = []): RootGraph {
  return {
    id: root.id,
    path: root.path,
    manager: root.manager,
    source: root.lockfile ? 'lockfile' : 'manifest-only',
    status: 'failed',
    error,
    importers: [],
    packages: new Map(),
    warnings,
  }
}

function parseLockfileText(root: RootDescriptor, text: string, source: SourceKind, parser: LockfileParser): LockfileAttempt {
  const builder = newBuilder(root, source)
  const { supported } = parser(text, builder)
  const graph = builder.build()
  if (supported) return { graph, reason: '' }
  return { graph: null, reason: graph.warnings.join('; ') || 'lockfile is not supported' }
}

export function parseRootLockfile(
  root: Pick<RootDescriptor, 'id' | 'path' | 'manager'>,
  lockfileName: string,
  text: string,
): { graph: RootGraph } | { error: string } {
  const parser = LOCKFILE_PARSERS[posix.basename(lockfileName)]
  if (!parser) return { error: `${lockfileName} has no supported lockfile format` }
  try {
    const attempt = parseLockfileText({ ...root, importerPaths: [] }, text, 'lockfile', parser)
    return attempt.graph ? { graph: attempt.graph } : { error: attempt.reason }
  } catch (failure) {
    return { error: messageOf(failure) }
  }
}

async function attemptLockfile(root: RootDescriptor, reader: FileReader): Promise<LockfileAttempt> {
  if (!root.lockfile) return { graph: null, reason: 'no lockfile' }
  const parser = LOCKFILE_PARSERS[posix.basename(root.lockfile)]
  if (!parser) return { graph: null, reason: `${root.lockfile} has no supported lockfile format` }
  const text = await reader.readText(root.lockfile)
  if (text === null) return { graph: null, reason: `${root.lockfile} could not be read` }
  return parseLockfileText(root, text, 'lockfile', parser)
}

async function attemptInstalled(root: RootDescriptor, reader: FileReader): Promise<RootGraph | null> {
  const builder = newBuilder(root, 'installed')
  return (await walkNodeModules(reader, root, builder)) ? builder.build() : null
}

async function attemptResolveToday(root: RootDescriptor, deps: BuildRootDeps): Promise<LockfileAttempt> {
  if (!deps.allowResolve) return { graph: null, reason: 'versions not resolved' }
  const result = await resolveToday(deps.reader, root, deps.runner)
  if ('error' in result) return { graph: null, reason: `version resolution failed: ${result.error}` }
  const parser = result.manager === 'pnpm' ? parsePnpmLock : parseNpmLock
  const attempt = parseLockfileText(root, result.lockfileText, 'resolved-today', parser)
  if (attempt.graph) return attempt
  return { graph: null, reason: `resolved ${result.manager} lockfile is not usable: ${attempt.reason}` }
}

async function attemptManifestOnly(root: RootDescriptor, reader: FileReader): Promise<RootGraph> {
  const builder = newBuilder(root, 'manifest-only')
  await buildManifestOnly(reader, root, builder)
  return builder.build()
}

function withFallbackWarning(graph: RootGraph, reasons: string[]): RootGraph {
  if (reasons.length === 0) return graph
  const sourceLabel: Record<SourceKind, string> = {
    lockfile: 'lockfile',
    installed: 'installed node_modules',
    'resolved-today': 'versions resolved today',
    'manifest-only': 'package.json manifests only',
  }
  graph.warnings.push(`${reasons.join('; ')}; built from ${sourceLabel[graph.source]}`)
  return graph
}

async function useRepoRelativeImporters(root: RootDescriptor, graph: RootGraph, reader: FileReader): Promise<void> {
  await Promise.all(
    graph.importers.map(async (importer) => {
      const rootRelativePath = importer.path
      importer.path = rootRelativePath === '.' ? root.path : posix.join(root.path, rootRelativePath)
      if (importer.name !== rootRelativePath) return
      const read = await readManifest(reader, importer.path)
      if ('manifest' in read && read.manifest.name) importer.name = read.manifest.name
    }),
  )
}

async function cascade(root: RootDescriptor, deps: BuildRootDeps, reasons: string[]): Promise<RootGraph> {
  const fromLockfile = await attemptLockfile(root, deps.reader)
  if (fromLockfile.graph) return finish(root, fromLockfile.graph, reasons, deps)
  reasons.push(fromLockfile.reason)

  if (deps.allowInstalled !== false) {
    const installed = await attemptInstalled(root, deps.reader)
    if (installed) return finish(root, installed, reasons, deps)
    reasons.push('no installed node_modules')
  }

  const resolved = await attemptResolveToday(root, deps)
  if (resolved.graph) return finish(root, resolved.graph, reasons, deps)
  reasons.push(resolved.reason)

  return finish(root, await attemptManifestOnly(root, deps.reader), reasons, deps)
}

async function finish(root: RootDescriptor, graph: RootGraph, reasons: string[], deps: BuildRootDeps): Promise<RootGraph> {
  await useRepoRelativeImporters(root, graph, deps.reader)
  return withFallbackWarning(graph, reasons)
}

export async function buildRoot(root: RootDescriptor, deps: BuildRootDeps): Promise<RootGraph> {
  const reasons: string[] = []
  try {
    return await cascade(root, deps, reasons)
  } catch (failure) {
    return failedRootGraph(root, messageOf(failure), reasons.length > 0 ? [reasons.join('; ')] : [])
  }
}
