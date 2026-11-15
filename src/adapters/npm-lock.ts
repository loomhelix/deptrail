import type { RootGraphBuilder } from '../graph/root-graph-builder.ts'
import { IMPORTER_PREFIX, type DepKind, type NodeId } from '../model.ts'

type UnknownRecord = Record<string, unknown>
type BlockKinds = ReadonlyArray<readonly [blockName: string, kind: DepKind]>
type InstallIndex = { nodeIdByKey: ReadonlyMap<string, NodeId>; importerKeys: ReadonlySet<string> }
type LockRecord = { id: NodeId; key: string; entry: UnknownRecord }
type ImporterRecord = LockRecord & { path: string; name: string }
type PackageRecord = LockRecord & { name: string; version: string }
type LockContents = { importers: ImporterRecord[]; packages: PackageRecord[]; index: InstallIndex }

const ROOT_IMPORTER_PATH = '.'
const ROOT_KEY = ''
const FIRST_SUPPORTED_VERSION = 2
const LATEST_SUPPORTED_VERSION = 3
const MODULES_DIRECTORY = 'node_modules/'
const NESTED_MODULES_DIRECTORY = '/node_modules/'
const OPTIONAL_KINDS: ReadonlySet<DepKind> = new Set<DepKind>(['optional', 'peer'])

const IMPORTER_BLOCKS: BlockKinds = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
]

const PACKAGE_BLOCKS: BlockKinds = [
  ['dependencies', 'prod'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
]

export function parseNpmLock(text: string, builder: RootGraphBuilder): { supported: boolean } {
  const document = recordOf(JSON.parse(text))
  if (!isSupportedVersion(document.lockfileVersion)) {
    builder.warn(`npm lockfile version ${String(document.lockfileVersion)} is not supported`)
    return { supported: false }
  }
  if (isNewerThanSupported(document.lockfileVersion)) {
    builder.warn(`npm lockfile version ${String(document.lockfileVersion)} is newer than supported; results may be incomplete`)
  }
  const { importers, packages, index } = readLockContents(recordOf(document.packages))
  for (const importer of importers) builder.addImporter(importer.path, importer.name)
  for (const record of packages) {
    builder.addPackage(record.id, record.name, record.version)
    if (isNonRegistryResolution(record.entry.resolved)) builder.markNonRegistry(record.id)
  }
  for (const importer of importers) addDependencyEdges(builder, index, importer, IMPORTER_BLOCKS)
  for (const record of packages) addDependencyEdges(builder, index, record, PACKAGE_BLOCKS)
  return { supported: true }
}

function isNonRegistryResolution(resolved: unknown): boolean {
  return typeof resolved === 'string' && !resolved.startsWith('http://') && !resolved.startsWith('https://')
}

function isSupportedVersion(lockfileVersion: unknown): boolean {
  const version = Number.parseFloat(String(lockfileVersion))
  return Number.isFinite(version) && version >= FIRST_SUPPORTED_VERSION
}

function isNewerThanSupported(lockfileVersion: unknown): boolean {
  return Number.parseFloat(String(lockfileVersion)) > LATEST_SUPPORTED_VERSION
}

function readLockContents(packagesBlock: UnknownRecord): LockContents {
  const importers: ImporterRecord[] = []
  const packages: PackageRecord[] = []
  const nodeIdByKey = new Map<string, NodeId>()
  const importerKeys = new Set<string>()
  for (const [key, value] of Object.entries(packagesBlock)) {
    const entry = recordOf(value)
    if (!isInstallPath(key)) {
      importers.push(toImporterRecord(key, entry))
      importerKeys.add(key)
    } else if (entry.link === true) {
      if (typeof entry.resolved === 'string') nodeIdByKey.set(key, IMPORTER_PREFIX + entry.resolved)
    } else {
      const record = toPackageRecord(key, entry)
      packages.push(record)
      nodeIdByKey.set(key, record.id)
    }
  }
  return { importers, packages, index: { nodeIdByKey, importerKeys } }
}

function isInstallPath(key: string): boolean {
  return key.startsWith(MODULES_DIRECTORY) || key.includes(NESTED_MODULES_DIRECTORY)
}

function toImporterRecord(key: string, entry: UnknownRecord): ImporterRecord {
  const path = key === ROOT_KEY ? ROOT_IMPORTER_PATH : key
  return { id: IMPORTER_PREFIX + path, key, entry, path, name: typeof entry.name === 'string' ? entry.name : path }
}

function toPackageRecord(key: string, entry: UnknownRecord): PackageRecord {
  const name = typeof entry.name === 'string' ? entry.name : nameFromInstallPath(key)
  const version = typeof entry.version === 'string' ? entry.version : ''
  return { id: `${name}@${version}`, key, entry, name, version }
}

function nameFromInstallPath(key: string): string {
  const nestedStart = key.lastIndexOf(NESTED_MODULES_DIRECTORY)
  const nameStart = nestedStart === -1 ? MODULES_DIRECTORY.length : nestedStart + NESTED_MODULES_DIRECTORY.length
  return key.slice(nameStart)
}

function addDependencyEdges(
  builder: RootGraphBuilder,
  index: InstallIndex,
  record: LockRecord,
  blocks: BlockKinds,
): void {
  let lookupPrefixes: string[] | undefined
  for (const [blockName, kind] of blocks) {
    const declared = record.entry[blockName]
    if (!isRecord(declared)) continue
    lookupPrefixes ??= modulesPrefixesFrom(record.key, index.importerKeys)
    for (const [name, range] of Object.entries(declared)) {
      if (typeof range !== 'string') continue
      const to = findInstalled(index.nodeIdByKey, lookupPrefixes, name) ?? unresolvedTarget(kind, name, range)
      if (to !== undefined) builder.addEdge(record.id, { to, kind, range })
    }
  }
}

function modulesPrefixesFrom(key: string, importerKeys: ReadonlySet<string>): string[] {
  const prefixes: string[] = []
  for (let scope = key; scope !== ROOT_KEY; scope = parentScope(scope, importerKeys)) {
    prefixes.push(scope + NESTED_MODULES_DIRECTORY)
  }
  prefixes.push(MODULES_DIRECTORY)
  return prefixes
}

function parentScope(scope: string, importerKeys: ReadonlySet<string>): string {
  const nestedStart = scope.lastIndexOf(NESTED_MODULES_DIRECTORY)
  if (nestedStart !== -1) return scope.slice(0, nestedStart)
  if (scope.startsWith(MODULES_DIRECTORY)) return ROOT_KEY
  return nearestEnclosingImporter(scope, importerKeys)
}

function nearestEnclosingImporter(path: string, importerKeys: ReadonlySet<string>): string {
  for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
    const candidate = path.slice(0, end)
    if (importerKeys.has(candidate)) return candidate
  }
  return ROOT_KEY
}

function findInstalled(
  nodeIdByKey: ReadonlyMap<string, NodeId>,
  prefixes: readonly string[],
  name: string,
): NodeId | undefined {
  for (const prefix of prefixes) {
    const nodeId = nodeIdByKey.get(prefix + name)
    if (nodeId !== undefined) return nodeId
  }
  return undefined
}

function unresolvedTarget(kind: DepKind, name: string, range: string): NodeId | undefined {
  return OPTIONAL_KINDS.has(kind) ? undefined : `${name}@${range}`
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}
