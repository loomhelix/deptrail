import semver from 'semver'
import type { Importer, NodeId, PackageNode, RootGraph } from '../model.ts'
import type { Advisory, EnrichmentView, PackageMeta } from '../enrich/types.ts'
import { ParentLinkResolver } from '../query/dependents.ts'
import { nodeMeta, requestedRange, worstSeverity } from '../query/enrichment-lookup.ts'
import { ALL_KINDS, findNode } from '../query/lookup.ts'
import { normalizedRequestedRange } from '../query/node-fix.ts'
import { isAffected } from '../query/versions.ts'
import { relockTarget, type OptionsContext } from './fix-options.ts'
import { importerLabel } from './labels.ts'
import { catalogNameOf, rewriteRange } from './range-style.ts'
import { setRangeStep } from './set-range.ts'
import type { DependencyField, SetRangeStep, Step, UpdateActions, UpdateChoice, UpdateGoal, UpdateImporter, UpdateVersion } from './types.ts'

export type ImporterManifests = ReadonlyMap<NodeId, Record<string, unknown>>
export type UpdatePlan = { goal: UpdateGoal; steps: Step[]; warnings: string[] }
export type UpdateError = { error: string }

type Editability = { editable: true; template: string } | { editable: false; reason: string }
type RegistryChoices = Pick<UpdateActions, 'wanted' | 'latest' | 'versions'>
type RangeChoice = Exclude<UpdateChoice, 'wanted'>
type ManifestEntry = { key: string; specifier: string }

const DECLARING_FIELDS: readonly DependencyField[] = ['dependencies', 'devDependencies', 'optionalDependencies']
const PEER_FIELD = 'peerDependencies'
const ALIAS_PREFIX = 'npm:'
const VERSION_PLACEHOLDER = '<version>'
const LATEST_TAG = 'latest'
const DEFAULT_CATALOG = 'default'
const MAJOR_UPDATE = 'major update'
const EMPTY_SELECTION = 'Select at least one workspace package'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function declaredRange(manifest: Record<string, unknown>, field: string, name: string): string | undefined {
  const section = manifest[field]
  if (!isRecord(section)) return undefined
  const range = section[name]
  return typeof range === 'string' ? range : undefined
}

function templateOf(specifier: string): Editability {
  const rewritten = rewriteRange(specifier, VERSION_PLACEHOLDER)
  return rewritten.editable ? { editable: true, template: rewritten.specifier } : { editable: false, reason: rewritten.reason }
}

function catalogEntryOf(root: RootGraph, entry: ManifestEntry): string | undefined {
  const catalog = catalogNameOf(entry.specifier)
  return catalog === undefined ? entry.specifier : root.config?.catalogs[catalog]?.[entry.key]
}

function editability(root: RootGraph, entry: ManifestEntry): Editability {
  const resolved = catalogEntryOf(root, entry)
  if (resolved !== undefined) return templateOf(resolved)
  return { editable: false, reason: `the ${catalogNameOf(entry.specifier)} catalog has no entry for ${entry.key}` }
}

function aliasedPackageOf(specifier: string): string | undefined {
  if (!specifier.startsWith(ALIAS_PREFIX)) return undefined
  const versionSeparator = specifier.lastIndexOf('@')
  return versionSeparator <= ALIAS_PREFIX.length ? specifier.slice(ALIAS_PREFIX.length) : specifier.slice(ALIAS_PREFIX.length, versionSeparator)
}

function declaresPackage(root: RootGraph, entry: ManifestEntry, name: string): boolean {
  const aliased = aliasedPackageOf(catalogEntryOf(root, entry) ?? entry.specifier)
  return aliased === undefined ? entry.key === name : aliased === name
}

function manifestEntries(manifest: Record<string, unknown>, field: string): ManifestEntry[] {
  const section = manifest[field]
  if (!isRecord(section)) return []
  return Object.entries(section).flatMap(([key, specifier]) => (typeof specifier === 'string' ? [{ key, specifier }] : []))
}

function declaringEntry(root: RootGraph, manifest: Record<string, unknown>, name: string): { field: DependencyField; entry: ManifestEntry } | undefined {
  for (const field of DECLARING_FIELDS) {
    const declaring = manifestEntries(manifest, field).filter((entry) => declaresPackage(root, entry, name))
    const entry = declaring.find((candidate) => candidate.key === name) ?? declaring[0]
    if (entry !== undefined) return { field, entry }
  }
  return undefined
}

function declaringImporter(root: RootGraph, id: NodeId, manifest: Record<string, unknown>, name: string): UpdateImporter | undefined {
  const declaring = declaringEntry(root, manifest, name)
  if (declaring === undefined) return undefined
  const { field, entry } = declaring
  const peerRange = declaredRange(manifest, PEER_FIELD, entry.key)
  return {
    id,
    field,
    ...(entry.key === name ? {} : { alias: entry.key }),
    specifier: entry.specifier,
    ...editability(root, entry),
    ...(peerRange === undefined ? {} : { peerRange }),
  }
}

function declaringImporters(root: RootGraph, name: string, manifests: ImporterManifests): UpdateImporter[] {
  return root.importers.flatMap((importer) => {
    const manifest = manifests.get(importer.id)
    const declaring = manifest === undefined ? undefined : declaringImporter(root, importer.id, manifest, name)
    return declaring === undefined ? [] : [declaring]
  })
}

function dependsDirectly(importer: Importer, node: PackageNode): boolean {
  return importer.deps.some((edge) => edge.to === node.id && edge.kind !== 'peer')
}

function parentRanges(view: EnrichmentView, root: RootGraph, node: PackageNode, meta: PackageMeta): (string | undefined)[] {
  return new ParentLinkResolver(root, ALL_KINDS).of(node).flatMap((link) => {
    const parent = findNode(root, link.id)
    return parent === undefined ? [] : [normalizedRequestedRange(root, node, meta, requestedRange(view, root, parent, link.range, node))]
  })
}

function newerReleases(meta: PackageMeta, current: string): string[] {
  if (semver.valid(current) === null) return []
  return meta.versions.filter((version) => semver.valid(version) !== null && semver.prerelease(version) === null && semver.gt(version, current))
}

function latestOf(meta: PackageMeta, current: string): string | undefined {
  const latest = meta.distTags[LATEST_TAG]
  return latest !== undefined && semver.valid(latest) !== null && latest !== current ? latest : undefined
}

function packageAdvisories(view: EnrichmentView, name: string): Advisory[] {
  const loaded = view.advisoriesOf(name)
  return loaded.state === 'ok' || loaded.state === 'stale' ? loaded.advisories : []
}

function publishedVersion(meta: PackageMeta, advisories: readonly Advisory[], version: string): UpdateVersion {
  const severity = worstSeverity(advisories.filter((advisory) => isAffected(version, advisory)).map((advisory) => advisory.severity))
  return {
    version,
    ...(severity === undefined ? {} : { severity }),
    ...(meta.deprecated[version] === undefined ? {} : { deprecated: true as const }),
    ...(semver.prerelease(version) === null ? {} : { prerelease: true as const }),
  }
}

function registryChoices(view: EnrichmentView, root: RootGraph, node: PackageNode): RegistryChoices {
  const meta = nodeMeta(view, root, node)
  if (meta === undefined) return { versions: [] }
  const wanted = relockTarget(parentRanges(view, root, node, meta), newerReleases(meta, node.version))
  const latest = latestOf(meta, node.version)
  const advisories = packageAdvisories(view, node.name)
  return {
    ...(wanted === undefined ? {} : { wanted }),
    ...(latest === undefined ? {} : { latest }),
    versions: meta.versions
      .filter((version) => semver.valid(version) !== null)
      .sort(semver.rcompare)
      .map((version) => publishedVersion(meta, advisories, version)),
  }
}

export function updateActions(context: Pick<OptionsContext, 'view' | 'root'>, node: PackageNode, manifests: ImporterManifests): UpdateActions | undefined {
  const { view, root } = context
  if (!root.importers.some((importer) => dependsDirectly(importer, node))) return undefined
  return { name: node.name, current: node.version, ...registryChoices(view, root, node), importers: declaringImporters(root, node.name, manifests) }
}

function majorWarnings(current: string, target: string): string[] {
  if (semver.valid(current) === null || semver.valid(target) === null) return []
  return semver.major(target) > semver.major(current) ? [MAJOR_UPDATE] : []
}

function peerWarnings(selected: readonly UpdateImporter[]): string[] {
  return selected.flatMap((importer) => (importer.peerRange === undefined ? [] : [`${importerLabel(importer.id)}: peerDependencies ${importer.peerRange} unchanged`]))
}

function locksCurrent(root: RootGraph, importer: Importer, update: UpdateActions): boolean {
  return importer.deps.some((edge) => {
    const target = root.packages.get(edge.to)
    return edge.kind !== 'peer' && target?.name === update.name && target.version === update.current
  })
}

function lockingImporters(root: RootGraph, update: UpdateActions): NodeId[] {
  return root.importers.filter((importer) => locksCurrent(root, importer, update)).map((importer) => importer.id)
}

function wantedPlan(update: UpdateActions, root: RootGraph): UpdatePlan | UpdateError {
  const wanted = update.wanted
  if (wanted === undefined) return { error: `${update.name} has no newer version within its ranges` }
  return {
    goal: { kind: 'update', name: update.name, importers: lockingImporters(root, update), target: wanted },
    steps: [{ kind: 'relock', name: update.name, from: update.current, to: wanted, reason: `every requesting range accepts ${wanted}` }],
    warnings: majorWarnings(update.current, wanted),
  }
}

function targetVersion(update: UpdateActions, choice: RangeChoice, version: string | undefined): { version: string } | UpdateError {
  const target = choice === 'latest' ? update.latest : version
  if (target === undefined) return { error: choice === 'latest' ? `${update.name} has no latest version to update to` : `Select a version of ${update.name}` }
  if (!update.versions.some((entry) => entry.version === target)) return { error: `${target} is not a published version of ${update.name}` }
  if (target === update.current) return { error: `${target} is the current version` }
  return { version: target }
}

function selectedImporters(update: UpdateActions, ids: readonly NodeId[]): { importers: UpdateImporter[] } | UpdateError {
  const requested = new Set(ids)
  if (requested.size === 0) return { error: EMPTY_SELECTION }
  for (const id of requested) {
    const declaring = update.importers.find((importer) => importer.id === id)
    if (declaring === undefined) return { error: `${id} does not declare ${update.name}` }
    if (!declaring.editable) return { error: `${id}: ${declaring.reason}` }
  }
  return { importers: update.importers.filter((importer) => requested.has(importer.id)) }
}

function catalogEntryKey(step: SetRangeStep): string | undefined {
  return step.place === 'catalog' ? `${step.catalog ?? DEFAULT_CATALOG}\0${step.dependency}` : undefined
}

function rangeReason(choice: RangeChoice, update: UpdateActions, target: string): string {
  return choice === 'latest' ? `${target} is the latest version of ${update.name}` : `${target} is the selected version of ${update.name}`
}

function rangePlan(update: UpdateActions, root: RootGraph, choice: RangeChoice, target: string, selected: readonly UpdateImporter[]): UpdatePlan | UpdateError {
  const reason = rangeReason(choice, update, target)
  const steps: SetRangeStep[] = []
  const editedCatalogEntries = new Set<string>()
  for (const importer of selected) {
    const dependency = importer.alias ?? update.name
    const result = setRangeStep(root, { importer: importer.id, field: importer.field, dependency, specifier: importer.specifier, target, reason })
    if ('unavailable' in result) return { error: result.unavailable }
    const catalogEntry = catalogEntryKey(result.step)
    if (catalogEntry !== undefined) {
      if (editedCatalogEntries.has(catalogEntry)) continue
      editedCatalogEntries.add(catalogEntry)
    }
    steps.push(result.step)
  }
  return {
    goal: { kind: 'update', name: update.name, importers: selected.map((importer) => importer.id), target },
    steps,
    warnings: [...majorWarnings(update.current, target), ...peerWarnings(selected)],
  }
}

export function updateSteps(
  update: UpdateActions,
  root: RootGraph,
  choice: UpdateChoice,
  version: string | undefined,
  importers: readonly NodeId[],
): UpdatePlan | UpdateError {
  if (choice === 'wanted') return wantedPlan(update, root)
  const target = targetVersion(update, choice, version)
  if ('error' in target) return target
  const selected = selectedImporters(update, importers)
  if ('error' in selected) return selected
  return rangePlan(update, root, choice, target.version, selected.importers)
}
