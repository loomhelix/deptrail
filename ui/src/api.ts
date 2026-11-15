import { encodeRootSegment } from '../../src/server/root-segment.ts'
import type { AddChangeRequest, ChangeItem, ChangesResponse, Job, NodeActions, RestoreResult } from '../../src/actions/types.ts'
import type { DepKind, NodeId } from '../../src/model.ts'
import type { ChildrenResult } from '../../src/query/children.ts'
import type { DependentsResult } from '../../src/query/dependents.ts'
import type { DuplicateEntry } from '../../src/query/duplicates.ts'
import type { PackageInsight } from '../../src/query/package-insight.ts'
import type { SearchHit } from '../../src/query/search.ts'
import type { SubgraphResult } from '../../src/query/subgraph.ts'
import type { CompareResponse } from '../../src/query/compare-shape.ts'
import type { GitInfo, OpenedSource, OpenSourceRequest } from '../../src/server/branches.ts'
import type {
  DecorationsResponse,
  IssueGroupsResponse,
  IssueRowsResponse,
  RootSummary,
  ScanSummary,
} from '../../src/server/router.ts'
import { DEP_KINDS } from './context.ts'
import { requestFailedText } from './vocabulary.ts'

export type {
  ChildrenResult,
  CompareResponse,
  GitInfo,
  OpenedSource,
  OpenSourceRequest,
  DecorationsResponse,
  DependentsResult,
  DuplicateEntry,
  IssueGroupsResponse,
  IssueRowsResponse,
  PackageInsight,
  RootSummary,
  ScanSummary,
  SearchHit,
  SubgraphResult,
}

export type DeptrailApi = {
  scan(): Promise<ScanSummary>
  importers(root: string): Promise<RootSummary['importers']>
  children(root: string, id: NodeId, depth: number, kinds: DepKind[]): Promise<ChildrenResult>
  dependents(root: string, id: NodeId, depth: number, kinds: DepKind[]): Promise<DependentsResult>
  subgraph(root: string, id: NodeId, up: number, down: number, limit: number, kinds: DepKind[]): Promise<SubgraphResult>
  search(q: string): Promise<SearchHit[]>
  duplicates(root?: string): Promise<DuplicateEntry[]>
  resolve(root: string): Promise<void>
  rescan(): Promise<void>
  decorations(root: string, kinds: DepKind[]): Promise<DecorationsResponse>
  issueRows(root: string | undefined, kinds: DepKind[]): Promise<IssueRowsResponse>
  issueGroups(root: string | undefined, kinds: DepKind[]): Promise<IssueGroupsResponse>
  insight(root: string, id: NodeId, kinds: DepKind[]): Promise<PackageInsight>
  refreshEnrichment(): Promise<void>
  nodeActions(root: string, id: NodeId, kinds: DepKind[]): Promise<NodeActions>
  changes(root: string): Promise<ChangesResponse>
  addChange(root: string, request: AddChangeRequest): Promise<ChangeItem>
  replaceChange(root: string, itemId: string, request: AddChangeRequest): Promise<ChangeItem>
  removeChange(root: string, itemId: string): Promise<void>
  clearChanges(root: string): Promise<void>
  restoreCleared(root: string): Promise<RestoreResult>
  addRecommended(root: string, kinds: DepKind[]): Promise<JobStarted>
  preview(root: string): Promise<JobStarted>
  previewFileDiff(root: string, index: number): Promise<FileDiff>
  apply(root: string, previewId: string, install: boolean): Promise<JobStarted>
  revert(root: string): Promise<JobStarted>
  job(id: string, since: number): Promise<Job>
  cancelJob(id: string): Promise<void>
  git(): Promise<GitInfo>
  openSource(request: OpenSourceRequest): Promise<OpenedSource>
  compare(base: string, target: string): Promise<CompareResponse>
}

export type JobStarted = { jobId: string }
export type FileDiff = { diff: string; truncated: boolean }

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type QueryValues = Record<string, string | number | undefined>
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

const JSON_MEDIA_TYPE = 'application/json'
const API_PREFIX = '/api/'
const PER_SOURCE_PATH = /^\/api\/(?:(?:scan|search|duplicates|issues)(?=[/?]|$)|roots\/)/

const NOT_FOUND_STATUS = 404
const UNKNOWN_SOURCE_PREFIX = 'Unknown source '

let sourceCommit: string | undefined
let onSourceDropped: (() => void) | undefined

export function setApiSource(commit: string | undefined, onDropped?: () => void): void {
  sourceCommit = commit
  onSourceDropped = onDropped
}

function reportDroppedSource(status: number, message: string): void {
  if (sourceCommit !== undefined && status === NOT_FOUND_STATUS && message === `${UNKNOWN_SOURCE_PREFIX}${sourceCommit}`) onSourceDropped?.()
}

function sourcedPath(path: string): string {
  if (sourceCommit === undefined || !PER_SOURCE_PATH.test(path)) return path
  return `/api/commits/${sourceCommit}/${path.slice(API_PREFIX.length)}`
}

function withQuery(path: string, values: QueryValues): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, String(value))
  }
  const query = params.toString()
  return query === '' ? path : `${path}?${query}`
}

function kindsList(kinds: DepKind[]): DepKind[] | undefined {
  return DEP_KINDS.every((kind) => kinds.includes(kind)) ? undefined : kinds
}

function kindsValue(kinds: DepKind[]): string | undefined {
  return kindsList(kinds)?.join(',')
}

function rootPath(root: string): string {
  return `/api/roots/${encodeRootSegment(root)}`
}

function nodePath(root: string, id: NodeId, action: string): string {
  return `${rootPath(root)}/nodes/${encodeURIComponent(id)}/${action}`
}

function changesPath(root: string): string {
  return `${rootPath(root)}/changes`
}

function changePath(root: string, itemId: string): string {
  return `${changesPath(root)}/${encodeURIComponent(itemId)}`
}

function jobPath(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}`
}

async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error
  } catch {}
  return requestFailedText(response.status)
}

export function createApi(fetchImpl: typeof fetch = fetch): DeptrailApi {
  async function send(path: string, method: Method = 'GET', body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Accept: JSON_MEDIA_TYPE }
    if (body !== undefined) headers['Content-Type'] = JSON_MEDIA_TYPE
    const init: RequestInit = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    const response = await fetchImpl(sourcedPath(path), init)
    if (!response.ok) {
      const message = await errorText(response)
      reportDroppedSource(response.status, message)
      throw new ApiError(response.status, message)
    }
    return response
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await (await send(path)).json()) as T
  }

  async function post(path: string): Promise<void> {
    await send(path, 'POST')
  }

  async function postJson<T>(path: string, body?: unknown): Promise<T> {
    return (await (await send(path, 'POST', body)).json()) as T
  }

  async function putJson<T>(path: string, body: unknown): Promise<T> {
    return (await (await send(path, 'PUT', body)).json()) as T
  }

  async function remove(path: string): Promise<void> {
    await send(path, 'DELETE')
  }

  return {
    scan: () => getJson('/api/scan'),
    importers: (root) => getJson(`${rootPath(root)}/importers`),
    children: (root, id, depth, kinds) => getJson(withQuery(nodePath(root, id, 'children'), { depth, kinds: kindsValue(kinds) })),
    dependents: (root, id, depth, kinds) =>
      getJson(withQuery(nodePath(root, id, 'dependents'), { depth, kinds: kindsValue(kinds) })),
    subgraph: (root, id, up, down, limit, kinds) =>
      getJson(withQuery(nodePath(root, id, 'subgraph'), { up, down, limit, kinds: kindsValue(kinds) })),
    search: (q) => getJson(withQuery('/api/search', { q })),
    duplicates: (root) => getJson(withQuery('/api/duplicates', { root })),
    resolve: (root) => post(`${rootPath(root)}/resolve`),
    rescan: () => post('/api/rescan'),
    decorations: (root, kinds) => getJson(withQuery(`${rootPath(root)}/decorations`, { kinds: kindsValue(kinds) })),
    issueRows: (root, kinds) => getJson(withQuery('/api/issues', { root, kinds: kindsValue(kinds), groupBy: 'package' })),
    issueGroups: (root, kinds) => getJson(withQuery('/api/issues', { root, kinds: kindsValue(kinds), groupBy: 'direct' })),
    insight: (root, id, kinds) => getJson(withQuery(nodePath(root, id, 'insight'), { kinds: kindsValue(kinds) })),
    refreshEnrichment: () => post('/api/enrichment/refresh'),
    nodeActions: (root, id, kinds) => getJson(withQuery(nodePath(root, id, 'actions'), { kinds: kindsValue(kinds) })),
    changes: (root) => getJson(changesPath(root)),
    addChange: (root, request) => postJson(changesPath(root), request),
    replaceChange: (root, itemId, request) => putJson(changePath(root, itemId), request),
    removeChange: (root, itemId) => remove(changePath(root, itemId)),
    clearChanges: (root) => remove(changesPath(root)),
    restoreCleared: (root) => postJson(`${changesPath(root)}/restore-cleared`),
    addRecommended: (root, kinds) => postJson(`${changesPath(root)}/recommended`, { kinds: kindsList(kinds) }),
    preview: (root) => postJson(`${rootPath(root)}/preview`),
    previewFileDiff: (root, index) => getJson(`${rootPath(root)}/preview/files/${index}/diff`),
    apply: (root, previewId, install) => postJson(`${rootPath(root)}/apply`, { previewId, install }),
    revert: (root) => postJson(`${rootPath(root)}/revert`),
    job: (id, since) => getJson(withQuery(jobPath(id), { since })),
    cancelJob: (id) => post(`${jobPath(id)}/cancel`),
    git: () => getJson('/api/git'),
    openSource: (request) => postJson('/api/sources', request),
    compare: (base, target) => getJson(withQuery('/api/compare', { base, target })),
  }
}
