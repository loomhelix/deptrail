import type { DepKind, NodeId } from '../model.ts'
import type { Severity } from '../enrich/types.ts'
import type { PackageChange } from '../query/graph-diff.ts'

export type PackageManagerName = 'pnpm' | 'npm'
export type SharingRoot = { id: string; manager: PackageManagerName }
export type ManagerInfo = { name: PackageManagerName; version: string }
export type DependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies'
export type OverridesFile = 'pnpm-workspace.yaml' | 'package.json#pnpm.overrides' | 'package.json#overrides'
export type RelockStep = { kind: 'relock'; name: string; from: string; to: string; reason: string }
export type SetRangeStep = { kind: 'set-range'; importer: NodeId; dependency: string; field: DependencyField; place: 'manifest' | 'catalog'; catalog?: string; from: string; to: string; reason: string }
export type OverrideStep = { kind: 'override'; selector: string; value: string; file: OverridesFile; reason: string }
export type Step = RelockStep | SetRangeStep | OverrideStep
export type FixGoal = { kind: 'fix'; name: string; version: string; advisoryIds: string[]; severity: Severity }
export type UpdateGoal = { kind: 'update'; name: string; importers: NodeId[]; target: string }
export type Goal = FixGoal | UpdateGoal
export type FixChoice = 'relock' | 'chain' | 'override'
export type UpdateChoice = 'wanted' | 'latest' | 'version'
export type Choice = FixChoice | UpdateChoice
export type ChangeItem = { id: string; goal: Goal; choice: Choice; steps: Step[]; warnings: string[] }
export type FixOption = { choice: FixChoice; recommended: boolean; steps: Step[]; warnings: string[] }
export type FixActions = { goal: FixGoal; options: FixOption[]; unavailable: { choice: FixChoice; reason: string }[]; reason?: string }
export type UpdateImporter = { id: NodeId; field: DependencyField; alias?: string; specifier: string; editable: boolean; reason?: string; template?: string; peerRange?: string }
export type UpdateVersion = { version: string; severity?: Severity; deprecated?: true; prerelease?: true }
export type UpdateActions = { name: string; current: string; wanted?: string; latest?: string; versions: UpdateVersion[]; importers: UpdateImporter[] }
export type NodeActions = { fix?: FixActions; update?: UpdateActions; unavailable?: string }
export type JobKind = 'preview' | 'apply' | 'revert' | 'collect'
export type JobState = 'running' | 'done' | 'failed' | 'cancelled'
export type JobPhase = 'staging' | 'resolving' | 'checking' | 'writing' | 'installing' | 'rescanning'
export type JobResult = { previewId?: string; added?: number; skipped?: { name: string; reason: string }[]; goalsMet?: number; install?: 'done' | 'failed' | 'not-run'; restored?: number; appliedInstall?: 'done' | 'failed' | 'not-run'; files?: string[]; sharedRoots?: SharingRoot[] }
export type Job = { id: string; rootId: string; kind: JobKind; state: JobState; phase?: JobPhase; log: string[]; firstLine: number; error?: string; result?: JobResult }
export type PreviewGoal = { itemId: string; met: boolean; detail: string }
export type NewIssue = { name: string; version: string; severity?: Severity; vulnIds: string[]; deprecated?: string; notChecked?: string }
export type PreviewFile = { path: string; change: 'modified' | 'created'; added: number; removed: number; diff?: string; diffTruncated?: true; sharedWith?: string[] }
export type Preview = { id: string; rootId: string; createdAt: string; stale: boolean; manager: ManagerInfo; goals: PreviewGoal[]; newIssues: NewIssue[]; warnings: string[]; files: PreviewFile[]; packageChanges: PackageChange[]; outsidePackages?: number }
export type ActionsSummary = { available: boolean; reason?: string; changeCount: number; job?: Pick<Job, 'id' | 'kind' | 'state' | 'phase'>; revertable: boolean }
export type AddChangeRequest = { nodeId: NodeId; choice: Choice | 'recommended'; version?: string; importers?: NodeId[]; kinds?: DepKind[] }
export type RestoreResult = { restored: number; skipped: { name: string; reason: string }[] }
export type ChangesResponse = { items: ChangeItem[]; preview?: Preview; job?: Job; revertable: boolean; installByDefault: boolean; revert?: { files: string[]; itemCount: number; sharedRoots?: SharingRoot[] } }
