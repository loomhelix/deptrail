export type NodeId = string
export type DepKind = 'prod' | 'dev' | 'optional' | 'peer'
export type Manager = 'pnpm' | 'npm' | 'unknown'
export type SourceKind = 'lockfile' | 'installed' | 'resolved-today' | 'manifest-only'
export type RootStatus = 'scanning' | 'ready' | 'failed'
export type Edge = { to: NodeId; kind: DepKind; range: string }
export type PackageNode = {
  id: NodeId
  name: string
  version: string
  peerSuffix?: string
  nonRegistry?: true
  deps: Edge[]
  dependents: NodeId[]
}
export type Importer = { id: NodeId; path: string; name: string; deps: Edge[]; dependents: NodeId[] }
export type RootConfig = {
  registry: string
  scopedRegistries: Record<string, string>
  hasAuth: boolean
  catalogs: Record<string, Record<string, string>>
  overrides: Record<string, string>
  workspacePatterns: string[]
  warnings: string[]
}
export type RootDescriptor = {
  id: string
  path: string
  manager: Manager
  lockfile?: string
  importerPaths: string[]
}
export type RootGraph = {
  id: string
  path: string
  manager: Manager
  source: SourceKind
  status: RootStatus
  error?: string
  importers: Importer[]
  packages: Map<NodeId, PackageNode>
  warnings: string[]
  config?: RootConfig
}
export type Scan = { repoPath: string; roots: RootGraph[]; scannedAt: string; skippedSubmodules?: string[] }
export const IMPORTER_PREFIX = 'importer:'
export const PLACEHOLDER_PREFIX = '?:'
