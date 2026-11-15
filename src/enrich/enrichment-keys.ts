import semver from 'semver'
import { PLACEHOLDER_PREFIX, type PackageNode, type RootConfig, type RootGraph } from '../model.ts'
import { versionKey } from './osv-client.ts'

export type TrackableRoot = RootGraph & { config: RootConfig }
export type RegistryTarget = {
  key: string
  registryUrl: string
  name: string
  versionsInUse: Set<string>
  credentialsRoot: TrackableRoot
}
export type VersionTarget = { key: string; name: string; version: string }
export type KeyPlan = {
  roots: TrackableRoot[]
  registry: Map<string, RegistryTarget>
  versions: Map<string, VersionTarget>
  skippedVersions: number
  privateScopes: ReadonlySet<string>
  waitsForScanningRoots: boolean
}

const KEY_SEPARATOR = '\0'

export function isTrackable(root: RootGraph): root is TrackableRoot {
  return root.status === 'ready' && root.config !== undefined
}

export function isPlaceholder(node: PackageNode): boolean {
  return node.id.startsWith(PLACEHOLDER_PREFIX)
}

export function isRegistryPackage(node: PackageNode): boolean {
  return node.nonRegistry !== true && !isPlaceholder(node)
}

function scopeOf(name: string): string | undefined {
  const slash = name.indexOf('/')
  return name.startsWith('@') && slash > 0 ? name.slice(0, slash) : undefined
}

export function inPrivateScope(name: string, privateScopes: ReadonlySet<string>): boolean {
  const scope = scopeOf(name)
  return scope !== undefined && privateScopes.has(scope)
}

export function hasKnownVersion(version: string): boolean {
  return semver.valid(version) !== null
}

export function registryUrlOf(config: RootConfig, name: string): string {
  const scope = scopeOf(name)
  const configured = (scope === undefined ? undefined : config.scopedRegistries[scope]) ?? config.registry
  return configured.endsWith('/') ? configured : `${configured}/`
}

export function registryKeyOf(registryUrl: string, name: string): string {
  return `${registryUrl}${KEY_SEPARATOR}${name}`
}

function addRegistryTarget(registry: Map<string, RegistryTarget>, root: TrackableRoot, node: PackageNode): void {
  const registryUrl = registryUrlOf(root.config, node.name)
  const key = registryKeyOf(registryUrl, node.name)
  const existing = registry.get(key)
  if (existing !== undefined) {
    existing.versionsInUse.add(node.version)
    return
  }
  registry.set(key, { key, registryUrl, name: node.name, versionsInUse: new Set([node.version]), credentialsRoot: root })
}

export function planKeys(roots: readonly RootGraph[], privateScopesSoFar: ReadonlySet<string>): KeyPlan {
  const trackable = roots.filter(isTrackable)
  const privateScopes = new Set([...privateScopesSoFar, ...trackable.flatMap((root) => Object.keys(root.config.scopedRegistries))])
  const registry = new Map<string, RegistryTarget>()
  const versions = new Map<string, VersionTarget>()
  const skipped = new Set<string>()
  for (const root of trackable) {
    for (const node of root.packages.values()) {
      if (!isRegistryPackage(node)) continue
      addRegistryTarget(registry, root, node)
      const key = versionKey(node.name, node.version)
      if (versions.has(key) || skipped.has(key)) continue
      if (inPrivateScope(node.name, privateScopes) || !hasKnownVersion(node.version)) skipped.add(key)
      else versions.set(key, { key, name: node.name, version: node.version })
    }
  }
  return {
    roots: trackable,
    registry,
    versions,
    skippedVersions: skipped.size,
    privateScopes,
    waitsForScanningRoots: roots.some((root) => root.status === 'scanning'),
  }
}
