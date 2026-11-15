import semver from 'semver'
import { IMPORTER_PREFIX, type DepKind, type Importer, type NodeId, type PackageNode, type RootGraph } from '../model.ts'
import type { EnrichmentView, PackageMeta, PublishedVersions } from '../enrich/types.ts'
import { ParentLinkResolver, type ParentLink } from '../query/dependents.ts'
import { nodeMeta, requestedRange } from '../query/enrichment-lookup.ts'
import { findNode, type GraphNode, type KindFilter } from '../query/lookup.ts'
import { normalizeRange } from '../query/versions.ts'
import { acceptedClause, fieldOf, importerLabel } from './labels.ts'
import { catalogNameOf } from './range-style.ts'
import { compareText, setRangeStep } from './set-range.ts'
import type { DependencyField, RelockStep, SetRangeStep, Step } from './types.ts'

export const CHAIN_MAX_DEPTH = 5
export const CHAIN_MAX_LOADS = 20

export type VersionsLoader = (name: string) => Promise<PublishedVersions>
export type ChainInput = { view: EnrichmentView; root: RootGraph; node: PackageNode; safe: readonly string[]; kinds: KindFilter; loadVersions: VersionsLoader }
export type ChainResult = { steps: Step[] } | { unavailable: string }

type Requester = { label: string; range: string }
type RelockEntry = { node: PackageNode; depth: number; requesters: Requester[]; acceptable: string[]; climbedFrom?: PackageNode }
type SetRangeEntry = {
  importer: Importer
  field: DependencyField
  specifier: string
  node: PackageNode
  acceptable: string[]
  climbedFrom?: PackageNode
}
type Visit = { node: PackageNode; acceptable: readonly string[]; depth: number; climbedFrom?: PackageNode }

class ChainUnavailableError extends Error {}

function isImporter(node: GraphNode): node is Importer {
  return node.id.startsWith(IMPORTER_PREFIX)
}

function admitsAny(range: string, versions: readonly string[]): boolean {
  return versions.some((version) => semver.satisfies(version, range))
}

function versionsAbove(versions: readonly string[], current: string): string[] {
  if (semver.valid(current) === null) return []
  return versions.filter((version) => semver.gt(version, current))
}

function intersect(known: readonly string[], incoming: readonly string[]): string[] {
  const accepted = new Set(incoming)
  return known.filter((version) => accepted.has(version))
}

function withClimbedFrom(climbedFrom: PackageNode | undefined): { climbedFrom?: PackageNode } {
  return climbedFrom === undefined ? {} : { climbedFrom }
}

function compareRelocks(left: RelockEntry, right: RelockEntry): number {
  return left.depth - right.depth || compareText(left.node.name, right.node.name) || compareText(left.node.version, right.node.version)
}

function compareSetRanges(left: SetRangeEntry, right: SetRangeEntry): number {
  return compareText(left.importer.path, right.importer.path) || compareText(left.node.name, right.node.name)
}

function setRangeKey(entry: SetRangeEntry): string {
  const catalog = catalogNameOf(entry.specifier)
  return catalog === undefined ? `${entry.importer.id}\0${entry.node.name}` : `catalog:${catalog}\0${entry.node.name}`
}

class ChainSearch {
  private readonly view: EnrichmentView
  private readonly root: RootGraph
  private readonly start: PackageNode
  private readonly safe: string[]
  private readonly links: ParentLinkResolver
  private readonly loadVersions: VersionsLoader
  private readonly loaded = new Map<string, PublishedVersions>()
  private readonly path = new Set<NodeId>()
  private readonly relocks = new Map<string, RelockEntry>()
  private readonly setRanges = new Map<string, SetRangeEntry>()

  constructor(input: ChainInput) {
    this.view = input.view
    this.root = input.root
    this.start = input.node
    this.safe = input.safe.filter((version) => semver.valid(version) !== null).sort(semver.compare)
    this.links = new ParentLinkResolver(input.root, new Set<DepKind>([...input.kinds].filter((kind) => kind !== 'peer')))
    this.loadVersions = input.loadVersions
  }

  async run(): Promise<Step[]> {
    this.path.add(this.start.id)
    await this.visit({ node: this.start, acceptable: this.safe, depth: 0 })
    const relockSteps = [...this.relocks.values()].sort(compareRelocks).map((entry) => this.relockStep(entry))
    const setRangeSteps = [...this.setRanges.values()].sort(compareSetRanges).map((entry) => this.setRangeStep(entry))
    const steps = [...relockSteps, ...setRangeSteps]
    if (steps.length === 0) throw new ChainUnavailableError('no parent path reaches a workspace package')
    return steps
  }

  private async visit(visit: Visit): Promise<void> {
    for (const link of this.links.of(visit.node)) {
      const parent = findNode(this.root, link.id)
      if (parent === undefined) continue
      const requested = requestedRange(this.view, this.root, parent, link.range, visit.node).range
      const range = this.normalized(visit.node, requested)
      if (range !== undefined && admitsAny(range, visit.acceptable)) {
        this.addRequester(visit, { label: this.requesterLabel(parent, requested, visit.depth), range })
        continue
      }
      if (isImporter(parent)) {
        this.addRaisedRange(visit, parent, link)
        continue
      }
      if (this.path.has(parent.id)) continue
      await this.climb(parent, visit)
    }
  }

  private async climb(parent: PackageNode, from: Visit): Promise<void> {
    if (from.depth + 1 > CHAIN_MAX_DEPTH) throw new ChainUnavailableError(`the chain is deeper than ${CHAIN_MAX_DEPTH} levels`)
    const meta = await this.publishedMeta(parent.name)
    const acceptable = this.acceptableVersions(parent, meta, from)
    if (acceptable.length === 0) throw new ChainUnavailableError(`${parent.name} has no version that accepts a safe ${from.node.name}`)
    this.path.add(parent.id)
    await this.visit({ node: parent, acceptable, depth: from.depth + 1, climbedFrom: from.node })
    this.path.delete(parent.id)
  }

  private async publishedMeta(name: string): Promise<PackageMeta> {
    let published = this.loaded.get(name)
    if (published === undefined) {
      if (this.loaded.size >= CHAIN_MAX_LOADS) throw new ChainUnavailableError(`the search needs more than ${CHAIN_MAX_LOADS} packument loads`)
      published = await this.loadVersions(name)
      this.loaded.set(name, published)
    }
    if (published.state === 'failed') throw new ChainUnavailableError(`could not load the versions of ${name}: ${published.reason}`)
    return published.meta
  }

  private acceptableVersions(parent: PackageNode, meta: PackageMeta, from: Visit): string[] {
    const newer = versionsAbove(
      meta.versions.filter((version) => semver.valid(version) !== null && semver.prerelease(version) === null),
      parent.version,
    )
    return newer.filter((version) => this.acceptsSafeChild(meta.manifests[version], from)).sort(semver.compare)
  }

  private acceptsSafeChild(manifest: Record<string, string> | undefined, from: Visit): boolean {
    if (manifest === undefined) return false
    const declared = manifest[from.node.name]
    if (declared === undefined) return true
    const range = this.normalized(from.node, declared)
    return range !== undefined && admitsAny(range, from.acceptable)
  }

  private metaOf(node: PackageNode): PackageMeta | undefined {
    const published = this.loaded.get(node.name)
    return published?.state === 'ok' ? published.meta : nodeMeta(this.view, this.root, node)
  }

  private normalized(child: PackageNode, range: string): string | undefined {
    return normalizeRange(range, { name: child.name, catalogs: this.root.config?.catalogs ?? {}, distTags: this.metaOf(child)?.distTags })
  }

  private requesterLabel(parent: GraphNode, requested: string, depth: number): string {
    const name = isImporter(parent) ? importerLabel(parent.id) : parent.name
    return depth === 0 ? name : `${name} ${requested}`
  }

  private addRequester(visit: Visit, requester: Requester): void {
    const key = `${visit.node.name}@${visit.node.version}`
    const entry = this.relocks.get(key)
    if (entry === undefined) {
      this.relocks.set(key, {
        node: visit.node,
        depth: visit.depth,
        requesters: [requester],
        acceptable: [...visit.acceptable],
        ...withClimbedFrom(visit.climbedFrom),
      })
      return
    }
    if (!entry.requesters.some((known) => known.label === requester.label && known.range === requester.range)) entry.requesters.push(requester)
    entry.acceptable = intersect(entry.acceptable, visit.acceptable)
  }

  private addRaisedRange(visit: Visit, importer: Importer, link: ParentLink): void {
    const field = fieldOf(link.kind)
    if (field === undefined) return
    const raised: SetRangeEntry = {
      importer,
      field,
      specifier: link.range,
      node: visit.node,
      acceptable: versionsAbove(visit.acceptable, visit.node.version),
      ...withClimbedFrom(visit.climbedFrom),
    }
    const key = setRangeKey(raised)
    const known = this.setRanges.get(key)
    if (known === undefined) {
      this.setRanges.set(key, raised)
      return
    }
    const kept = compareText(raised.importer.path, known.importer.path) < 0 ? raised : known
    this.setRanges.set(key, { ...kept, acceptable: intersect(known.acceptable, raised.acceptable) })
  }

  private dependencyNote(node: PackageNode, to: string, child: PackageNode): string {
    const declared = this.metaOf(node)?.manifests[to]?.[child.name]
    return declared === undefined ? `${to} no longer depends on ${child.name}` : `${to} requires ${child.name} ${declared}`
  }

  private relockStep(entry: RelockEntry): RelockStep {
    const { node, requesters, climbedFrom } = entry
    const to = entry.acceptable.filter((version) => requesters.every((requester) => semver.satisfies(version, requester.range))).at(-1)
    if (to === undefined) throw new ChainUnavailableError(`${node.name} ${node.version} has no fixed version that all its parents accept`)
    const clause = acceptedClause(requesters.map((requester) => requester.label))
    const reason = climbedFrom === undefined ? clause : `${this.dependencyNote(node, to, climbedFrom)}; ${clause}`
    return { kind: 'relock', name: node.name, from: node.version, to, reason }
  }

  private setRangeStep(entry: SetRangeEntry): SetRangeStep {
    const { node, climbedFrom } = entry
    const to = entry.acceptable[0]
    if (to === undefined) throw new ChainUnavailableError(`no safe version of ${node.name} above ${node.version}`)
    const reason = climbedFrom === undefined ? `${to} is the lowest safe ${node.name} above ${node.version}` : this.dependencyNote(node, to, climbedFrom)
    const result = setRangeStep(this.root, { importer: entry.importer.id, field: entry.field, dependency: node.name, specifier: entry.specifier, target: to, reason })
    if ('unavailable' in result) throw new ChainUnavailableError(result.unavailable)
    return result.step
  }
}

export async function parentChain(input: ChainInput): Promise<ChainResult> {
  try {
    return { steps: await new ChainSearch(input).run() }
  } catch (error) {
    if (error instanceof ChainUnavailableError) return { unavailable: error.message }
    throw error
  }
}
