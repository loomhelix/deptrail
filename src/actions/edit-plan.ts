import { parse } from 'yaml'
import semver from 'semver'
import type { NodeId, RootGraph } from '../model.ts'
import { setJsonString } from './json-edit.ts'
import { fieldOf, importerLabel } from './labels.ts'
import { findNode } from '../query/lookup.ts'
import type { ChangeItem, Goal, OverrideStep, OverridesFile, PackageManagerName, RelockStep, SetRangeStep, Step } from './types.ts'
import { setWorkspaceString } from './workspace-edit.ts'

export const ROOT_MANIFEST = 'package.json'
export const WORKSPACE_FILE = 'pnpm-workspace.yaml'

const IMPORTER_ID_PREFIX = 'importer:'
const ROOT_IMPORTER_PATH = '.'
const DEFAULT_CATALOG = 'default'

export class EditError extends Error {}

export function manifestPathOf(importer: NodeId): string {
  const path = importer.startsWith(IMPORTER_ID_PREFIX) ? importer.slice(IMPORTER_ID_PREFIX.length) : importer
  return path === ROOT_IMPORTER_PATH ? ROOT_MANIFEST : `${path}/package.json`
}

export function overridesFilePath(file: OverridesFile): string {
  return file === 'pnpm-workspace.yaml' ? WORKSPACE_FILE : ROOT_MANIFEST
}

function pathOfStep(step: Step): string | undefined {
  if (step.kind === 'relock') return undefined
  if (step.kind === 'override') return overridesFilePath(step.file)
  return step.place === 'catalog' ? WORKSPACE_FILE : manifestPathOf(step.importer)
}

export function stepPaths(steps: readonly Step[]): string[] {
  const paths = new Set<string>()
  for (const step of steps) {
    const path = pathOfStep(step)
    if (path !== undefined) paths.add(path)
  }
  return [...paths]
}

function stepKey(step: Step): string {
  const { reason: _reason, ...rest } = step
  return JSON.stringify(rest)
}

function hasDefaultCatalogEntry(text: string | null, dependency: string): boolean {
  if (text === null) return false
  const document: unknown = parse(text)
  if (typeof document !== 'object' || document === null) return false
  const catalogs = (document as { catalogs?: unknown }).catalogs
  if (typeof catalogs !== 'object' || catalogs === null) return false
  const entries = (catalogs as Record<string, unknown>)[DEFAULT_CATALOG]
  return typeof entries === 'object' && entries !== null && dependency in entries
}

function catalogPath(step: SetRangeStep, text: string | null): string[] {
  if (step.catalog !== undefined) return ['catalogs', step.catalog, step.dependency]
  if (hasDefaultCatalogEntry(text, step.dependency)) return ['catalogs', DEFAULT_CATALOG, step.dependency]
  return ['catalog', step.dependency]
}

function overridePath(step: OverrideStep): string[] {
  if (step.file === 'package.json#pnpm.overrides') return ['pnpm', 'overrides', step.selector]
  return ['overrides', step.selector]
}

function applyOne(path: string, text: string | null, step: SetRangeStep | OverrideStep): string {
  if (path === WORKSPACE_FILE) {
    const target = step.kind === 'override' ? ['overrides', step.selector] : catalogPath(step, text)
    return setWorkspaceString(text, target, step.kind === 'override' ? step.value : step.to)
  }
  if (text === null) throw new EditError(`${path} is missing`)
  const target = step.kind === 'override' ? overridePath(step) : [step.field, step.dependency]
  return setJsonString(text, target, step.kind === 'override' ? step.value : step.to)
}

export function applySteps(texts: ReadonlyMap<string, string | null>, steps: readonly Step[]): Map<string, string> {
  const current = new Map(texts)
  const changed = new Map<string, string>()
  const applied = new Set<string>()
  for (const step of steps) {
    if (step.kind === 'relock') continue
    const key = stepKey(step)
    if (applied.has(key)) continue
    applied.add(key)
    const path = pathOfStep(step) as string
    const next = applyOne(path, current.get(path) ?? null, step)
    current.set(path, next)
    changed.set(path, next)
  }
  return changed
}

function pinnedImporterSteps(root: RootGraph, relock: RelockStep): SetRangeStep[] {
  const steps: SetRangeStep[] = []
  for (const importer of root.importers) {
    for (const edge of importer.deps) {
      const field = fieldOf(edge.kind)
      const node = findNode(root, edge.to)
      if (field === undefined || node === undefined || node.name !== relock.name) continue
      if (!('version' in node) || node.version !== relock.from) continue
      if (semver.validRange(edge.range) === null || !semver.satisfies(relock.from, edge.range)) continue
      steps.push({
        kind: 'set-range',
        importer: importer.id,
        dependency: relock.name,
        field,
        place: 'manifest',
        from: edge.range,
        to: relock.to,
        reason: `npm rejects an override that changes a direct dependency of ${importerLabel(importer.id)}`,
      })
    }
  }
  return steps
}

export function relockPins(root: RootGraph, manager: PackageManagerName, relocks: readonly RelockStep[], file: OverridesFile): Step[] {
  const steps: Step[] = []
  for (const relock of relocks) {
    steps.push({ kind: 'override', selector: `${relock.name}@${relock.from}`, value: relock.to, file, reason: relock.reason })
    if (manager === 'npm') steps.push(...pinnedImporterSteps(root, relock))
  }
  return steps
}

export function sameGoal(left: Goal, right: Goal): boolean {
  if (left.kind === 'fix' && right.kind === 'fix') return left.name === right.name && left.version === right.version
  if (left.kind === 'update' && right.kind === 'update') return left.name === right.name
  return false
}

type Conflict = { item: ChangeItem; reason: string }

function setTarget(step: SetRangeStep): string {
  return step.place === 'catalog' ? `catalog:${step.catalog ?? DEFAULT_CATALOG}` : step.importer
}

function setLocation(step: SetRangeStep): string {
  return step.place === 'catalog' ? `the ${step.catalog ?? DEFAULT_CATALOG} catalog` : importerLabel(step.importer)
}

export function selectorParts(selector: string): { name: string; range?: string } {
  const separator = selector.lastIndexOf('@')
  if (separator <= 0) return { name: selector.split('>').pop() as string }
  return { name: selector.slice(0, separator).split('>').pop() as string, range: selector.slice(separator + 1) }
}

function selectorMatchesRelock(step: OverrideStep, relock: RelockStep): boolean {
  const { name, range } = selectorParts(step.selector)
  return name === relock.name && range !== undefined && semver.validRange(range) !== null && semver.satisfies(relock.from, range)
}

function stepConflict(first: Step, second: Step): string | undefined {
  if (first.kind === 'set-range' && second.kind === 'set-range') {
    const same = setTarget(first) === setTarget(second) && first.dependency === second.dependency
    return same && first.to !== second.to ? `both set ${first.dependency} in ${setLocation(first)}` : undefined
  }
  if (first.kind === 'override' && second.kind === 'override') {
    return first.selector === second.selector && first.value !== second.value ? `both override ${first.selector}` : undefined
  }
  if (first.kind === 'relock' && second.kind === 'relock') {
    return first.name === second.name && first.from === second.from && first.to !== second.to ? `both re-lock ${first.name} ${first.from}` : undefined
  }
  const [overrideStep, relockStep] = first.kind === 'override' ? [first, second] : [second, first]
  if (overrideStep.kind === 'override' && relockStep.kind === 'relock' && selectorMatchesRelock(overrideStep, relockStep)) {
    return `the override ${overrideStep.selector} also matches the re-lock of ${relockStep.name} ${relockStep.from}`
  }
  return undefined
}

export function findConflict(items: readonly ChangeItem[], candidate: ChangeItem): Conflict | undefined {
  for (const item of items) {
    for (const existing of item.steps) {
      for (const proposed of candidate.steps) {
        const reason = stepConflict(existing, proposed)
        if (reason !== undefined) return { item, reason }
      }
    }
  }
  return undefined
}
