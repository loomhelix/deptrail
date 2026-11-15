import { posix } from 'node:path'
import { valid } from 'semver'
import { parse } from 'yaml'
import type { RootGraphBuilder } from '../graph/root-graph-builder.ts'
import { IMPORTER_PREFIX, type DepKind, type Edge, type NodeId } from '../model.ts'

type UnknownRecord = Record<string, unknown>
type BlockKinds = ReadonlyArray<readonly [blockName: string, kind: DepKind]>
type PackageIdentity = { name: string; version: string; peerSuffix?: string }
type KnownPackages = ReadonlyMap<NodeId, PackageIdentity>
type PackageRecord = { id: NodeId; identity: PackageIdentity; entry: UnknownRecord; peerRanges: UnknownRecord }
type Resolution = { layout: LockLayout; knownPackages: KnownPackages }
type LockLayout = {
  toNodeId(dependencyName: string, value: string, knownPackages: KnownPackages): NodeId
  readPackageRecords(document: UnknownRecord): PackageRecord[]
}

const ROOT_IMPORTER_PATH = '.'
const LINK_PREFIX = 'link:'
const FIRST_SUPPORTED_VERSION = 6
const FIRST_SNAPSHOT_VERSION = 9
const LATEST_SUPPORTED_MAJOR_VERSION = 9
const ALIAS_PATTERN = /^(?:@[^/@]+\/)?[^/@(]+@/
const NON_REGISTRY_RESOLUTION_TYPES: ReadonlySet<unknown> = new Set(['git', 'directory'])
const DOCUMENT_START = '---\n'
const DOCUMENT_SEPARATOR = '\n---\n'
const SKIP_DUPLICATE_KEY_CHECK = { uniqueKeys: false }

const IMPORTER_BLOCKS: BlockKinds = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
]

const PACKAGE_BLOCKS: BlockKinds = [
  ['dependencies', 'prod'],
  ['optionalDependencies', 'optional'],
]

const SNAPSHOT_LAYOUT: LockLayout = {
  toNodeId(dependencyName, value) {
    return ALIAS_PATTERN.test(value) ? value : `${dependencyName}@${value}`
  },
  readPackageRecords(document) {
    const metadata = recordOf(document.packages)
    return Object.entries(recordOf(document.snapshots)).map(([id, entry]) => {
      const packageMetadata = recordOf(metadata[withoutPeerSuffix(id)])
      return {
        id,
        identity: identityOf(id, packageMetadata),
        entry: recordOf(entry),
        peerRanges: recordOf(packageMetadata.peerDependencies),
      }
    })
  },
}

const PACKAGES_LAYOUT: LockLayout = {
  toNodeId(dependencyName, value, knownPackages) {
    if (knownPackages.has(value)) return value
    const slashedValue = value.startsWith('/') ? value : `/${value}`
    if (knownPackages.has(slashedValue)) return slashedValue
    if (value.startsWith('/') || ALIAS_PATTERN.test(value)) return slashedValue
    return `/${dependencyName}@${value}`
  },
  readPackageRecords(document) {
    return Object.entries(recordOf(document.packages)).map(([id, entry]) => {
      const record = recordOf(entry)
      return { id, identity: identityOf(id, record), entry: record, peerRanges: recordOf(record.peerDependencies) }
    })
  },
}

export function parsePnpmLock(text: string, builder: RootGraphBuilder): { supported: boolean } {
  const document = recordOf(parse(extractMainDocument(text), SKIP_DUPLICATE_KEY_CHECK))
  const layout = selectLayout(document.lockfileVersion)
  if (!layout) {
    builder.warn(`pnpm lockfile version ${String(document.lockfileVersion)} is not supported`)
    return { supported: false }
  }
  if (isNewerThanSupported(document.lockfileVersion)) {
    builder.warn(`pnpm lockfile version ${String(document.lockfileVersion)} is newer than supported; results may be incomplete`)
  }
  const importerSections = readImporterSections(document)
  const packageRecords = layout.readPackageRecords(document)
  const resolution: Resolution = {
    layout,
    knownPackages: new Map(packageRecords.map((record) => [record.id, record.identity])),
  }
  for (const importerPath of Object.keys(importerSections)) builder.addImporter(importerPath, importerPath)
  for (const record of packageRecords) {
    builder.addPackage(record.id, record.identity.name, record.identity.version, record.identity.peerSuffix)
    if (isNonRegistryRecord(record)) builder.markNonRegistry(record.id)
  }
  for (const [importerPath, section] of Object.entries(importerSections)) {
    addImporterEdges(builder, resolution, importerPath, recordOf(section))
  }
  for (const record of packageRecords) addPackageEdges(builder, resolution, record)
  return { supported: true }
}

function isNonRegistryRecord(record: PackageRecord): boolean {
  const resolutionType = recordOf(record.entry.resolution).type
  return valid(parsePackageKey(record.id).version) === null || NON_REGISTRY_RESOLUTION_TYPES.has(resolutionType)
}

function extractMainDocument(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(DOCUMENT_START)) return normalized
  const separatorStart = normalized.indexOf(DOCUMENT_SEPARATOR)
  return separatorStart === -1 ? normalized : normalized.slice(separatorStart + DOCUMENT_SEPARATOR.length)
}

function selectLayout(lockfileVersion: unknown): LockLayout | undefined {
  const version = Number.parseFloat(String(lockfileVersion))
  if (!Number.isFinite(version) || version < FIRST_SUPPORTED_VERSION) return undefined
  return version >= FIRST_SNAPSHOT_VERSION ? SNAPSHOT_LAYOUT : PACKAGES_LAYOUT
}

function isNewerThanSupported(lockfileVersion: unknown): boolean {
  return Math.trunc(Number.parseFloat(String(lockfileVersion))) > LATEST_SUPPORTED_MAJOR_VERSION
}

function readImporterSections(document: UnknownRecord): UnknownRecord {
  return isRecord(document.importers) ? document.importers : { [ROOT_IMPORTER_PATH]: document }
}

function addImporterEdges(
  builder: RootGraphBuilder,
  resolution: Resolution,
  importerPath: string,
  section: UnknownRecord,
): void {
  const from = IMPORTER_PREFIX + importerPath
  for (const [blockName, kind] of IMPORTER_BLOCKS) {
    for (const [name, dependency] of Object.entries(recordOf(section[blockName]))) {
      const { specifier, version } = recordOf(dependency)
      if (typeof version !== 'string') continue
      const to = resolveTargetId(resolution, name, version, importerPath)
      builder.addEdge(from, { to, kind, range: typeof specifier === 'string' ? specifier : version })
    }
  }
}

function addPackageEdges(builder: RootGraphBuilder, resolution: Resolution, record: PackageRecord): void {
  for (const [blockName, blockKind] of PACKAGE_BLOCKS) {
    for (const [name, value] of Object.entries(recordOf(record.entry[blockName]))) {
      if (typeof value !== 'string') continue
      builder.addEdge(record.id, toPackageEdge(resolution, record.peerRanges, blockKind, name, value))
    }
  }
}

function toPackageEdge(
  resolution: Resolution,
  peerRanges: UnknownRecord,
  blockKind: DepKind,
  name: string,
  value: string,
): Edge {
  const to = resolveTargetId(resolution, name, value, ROOT_IMPORTER_PATH)
  const peerRange = peerRanges[name]
  if (typeof peerRange === 'string') return { to, kind: 'peer', range: peerRange }
  return { to, kind: blockKind, range: resolvedVersionOf(resolution, to, value) }
}

function resolvedVersionOf(resolution: Resolution, targetId: NodeId, value: string): string {
  if (targetId.startsWith(IMPORTER_PREFIX)) return value
  return (resolution.knownPackages.get(targetId) ?? parsePackageKey(targetId)).version
}

function resolveTargetId(resolution: Resolution, name: string, value: string, ownerPath: string): NodeId {
  if (!value.startsWith(LINK_PREFIX)) return resolution.layout.toNodeId(name, value, resolution.knownPackages)
  return IMPORTER_PREFIX + posix.join(ownerPath, value.slice(LINK_PREFIX.length))
}

function identityOf(key: string, declared: UnknownRecord): PackageIdentity {
  const parsed = parsePackageKey(key)
  return {
    ...parsed,
    name: typeof declared.name === 'string' ? declared.name : parsed.name,
    version: typeof declared.version === 'string' ? declared.version : parsed.version,
  }
}

function parsePackageKey(key: string): PackageIdentity {
  const unprefixed = key.startsWith('/') ? key.slice(1) : key
  const head = withoutPeerSuffix(unprefixed)
  const versionSeparator = head.indexOf('@', 1)
  const name = versionSeparator === -1 ? head : head.slice(0, versionSeparator)
  const version = versionSeparator === -1 ? '' : head.slice(versionSeparator + 1)
  if (head.length === unprefixed.length) return { name, version }
  return { name, version, peerSuffix: unprefixed.slice(head.length) }
}

function withoutPeerSuffix(key: string): string {
  const suffixStart = key.indexOf('(')
  return suffixStart === -1 ? key : key.slice(0, suffixStart)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}
