import type { SourceKind } from '../../src/model.ts'
import { hasChanges, type CompareNote, type CompareResponse, type RootComparison } from '../../src/query/compare-shape.ts'
import { shortCommit, shortRef, WORKING_KEY } from './source.ts'
import { countLabel } from './labels.ts'
import { mergeBaseText, WORKING_TREE } from './vocabulary.ts'

export const COMPARE_ROW_LIMIT = 100

export type SideLabels = { base: string; target: string }

const HEAD_REF = 'HEAD'
const WORKING_TREE_IN_SENTENCE = 'the working tree'
const INEXACT_SOURCE_TEXT: Partial<Record<SourceKind, string>> = {
  'manifest-only': 'package.json manifests only',
  'resolved-today': 'versions resolved today',
}
const CHANGED_KINDS = new Set(['upgraded', 'downgraded', 'changed'])

function inSentence(label: string): string {
  return label === WORKING_TREE ? WORKING_TREE_IN_SENTENCE : label
}

function sideLabel(side: CompareNote['side'], labels: SideLabels): string {
  return side === 'base' ? labels.base : labels.target
}

export function rootsInScope(response: CompareResponse, scope: string | undefined): RootComparison[] {
  return response.roots.filter((root) => hasChanges(root) && (scope === undefined || root.rootId === scope))
}

export function compareSummary(roots: readonly RootComparison[], labels: SideLabels): string {
  if (roots.length === 0) return `No dependency changes between ${inSentence(labels.base)} and ${inSentence(labels.target)}.`
  const versions = roots.flatMap((root) => root.versions)
  const vulnerabilities = roots.flatMap((root) => root.risk).filter((risk) => risk.issue === 'vulnerability')
  const versionParts = [
    [versions.filter((version) => version.change === 'added').length, 'added'],
    [versions.filter((version) => version.change === 'removed').length, 'removed'],
    [versions.filter((version) => CHANGED_KINDS.has(version.change)).length, 'changed'],
  ] as const
  const introduced = vulnerabilities.filter((risk) => risk.change === 'introduced').length
  const resolved = vulnerabilities.filter((risk) => risk.change === 'resolved').length
  const groups = [
    countLabel(roots.length, 'root changed', 'roots changed'),
    versionParts
      .filter(([amount]) => amount > 0)
      .map(([amount, word]) => countLabel(amount, word, word))
      .join(', '),
    introduced > 0 ? countLabel(introduced, 'vulnerable version introduced', 'vulnerable versions introduced') : '',
    resolved > 0 ? countLabel(resolved, 'resolved', 'resolved') : '',
  ]
  return groups.filter((group) => group !== '').join(' · ')
}

export function compareNoteText(note: CompareNote, labels: SideLabels): string {
  const label = sideLabel(note.side, labels)
  if (note.kind === 'failed') return `${label} failed to scan this root: ${note.error}`
  if (note.kind === 'submodule') return `Not compared: this root is inside a git submodule, and ${inSentence(label)} does not read submodules.`
  return `Package versions are not compared: ${inSentence(label)} builds this root from ${INEXACT_SOURCE_TEXT[note.source] ?? note.source}.`
}

export function presenceText(presence: RootComparison['presence'], labels: SideLabels): string | undefined {
  if (presence === 'both') return undefined
  return `Only in ${inSentence(presence === 'base-only' ? labels.base : labels.target)}`
}

export function baseLabel(base: string, mergeBase: { commit: string } | undefined): string {
  if (mergeBase !== undefined) return mergeBaseText(shortCommit(mergeBase.commit))
  if (base === WORKING_KEY) return WORKING_TREE
  return base === HEAD_REF ? HEAD_REF : shortRef(base)
}
