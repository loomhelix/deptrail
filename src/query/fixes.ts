import semver from 'semver'
import type { NodeId } from '../model.ts'

export type FixKind = 'within-range' | 'bump-manifest' | 'bump-parent' | 'no-fix' | 'unknown'

export type EdgeFix = { kind: FixKind; version?: string }

export type NodeFix = {
  kind: 'relock' | 'partial' | 'bump' | 'no-fix' | 'unknown'
  version?: string
  bump: { nodeId: NodeId; isImporter: boolean }[]
  bumpTruncated: number
}

export const BUMP_LIST_CAP = 20

type EdgeFixInput = { current: string; range: string | undefined; parentIsImporter: boolean; safe: readonly string[] | undefined }

type ParentFix = { parent: NodeId; parentIsImporter: boolean; fix: EdgeFix }

function highestSafeWithinRange(safe: readonly string[], range: string | undefined): string | undefined {
  if (range === undefined || semver.validRange(range) === null) return undefined
  return semver.maxSatisfying(safe, range) ?? undefined
}

function lowestSafeAbove(safe: readonly string[], current: string): string | undefined {
  if (semver.valid(current) === null) return undefined
  return safe.find((version) => semver.gt(version, current))
}

export function edgeFix({ current, range, parentIsImporter, safe }: EdgeFixInput): EdgeFix {
  if (safe === undefined) return { kind: 'unknown' }
  if (safe.length === 0) return { kind: 'no-fix' }
  const withinRange = highestSafeWithinRange(safe, range)
  if (withinRange !== undefined) return { kind: 'within-range', version: withinRange }
  if (!parentIsImporter) return { kind: 'bump-parent' }
  const raised = lowestSafeAbove(safe, current)
  return raised === undefined ? { kind: 'no-fix' } : { kind: 'bump-manifest', version: raised }
}

function sharedVersion(edges: readonly ParentFix[]): string | undefined {
  const versions = new Set(edges.map((edge) => edge.fix.version))
  return versions.size === 1 ? [...versions][0] : undefined
}

function bumpTargets(edges: readonly ParentFix[]): { nodeId: NodeId; isImporter: boolean }[] {
  return edges
    .filter((edge) => edge.fix.kind === 'bump-manifest' || edge.fix.kind === 'bump-parent')
    .map((edge) => ({ nodeId: edge.parent, isImporter: edge.parentIsImporter }))
}

function hasBumpTarget(edges: readonly ParentFix[]): boolean {
  return edges.some((edge) => edge.fix.kind === 'bump-manifest' || edge.fix.kind === 'bump-parent')
}

function nodeFixKind(edges: readonly ParentFix[]): NodeFix['kind'] {
  const withinRangeCount = edges.filter((edge) => edge.fix.kind === 'within-range').length
  if (withinRangeCount === edges.length) return 'relock'
  if (withinRangeCount > 0) return 'partial'
  if (edges.every((edge) => edge.fix.kind === 'no-fix')) return 'no-fix'
  return hasBumpTarget(edges) ? 'bump' : 'unknown'
}

export function combineFixes(edges: readonly ParentFix[]): NodeFix {
  if (edges.length === 0) return { kind: 'unknown', bump: [], bumpTruncated: 0 }
  const kind = nodeFixKind(edges)
  const targets = bumpTargets(edges)
  const version = kind === 'relock' ? sharedVersion(edges) : undefined
  return {
    kind,
    ...(version === undefined ? {} : { version }),
    bump: targets.slice(0, BUMP_LIST_CAP),
    bumpTruncated: Math.max(0, targets.length - BUMP_LIST_CAP)
  }
}
