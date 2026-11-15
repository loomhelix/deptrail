import semver from 'semver'
import type { HttpClient, HttpResponse } from './http.ts'
import { failureReason } from './registry-client.ts'
import type { Advisory, AffectedEntry, RangeEvent, Severity, VulnRef } from './types.ts'

export const OSV_DEFAULT_URL = 'https://api.osv.dev'
export const OSV_BATCH_SIZE = 1000
export const OSV_PARALLEL_BATCHES = 2
export const OSV_MAX_PAGES = 50

export type VersionQuery = { name: string; version: string }
export type BatchOutcome = { matches: Map<string, VulnRef[]>; failed: Map<string, string> }
export type PackageAdvisoriesResult = { state: 'ok'; advisories: Advisory[] } | { state: 'failed'; reason: string }

type PendingQuery = { key: string; query: VersionQuery; pageToken?: string }
type PageOutcome = { ok: true; body: unknown } | { ok: false; reason: string }

const ECOSYSTEM = 'npm'
const MALFORMED_REASON = 'returned a malformed response'
const TOO_MANY_PAGES_REASON = 'returned too many pages'
const ADVISORY_URL_PREFIX = 'https://osv.dev/vulnerability/'
const MALICIOUS_ID_PREFIX = 'MAL-'
const GITHUB_ID_PREFIX = 'GHSA-'
const SUPPORTED_RANGE_TYPES = ['SEMVER', 'ECOSYSTEM']
const CVSS_TYPES_BY_PREFERENCE = ['CVSS_V4', 'CVSS_V3', 'CVSS_V2']
const SEVERITY_BY_LABEL = new Map<string, Severity>([
  ['LOW', 'low'],
  ['MODERATE', 'moderate'],
  ['MEDIUM', 'moderate'],
  ['HIGH', 'high'],
  ['CRITICAL', 'critical'],
])

export function versionKey(name: string, version: string): string {
  return `${name}@${version}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}

async function postJson(http: HttpClient, osvUrl: string, path: string, payload: unknown): Promise<PageOutcome> {
  let response: HttpResponse
  try {
    response = await http.request({
      url: `${osvUrl.replace(/\/+$/, '')}${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    return { ok: false, reason: failureReason(error) }
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: `responded with HTTP ${response.status}` }
  }
  const body = parseJson(response.text)
  return isPlainObject(body) ? { ok: true, body } : { ok: false, reason: MALFORMED_REASON }
}

function toVulnRef(value: unknown): VulnRef | undefined {
  if (!isPlainObject(value) || typeof value.id !== 'string') return undefined
  return { id: value.id, modified: typeof value.modified === 'string' ? value.modified : '' }
}

function nextPageTokenOf(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.next_page_token === 'string' && value.next_page_token !== ''
    ? value.next_page_token
    : undefined
}

function batchPayload(pending: readonly PendingQuery[]): unknown {
  return {
    queries: pending.map(({ query, pageToken }) => ({
      package: { name: query.name, ecosystem: ECOSYSTEM },
      version: query.version,
      ...(pageToken === undefined ? {} : { page_token: pageToken }),
    })),
  }
}

async function resolveChunk(http: HttpClient, osvUrl: string, chunkQueries: readonly PendingQuery[]): Promise<BatchOutcome> {
  const matches = new Map<string, VulnRef[]>(chunkQueries.map(({ key }) => [key, []]))
  const sentTokens = new Map<string, Set<string>>()
  let pending: readonly PendingQuery[] = chunkQueries
  let followUpPages = 0
  while (pending.length > 0) {
    const page = await postJson(http, osvUrl, '/v1/querybatch', batchPayload(pending))
    const results = page.ok && isPlainObject(page.body) ? page.body.results : undefined
    if (!page.ok || !Array.isArray(results) || results.length !== pending.length) {
      const reason = page.ok ? MALFORMED_REASON : page.reason
      return { matches: new Map(), failed: new Map(chunkQueries.map(({ key }) => [key, reason])) }
    }
    const following: PendingQuery[] = []
    let repeatedToken = false
    pending.forEach((entry, index) => {
      const result: unknown = results[index]
      const vulns = isPlainObject(result) && Array.isArray(result.vulns) ? result.vulns : []
      matches.get(entry.key)?.push(...vulns.map(toVulnRef).filter((ref): ref is VulnRef => ref !== undefined))
      const pageToken = nextPageTokenOf(result)
      if (pageToken === undefined) return
      const tokens = sentTokens.get(entry.key) ?? new Set<string>()
      sentTokens.set(entry.key, tokens)
      if (tokens.has(pageToken)) repeatedToken = true
      tokens.add(pageToken)
      following.push({ ...entry, pageToken })
    })
    followUpPages += following.length > 0 ? 1 : 0
    if (repeatedToken || followUpPages > OSV_MAX_PAGES) {
      return { matches: new Map(), failed: new Map(chunkQueries.map(({ key }) => [key, TOO_MANY_PAGES_REASON])) }
    }
    pending = following
  }
  return { matches, failed: new Map() }
}

export async function queryVersions(
  http: HttpClient,
  osvUrl: string,
  queries: readonly VersionQuery[],
): Promise<BatchOutcome> {
  const uniqueQueries = new Map<string, PendingQuery>()
  for (const query of queries) {
    const key = versionKey(query.name, query.version)
    if (!uniqueQueries.has(key)) uniqueQueries.set(key, { key, query })
  }
  const chunks = chunk([...uniqueQueries.values()], OSV_BATCH_SIZE)
  const outcome: BatchOutcome = { matches: new Map(), failed: new Map() }
  let nextChunk = 0
  async function worker(): Promise<void> {
    while (nextChunk < chunks.length) {
      const chunkOutcome = await resolveChunk(http, osvUrl, chunks[nextChunk++])
      for (const [key, refs] of chunkOutcome.matches) outcome.matches.set(key, refs)
      for (const [key, reason] of chunkOutcome.failed) outcome.failed.set(key, reason)
    }
  }
  await Promise.all(Array.from({ length: Math.min(OSV_PARALLEL_BATCHES, chunks.length) }, worker))
  return outcome
}

export function severityOf(record: Record<string, unknown>): { severity: Severity; malicious: boolean } {
  if (typeof record.id === 'string' && record.id.startsWith(MALICIOUS_ID_PREFIX)) {
    return { severity: 'critical', malicious: true }
  }
  const label = isPlainObject(record.database_specific) ? record.database_specific.severity : undefined
  const severity = typeof label === 'string' ? SEVERITY_BY_LABEL.get(label) : undefined
  return { severity: severity ?? 'unknown', malicious: false }
}

function cvssOf(record: Record<string, unknown>): string | undefined {
  const entries = Array.isArray(record.severity) ? record.severity.filter(isPlainObject) : []
  for (const type of CVSS_TYPES_BY_PREFERENCE) {
    const match = entries.find((entry) => entry.type === type && typeof entry.score === 'string')
    if (match !== undefined) return match.score as string
  }
  return undefined
}

function toRangeEvent(value: unknown): RangeEvent | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.introduced === 'string') return { introduced: value.introduced }
  if (typeof value.fixed === 'string') return { fixed: value.fixed }
  if (typeof value.last_affected === 'string') return { last_affected: value.last_affected }
  return undefined
}

function toAffectedEntry(value: unknown, name: string): AffectedEntry | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.package)) return undefined
  if (value.package.ecosystem !== ECOSYSTEM || value.package.name !== name) return undefined
  const ranges = (Array.isArray(value.ranges) ? value.ranges : [])
    .filter(isPlainObject)
    .filter((range) => typeof range.type === 'string' && SUPPORTED_RANGE_TYPES.includes(range.type))
    .map((range) => ({
      events: (Array.isArray(range.events) ? range.events : [])
        .map(toRangeEvent)
        .filter((event): event is RangeEvent => event !== undefined),
    }))
  return { versions: stringsOf(value.versions), ranges }
}

function fixedVersionsOf(affected: readonly AffectedEntry[]): string[] {
  const fixed = new Set<string>()
  for (const entry of affected) {
    for (const range of entry.ranges) {
      for (const event of range.events) {
        if ('fixed' in event && semver.valid(event.fixed) !== null) fixed.add(event.fixed)
      }
    }
  }
  return [...fixed].sort(semver.compare)
}

export function toAdvisory(record: unknown, name: string): Advisory | null {
  if (!isPlainObject(record) || typeof record.id !== 'string' || record.id === '') return null
  if (record.withdrawn !== undefined && record.withdrawn !== null) return null
  const affected = (Array.isArray(record.affected) ? record.affected : [])
    .map((entry) => toAffectedEntry(entry, name))
    .filter((entry): entry is AffectedEntry => entry !== undefined)
  const cvss = cvssOf(record)
  return {
    id: record.id,
    aliases: stringsOf(record.aliases),
    summary: typeof record.summary === 'string' ? record.summary : '',
    ...severityOf(record),
    url: `${ADVISORY_URL_PREFIX}${record.id}`,
    fixedIn: fixedVersionsOf(affected),
    ...(cvss === undefined ? {} : { cvss }),
    modified: typeof record.modified === 'string' ? record.modified : '',
    affected,
  }
}

function areSameVulnerability(first: Advisory, second: Advisory): boolean {
  return first.aliases.includes(second.id) || second.aliases.includes(first.id)
}

export function dedupeAdvisories(advisories: readonly Advisory[]): Advisory[] {
  const kept: Advisory[] = []
  for (const candidate of advisories) {
    const duplicateIndex = kept.findIndex((existing) => areSameVulnerability(existing, candidate))
    if (duplicateIndex === -1) {
      kept.push(candidate)
      continue
    }
    const candidateIsGithub = candidate.id.startsWith(GITHUB_ID_PREFIX)
    const existingIsGithub = kept[duplicateIndex].id.startsWith(GITHUB_ID_PREFIX)
    if (candidateIsGithub && !existingIsGithub) kept[duplicateIndex] = candidate
  }
  return kept
}

export async function queryPackageAdvisories(
  http: HttpClient,
  osvUrl: string,
  name: string,
): Promise<PackageAdvisoriesResult> {
  const advisories: Advisory[] = []
  const sentTokens = new Set<string>()
  let pageToken: string | undefined
  let pagesFetched = 0
  do {
    const payload = { package: { name, ecosystem: ECOSYSTEM }, ...(pageToken === undefined ? {} : { page_token: pageToken }) }
    const page = await postJson(http, osvUrl, '/v1/query', payload)
    if (!page.ok) return { state: 'failed', reason: page.reason }
    const body = page.body as Record<string, unknown>
    for (const record of Array.isArray(body.vulns) ? body.vulns : []) {
      const converted = toAdvisory(record, name)
      if (converted !== null) advisories.push(converted)
    }
    pageToken = nextPageTokenOf(body)
    pagesFetched += 1
    if (pageToken !== undefined && (sentTokens.has(pageToken) || pagesFetched > OSV_MAX_PAGES)) {
      return { state: 'failed', reason: TOO_MANY_PAGES_REASON }
    }
    if (pageToken !== undefined) sentTokens.add(pageToken)
  } while (pageToken !== undefined)
  return { state: 'ok', advisories: dedupeAdvisories(advisories) }
}
