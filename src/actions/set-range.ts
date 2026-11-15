import type { NodeId, RootGraph } from '../model.ts'
import { findNode } from '../query/lookup.ts'
import { importerLabel } from './labels.ts'
import { catalogNameOf, rewriteRange } from './range-style.ts'
import type { DependencyField, SetRangeStep } from './types.ts'

export type SetRangeInput = { importer: NodeId; field: DependencyField; dependency: string; specifier: string; target: string; reason: string }
export type SetRangeResult = { step: SetRangeStep } | { unavailable: string }

const DEFAULT_CATALOG = 'default'

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function formNote(from: string, formChanged: boolean): string {
  return formChanged ? ` (the range form changes from ${from})` : ''
}

function catalogUsers(root: RootGraph, catalog: string, dependency: string): string[] {
  return root.importers
    .filter((importer) => importer.deps.some((edge) => catalogNameOf(edge.range) === catalog && findNode(root, edge.to)?.name === dependency))
    .sort((left, right) => compareText(left.path, right.path))
    .map((importer) => importerLabel(importer.id))
}

function manifestStep(input: SetRangeInput): SetRangeResult {
  const rewritten = rewriteRange(input.specifier, input.target)
  if (!rewritten.editable) return { unavailable: `${importerLabel(input.importer)}: ${rewritten.reason}` }
  return {
    step: {
      kind: 'set-range',
      importer: input.importer,
      dependency: input.dependency,
      field: input.field,
      place: 'manifest',
      from: input.specifier,
      to: rewritten.specifier,
      reason: `${input.reason}${formNote(input.specifier, rewritten.formChanged)}`,
    },
  }
}

function catalogStep(root: RootGraph, input: SetRangeInput, catalog: string): SetRangeResult {
  const entry = root.config?.catalogs[catalog]?.[input.dependency]
  if (entry === undefined) return { unavailable: `${importerLabel(input.importer)}: the ${catalog} catalog has no entry for ${input.dependency}` }
  const rewritten = rewriteRange(entry, input.target)
  if (!rewritten.editable) return { unavailable: `${importerLabel(input.importer)}: ${rewritten.reason}` }
  const users = catalogUsers(root, catalog, input.dependency).join(', ')
  return {
    step: {
      kind: 'set-range',
      importer: input.importer,
      dependency: input.dependency,
      field: input.field,
      place: 'catalog',
      ...(catalog === DEFAULT_CATALOG ? {} : { catalog }),
      from: entry,
      to: rewritten.specifier,
      reason: `${input.reason} (catalog entry used by ${users})${formNote(entry, rewritten.formChanged)}`,
    },
  }
}

export function setRangeStep(root: RootGraph, input: SetRangeInput): SetRangeResult {
  const catalog = catalogNameOf(input.specifier)
  return catalog === undefined ? manifestStep(input) : catalogStep(root, input, catalog)
}
