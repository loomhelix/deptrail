import path from 'node:path'
import type { ProcessRunner } from '../adapters/command-runner.ts'
import type { SecretSet } from '../config/secrets.ts'
import type { EnrichmentService } from '../enrich/enrichment-service.ts'
import type { NodeId, RootGraph } from '../model.ts'
import { findNode, type GraphNode, type KindFilter } from '../query/lookup.ts'
import type { ScanSession } from '../scan/scan-session.ts'
import { ActionError } from './action-error.ts'
import { applyJob, checkPreviewSources, checkWrittenFiles, collectJob, currentPreview, currentRevert, previewJob, revertJob, type JobDeps } from './action-jobs.ts'
import { SCANNING_REASON, createAvailability } from './availability.ts'
import { createChangeSets, type RevertRecord } from './change-sets.ts'
import { createJobRegistry, type JobRun } from './job-registry.ts'
import { actionsOfNode, kindFilterOf, requestedItem } from './node-actions.ts'
import { REPOSITORY_ROOT_ID } from './labels.ts'
import { pathExists, rootDirOf } from './root-files.ts'
import { removeActionSandboxes } from './sandbox.ts'
import { sharesWorkspacePackage } from './shared-packages.ts'
import type { ActionsSummary, AddChangeRequest, ChangeItem, ChangesResponse, Job, JobKind, ManagerInfo, NodeActions, RestoreResult } from './types.ts'

export { ActionError }

export type ActionServiceOptions = {
  repoPath: string
  session: ScanSession
  enrichment: EnrichmentService
  runner: ProcessRunner
  env: Record<string, string | undefined>
  offline: boolean
  secrets: SecretSet
}

export type ActionService = {
  track(roots: readonly RootGraph[]): void
  summary(root: RootGraph): ActionsSummary
  isBusy(rootId: string): boolean
  anyBusy(): boolean
  nodeActions(rootId: string, nodeId: NodeId, kinds: KindFilter): Promise<NodeActions>
  changes(rootId: string): Promise<ChangesResponse>
  addChange(rootId: string, request: AddChangeRequest): Promise<ChangeItem>
  replaceChange(rootId: string, itemId: string, request: AddChangeRequest): Promise<ChangeItem>
  removeChange(rootId: string, itemId: string): void
  clearChanges(rootId: string): void
  restoreCleared(rootId: string): RestoreResult
  startCollect(rootId: string, kinds: KindFilter): Job
  startPreview(rootId: string): Job
  previewFileDiff(rootId: string, index: number): { diff: string; truncated: boolean }
  startApply(rootId: string, previewId: string, install: boolean): Promise<Job>
  startRevert(rootId: string): Promise<Job>
  job(jobId: string, since: number): Job
  cancelJob(jobId: string): void
  close(): Promise<void>
}

type AvailableRoot = { root: RootGraph; manager: ManagerInfo }

const EMPTY_CHANGE_SET = 'There are no changes to preview'
const NO_PREVIEW = 'No preview'
const NOT_CANCELABLE = 'This job cannot be canceled now'
const NODE_MODULES = 'node_modules'
const WRITING_KINDS: readonly JobKind[] = ['apply', 'revert']
const WITHOUT_LOG_LINES = Number.MAX_SAFE_INTEGER

function unknownJob(jobId: string): ActionError {
  return new ActionError(404, `Unknown job ${jobId}`)
}

function summaryJob(job: Job): NonNullable<ActionsSummary['job']> {
  return { id: job.id, kind: job.kind, state: job.state, ...(job.phase === undefined ? {} : { phase: job.phase }) }
}

function revertSummary(record: RevertRecord): NonNullable<ChangesResponse['revert']> {
  const sharedRoots = record.sharedRoots ?? []
  return { files: [...record.files.hashes.keys()], itemCount: record.items.length, ...(sharedRoots.length > 0 ? { sharedRoots } : {}) }
}

function isCancellable(job: Job): boolean {
  if (job.state !== 'running') return false
  return job.kind === 'preview' || (job.kind === 'apply' && job.phase === 'installing')
}

export function createActionService(options: ActionServiceOptions): ActionService {
  const { session } = options
  const jobs = createJobRegistry(options.secrets)
  const availability = createAvailability(options)
  const changeSets = createChangeSets((rootId) => session.root(rootId))
  const deps: JobDeps = { options, changes: changeSets }
  const jobRoots = new Set<string>()
  const activeRuns = new Set<Promise<unknown>>()
  let closed = false

  function requireRoot(rootId: string): RootGraph {
    const root = session.root(rootId)
    if (root === undefined) throw new ActionError(404, `Unknown root ${rootId}`)
    return root
  }

  function requireAvailable(root: RootGraph): ManagerInfo {
    const check = availability.check(root)
    if ('reason' in check) throw new ActionError(409, check.reason)
    return check.manager
  }

  async function availableRoot(rootId: string): Promise<AvailableRoot> {
    const root = requireRoot(rootId)
    await availability.probe(root)
    return { root, manager: requireAvailable(root) }
  }

  function requireIdle(rootId: string): void {
    if (jobs.running(rootId) !== undefined) throw new ActionError(409, `A job is already running for ${rootId}`)
  }

  function requireNoSharedWrite(root: RootGraph): void {
    for (const other of session.scan.roots) {
      if (!sharesWorkspacePackage(root, other)) continue
      const running = jobs.running(other.id)
      if (running === undefined || !WRITING_KINDS.includes(running.kind)) continue
      throw new ActionError(409, `An apply or revert is running in ${other.id === REPOSITORY_ROOT_ID ? 'the repository root' : other.id}, which shares workspace packages with this root`)
    }
  }

  function launch(rootId: string, kind: JobKind, run: JobRun): Job {
    jobRoots.add(rootId)
    return jobs.start(rootId, kind, (context) => {
      const running = run(context)
      activeRuns.add(running)
      const forget = (): void => {
        activeRuns.delete(running)
      }
      running.then(forget, forget)
      return running
    })
  }

  function nodeOf(root: RootGraph, nodeId: NodeId): GraphNode {
    const node = findNode(root, nodeId)
    if (node === undefined) throw new ActionError(404, `Unknown node ${nodeId}`)
    return node
  }

  async function requestedChange(rootId: string, request: AddChangeRequest): Promise<ChangeItem> {
    const { root, manager } = await availableRoot(rootId)
    const node = nodeOf(root, request.nodeId)
    const kinds = kindFilterOf(request.kinds)
    const actions = await actionsOfNode({ repoPath: options.repoPath, enrichment: options.enrichment, root, manager, kinds }, node)
    return requestedItem(root, node, actions, request)
  }

  return {
    track(roots) {
      if (closed) return
      for (const root of roots) void availability.probe(root)
    },
    summary(root) {
      const check = availability.check(root)
      const changes = changeSets.of(root.id)
      const job = jobs.latest(root.id)
      return {
        available: !('reason' in check),
        ...('reason' in check ? { reason: check.reason } : {}),
        changeCount: changes.items.length,
        ...(job === undefined ? {} : { job: summaryJob(job) }),
        revertable: changes.revert !== undefined,
      }
    },
    isBusy(rootId) {
      return jobs.running(rootId) !== undefined
    },
    anyBusy() {
      return [...jobRoots].some((rootId) => jobs.running(rootId) !== undefined)
    },
    async nodeActions(rootId, nodeId, kinds) {
      const root = requireRoot(rootId)
      await availability.probe(root)
      const check = availability.check(root)
      if ('reason' in check) return { unavailable: check.reason }
      return actionsOfNode({ repoPath: options.repoPath, enrichment: options.enrichment, root, manager: check.manager, kinds }, nodeOf(root, nodeId))
    },
    async changes(rootId) {
      const root = requireRoot(rootId)
      void availability.probe(root)
      const installByDefault = await pathExists(path.join(rootDirOf(options.repoPath, root), NODE_MODULES))
      const changes = changeSets.of(rootId)
      const preview = changeSets.preview(rootId)
      const job = jobs.latest(rootId)
      return {
        items: [...changes.items],
        ...(preview === undefined ? {} : { preview }),
        ...(job === undefined ? {} : { job }),
        revertable: changes.revert !== undefined,
        ...(changes.revert === undefined ? {} : { revert: revertSummary(changes.revert) }),
        installByDefault,
      }
    },
    async addChange(rootId, request) {
      return changeSets.add(rootId, await requestedChange(rootId, request))
    },
    async replaceChange(rootId, itemId, request) {
      return changeSets.replace(rootId, itemId, await requestedChange(rootId, request))
    },
    removeChange(rootId, itemId) {
      requireRoot(rootId)
      changeSets.remove(rootId, itemId)
    },
    clearChanges(rootId) {
      requireRoot(rootId)
      changeSets.clear(rootId)
    },
    restoreCleared(rootId) {
      requireRoot(rootId)
      return changeSets.restoreCleared(rootId)
    },
    startCollect(rootId, kinds) {
      const root = requireRoot(rootId)
      const manager = requireAvailable(root)
      requireIdle(rootId)
      return launch(rootId, 'collect', collectJob(deps, { root, manager, kinds }))
    },
    startPreview(rootId) {
      const root = requireRoot(rootId)
      const manager = requireAvailable(root)
      requireIdle(rootId)
      const changes = changeSets.of(rootId)
      if (changes.items.length === 0) throw new ActionError(409, EMPTY_CHANGE_SET)
      return launch(rootId, 'preview', previewJob(deps, { root, manager, items: [...changes.items], changeRevision: changes.revision }))
    },
    previewFileDiff(rootId, index) {
      requireRoot(rootId)
      const record = changeSets.of(rootId).preview
      if (record === undefined) throw new ActionError(404, NO_PREVIEW)
      const file = record.preview.files[index]
      if (file === undefined) throw new ActionError(404, `Unknown file ${index}`)
      return file.path === record.lockfile ? { ...record.lockfileDiff } : { diff: file.diff ?? '', truncated: false }
    },
    async startApply(rootId, previewId, install) {
      const { root, manager } = await availableRoot(rootId)
      requireIdle(rootId)
      requireNoSharedWrite(root)
      await checkPreviewSources(currentPreview(changeSets, rootId, previewId))
      requireIdle(rootId)
      requireNoSharedWrite(root)
      const record = currentPreview(changeSets, rootId, previewId)
      return launch(rootId, 'apply', applyJob(deps, { record, manager, install }))
    },
    async startRevert(rootId) {
      const root = requireRoot(rootId)
      if (root.status === 'scanning') throw new ActionError(409, SCANNING_REASON)
      requireIdle(rootId)
      requireNoSharedWrite(root)
      await checkWrittenFiles(currentRevert(changeSets, rootId))
      requireIdle(rootId)
      requireNoSharedWrite(root)
      return launch(rootId, 'revert', revertJob(deps, rootId, currentRevert(changeSets, rootId)))
    },
    job(jobId, since) {
      const job = jobs.get(jobId, since)
      if (job === undefined) throw unknownJob(jobId)
      return job
    },
    cancelJob(jobId) {
      const job = jobs.get(jobId, WITHOUT_LOG_LINES)
      if (job === undefined) throw unknownJob(jobId)
      if (!isCancellable(job)) throw new ActionError(409, NOT_CANCELABLE)
      jobs.cancel(jobId)
    },
    async close() {
      closed = true
      jobs.cancelAll()
      options.runner.killRunning()
      await Promise.allSettled([...activeRuns])
      await availability.settled()
      await removeActionSandboxes()
    },
  }
}

export function disabledActions(reason: string): ActionService {
  const refuse = (): never => {
    throw new ActionError(409, reason)
  }
  return {
    track() {},
    summary: () => ({ available: false, reason, changeCount: 0, revertable: false }),
    isBusy: () => false,
    anyBusy: () => false,
    nodeActions: async () => ({ unavailable: reason }),
    changes: async () => ({ items: [], revertable: false, installByDefault: false }),
    addChange: async () => refuse(),
    replaceChange: async () => refuse(),
    removeChange: refuse,
    clearChanges: refuse,
    restoreCleared: refuse,
    startCollect: refuse,
    startPreview: refuse,
    previewFileDiff: () => {
      throw new ActionError(404, NO_PREVIEW)
    },
    startApply: async () => refuse(),
    startRevert: async () => refuse(),
    job: (jobId) => {
      throw unknownJob(jobId)
    },
    cancelJob: (jobId) => {
      throw unknownJob(jobId)
    },
    close: async () => {},
  }
}
