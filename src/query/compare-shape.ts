import type { DepKind, NodeId, SourceKind } from '../model.ts'
import type { Severity } from '../enrich/types.ts'

export type CompareSideName = 'base' | 'target'
export type VersionChange = { name: string; change: 'added' | 'removed' | 'upgraded' | 'downgraded' | 'changed'; base: string[]; target: string[]; targetNode?: NodeId }
export type DirectChange = {
  importer: string
  importerName: string
  name: string
  kind: DepKind
  change: 'added' | 'removed' | 'changed'
  base?: string
  target?: string
  targetNode?: NodeId
}
export type ImporterChange = { path: string; name: string; change: 'added' | 'removed' }
export type RiskChange = {
  name: string
  version: string
  issue: 'vulnerability' | 'deprecated'
  change: 'introduced' | 'resolved'
  severity?: Severity
  targetNode?: NodeId
}
export type CompareNote =
  | { side: CompareSideName; kind: 'inexact'; source: SourceKind }
  | { side: CompareSideName; kind: 'failed'; error: string }
  | { side: CompareSideName; kind: 'submodule' }
export type RootComparison = {
  rootId: string
  presence: 'both' | 'base-only' | 'target-only'
  state: 'ready' | 'scanning' | 'failed'
  notes: CompareNote[]
  exact: boolean
  versions: VersionChange[]
  directs: DirectChange[]
  importers: ImporterChange[]
  risk: RiskChange[]
  riskPending: number
}
export type CompareResponse = { revision: number; complete: boolean; roots: RootComparison[] }

function sourceDiffers(notes: readonly CompareNote[]): boolean {
  const sources = notes.flatMap((note) => (note.kind === 'inexact' ? [note.source] : []))
  return sources.length === 1 || new Set(sources).size > 1
}

export function hasChanges(root: RootComparison): boolean {
  return (
    root.presence !== 'both' ||
    root.state !== 'ready' ||
    sourceDiffers(root.notes) ||
    root.versions.length > 0 ||
    root.directs.length > 0 ||
    root.importers.length > 0 ||
    root.risk.length > 0
  )
}
