import type { DepKind, NodeId } from '../../src/model.ts'
import type { IssueKind } from '../../src/query/issues.ts'

export type ViewName = 'issues' | 'changes' | 'explore' | 'compare'
export type ExploreMode = 'trail' | 'tree' | 'graph'
export type IssueGrouping = 'package' | 'direct'
export type Selection = { root: string; node: NodeId }

export type UiContext = {
  ref?: string
  root?: string
  selection?: Selection
  view: ViewName
  mode: ExploreMode
  anchor?: Selection
  kinds: DepKind[]
  types: IssueKind[]
  group: IssueGrouping
  duplicatesOnly: boolean
  up: number
  down: number
  base?: string
  mergeBase: boolean
}

export type HistoryMode = 'push' | 'replace'
export type Transition = { context: UiContext; history: HistoryMode }
export type FilterChange = Partial<Pick<UiContext, 'kinds' | 'types' | 'group' | 'duplicatesOnly' | 'up' | 'down'>>

export const DEP_KINDS: readonly DepKind[] = ['prod', 'dev', 'optional', 'peer']
export const ISSUE_KINDS: readonly IssueKind[] = ['vulnerability', 'deprecated', 'outdated']

const VIEW_NAMES: readonly ViewName[] = ['issues', 'changes', 'explore', 'compare']
const EXPLORE_MODES: readonly ExploreMode[] = ['trail', 'tree', 'graph']
const DEFAULT_VIEW: ViewName = 'issues'
const DEFAULT_MODE: ExploreMode = 'trail'
const DEFAULT_UP = 3
const DEFAULT_DOWN = 1
const DEFAULT_GROUP: IssueGrouping = 'package'
const READABLE_ESCAPES = /%(40|2F|3A|2C|28|29)/g

export function canonicalKinds(kinds: Iterable<string>): DepKind[] {
  const requested = new Set(kinds)
  return DEP_KINDS.filter((kind) => requested.has(kind))
}

export function canonicalIssueKinds(kinds: Iterable<string>): IssueKind[] {
  const requested = new Set(kinds)
  return ISSUE_KINDS.filter((kind) => requested.has(kind))
}

function isViewName(value: string | null): value is ViewName {
  return VIEW_NAMES.includes(value as ViewName)
}

function isExploreMode(value: string | null): value is ExploreMode {
  return EXPLORE_MODES.includes(value as ExploreMode)
}

function readIssueKinds(raw: string | null): IssueKind[] {
  const kinds = raw === null ? [] : canonicalIssueKinds(raw.split(','))
  return kinds.length > 0 ? kinds : [...ISSUE_KINDS]
}

function readKinds(raw: string | null): DepKind[] {
  const kinds = raw === null ? [] : canonicalKinds(raw.split(','))
  return kinds.length > 0 ? kinds : [...DEP_KINDS]
}

function nonNegativeInteger(raw: string | null, fallback: number): number {
  if (raw === null || !/^\d+$/.test(raw)) return fallback
  return Number(raw)
}

function nonEmpty(raw: string | null): string | undefined {
  return raw === null || raw === '' ? undefined : raw
}

function assemble(context: UiContext, changes: Partial<Record<keyof UiContext, unknown>>): UiContext {
  const merged: Record<string, unknown> = { ...context, ...changes }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return merged as UiContext
}

function readViewAndMode(params: URLSearchParams): Pick<UiContext, 'view' | 'mode'> {
  const view = params.get('view')
  const mode = params.get('mode')
  if (isExploreMode(view)) return { view: 'explore', mode: isExploreMode(mode) ? mode : view }
  return {
    view: isViewName(view) ? view : DEFAULT_VIEW,
    mode: isExploreMode(mode) ? mode : DEFAULT_MODE,
  }
}

function readSelection(root: string | undefined, selectionRoot: string | undefined, node: string | undefined): Selection | undefined {
  if (node === undefined) return undefined
  const owner = root ?? selectionRoot
  return owner === undefined ? undefined : { root: owner, node }
}

export function readContext(search: string): UiContext {
  const params = new URLSearchParams(search)
  const root = nonEmpty(params.get('root'))
  const context: UiContext = {
    ...readViewAndMode(params),
    kinds: readKinds(params.get('kinds')),
    types: readIssueKinds(params.get('types')),
    group: params.get('group') === 'direct' ? 'direct' : DEFAULT_GROUP,
    duplicatesOnly: params.get('dup') === '1',
    up: nonNegativeInteger(params.get('up'), DEFAULT_UP),
    down: nonNegativeInteger(params.get('down'), DEFAULT_DOWN),
    mergeBase: params.get('mb') === '1',
  }
  const scoped = assemble(context, {
    ref: nonEmpty(params.get('ref')),
    base: nonEmpty(params.get('base')),
    root,
    selection: readSelection(root, nonEmpty(params.get('in')), nonEmpty(params.get('focus'))),
  })
  const anchorNode = nonEmpty(params.get('at'))
  const anchorRoot = exploreRoot(scoped)
  if (anchorNode === undefined || anchorRoot === undefined) return scoped
  return assemble(scoped, { anchor: { root: anchorRoot, node: anchorNode } })
}

export function readableQuery(params: URLSearchParams): string {
  return params.toString().replace(READABLE_ESCAPES, decodeURIComponent)
}

export function writeContext(context: UiContext): string {
  const params = new URLSearchParams()
  if (context.ref) params.set('ref', context.ref)
  if (context.root) params.set('root', context.root)
  if (context.selection && !context.root) params.set('in', context.selection.root)
  if (context.selection) params.set('focus', context.selection.node)
  if (context.view !== DEFAULT_VIEW) params.set('view', context.view)
  if (context.mode !== DEFAULT_MODE) params.set('mode', context.mode)
  if (context.anchor) params.set('at', context.anchor.node)
  const kinds = canonicalKinds(context.kinds)
  if (kinds.length > 0 && kinds.length < DEP_KINDS.length) params.set('kinds', kinds.join(','))
  const types = canonicalIssueKinds(context.types)
  if (types.length > 0 && types.length < ISSUE_KINDS.length) params.set('types', types.join(','))
  if (context.group !== DEFAULT_GROUP) params.set('group', context.group)
  if (context.duplicatesOnly) params.set('dup', '1')
  if (context.up !== DEFAULT_UP) params.set('up', String(context.up))
  if (context.down !== DEFAULT_DOWN) params.set('down', String(context.down))
  if (context.base) params.set('base', context.base)
  if (context.mergeBase) params.set('mb', '1')
  const query = readableQuery(params)
  return query === '' ? '' : `?${query}`
}

export function setCompareBase(context: UiContext, base: string | undefined): Transition {
  return replace(assemble(context, { base }))
}

export function setMergeBase(context: UiContext, mergeBase: boolean): Transition {
  return replace(assemble(context, { mergeBase }))
}

export function exploreRoot(context: UiContext): string | undefined {
  return context.root ?? context.selection?.root
}

export function exploreAnchor(context: UiContext): NodeId | undefined {
  return isAnchorInExploreRoot(context) ? context.anchor?.node : undefined
}

function isSameSelection(left: Selection | undefined, right: Selection | undefined): boolean {
  return left !== undefined && right !== undefined && left.root === right.root && left.node === right.node
}

function push(context: UiContext): Transition {
  return { context, history: 'push' }
}

function replace(context: UiContext): Transition {
  return { context, history: 'replace' }
}

function resetAnchorWhenExploreRootChanges(before: UiContext, after: UiContext): UiContext {
  if (exploreRoot(before) === exploreRoot(after)) return after
  return assemble(after, { anchor: after.selection })
}

function moveTo(context: UiContext, changes: Partial<Record<keyof UiContext, unknown>>): UiContext {
  return resetAnchorWhenExploreRootChanges(context, assemble(context, changes))
}

function anchorOnSelectionInExplore(context: UiContext): UiContext {
  return context.view === 'explore' ? assemble(context, { anchor: context.selection }) : context
}

export function setScope(context: UiContext, root: string | undefined): Transition {
  const selection = context.selection && { root: root ?? context.selection.root, node: context.selection.node }
  return push(moveTo(context, { root, selection }))
}

export function openInRoot(context: UiContext, selection: Selection): Transition {
  const root = context.root === undefined ? undefined : selection.root
  return push(anchorOnSelectionInExplore(moveTo(context, { root, selection })))
}

export function selectPackage(context: UiContext, selection: Selection): Transition {
  if (context.root !== undefined && context.root !== selection.root) return openInRoot(context, selection)
  return push(anchorOnSelectionInExplore(moveTo(context, { selection })))
}

export function selectInExplore(context: UiContext, selection: Selection): Transition {
  return push(moveTo(context, { selection }))
}

export function followSelectionTo(context: UiContext, selection: Selection): Transition {
  const selected = selectPackage(context, selection).context
  const anchor = isSameSelection(context.anchor, context.selection) ? selection : selected.anchor
  return replace(assemble(selected, { anchor }))
}

export function openWorkspacePackage(context: UiContext, selection: Selection): Transition {
  return push(anchorOnSelectionInExplore(moveTo(context, { root: selection.root, selection })))
}

export function pickSearchOption(context: UiContext, selection: Selection): Transition & { switchedTo?: string } {
  const isOutsideScope = context.root !== undefined && context.root !== selection.root
  if (!isOutsideScope) return selectPackage(context, selection)
  return { ...openInRoot(context, selection), switchedTo: selection.root }
}

function reRooted(selection: Selection | undefined, root: string): Selection | undefined {
  return selection && { root, node: selection.node }
}

export function openRootIssues(context: UiContext, root: string, kind: IssueKind): Transition {
  const selection = reRooted(context.selection, root)
  return push(moveTo(context, { root, selection, view: 'issues', types: [kind] }))
}

export function openRootChanges(context: UiContext, root: string): Transition {
  const selection = reRooted(context.selection, root)
  return push(moveTo(context, { root, selection, view: 'changes' }))
}

function openExplore(context: UiContext, mode: ExploreMode): Transition {
  return push(assemble(context, { view: 'explore', mode, anchor: context.selection }))
}

export function openTrail(context: UiContext): Transition {
  return openExplore(context, 'trail')
}

export function openTree(context: UiContext): Transition {
  return openExplore(context, 'tree')
}

export function clearSelection(context: UiContext): Transition {
  return push(assemble(context, { selection: undefined }))
}

function isAnchorInExploreRoot(context: UiContext): boolean {
  return context.anchor !== undefined && context.anchor.root === exploreRoot(context)
}

export function setView(context: UiContext, view: ViewName): Transition {
  const entersExplore = view === 'explore' && context.view !== 'explore'
  const anchor = entersExplore ? context.selection : context.anchor
  return replace(assemble(context, { view, anchor }))
}

export function setMode(context: UiContext, mode: ExploreMode): Transition {
  return replace(assemble(context, { mode }))
}

export function focusOn(context: UiContext): Transition {
  if (context.selection === undefined) return push(context)
  return push(assemble(context, { anchor: context.selection }))
}

export function setFilters(context: UiContext, change: FilterChange): Transition {
  return replace(assemble(context, change))
}

export function orderByScope<T extends { rootId: string }>(options: readonly T[], root: string | undefined): T[] {
  if (root === undefined) return [...options]
  const inScope = options.filter((option) => option.rootId === root)
  const elsewhere = options.filter((option) => option.rootId !== root)
  return [...inScope, ...elsewhere]
}

type RootHit = { rootId: string }
type VersionHit<R extends RootHit> = { roots: R[] }
type NameHit<R extends RootHit, V extends VersionHit<R>> = { versions: V[] }

function hasRoot(roots: readonly RootHit[], root: string): boolean {
  return roots.some((candidate) => candidate.rootId === root)
}

export function orderHitsByScope<R extends RootHit, V extends VersionHit<R>, H extends NameHit<R, V>>(
  hits: readonly H[],
  root: string | undefined,
): H[] {
  if (root === undefined) return [...hits]
  const withScopedRoots = hits.map((hit) => {
    const versions = hit.versions.map((version) => ({ ...version, roots: orderByScope(version.roots, root) }))
    return { ...hit, versions: [...versions.filter((v) => hasRoot(v.roots, root)), ...versions.filter((v) => !hasRoot(v.roots, root))] }
  })
  const inScope = withScopedRoots.filter((hit) => hit.versions.some((version) => hasRoot(version.roots, root)))
  const elsewhere = withScopedRoots.filter((hit) => !inScope.includes(hit))
  return [...inScope, ...elsewhere]
}
