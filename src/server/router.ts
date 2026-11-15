import { ActionError } from '../actions/action-error.ts'
import { disabledActions, type ActionService } from '../actions/action-service.ts'
import { isObjectId } from '../git/git-commands.ts'
import { compareSources, type CompareSide } from '../query/compare.ts'
import { BranchError, COMMIT_ACTIONS_REASON, COMMIT_RESOLVE_REASON, type Branches, type GitInfo, type OpenSourceRequest } from './branches.ts'
import type { ActionsSummary, AddChangeRequest } from '../actions/types.ts'
import { PLACEHOLDER_PREFIX, type DepKind, type Manager, type NodeId, type RootGraph, type RootStatus, type SourceKind } from '../model.ts'
import { decodeRootSegment } from './root-segment.ts'
import type { EnrichmentService } from '../enrich/enrichment-service.ts'
import type { EnrichmentStatus } from '../enrich/types.ts'
import { children } from '../query/children.ts'
import { decorations, issueCounts, type IssueCounts, type NodeDecoration } from '../query/decorations.ts'
import { dependents } from '../query/dependents.ts'
import { duplicates } from '../query/duplicates.ts'
import { issuesByDirect, issuesByPackage, type DirectGroup, type IssueRow } from '../query/issues.ts'
import { ALL_KINDS, findNode, UnknownNodeError, type KindFilter } from '../query/lookup.ts'
import { packageInsight } from '../query/package-insight.ts'
import { search } from '../query/search.ts'
import { subgraph } from '../query/subgraph.ts'
import type { ScanSession } from '../scan/scan-session.ts'
import type { ErrorLog } from './error-log.ts'

export type ApiContext = { session: ScanSession; enrichment: EnrichmentService; actions: ActionService; branches?: Branches; resolveUnavailable?: string }

export type RootSummary = {
  id: string
  path: string
  manager: Manager
  source: SourceKind
  status: RootStatus
  error?: string
  warnings: string[]
  importers: { id: NodeId; path: string; name: string; dependencyCount: number }[]
  packageCount: number
  duplicateCount: number
  hasAuth: boolean
  issueCounts?: IssueCounts
  actions: ActionsSummary
}

export type ScanSummary = { repoPath: string; scannedAt: string; roots: RootSummary[]; enrichment: EnrichmentStatus }

export type DecorationsResponse = { revision: number; nodes: Record<NodeId, NodeDecoration> }
export type IssueRowsResponse = { revision: number; rows: IssueRow[] }
export type IssueGroupsResponse = { revision: number; groups: DirectGroup[] }

export type ApiResponse = { status: number; body: unknown }

export type ApiRequest = { method: string; pathname: string; searchParams: URLSearchParams; body?: unknown }

const DEFAULT_DEPTH = 1
const DEFAULT_UP = 3
const DEFAULT_DOWN = 1
const DEFAULT_LIMIT = 300
const DEFAULT_GROUP_BY = 'package'

type GroupBy = 'package' | 'direct'
type RootLookup = { root: RootGraph; failure?: undefined } | { root?: undefined; failure: ApiResponse }

export class BadRequestError extends Error {}

function reply(status: number, body: unknown): ApiResponse {
  return { status, body }
}

function failure(status: number, message: string): ApiResponse {
  return reply(status, { error: message })
}

function importerSummaries(root: RootGraph): RootSummary['importers'] {
  return root.importers.map(({ id, path, name, deps }) => ({ id, path, name, dependencyCount: deps.length }))
}

function summarizeRoot({ session, enrichment, actions }: ApiContext, root: RootGraph): RootSummary {
  const summary: RootSummary = {
    id: root.id,
    path: root.path,
    manager: root.manager,
    source: root.source,
    status: root.status,
    warnings: root.warnings,
    importers: importerSummaries(root),
    packageCount: [...root.packages.keys()].filter((id) => !id.startsWith(PLACEHOLDER_PREFIX)).length,
    duplicateCount: duplicates(session.index, root.id).length,
    hasAuth: root.config?.hasAuth ?? false,
    actions: actions.summary(root),
  }
  if (root.error !== undefined) summary.error = root.error
  if (root.status === 'ready') summary.issueCounts = issueCounts(enrichment, root)
  return summary
}

function anyRootScanning(roots: readonly RootGraph[]): boolean {
  return roots.some((root) => root.status === 'scanning')
}

export function summarizeScan(context: ApiContext): ScanSummary {
  const { repoPath, scannedAt, roots } = context.session.scan
  return {
    repoPath,
    scannedAt,
    roots: roots.map((root) => summarizeRoot(context, root)),
    enrichment: context.enrichment.status(anyRootScanning(roots)),
  }
}

function readyRoot(session: ScanSession, rootId: string): RootLookup {
  const root = session.root(rootId)
  if (!root) return { failure: failure(404, `Unknown root ${rootId}`) }
  if (root.status !== 'ready') return { failure: failure(409, `Root ${rootId} is ${root.status}`) }
  return { root }
}

function integerParam(params: URLSearchParams, name: string, fallback: number, minimum: number): number {
  const raw = params.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value) || value < minimum) {
    throw new BadRequestError(`Invalid ${name}: expected an integer >= ${minimum}`)
  }
  return value
}

function kindsParam(params: URLSearchParams): KindFilter {
  const raw = params.get('kinds')
  if (raw === null) return ALL_KINDS
  const requested = raw.split(',')
  for (const kind of requested) {
    if (!ALL_KINDS.has(kind as DepKind)) throw new BadRequestError(`Unknown kind: ${kind}`)
  }
  return new Set(requested as DepKind[])
}

function groupByParam(params: URLSearchParams): GroupBy {
  const raw = params.get('groupBy') ?? DEFAULT_GROUP_BY
  if (raw !== 'package' && raw !== 'direct') throw new BadRequestError('Invalid groupBy: expected package or direct')
  return raw
}

function monolithVersionsOf(session: ScanSession, root: RootGraph, nodeId: NodeId): string[] {
  const node = findNode(root, nodeId)
  if (!node) return []
  return [...new Set((session.index.get(node.name) ?? []).map((entry) => entry.version))]
}

type NodeHandler = (context: ApiContext, root: RootGraph, nodeId: NodeId, params: URLSearchParams) => unknown | Promise<unknown>

const NODE_HANDLERS: ReadonlyMap<string, NodeHandler> = new Map<string, NodeHandler>(Object.entries({
  actions: ({ actions }, root, nodeId, params) => actions.nodeActions(root.id, nodeId, kindsParam(params)),
  children: (_context, root, nodeId, params) => children(root, nodeId, integerParam(params, 'depth', DEFAULT_DEPTH, 0), kindsParam(params)),
  dependents: (_context, root, nodeId, params) => dependents(root, nodeId, integerParam(params, 'depth', DEFAULT_DEPTH, 0), kindsParam(params)),
  subgraph: (_context, root, nodeId, params) =>
    subgraph(root, nodeId, {
      up: integerParam(params, 'up', DEFAULT_UP, 0),
      down: integerParam(params, 'down', DEFAULT_DOWN, 0),
      limit: integerParam(params, 'limit', DEFAULT_LIMIT, 1),
      kinds: kindsParam(params),
    }),
  insight: ({ session, enrichment }, root, nodeId, params) =>
    packageInsight(enrichment, root, nodeId, kindsParam(params), monolithVersionsOf(session, root, nodeId)),
}))

function runDetached(work: Promise<void>, logError: ErrorLog, context: string): void {
  work.catch((failure: unknown) => logError(context, failure))
}

function rootSegmentPosition(raw: readonly string[]): number {
  if (raw[1] === 'roots') return 2
  if (raw[1] === 'commits' && raw[3] === 'roots') return 4
  return -1
}

function decodeSegments(pathname: string): string[] | null {
  try {
    const raw = pathname.split('/').slice(1)
    const rootPosition = rootSegmentPosition(raw)
    return raw.map((segment, position) =>
      position === rootPosition ? decodeRootSegment(segment) : decodeURIComponent(segment),
    )
  } catch {
    return null
  }
}

async function handleNodeRoute(context: ApiContext, request: ApiRequest, rootId: string, nodeId: string, action: string): Promise<ApiResponse> {
  const handler = NODE_HANDLERS.get(action)
  if (!handler) return failure(404, 'Not found')
  if (request.method !== 'GET') return failure(405, 'Method not allowed')
  const lookup = readyRoot(context.session, rootId)
  if (lookup.failure) return lookup.failure
  return reply(200, await handler(context, lookup.root, nodeId, request.searchParams))
}

function handleDecorations(context: ApiContext, request: ApiRequest, rootId: string): ApiResponse {
  if (request.method !== 'GET') return failure(405, 'Method not allowed')
  const lookup = readyRoot(context.session, rootId)
  if (lookup.failure) return lookup.failure
  const { enrichment } = context
  const body: DecorationsResponse = { revision: enrichment.revision, nodes: decorations(enrichment, lookup.root, kindsParam(request.searchParams)) }
  return reply(200, body)
}

function invalidBody(expected: string): BadRequestError {
  return new BadRequestError(`Invalid body: expected ${expected}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

const ADD_CHANGE_SHAPE = '{ nodeId: string, choice: string, version?: string, importers?: string[], kinds?: string[] }'
const KINDS_SHAPE = '{ kinds?: string[] }'
const INVALID_KINDS = 'Invalid kinds'
const APPLY_SHAPE = '{ previewId: string, install: boolean }'

function addChangeBody(body: unknown): AddChangeRequest {
  if (
    !isRecord(body) ||
    !isString(body.nodeId) ||
    !isString(body.choice) ||
    !isOptional(body.version, isString) ||
    !isOptional(body.importers, isStringArray) ||
    !isOptional(body.kinds, isStringArray)
  ) {
    throw invalidBody(ADD_CHANGE_SHAPE)
  }
  return body as AddChangeRequest
}

function kindsBody(body: unknown): KindFilter {
  if (body === undefined) return ALL_KINDS
  if (!isRecord(body) || !isOptional(body.kinds, isStringArray)) throw invalidBody(KINDS_SHAPE)
  if (body.kinds === undefined) return ALL_KINDS
  if ((body.kinds as string[]).length === 0) throw new BadRequestError(INVALID_KINDS)
  for (const kind of body.kinds as string[]) {
    if (!ALL_KINDS.has(kind as DepKind)) throw new BadRequestError(`Unknown kind: ${kind}`)
  }
  return new Set(body.kinds as DepKind[])
}

function applyBody(body: unknown): { previewId: string; install: boolean } {
  if (!isRecord(body) || !isString(body.previewId) || typeof body.install !== 'boolean') throw invalidBody(APPLY_SHAPE)
  return { previewId: body.previewId, install: body.install }
}

function fileIndex(segment: string): number {
  const value = Number(segment)
  if (segment.trim() === '' || !Number.isInteger(value) || value < 0) throw new BadRequestError('Invalid index: expected an integer >= 0')
  return value
}

function onlyMethod(request: ApiRequest, method: string): void {
  if (request.method !== method) throw new MethodNotAllowedError()
}

class MethodNotAllowedError extends Error {}

function unknownRoot(rootId: string): ApiResponse {
  return failure(404, `Unknown root ${rootId}`)
}

async function handleChangesRoute(context: ApiContext, request: ApiRequest, rootId: string, rest: string[]): Promise<ApiResponse> {
  const { actions } = context
  if (rest.length === 1) {
    if (request.method === 'GET') return reply(200, await actions.changes(rootId))
    if (request.method === 'POST') return reply(201, await actions.addChange(rootId, addChangeBody(request.body)))
    onlyMethod(request, 'DELETE')
    actions.clearChanges(rootId)
    return reply(204, null)
  }
  if (rest.length === 2 && rest[1] === 'recommended') {
    onlyMethod(request, 'POST')
    return reply(202, { jobId: actions.startCollect(rootId, kindsBody(request.body)).id })
  }
  if (rest.length === 2 && rest[1] === 'restore-cleared') {
    onlyMethod(request, 'POST')
    return reply(200, actions.restoreCleared(rootId))
  }
  if (rest.length === 2) {
    if (request.method === 'PUT') return reply(200, await actions.replaceChange(rootId, rest[1]!, addChangeBody(request.body)))
    onlyMethod(request, 'DELETE')
    actions.removeChange(rootId, rest[1]!)
    return reply(204, null)
  }
  return failure(404, 'Not found')
}

async function handleActionRoute(context: ApiContext, request: ApiRequest, rootId: string, rest: string[]): Promise<ApiResponse | undefined> {
  const { actions } = context
  const [resource] = rest
  if (resource === 'changes') return handleChangesRoute(context, request, rootId, rest)
  if (resource === 'preview' && rest.length === 1) {
    onlyMethod(request, 'POST')
    return reply(202, { jobId: actions.startPreview(rootId).id })
  }
  if (resource === 'preview' && rest.length === 4 && rest[1] === 'files' && rest[3] === 'diff') {
    onlyMethod(request, 'GET')
    return reply(200, actions.previewFileDiff(rootId, fileIndex(rest[2]!)))
  }
  if (resource === 'apply' && rest.length === 1) {
    onlyMethod(request, 'POST')
    const { previewId, install } = applyBody(request.body)
    return reply(202, { jobId: (await actions.startApply(rootId, previewId, install)).id })
  }
  if (resource === 'revert' && rest.length === 1) {
    onlyMethod(request, 'POST')
    return reply(202, { jobId: (await actions.startRevert(rootId)).id })
  }
  return undefined
}

function handleJobRoute(context: ApiContext, request: ApiRequest, rest: string[]): ApiResponse {
  const { actions } = context
  if (rest.length === 1) {
    onlyMethod(request, 'GET')
    return reply(200, actions.job(rest[0]!, integerParam(request.searchParams, 'since', 0, 0)))
  }
  if (rest.length === 2 && rest[1] === 'cancel') {
    onlyMethod(request, 'POST')
    actions.cancelJob(rest[0]!)
    return reply(202, { accepted: true })
  }
  return failure(404, 'Not found')
}

const ACTION_RESOURCES = new Set(['changes', 'preview', 'apply', 'revert'])

function handleRootRoute(context: ApiContext, request: ApiRequest, rootId: string, rest: string[], logError: ErrorLog): ApiResponse | Promise<ApiResponse> {
  const { session, actions } = context
  const root = session.root(rootId)
  if (rest.length === 1 && rest[0] === 'importers') {
    if (request.method !== 'GET') return failure(405, 'Method not allowed')
    if (!root) return failure(404, `Unknown root ${rootId}`)
    return reply(200, importerSummaries(root))
  }
  if (rest.length === 1 && rest[0] === 'resolve') {
    if (request.method !== 'POST') return failure(405, 'Method not allowed')
    if (!root) return failure(404, `Unknown root ${rootId}`)
    if (context.resolveUnavailable !== undefined) return failure(409, context.resolveUnavailable)
    if (actions.isBusy(rootId)) return failure(409, `A change job is running for ${rootId}`)
    runDetached(session.resolve(rootId), logError, `resolve ${rootId}`)
    return reply(202, { accepted: true })
  }
  if (rest.length === 1 && rest[0] === 'decorations') return handleDecorations(context, request, rootId)
  if (rest.length === 3 && rest[0] === 'nodes') return handleNodeRoute(context, request, rootId, rest[1]!, rest[2]!)
  if (ACTION_RESOURCES.has(rest[0]!)) {
    if (!root) return unknownRoot(rootId)
    return handleActionRoute(context, request, rootId, rest).then((response) => response ?? failure(404, 'Not found'))
  }
  return failure(404, 'Not found')
}

function handleIssues(context: ApiContext, request: ApiRequest): ApiResponse {
  if (request.method !== 'GET') return failure(405, 'Method not allowed')
  const params = request.searchParams
  const groupBy = groupByParam(params)
  const kinds = kindsParam(params)
  const rootId = params.get('root')
  let roots: RootGraph[]
  if (rootId === null) {
    roots = context.session.scan.roots.filter((root) => root.status === 'ready')
  } else {
    const lookup = readyRoot(context.session, rootId)
    if (lookup.failure) return lookup.failure
    roots = [lookup.root]
  }
  const { enrichment } = context
  if (groupBy === 'direct') {
    const body: IssueGroupsResponse = { revision: enrichment.revision, groups: issuesByDirect(enrichment, roots, kinds) }
    return reply(200, body)
  }
  const body: IssueRowsResponse = { revision: enrichment.revision, rows: issuesByPackage(enrichment, roots, kinds) }
  return reply(200, body)
}

function handleEnrichmentRefresh(context: ApiContext, request: ApiRequest): ApiResponse {
  if (request.method !== 'POST') return failure(405, 'Method not allowed')
  const { session, enrichment } = context
  if (enrichment.status(anyRootScanning(session.scan.roots)).state === 'offline') return failure(409, 'Package checks are disabled with --offline')
  enrichment.refresh()
  return reply(202, { accepted: true })
}

const SOURCE_RESOURCES: ReadonlySet<string> = new Set(['scan', 'search', 'duplicates', 'issues', 'roots'])
const SOURCES_SHAPE = '{ ref: string } or { mergeBase: { base: string, target: string } }'
const BRANCHES_DISABLED = { available: false, reason: 'Branches are not enabled', quiet: true } as const satisfies GitInfo
const COMMIT_ACTIONS = disabledActions(COMMIT_ACTIONS_REASON)

function sourcesBody(body: unknown): OpenSourceRequest {
  if (isRecord(body) && isString(body.ref)) return { ref: body.ref }
  const mergeBase = isRecord(body) ? body.mergeBase : undefined
  if (isRecord(mergeBase) && isString(mergeBase.base) && isString(mergeBase.target)) {
    return { mergeBase: { base: mergeBase.base, target: mergeBase.target } }
  }
  throw invalidBody(SOURCES_SHAPE)
}

function unknownSource(key: string): ApiResponse {
  return failure(404, `Unknown source ${key}`)
}

async function handleGit(context: ApiContext, request: ApiRequest): Promise<ApiResponse> {
  onlyMethod(request, 'GET')
  return reply(200, context.branches ? await context.branches.info() : BRANCHES_DISABLED)
}

async function handleSources(context: ApiContext, request: ApiRequest): Promise<ApiResponse> {
  onlyMethod(request, 'POST')
  if (!context.branches) return failure(409, BRANCHES_DISABLED.reason)
  return reply(200, await context.branches.open(sourcesBody(request.body)))
}

function handleCommitRoute(context: ApiContext, request: ApiRequest, rest: string[], logError: ErrorLog): ApiResponse | Promise<ApiResponse> {
  const [commit, resource] = rest as [string, string]
  if (!SOURCE_RESOURCES.has(resource)) return failure(404, 'Not found')
  const session = isObjectId(commit) ? context.branches?.sessionOf(commit) : undefined
  if (!session) return unknownSource(commit)
  return route({ session, enrichment: context.enrichment, actions: COMMIT_ACTIONS, resolveUnavailable: COMMIT_RESOLVE_REASON }, request, ['api', ...rest.slice(1)], logError)
}

function compareSideOf(session: ScanSession): CompareSide {
  const { roots, skippedSubmodules } = session.scan
  return skippedSubmodules === undefined ? { roots } : { roots, skippedSubmodules }
}

function handleCompare(context: ApiContext, request: ApiRequest): ApiResponse {
  onlyMethod(request, 'GET')
  const base = request.searchParams.get('base')
  const target = request.searchParams.get('target')
  if (base === null || target === null) throw new BadRequestError('Missing base or target')
  const baseSession = context.branches?.sessionOf(base)
  const targetSession = context.branches?.sessionOf(target)
  if (!baseSession) return unknownSource(base)
  if (!targetSession) return unknownSource(target)
  return reply(200, compareSources(context.enrichment, compareSideOf(baseSession), compareSideOf(targetSession)))
}

function route(context: ApiContext, request: ApiRequest, segments: string[], logError: ErrorLog): ApiResponse | Promise<ApiResponse> {
  const { session } = context
  const [, resource, ...rest] = segments
  if (resource === 'scan' && rest.length === 0) {
    return request.method === 'GET' ? reply(200, summarizeScan(context)) : failure(405, 'Method not allowed')
  }
  if (resource === 'rescan' && rest.length === 0) {
    if (request.method !== 'POST') return failure(405, 'Method not allowed')
    if (context.actions.anyBusy()) return failure(409, 'A change job is running')
    runDetached(session.rescan(), logError, 'rescan')
    return reply(202, { accepted: true })
  }
  if (resource === 'search' && rest.length === 0) {
    if (request.method !== 'GET') return failure(405, 'Method not allowed')
    return reply(200, search(session.index, request.searchParams.get('q') ?? ''))
  }
  if (resource === 'duplicates' && rest.length === 0) {
    if (request.method !== 'GET') return failure(405, 'Method not allowed')
    return reply(200, duplicates(session.index, request.searchParams.get('root') ?? undefined))
  }
  if (resource === 'git' && rest.length === 0) return handleGit(context, request)
  if (resource === 'sources' && rest.length === 0) return handleSources(context, request)
  if (resource === 'commits' && rest.length >= 2) return handleCommitRoute(context, request, rest, logError)
  if (resource === 'compare' && rest.length === 0) return handleCompare(context, request)
  if (resource === 'issues' && rest.length === 0) return handleIssues(context, request)
  if (resource === 'enrichment' && rest.length === 1 && rest[0] === 'refresh') return handleEnrichmentRefresh(context, request)
  if (resource === 'jobs' && rest.length >= 1) return handleJobRoute(context, request, rest)
  if (resource === 'roots' && rest.length >= 1) return handleRootRoute(context, request, rest[0]!, rest.slice(1), logError)
  return failure(404, 'Not found')
}

export async function handleApi(context: ApiContext, request: ApiRequest, logError: ErrorLog): Promise<ApiResponse> {
  const segments = decodeSegments(request.pathname)
  if (!segments) return failure(400, 'Malformed path encoding')
  try {
    return await route(context, request, segments, logError)
  } catch (error) {
    if (error instanceof BadRequestError) return failure(400, error.message)
    if (error instanceof BranchError) return failure(error.status, error.message)
    if (error instanceof MethodNotAllowedError) return failure(405, 'Method not allowed')
    if (error instanceof ActionError) {
      return reply(error.status, { error: error.message, ...(error.conflictsWith === undefined ? {} : { conflictsWith: error.conflictsWith }) })
    }
    if (error instanceof UnknownNodeError) return failure(404, error.message)
    logError(`${request.method} ${request.pathname}`, error)
    return failure(500, 'Internal error')
  }
}
