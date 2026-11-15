import type { AuthorizationLookup } from './credentials.ts'
import { HttpError, type HttpClient } from './http.ts'
import type { PackageMeta } from './types.ts'

export const CORGI_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'

export type RegistryFetchRequest = {
  registry: string
  name: string
  etag?: string
  versionsInUse: readonly string[]
  allManifests?: true
  authorizationFor: AuthorizationLookup
}

export type RegistryFetchResult =
  | { state: 'ok'; meta: PackageMeta; etag?: string }
  | { state: 'not-modified' }
  | { state: 'not-found' }
  | { state: 'failed'; reason: string; authRejected: boolean }

type StringRecord = Record<string, string>

const UNAUTHORIZED_STATUS = 401
const FORBIDDEN_STATUS = 403
const MALFORMED_REASON = 'returned a malformed packument'

const FAILURE_REASON_BY_KIND: Record<HttpError['kind'], string> = {
  timeout: 'did not respond within 30 s',
  network: 'is unreachable',
  'too-large': 'returned more than 50 MB',
  redirects: 'redirected too many times',
  aborted: 'request was canceled',
}

export function packumentUrl(registry: string, name: string): string {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  return `${base}${name.replace('/', '%2f')}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is StringRecord {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

export function isPackageMeta(value: unknown): value is PackageMeta {
  return (
    isPlainObject(value) &&
    isStringRecord(value.distTags) &&
    Array.isArray(value.versions) &&
    value.versions.every((version) => typeof version === 'string') &&
    isStringRecord(value.deprecated) &&
    isPlainObject(value.manifests) &&
    Object.values(value.manifests).every(isStringRecord)
  )
}

export function metaCovers(meta: PackageMeta, versionsInUse: readonly string[]): boolean {
  const known = new Set(meta.versions)
  return versionsInUse.every((version) => !known.has(version) || version in meta.manifests)
}

export function failureReason(error: unknown): string {
  return error instanceof HttpError ? FAILURE_REASON_BY_KIND[error.kind] : FAILURE_REASON_BY_KIND.network
}

function declaredRanges(version: Record<string, unknown>): StringRecord {
  const merged: StringRecord = {}
  for (const field of ['peerDependencies', 'optionalDependencies', 'dependencies']) {
    const ranges = version[field]
    if (!isPlainObject(ranges)) continue
    for (const [name, range] of Object.entries(ranges)) {
      if (typeof range === 'string') merged[name] = range
    }
  }
  return merged
}

function toPackageMeta(packument: unknown, versionsInUse: readonly string[], allManifests: boolean): PackageMeta | undefined {
  if (!isPlainObject(packument) || !isPlainObject(packument.versions)) return undefined
  const distTags = isStringRecord(packument['dist-tags']) ? packument['dist-tags'] : {}
  const deprecated: StringRecord = {}
  const manifests: Record<string, StringRecord> = {}
  const inUse = new Set(versionsInUse)
  for (const [version, entry] of Object.entries(packument.versions)) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.deprecated === 'string') deprecated[version] = entry.deprecated
    if (allManifests || inUse.has(version)) manifests[version] = declaredRanges(entry)
  }
  return { distTags, versions: Object.keys(packument.versions), deprecated, manifests }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function failed(reason: string, authRejected = false): RegistryFetchResult {
  return { state: 'failed', reason, authRejected }
}

export async function fetchPackageMeta(
  http: HttpClient,
  request: RegistryFetchRequest,
): Promise<RegistryFetchResult> {
  const headers: Record<string, string> = { Accept: CORGI_ACCEPT }
  if (request.etag !== undefined) headers['If-None-Match'] = request.etag
  let response
  try {
    response = await http.request({
      url: packumentUrl(request.registry, request.name),
      headers,
      authorizationFor: request.authorizationFor,
    })
  } catch (error) {
    return failed(failureReason(error))
  }
  if (response.status === 304) return { state: 'not-modified' }
  if (response.status === 404) return { state: 'not-found' }
  if (response.status === UNAUTHORIZED_STATUS) return failed(`rejected credentials (${response.status})`, true)
  if (response.status === FORBIDDEN_STATUS) return failed(`rejected credentials (${response.status})`)
  if (response.status < 200 || response.status >= 300) return failed(`responded with HTTP ${response.status}`)
  const meta = toPackageMeta(parseJson(response.text), request.versionsInUse, request.allManifests === true)
  if (meta === undefined) return failed(MALFORMED_REASON)
  const etag = response.headers.get('etag') ?? undefined
  return etag === undefined ? { state: 'ok', meta } : { state: 'ok', meta, etag }
}
