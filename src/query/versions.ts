import semver from 'semver'
import { isNonRegistrySpec } from '../adapters/package-manifest.ts'
import type { Advisory, PackageMeta, RangeEvent } from '../enrich/types.ts'

export type OutdatedLevel = 'major' | 'minor' | 'patch'

export type RangeContext = { name: string; catalogs: Record<string, Record<string, string>>; distTags?: Record<string, string> }

const LOCAL_SPEC_PREFIXES = ['workspace:', 'link:', 'file:']
const NPM_ALIAS_PREFIX = 'npm:'
const CATALOG_PREFIX = 'catalog:'
const DEFAULT_CATALOG = 'default'
const LATEST_TAG = 'latest'

function resolveCatalogRange(range: string, context: RangeContext): string | undefined {
  const catalogName = range.slice(CATALOG_PREFIX.length) || DEFAULT_CATALOG
  const resolved = context.catalogs[catalogName]?.[context.name]
  if (resolved === undefined || resolved.startsWith(CATALOG_PREFIX)) return undefined
  return normalizeRange(resolved, context)
}

function resolveAliasRange(range: string, context: RangeContext): string | undefined {
  const versionSeparator = range.lastIndexOf('@')
  const aliased = versionSeparator > NPM_ALIAS_PREFIX.length ? range.slice(versionSeparator + 1) : LATEST_TAG
  if (aliased.startsWith(NPM_ALIAS_PREFIX)) return undefined
  return normalizeRange(aliased, context)
}

export function normalizeRange(range: string, context: RangeContext): string | undefined {
  if (LOCAL_SPEC_PREFIXES.some((prefix) => range.startsWith(prefix)) || isNonRegistrySpec(range)) return undefined
  if (range.startsWith(CATALOG_PREFIX)) return resolveCatalogRange(range, context)
  if (range.startsWith(NPM_ALIAS_PREFIX)) return resolveAliasRange(range, context)
  if (semver.validRange(range) !== null) return range
  const tagged = context.distTags?.[range]
  return tagged !== undefined && semver.valid(tagged) !== null ? tagged : undefined
}

export function wantedVersion(versions: readonly string[], range: string | undefined): string | undefined {
  if (range === undefined || semver.validRange(range) === null) return undefined
  return semver.maxSatisfying(versions.filter((version) => semver.valid(version) !== null), range) ?? undefined
}

export function outdatedLevel(current: string, latest: string | undefined): OutdatedLevel | undefined {
  if (latest === undefined || semver.valid(current) === null || semver.valid(latest) === null) return undefined
  if (semver.prerelease(current) !== null || !semver.gt(latest, current)) return undefined
  const difference = semver.diff(current, latest)
  if (difference === 'major' || difference === 'premajor') return 'major'
  if (difference === 'minor' || difference === 'preminor') return 'minor'
  return 'patch'
}

function eventVersion(event: RangeEvent): string {
  if ('introduced' in event) return event.introduced
  if ('fixed' in event) return event.fixed
  return event.last_affected
}

function isUsableEvent(event: RangeEvent): boolean {
  const version = eventVersion(event)
  if (typeof version !== 'string') return false
  if ('introduced' in event && version === '0') return true
  return semver.valid(version) !== null
}

function compareEventVersions(left: string, right: string): number {
  if (left === right) return 0
  if (left === '0') return -1
  if (right === '0') return 1
  return semver.compare(left, right)
}

function sortedEvents(events: readonly RangeEvent[]): RangeEvent[] {
  return events
    .filter(isUsableEvent)
    .sort((left, right) => compareEventVersions(eventVersion(left), eventVersion(right)))
}

export function isAffected(version: string, advisory: Pick<Advisory, 'affected'>): boolean {
  if (advisory.affected.some((entry) => entry.versions.includes(version))) return true
  if (semver.valid(version) === null) return false
  return advisory.affected.some((entry) => entry.ranges.some((range) => {
    let affected = false
    for (const event of sortedEvents(range.events)) {
      if ('introduced' in event && (event.introduced === '0' || semver.gte(version, event.introduced))) affected = true
      if ('fixed' in event && semver.gte(version, event.fixed)) affected = false
      if ('last_affected' in event && semver.gt(version, event.last_affected)) affected = false
    }
    return affected
  }))
}

export function safeVersions(meta: PackageMeta, advisories: readonly Advisory[]): string[] {
  return meta.versions
    .filter((version) => semver.valid(version) !== null && semver.prerelease(version) === null)
    .filter((version) => !advisories.some((advisory) => isAffected(version, advisory)))
    .sort(semver.compare)
}
