import path from 'node:path'
import type { ProcessRunner } from '../adapters/command-runner.ts'
import type { SecretSet } from '../config/secrets.ts'
import type { RootGraph } from '../model.ts'
import { outsideImporters, type OutsideImporterProblem } from './file-scope.ts'
import { probeManager } from './recipes.ts'
import type { ManagerInfo, PackageManagerName } from './types.ts'

export type AvailabilityOptions = {
  repoPath: string
  runner: ProcessRunner
  env: Record<string, string | undefined>
  offline: boolean
  secrets: SecretSet
}

export type AvailabilityCheck = { manager: ManagerInfo } | { reason: string }

export type Availability = {
  probe(root: RootGraph): Promise<void>
  retryFailedProbe(root: RootGraph): Promise<void>
  check(root: RootGraph): AvailabilityCheck
  settled(): Promise<void>
}

type ProbeState = { state: 'pending' } | { state: 'ok'; version: string } | { state: 'failed'; reason: string }
type Probe = { current: ProbeState; done: Promise<void> }

export const SCANNING_REASON = 'Waiting for the scan'
const FAILED_REASON = 'The root failed to scan'
const LOCKFILE_REASON = 'Actions require a pnpm or npm lockfile'
const OFFLINE_REASON = 'Actions are unavailable with --offline'

function managerNameOf(root: RootGraph): PackageManagerName | undefined {
  return root.manager === 'pnpm' || root.manager === 'npm' ? root.manager : undefined
}

function outsideImporterReason(problem: OutsideImporterProblem): string {
  if (problem.kind === 'outside-repository') return `Actions do not support workspace packages outside the repository (${problem.path})`
  if (problem.kind === 'npm') return `Actions do not support workspace packages outside the root (${problem.path})`
  return `The lockfile lists ${problem.path}, which pnpm-workspace.yaml does not declare`
}

function blockingReason(root: RootGraph, offline: boolean): string | undefined {
  if (root.status === 'scanning') return SCANNING_REASON
  if (root.status === 'failed') return FAILED_REASON
  if (root.source !== 'lockfile' || managerNameOf(root) === undefined) return LOCKFILE_REASON
  if (offline) return OFFLINE_REASON
  const { problem } = outsideImporters(root)
  return problem === undefined ? undefined : outsideImporterReason(problem)
}

function probeKey(root: RootGraph, manager: PackageManagerName): string {
  return `${manager}\0${root.path}`
}

export function createAvailability(options: AvailabilityOptions): Availability {
  const probes = new Map<string, Probe>()

  function startProbe(root: RootGraph, manager: PackageManagerName): Probe {
    const probe: Probe = { current: { state: 'pending' }, done: Promise.resolve() }
    const cwd = path.join(options.repoPath, root.path)
    probe.done = probeManager(options.runner, manager, cwd, options.env, options.secrets).then((result) => {
      probe.current = result.ok ? { state: 'ok', version: result.version } : { state: 'failed', reason: result.reason }
    })
    return probe
  }

  function probe(root: RootGraph): Promise<void> {
    const manager = managerNameOf(root)
    if (manager === undefined || blockingReason(root, options.offline) !== undefined) return Promise.resolve()
    const key = probeKey(root, manager)
    let existing = probes.get(key)
    if (existing === undefined) {
      existing = startProbe(root, manager)
      probes.set(key, existing)
    }
    return existing.done
  }

  return {
    probe,
    retryFailedProbe(root) {
      const manager = managerNameOf(root)
      if (manager !== undefined && probes.get(probeKey(root, manager))?.current.state === 'failed') probes.delete(probeKey(root, manager))
      return probe(root)
    },
    check(root) {
      const manager = managerNameOf(root)
      const blocking = blockingReason(root, options.offline)
      if (manager === undefined || blocking !== undefined) return { reason: blocking ?? LOCKFILE_REASON }
      const current = probes.get(probeKey(root, manager))?.current
      if (current === undefined || current.state === 'pending') return { reason: `Checking ${manager}…` }
      if (current.state === 'failed') return { reason: current.reason }
      return { manager: { name: manager, version: current.version } }
    },
    async settled() {
      await Promise.all([...probes.values()].map((probe) => probe.done))
    },
  }
}
