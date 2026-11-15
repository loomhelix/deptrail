import semver from 'semver'
import type { NodeId } from '../model.ts'
import type { GlobalEntry, GlobalIndex } from '../graph/global-index.ts'

export type SearchHit = { name: string; versions: { version: string; roots: { rootId: string; nodeId: NodeId }[] }[] }

const DEFAULT_MAX_HITS = 50

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareVersions(left: string, right: string): number {
  const leftValid = semver.valid(left) !== null
  const rightValid = semver.valid(right) !== null
  if (leftValid && rightValid) return semver.rcompare(left, right)
  if (leftValid) return -1
  if (rightValid) return 1
  return compareText(left, right)
}

function parseQuery(query: string): { term: string; range?: string } {
  const separator = query.lastIndexOf('@')
  if (separator <= 0) return { term: query }
  return { term: query.slice(0, separator), range: query.slice(separator + 1) }
}

function groupByVersion(entries: GlobalEntry[]): SearchHit['versions'] {
  const byVersion = new Map<string, { rootId: string; nodeId: NodeId }[]>()
  for (const entry of entries) {
    const roots = byVersion.get(entry.version) ?? []
    roots.push({ rootId: entry.rootId, nodeId: entry.nodeId })
    byVersion.set(entry.version, roots)
  }
  return [...byVersion]
    .sort(([left], [right]) => compareVersions(left, right))
    .map(([version, roots]) => ({
      version,
      roots: roots.sort((left, right) => compareText(left.rootId, right.rootId) || compareText(left.nodeId, right.nodeId)),
    }))
}

function satisfiesRange(version: string, range: string): boolean {
  return semver.valid(version) !== null && semver.satisfies(version, range, { includePrerelease: true })
}

export function search(index: GlobalIndex, query: string, max: number = DEFAULT_MAX_HITS): SearchHit[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const { term, range } = parseQuery(trimmed)
  const needle = term.toLowerCase()
  if (range !== undefined && semver.validRange(range) === null) return []
  const hits: SearchHit[] = []
  for (const [name, entries] of index) {
    const lowerName = name.toLowerCase()
    if (range === undefined ? !lowerName.includes(needle) : lowerName !== needle) continue
    const matching = range === undefined ? entries : entries.filter((entry) => satisfiesRange(entry.version, range))
    if (matching.length === 0) continue
    hits.push({ name, versions: groupByVersion(matching) })
  }
  const exactFirst = (hit: SearchHit) => (hit.name.toLowerCase() === needle ? 0 : 1)
  hits.sort(
    (left, right) =>
      exactFirst(left) - exactFirst(right) || left.name.length - right.name.length || compareText(left.name, right.name),
  )
  return hits.slice(0, max)
}
