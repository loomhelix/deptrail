import type { PackageNode, RootGraph } from '../../src/model.ts'
import type { EnrichmentService } from '../../src/enrich/enrichment-service.ts'
import type {
  Advisory,
  AdvisoriesState,
  AssessedPackage,
  EnrichmentStatus,
  EnrichmentView,
  MatchState,
  PackageMeta,
  PublishedVersions,
  RangeEvent,
  RegistryState,
  Severity,
  SkipReason,
} from '../../src/enrich/types.ts'

export type ViewSpec = {
  revision?: number
  meta?: Record<string, PackageMeta>
  vulns?: Record<string, string[]>
  advisories?: Record<string, Advisory[]>
  skipped?: Record<string, SkipReason>
  offline?: boolean
  failedRegistry?: Record<string, string>
  failedMatches?: Record<string, string>
  failedAdvisories?: Record<string, string>
}

const FETCHED_AT = '2026-01-01T00:00:00.000Z'

export function makeEnrichmentView(spec: ViewSpec): EnrichmentView {
  const matchOfVersion = (name: string, version: string): MatchState => {
    if (spec.offline) return { state: 'offline' }
    const key = `${name}@${version}`
    const reason = spec.skipped?.[key]
    if (reason) return { state: 'skipped', reason }
    const failure = spec.failedMatches?.[key]
    if (failure) return { state: 'failed', reason: failure }
    const ids = spec.vulns?.[key]
    if (ids) return { state: 'ok', vulns: ids.map((id) => ({ id, modified: '' })), fetchedAt: FETCHED_AT }
    return { state: 'pending' }
  }
  return {
    revision: spec.revision ?? 1,
    registryOf(_root: RootGraph, node: PackageNode): RegistryState {
      if (spec.offline) return { state: 'offline' }
      const failure = spec.failedRegistry?.[node.name]
      if (failure) return { state: 'failed', reason: failure }
      const meta = spec.meta?.[node.name]
      return meta ? { state: 'ok', meta, fetchedAt: FETCHED_AT } : { state: 'pending' }
    },
    matchOf(_root: RootGraph, node: PackageNode): MatchState {
      return matchOfVersion(node.name, node.version)
    },
    matchOfVersion,
    advisoriesOf(name: string): AdvisoriesState {
      const failure = spec.failedAdvisories?.[name]
      if (failure) return { state: 'failed', reason: failure }
      const advisories = spec.advisories?.[name]
      return advisories ? { state: 'ok', advisories, fetchedAt: FETCHED_AT } : { state: 'pending' }
    },
  }
}

export function makeMeta(spec: {
  versions: string[]
  latest?: string
  deprecated?: Record<string, string>
  manifests?: Record<string, Record<string, string>>
}): PackageMeta {
  return {
    distTags: spec.latest ? { latest: spec.latest } : {},
    versions: spec.versions,
    deprecated: spec.deprecated ?? {},
    manifests: spec.manifests ?? {},
  }
}

export function makeAdvisory(spec: {
  id: string
  severity?: Severity
  malicious?: boolean
  events?: RangeEvent[]
  fixedIn?: string[]
}): Advisory {
  return {
    id: spec.id,
    aliases: [],
    summary: '',
    severity: spec.severity ?? 'unknown',
    malicious: spec.malicious ?? spec.id.startsWith('MAL-'),
    url: `https://osv.dev/vulnerability/${spec.id}`,
    fixedIn: spec.fixedIn ?? [],
    modified: '',
    affected: spec.events ? [{ versions: [], ranges: [{ events: spec.events }] }] : [],
  }
}

export type OnDemandSpec = { published?: Record<string, PackageMeta>; assessed?: Record<string, Partial<AssessedPackage>> }

export function stubEnrichment(
  view: EnrichmentView,
  status: Partial<EnrichmentStatus> = {},
  onDemand: OnDemandSpec = {},
): EnrichmentService & { refreshCalls: number; publishedCalls: string[] } {
  const stub = {
    get revision() {
      return view.revision
    },
    registryOf: (root: RootGraph, node: PackageNode) => view.registryOf(root, node),
    matchOf: (root: RootGraph, node: PackageNode) => view.matchOf(root, node),
    matchOfVersion: (name: string, version: string) => view.matchOfVersion(name, version),
    advisoriesOf: (name: string) => view.advisoriesOf(name),
    refreshCalls: 0,
    track() {},
    refresh() {
      stub.refreshCalls++
    },
    status(anyRootScanning: boolean): EnrichmentStatus {
      return {
        state: anyRootScanning ? 'running' : 'done',
        revision: view.revision,
        registry: { total: 0, done: 0, failed: 0 },
        osv: { total: 0, done: 0, skipped: 0, failed: 0 },
        problems: [],
        ...status,
      }
    },
    settled: async () => {},
    close() {},
    publishedCalls: [] as string[],
    async publishedVersions(_root: RootGraph, name: string): Promise<PublishedVersions> {
      stub.publishedCalls.push(name)
      const meta = onDemand.published?.[name]
      return meta ? { state: 'ok', meta } : { state: 'failed', reason: 'not found in the registry' }
    },
    async assess(_root: RootGraph, packages: readonly { name: string; version: string }[]): Promise<AssessedPackage[]> {
      return packages.map(({ name, version }) => ({ name, version, vulnIds: [], ...onDemand.assessed?.[`${name}@${version}`] }))
    },
  }
  return stub
}
