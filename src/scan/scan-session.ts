import type { CommandRunner } from '../adapters/command-runner.ts'
import { readRootConfig } from '../config/root-config.ts'
import { findRoots } from '../discovery/find-roots.ts'
import { buildGlobalIndex, type GlobalIndex } from '../graph/global-index.ts'
import type { RootDescriptor, RootGraph, Scan } from '../model.ts'
import type { FileReader } from '../sources/file-reader.ts'
import { buildRoot, failedRootGraph, messageOf } from './build-root.ts'
import { cacheKeyOf, type ScanCache } from './scan-cache.ts'

export type ScanSession = {
  readonly scan: Scan
  readonly index: GlobalIndex
  ready: Promise<void>
  root(id: string): RootGraph | undefined
  resolve(rootId: string): Promise<void>
  refreshRoot(rootId: string): Promise<void>
  rescan(): Promise<void>
}

export type ScanSessionOptions = {
  repoPath: string
  reader: FileReader
  runner: CommandRunner
  cache: ScanCache | null
  env: Record<string, string | undefined>
  userNpmrc: string | null
  useInstalled?: boolean
  expandNpmrcVariables?: boolean
  skippedSubmodules?: readonly string[]
  onRootPublished?: (roots: readonly RootGraph[]) => void
}

type ScanRun = { scan: Scan; descriptors: RootDescriptor[]; generations: Map<string, number> }

function scanningPlaceholder(root: RootDescriptor): RootGraph {
  return {
    id: root.id,
    path: root.path,
    manager: root.manager,
    source: root.lockfile ? 'lockfile' : 'manifest-only',
    status: 'scanning',
    importers: [],
    packages: new Map(),
    warnings: [],
  }
}

export async function startScanSession(options: ScanSessionOptions): Promise<ScanSession> {
  const { repoPath, reader, runner, cache, env, userNpmrc, onRootPublished } = options
  const allowInstalled = options.useInstalled ?? true
  let run = await discover()
  let index: GlobalIndex = new Map()
  let ready: Promise<void> = Promise.resolve()

  async function discover(): Promise<ScanRun> {
    const descriptors = await findRoots(reader)
    const scan: Scan = {
      repoPath,
      roots: descriptors.map(scanningPlaceholder),
      scannedAt: new Date().toISOString(),
      ...(options.skippedSubmodules === undefined ? {} : { skippedSubmodules: [...options.skippedSubmodules] }),
    }
    return { scan, descriptors, generations: new Map() }
  }

  async function buildWithCache(descriptor: RootDescriptor): Promise<RootGraph> {
    const lockfileText = descriptor.lockfile && cache ? await reader.readText(descriptor.lockfile) : null
    const key = lockfileText === null ? null : cacheKeyOf(repoPath, descriptor.path, lockfileText)
    const cached = key && cache ? await cache.get(key) : null
    if (cached) return { ...cached, id: descriptor.id, path: descriptor.path, manager: descriptor.manager }
    const graph = await buildRoot(descriptor, { reader, runner, allowResolve: false, allowInstalled })
    if (key && cache && graph.source === 'lockfile' && graph.status === 'ready') await cache.set(key, graph).catch(() => {})
    return graph
  }

  async function withConfig(descriptor: RootDescriptor, graph: RootGraph): Promise<RootGraph> {
    if (graph.status === 'failed') return graph
    graph.config = await readRootConfig(reader, descriptor.path, { userNpmrc, env, expandProjectVariables: options.expandNpmrcVariables ?? true })
    graph.warnings = [...graph.warnings, ...graph.config.warnings]
    return graph
  }

  function descriptorOf(target: ScanRun, rootId: string): RootDescriptor {
    const descriptor = target.descriptors.find((candidate) => candidate.id === rootId)
    if (!descriptor) throw new Error(`Unknown root ${rootId}`)
    return descriptor
  }

  function beginBuild(target: ScanRun, descriptor: RootDescriptor): number {
    const generation = (target.generations.get(descriptor.id) ?? 0) + 1
    target.generations.set(descriptor.id, generation)
    return generation
  }

  function publish(target: ScanRun, descriptor: RootDescriptor, generation: number, graph: RootGraph): void {
    if (target !== run || target.generations.get(descriptor.id) !== generation) return
    const position = target.scan.roots.findIndex((candidate) => candidate.id === descriptor.id)
    if (position === -1) return
    target.scan.roots[position] = graph
    index = buildGlobalIndex(target.scan.roots)
    onRootPublished?.(target.scan.roots)
  }

  async function runBuild(
    target: ScanRun,
    descriptor: RootDescriptor,
    generation: number,
    build: () => Promise<RootGraph>,
  ): Promise<void> {
    let graph: RootGraph
    try {
      graph = await withConfig(descriptor, await build())
    } catch (failure) {
      graph = failedRootGraph(descriptor, messageOf(failure))
    }
    publish(target, descriptor, generation, graph)
  }

  function buildAll(target: ScanRun): Promise<void> {
    const builds = target.descriptors.map((descriptor) => {
      const generation = beginBuild(target, descriptor)
      return runBuild(target, descriptor, generation, () => buildWithCache(descriptor))
    })
    return Promise.all(builds).then(() => undefined)
  }

  async function startRun(): Promise<void> {
    index = new Map()
    ready = buildAll(run)
    await ready
  }

  ready = buildAll(run)

  return {
    get scan() {
      return run.scan
    },
    get index() {
      return index
    },
    get ready() {
      return ready
    },
    root(id) {
      return run.scan.roots.find((candidate) => candidate.id === id)
    },
    async resolve(rootId) {
      const target = run
      const descriptor = descriptorOf(target, rootId)
      const generation = beginBuild(target, descriptor)
      publish(target, descriptor, generation, scanningPlaceholder(descriptor))
      await runBuild(target, descriptor, generation, () => buildRoot(descriptor, { reader, runner, allowResolve: true, allowInstalled }))
    },
    async refreshRoot(rootId) {
      const target = run
      const descriptor = descriptorOf(target, rootId)
      const generation = beginBuild(target, descriptor)
      await runBuild(target, descriptor, generation, () => buildWithCache(descriptor))
    },
    async rescan() {
      run = await discover()
      await startRun()
    },
  }
}
