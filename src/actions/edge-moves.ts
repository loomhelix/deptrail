import semver from 'semver'
import { PLACEHOLDER_PREFIX, type Edge, type Importer, type PackageNode, type RootGraph } from '../model.ts'
import { selectorParts } from './edit-plan.ts'
import { importerLabel } from './labels.ts'
import { catalogNameOf } from './range-style.ts'
import type { OverrideStep, RelockStep, SetRangeStep, Step } from './types.ts'

type Resolution = { label: string; versions: Set<string> }
type IntendedMoves = { relocks: RelockStep[]; overrides: OverrideStep[] }

const DEFAULT_CATALOG = 'default'

function targetedName(step: Step): string | undefined {
  if (step.kind === 'relock') return step.name
  if (step.kind === 'override') return selectorParts(step.selector).name
  return undefined
}

function isImporter(parent: Importer | PackageNode): parent is Importer {
  return 'path' in parent
}

function edgeKey(parent: Importer | PackageNode, edge: Edge): string {
  return isImporter(parent) ? `${parent.id}\0${edge.kind}\0${edge.range}` : `${parent.name}@${parent.version}\0${edge.kind}`
}

function parentLabel(parent: Importer | PackageNode): string {
  return isImporter(parent) ? importerLabel(parent.id) : `${parent.name} ${parent.version}`
}

function editedCatalogs(steps: readonly Step[], name: string): Set<string> {
  const edits = steps.filter((step): step is SetRangeStep => step.kind === 'set-range' && step.place === 'catalog' && step.dependency === name)
  return new Set(edits.map((step) => step.catalog ?? DEFAULT_CATALOG))
}

function isSetByUpdate(parent: Importer | PackageNode, edge: Edge, catalogs: ReadonlySet<string>): boolean {
  if (!isImporter(parent)) return false
  const catalog = catalogNameOf(edge.range)
  return catalog !== undefined && catalogs.has(catalog)
}

function resolutionsOf(graph: RootGraph, name: string, catalogs: ReadonlySet<string>): Map<string, Resolution> {
  const resolutions = new Map<string, Resolution>()
  const parents = [...graph.importers, ...[...graph.packages.values()].filter((node) => !node.id.startsWith(PLACEHOLDER_PREFIX))]
  for (const parent of parents) {
    for (const edge of parent.deps) {
      const child = graph.packages.get(edge.to)
      if (child === undefined || child.name !== name || child.id.startsWith(PLACEHOLDER_PREFIX)) continue
      if (isSetByUpdate(parent, edge, catalogs)) continue
      const key = edgeKey(parent, edge)
      const known = resolutions.get(key)
      if (known === undefined) resolutions.set(key, { label: parentLabel(parent), versions: new Set([child.version]) })
      else known.versions.add(child.version)
    }
  }
  return resolutions
}

function onlyIn(source: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return [...source].filter((version) => !other.has(version))
}

function satisfiesValue(version: string, value: string): boolean {
  if (version === value) return true
  return semver.valid(version) !== null && semver.validRange(value) !== null && semver.satisfies(version, value)
}

function selectorMatches(range: string | undefined, version: string): boolean {
  if (range === undefined) return true
  return semver.valid(version) !== null && semver.validRange(range) !== null && semver.satisfies(version, range)
}

function isIntended(intended: IntendedMoves, name: string, from: string, to: string): boolean {
  if (intended.relocks.some((step) => step.name === name && step.from === from && step.to === to)) return true
  return intended.overrides.some((step) => {
    const selector = selectorParts(step.selector)
    return selector.name === name && satisfiesValue(to, step.value) && selectorMatches(selector.range, from)
  })
}

function isDowngrade(from: string, to: string): boolean {
  return semver.valid(from) !== null && semver.valid(to) !== null && semver.lt(to, from)
}

function moveText(label: string, name: string, from: string, to: string): string {
  return `${label} moves ${name} ${from} → ${to}${isDowngrade(from, to) ? ' (downgrade)' : ''}`
}

function sameVersions(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((version) => right.has(version))
}

export function edgeMoveWarnings(steps: readonly Step[], before: RootGraph, after: RootGraph): string[] {
  const intended: IntendedMoves = {
    relocks: steps.filter((step): step is RelockStep => step.kind === 'relock'),
    overrides: steps.filter((step): step is OverrideStep => step.kind === 'override'),
  }
  const names = new Set(steps.flatMap((step) => targetedName(step) ?? []))
  const warnings = new Set<string>()
  for (const name of names) {
    const catalogs = editedCatalogs(steps, name)
    const afterResolutions = resolutionsOf(after, name, catalogs)
    for (const [key, previous] of resolutionsOf(before, name, catalogs)) {
      const current = afterResolutions.get(key)
      if (current === undefined || sameVersions(previous.versions, current.versions)) continue
      const removed = onlyIn(previous.versions, current.versions)
      const added = onlyIn(current.versions, previous.versions)
      for (const from of removed.length > 0 ? removed : [...previous.versions]) {
        for (const to of added.length > 0 ? added : [...current.versions]) {
          if (from !== to && !isIntended(intended, name, from, to)) warnings.add(moveText(previous.label, name, from, to))
        }
      }
    }
  }
  return [...warnings]
}
