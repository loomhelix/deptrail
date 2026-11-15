import type { PackageNode, RootGraph } from '../model.ts'

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'unknown', 'low']

export type PackageMeta = {
  distTags: Record<string, string>
  versions: string[]
  deprecated: Record<string, string>
  manifests: Record<string, Record<string, string>>
}

export type VulnRef = { id: string; modified: string }

export type RangeEvent = { introduced: string } | { fixed: string } | { last_affected: string }

export type AffectedEntry = { versions: string[]; ranges: { events: RangeEvent[] }[] }

export type Advisory = {
  id: string
  aliases: string[]
  summary: string
  severity: Severity
  malicious: boolean
  url: string
  fixedIn: string[]
  cvss?: string
  modified: string
  affected: AffectedEntry[]
}

export type SkipReason = 'private-scope' | 'non-registry' | 'unknown-version'

export type RegistryState =
  | { state: 'pending' }
  | { state: 'offline' }
  | { state: 'not-applicable' }
  | { state: 'not-found'; fetchedAt: string }
  | { state: 'ok' | 'stale'; meta: PackageMeta; fetchedAt: string }
  | { state: 'failed'; reason: string }

export type MatchState =
  | { state: 'pending' }
  | { state: 'offline' }
  | { state: 'not-applicable' }
  | { state: 'skipped'; reason: SkipReason }
  | { state: 'ok' | 'stale'; vulns: VulnRef[]; fetchedAt: string }
  | { state: 'failed'; reason: string }

export type AdvisoriesState =
  | { state: 'pending' }
  | { state: 'ok' | 'stale'; advisories: Advisory[]; fetchedAt: string }
  | { state: 'failed'; reason: string }

export type PublishedVersions = { state: 'ok'; meta: PackageMeta } | { state: 'failed'; reason: string }

export type AssessedPackage = {
  name: string
  version: string
  severity?: Severity
  vulnIds: string[]
  deprecated?: string
  notChecked?: string
}

export type EnrichmentView = {
  readonly revision: number
  registryOf(root: RootGraph, node: PackageNode): RegistryState
  matchOf(root: RootGraph, node: PackageNode): MatchState
  matchOfVersion(name: string, version: string): MatchState
  advisoriesOf(name: string): AdvisoriesState
}

export type EnrichmentProblem = { source: 'registry' | 'osv'; origin: string; message: string; count: number }

export type EnrichmentStatus = {
  state: 'offline' | 'running' | 'done'
  revision: number
  registry: { total: number; done: number; failed: number }
  osv: { total: number; done: number; skipped: number; failed: number }
  problems: EnrichmentProblem[]
  finishedAt?: string
}
