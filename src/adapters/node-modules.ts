import { posix } from 'node:path'
import type { RootGraphBuilder } from '../graph/root-graph-builder.ts'
import { IMPORTER_PREFIX, type NodeId, type RootDescriptor } from '../model.ts'
import type { FileReader } from '../sources/file-reader.ts'
import {
  IMPORTER_BLOCKS,
  PACKAGE_BLOCKS,
  declaredDependencies,
  importerKeyOf,
  isNonRegistrySpec,
  readManifest,
  type DeclaredDependency,
  type Manifest,
} from './package-manifest.ts'

type Dependent = { id: NodeId; directory: string; manifest: Manifest; blocks: typeof PACKAGE_BLOCKS }
type Resolution = { directory: string } | { warning: string } | null

const MODULES_DIRECTORY = 'node_modules'
const REPO_ROOT = '.'

export async function walkNodeModules(reader: FileReader, root: RootDescriptor, builder: RootGraphBuilder): Promise<boolean> {
  if (!(await anyImporterHasModules(reader, root))) return false
  const walker = new InstalledWalker(reader, root, builder)
  await walker.walkFromImporters()
  return true
}

async function anyImporterHasModules(reader: FileReader, root: RootDescriptor): Promise<boolean> {
  const checks = await Promise.all(
    root.importerPaths.map((importerPath) => reader.exists(posix.join(importerPath, MODULES_DIRECTORY))),
  )
  return checks.some(Boolean)
}

function ancestorsOf(directory: string): string[] {
  const ancestors: string[] = []
  let current = directory
  while (current !== REPO_ROOT && current !== '') {
    ancestors.push(current)
    current = posix.dirname(current)
  }
  ancestors.push(REPO_ROOT)
  return ancestors
}

class InstalledWalker {
  private readonly reader: FileReader
  private readonly root: RootDescriptor
  private readonly builder: RootGraphBuilder
  private readonly importerKeyByDirectory = new Map<string, string>()
  private readonly nodeIdByDirectory = new Map<string, NodeId>()
  private readonly resolutionCache = new Map<string, Resolution>()
  private readonly directoryListings = new Map<string, Promise<Set<string>>>()
  private readonly pending: Dependent[] = []

  constructor(reader: FileReader, root: RootDescriptor, builder: RootGraphBuilder) {
    this.reader = reader
    this.root = root
    this.builder = builder
  }

  async walkFromImporters(): Promise<void> {
    for (const importerPath of this.root.importerPaths) {
      this.importerKeyByDirectory.set(importerPath, importerKeyOf(this.root, importerPath))
    }
    for (const importerPath of this.root.importerPaths) await this.enqueueImporter(importerPath)
    for (let dependent = this.pending.pop(); dependent; dependent = this.pending.pop()) {
      await this.linkDependencies(dependent)
    }
  }

  private async enqueueImporter(importerPath: string): Promise<void> {
    const importerKey = importerKeyOf(this.root, importerPath)
    const read = await readManifest(this.reader, importerPath)
    if ('problem' in read) {
      this.builder.warn(read.problem)
      this.builder.addImporter(importerKey, importerKey)
      return
    }
    const id = this.builder.addImporter(importerKey, read.manifest.name ?? importerKey)
    this.pending.push({ id, directory: importerPath, manifest: read.manifest, blocks: IMPORTER_BLOCKS })
  }

  private async linkDependencies(dependent: Dependent): Promise<void> {
    for (const declared of declaredDependencies(dependent.manifest, dependent.blocks)) {
      const target = await this.resolveTarget(dependent.directory, declared)
      if (target !== undefined) this.builder.addEdge(dependent.id, { to: target, kind: declared.kind, range: declared.range })
    }
  }

  private async resolveTarget(fromDirectory: string, declared: DeclaredDependency): Promise<NodeId | undefined> {
    const resolution = await this.resolve(fromDirectory, declared.name)
    if (resolution === null) return this.unresolvedTarget(declared)
    if ('warning' in resolution) {
      this.builder.warn(resolution.warning)
      return this.unresolvedTarget(declared)
    }
    const importerKey = this.importerKeyByDirectory.get(resolution.directory)
    if (importerKey !== undefined) return IMPORTER_PREFIX + importerKey
    return this.registerPackage(resolution.directory, declared)
  }

  private unresolvedTarget(declared: DeclaredDependency): NodeId | undefined {
    return declared.kind === 'prod' ? `${declared.name}@${declared.range}` : undefined
  }

  private async registerPackage(directory: string, declared: DeclaredDependency): Promise<NodeId | undefined> {
    const known = this.nodeIdByDirectory.get(directory)
    if (known !== undefined) return known
    const read = await readManifest(this.reader, directory)
    if ('problem' in read) {
      this.builder.warn(read.problem)
      return this.unresolvedTarget(declared)
    }
    const name = read.manifest.name ?? declared.name
    const version = read.manifest.version ?? ''
    const id = `${name}@${version}`
    this.builder.addPackage(id, name, version)
    if (isNonRegistrySpec(declared.range)) this.builder.markNonRegistry(id)
    this.nodeIdByDirectory.set(directory, id)
    this.pending.push({ id, directory, manifest: read.manifest, blocks: PACKAGE_BLOCKS })
    return id
  }

  private async resolve(fromDirectory: string, name: string): Promise<Resolution> {
    const cacheKey = `${fromDirectory}\0${name}`
    const cached = this.resolutionCache.get(cacheKey)
    if (cached !== undefined) return cached
    const resolution = await this.search(fromDirectory, name)
    this.resolutionCache.set(cacheKey, resolution)
    return resolution
  }

  private async search(fromDirectory: string, name: string): Promise<Resolution> {
    const realDirectory = await this.reader.realpath(fromDirectory)
    if (realDirectory === null) return { warning: `Could not resolve ${fromDirectory} inside the repository` }
    for (const ancestor of ancestorsOf(realDirectory)) {
      if (posix.basename(ancestor) === MODULES_DIRECTORY) continue
      const modulesDirectory = posix.join(ancestor, MODULES_DIRECTORY)
      if (!(await this.hasEntry(modulesDirectory, name))) continue
      const candidate = posix.join(modulesDirectory, name)
      const realCandidate = await this.reader.realpath(candidate)
      if (realCandidate === null) return { warning: `Skipped ${candidate}: broken link, looping link or link outside the repository` }
      return { directory: realCandidate }
    }
    return null
  }

  private async hasEntry(modulesDirectory: string, name: string): Promise<boolean> {
    const slash = name.indexOf('/')
    if (slash === -1) return (await this.listing(modulesDirectory)).has(name)
    const scope = name.slice(0, slash)
    if (!(await this.listing(modulesDirectory)).has(scope)) return false
    return (await this.listing(posix.join(modulesDirectory, scope))).has(name.slice(slash + 1))
  }

  private listing(directory: string): Promise<Set<string>> {
    let listing = this.directoryListings.get(directory)
    if (listing === undefined) {
      listing = this.reader.listDir(directory).then((entries) => new Set(entries.map((entry) => entry.name)))
      this.directoryListings.set(directory, listing)
    }
    return listing
  }
}
