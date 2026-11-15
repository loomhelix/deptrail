import type { ChangeItem, ChangesResponse, Step } from '../../src/actions/types.ts'
import type { NodeId } from '../../src/model.ts'
import type { OutdatedLevel } from '../../src/query/versions.ts'
import type { ChildrenResult, RootSummary, SearchHit } from './api.ts'

export type ChangeStep = 'changes' | 'preview' | 'apply' | 'applied'
export type PrimaryAction = 'preview' | 'apply' | 'preview-again'
export type EditLookup = { kind: 'version'; name: string; version: string } | { kind: 'direct'; name: string; importer: NodeId }

type VersionCore = readonly [major: number, minor: number, patch: number]

export const UNDO_WINDOW_MS = 10_000

const VERSION_CORE_PATTERN = /(\d+)\.(\d+)\.(\d+)/
const NODE_VERSION_SEPARATOR = '@'

function hasWork(root: RootSummary): boolean {
  const { changeCount, job, revertable } = root.actions
  return changeCount > 0 || job?.state === 'running' || revertable
}

export function sectionRoots(roots: readonly RootSummary[], scope: string | undefined): string[] {
  if (scope !== undefined) return roots.filter((root) => root.id === scope).map((root) => root.id)
  return roots.filter(hasWork).map((root) => root.id)
}

export function changeStep(changes: ChangesResponse): ChangeStep {
  const { items, preview, job } = changes
  if (items.length === 0) return job?.kind === 'apply' && job.state === 'done' ? 'applied' : 'changes'
  if (preview === undefined) return 'changes'
  return preview.stale ? 'preview' : 'apply'
}

export function primaryAction(changes: ChangesResponse): PrimaryAction | undefined {
  if (changes.items.length === 0) return undefined
  const preview = changes.preview
  if (preview === undefined) return 'preview'
  return preview.stale ? 'preview-again' : 'apply'
}

function relockOf(steps: readonly Step[], name: string): Extract<Step, { kind: 'relock' }> | undefined {
  return steps.find((step): step is Extract<Step, { kind: 'relock' }> => step.kind === 'relock' && step.name === name)
}

export function editLookup(item: ChangeItem): EditLookup | undefined {
  const { goal } = item
  if (goal.kind === 'fix') return { kind: 'version', name: goal.name, version: goal.version }
  const [importer] = goal.importers
  if (importer !== undefined) return { kind: 'direct', name: goal.name, importer }
  const relock = relockOf(item.steps, goal.name)
  return relock === undefined ? undefined : { kind: 'version', name: goal.name, version: relock.from }
}

export function nodeInRoot(hits: readonly SearchHit[], root: string, name: string, version: string): NodeId | undefined {
  const entry = hits.find((hit) => hit.name === name)?.versions.find((candidate) => candidate.version === version)
  const nodes = (entry?.roots ?? []).filter((candidate) => candidate.rootId === root).map((candidate) => candidate.nodeId)
  const plainNode = `${name}${NODE_VERSION_SEPARATOR}${version}`
  return nodes.includes(plainNode) ? plainNode : nodes[0]
}

export function directDependencyNode(rows: readonly ChildrenResult['rows'][number][], name: string): NodeId | undefined {
  const matching = rows.filter((row) => row.node.name === name && !row.node.isImporter)
  return (matching.find((row) => row.kind !== 'peer') ?? matching[0])?.node.id
}

function versionCore(text: string): VersionCore | undefined {
  const match = VERSION_CORE_PATTERN.exec(text)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function currentVersionText(item: ChangeItem, name: string): string | undefined {
  const relock = relockOf(item.steps, name)
  if (relock !== undefined) return relock.from
  const setRange = item.steps.find((step) => step.kind === 'set-range')
  return setRange?.kind === 'set-range' ? setRange.from : undefined
}

function sizeBetween(current: VersionCore, target: VersionCore): OutdatedLevel | undefined {
  const [currentMajor, currentMinor, currentPatch] = current
  const [targetMajor, targetMinor, targetPatch] = target
  if (targetMajor !== currentMajor) return targetMajor > currentMajor ? 'major' : undefined
  if (targetMinor !== currentMinor) return targetMinor > currentMinor ? 'minor' : undefined
  return targetPatch > currentPatch ? 'patch' : undefined
}

export function updateSize(item: ChangeItem): OutdatedLevel | undefined {
  const { goal } = item
  if (goal.kind !== 'update') return undefined
  const currentText = currentVersionText(item, goal.name)
  const current = currentText === undefined ? undefined : versionCore(currentText)
  const target = versionCore(goal.target)
  return current === undefined || target === undefined ? undefined : sizeBetween(current, target)
}
