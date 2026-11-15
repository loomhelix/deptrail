import { randomUUID } from 'node:crypto'
import { SEVERITY_ORDER, type EnrichmentView } from '../enrich/types.ts'
import { PLACEHOLDER_PREFIX, type PackageNode, type RootGraph } from '../model.ts'
import { dependentsSummary } from '../query/dependents.ts'
import { nodeAdvisories, worstSeverity } from '../query/enrichment-lookup.ts'
import type { KindFilter } from '../query/lookup.ts'
import { ActionError } from './action-error.ts'
import type { ActionServiceOptions } from './action-service.ts'
import { changedSinceWrite, changedSources, PartialWriteError, revertWrittenFiles, RevertConflictError, writePreviewFiles, type WrittenFiles } from './apply.ts'
import type { ChangeSets, PreviewRecord, RevertRecord } from './change-sets.ts'
import { fileScopeOf } from './file-scope.ts'
import { INSTALL_FAILURE_PREFIX } from './labels.ts'
import { runDryRun } from './dry-run.ts'
import { runFrozenInstall, type InstallOutcome } from './install.ts'
import type { JobContext, JobRun } from './job-registry.ts'
import { actionsOfNode, nodeLabel, requestedItem } from './node-actions.ts'
import { sharingRoots } from './shared-packages.ts'
import { lockfileNameOf, overridesLocationOf } from './root-files.ts'
import type { ChangeItem, JobResult, ManagerInfo, SharingRoot } from './types.ts'

export type JobDeps = { options: ActionServiceOptions; changes: ChangeSets }
export type PreviewSnapshot = { root: RootGraph; manager: ManagerInfo; items: ChangeItem[]; changeRevision: number }
export type ApplyRequest = { record: PreviewRecord; manager: ManagerInfo; install: boolean }
export type CollectRequest = { root: RootGraph; manager: ManagerInfo; kinds: KindFilter }

type SkippedFix = { name: string; reason: string }

const OUT_OF_DATE = 'The preview is out of date; preview again'
const NOTHING_TO_REVERT = 'Nothing to revert'

function filesChangedSinceApply(paths: readonly string[]): string {
  return `Files changed since they were applied: ${paths.join(', ')}`
}

export function currentPreview(changes: ChangeSets, rootId: string, previewId: string): PreviewRecord {
  const record = changes.of(rootId).preview
  if (record === undefined || record.preview.id !== previewId || changes.isStale(rootId, record)) throw new ActionError(409, OUT_OF_DATE)
  return record
}

export async function checkPreviewSources(record: PreviewRecord): Promise<void> {
  const changed = await changedSources(record.scope, record.sources)
  if (changed.length > 0) throw new ActionError(409, `Files changed since the preview: ${changed.join(', ')}`)
}

export function currentRevert(changes: ChangeSets, rootId: string): RevertRecord {
  const record = changes.of(rootId).revert
  if (record === undefined) throw new ActionError(409, NOTHING_TO_REVERT)
  return record
}

export async function checkWrittenFiles(record: RevertRecord): Promise<void> {
  const changed = await changedSinceWrite(record.scope, record.files)
  if (changed.length > 0) throw new ActionError(409, filesChangedSinceApply(changed))
}

export function sharedRootsOf(files: readonly { path: string }[], shared: ReadonlyMap<string, readonly SharingRoot[]>): SharingRoot[] {
  const unique = new Map<string, SharingRoot>()
  for (const file of files) for (const sharing of shared.get(file.path) ?? []) unique.set(sharing.id, sharing)
  return [...unique.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

export function previewJob({ options, changes }: JobDeps, snapshot: PreviewSnapshot): JobRun {
  return async (context) => {
    context.phase('staging')
    const { root, manager, items } = snapshot
    const scope = fileScopeOf(options.repoPath, root)
    const [lockfile, overrides] = await Promise.all([lockfileNameOf(scope.rootDir, manager.name), overridesLocationOf(scope.rootDir, manager)])
    const sharedManifests = sharingRoots(root, options.session.scan.roots)
    const result = await runDryRun({
      previewId: randomUUID(),
      root,
      scope,
      sharedManifests,
      lockfile,
      manager,
      overridesFile: overrides.file,
      items,
      view: options.enrichment,
      assess: (packages) => options.enrichment.assess(root, packages),
      runner: options.runner,
      env: options.env,
      secrets: options.secrets,
      signal: context.signal,
      onPhase: context.phase,
      onLine: context.log,
      now: () => new Date(),
    })
    changes.storePreview(root.id, {
      preview: result.preview,
      graph: root,
      changeRevision: snapshot.changeRevision,
      itemIds: items.map((item) => item.id),
      written: result.written,
      originals: result.originals,
      sources: result.sources,
      lockfileDiff: result.lockfileDiff,
      scope,
      lockfile,
      sharedRoots: sharedRootsOf(result.preview.files, sharedManifests),
    })
    return { previewId: result.preview.id }
  }
}

async function writeKeepingUnrestored({ changes }: JobDeps, record: PreviewRecord): Promise<WrittenFiles> {
  try {
    return await writePreviewFiles(record.scope, record.written, record.lockfile, record.originals)
  } catch (failure) {
    if (failure instanceof PartialWriteError) changes.storeRevert(record.preview.rootId, { scope: record.scope, files: failure.unrestored, items: [], sharedRoots: record.sharedRoots })
    throw failure
  }
}

function installResult(outcome: InstallOutcome | undefined): NonNullable<JobResult['install']> {
  if (outcome === undefined) return 'not-run'
  return outcome.ok ? 'done' : 'failed'
}

async function frozenInstall({ options }: JobDeps, request: ApplyRequest, context: JobContext): Promise<InstallOutcome> {
  context.phase('installing')
  return runFrozenInstall({
    manager: request.manager.name,
    rootDir: request.record.scope.rootDir,
    runner: options.runner,
    env: options.env,
    secrets: options.secrets,
    signal: context.signal,
    onLine: context.log,
  })
}

function writtenPaths(record: PreviewRecord, files: WrittenFiles): string[] {
  const previewed = record.preview.files.map((file) => file.path)
  const written = [...files.hashes.keys()]
  return [...previewed.filter((relativePath) => files.hashes.has(relativePath)), ...written.filter((relativePath) => !previewed.includes(relativePath))]
}

export function applyJob(deps: JobDeps, request: ApplyRequest): JobRun {
  return async (context) => {
    const { record } = request
    const rootId = record.preview.rootId
    context.phase('writing')
    currentPreview(deps.changes, rootId, record.preview.id)
    await checkPreviewSources(record)
    const files = await writeKeepingUnrestored(deps, record)
    const revert = deps.changes.applied(rootId, record, { scope: record.scope, files })
    const install = request.install && !context.signal.aborted ? await frozenInstall(deps, request, context) : undefined
    revert.install = installResult(install)
    context.phase('rescanning')
    await deps.options.session.refreshRoot(rootId)
    if (install !== undefined && !install.ok && !install.cancelled) throw new Error(`${INSTALL_FAILURE_PREFIX} ${install.reason}`)
    return { goalsMet: record.preview.goals.filter((goal) => goal.met).length, install: revert.install, files: writtenPaths(record, files), ...(record.sharedRoots.length > 0 ? { sharedRoots: record.sharedRoots } : {}) }
  }
}

export function revertJob({ options, changes }: JobDeps, rootId: string, record: RevertRecord): JobRun {
  return async (context) => {
    context.phase('writing')
    try {
      await revertWrittenFiles(record.scope, record.files)
    } catch (failure) {
      if (failure instanceof RevertConflictError) throw new ActionError(409, filesChangedSinceApply(failure.paths))
      throw failure
    }
    changes.reverted(rootId, record)
    const { restored, skipped } = changes.restore(rootId, record.items)
    context.phase('rescanning')
    await options.session.refreshRoot(rootId)
    return { restored, skipped, appliedInstall: record.install ?? 'not-run' }
  }
}

function severityRank(view: EnrichmentView, root: RootGraph, node: PackageNode): number | undefined {
  const advisories = nodeAdvisories(view, root, node)
  const worst = worstSeverity(advisories.map((advisory) => advisory.severity))
  return worst === undefined ? undefined : SEVERITY_ORDER.indexOf(worst)
}

function vulnerableNodes(view: EnrichmentView, root: RootGraph, kinds: KindFilter): PackageNode[] {
  const ranked: { node: PackageNode; rank: number }[] = []
  for (const node of root.packages.values()) {
    if (node.id.startsWith(PLACEHOLDER_PREFIX)) continue
    const rank = severityRank(view, root, node)
    if (rank === undefined || dependentsSummary(root, node.id, kinds).importers.length === 0) continue
    ranked.push({ node, rank })
  }
  return ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.node)
}

export function collectJob({ options, changes }: JobDeps, request: CollectRequest): JobRun {
  return async () => {
    const { root, manager, kinds } = request
    const skipped: SkippedFix[] = []
    let added = 0
    for (const node of vulnerableNodes(options.enrichment, root, kinds)) {
      const actions = await actionsOfNode({ repoPath: options.repoPath, enrichment: options.enrichment, root, manager, kinds }, node)
      if (actions.fix?.reason !== undefined) {
        skipped.push({ name: nodeLabel(node), reason: actions.fix.reason })
        continue
      }
      try {
        changes.add(root.id, requestedItem(root, node, actions, { nodeId: node.id, choice: 'recommended' }))
        added++
      } catch (failure) {
        if (!(failure instanceof ActionError)) throw failure
        skipped.push({ name: nodeLabel(node), reason: failure.message })
      }
    }
    return { added, skipped }
  }
}
