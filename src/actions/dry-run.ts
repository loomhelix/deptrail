import { posix } from 'node:path'
import type { ProcessResult, ProcessRunner } from '../adapters/command-runner.ts'
import type { SecretSet } from '../config/secrets.ts'
import { SEVERITY_ORDER, type AssessedPackage, type EnrichmentView } from '../enrich/types.ts'
import { PLACEHOLDER_PREFIX, type PackageNode, type RootGraph } from '../model.ts'
import { compareVersions, graphDiff, packageVersions } from '../query/graph-diff.ts'
import { messageOf, parseRootLockfile } from '../scan/build-root.ts'
import { edgeMoveWarnings } from './edge-moves.ts'
import { ROOT_MANIFEST, WORKSPACE_FILE, applySteps, manifestPathOf, relockPins, stepPaths } from './edit-plan.ts'
import { checkGoals } from './goal-check.ts'
import { parseManagerVersion } from './overrides-location.ts'
import { LOCKFILE_ONLY_ARGS, PROBE_TIMEOUT_MS, SANDBOX_TIMEOUT_MS, commandText } from './recipes.ts'
import type { FileScope } from './file-scope.ts'
import { sharedRootWarnings } from './shared-packages.ts'
import { createSandbox, type Sandbox } from './sandbox.ts'
import { truncateUtf8, unifiedDiff } from './text-diff.ts'
import type { ChangeItem, JobPhase, ManagerInfo, NewIssue, OverridesFile, Preview, PreviewFile, RelockStep, SharingRoot, Step } from './types.ts'

export { checkGoals }

export const LOCKFILE_DIFF_MAX_BYTES = 2_097_152
export const STDERR_TAIL_CHARS = 400

const OUTPUT_WARNING_LIMIT = 20
const CANCELED_MESSAGE = 'canceled'
const SANDBOX_TIMEOUT_TEXT = `${SANDBOX_TIMEOUT_MS / 60_000} minutes`
const PROBE_TIMEOUT_TEXT = `${PROBE_TIMEOUT_MS / 1000} seconds`
const VERSION_ARGS = ['--version']
const EOVERRIDE_CODE = 'EOVERRIDE'
const EOVERRIDE_HINT = ' npm refused an override of a direct dependency; update the direct dependency instead.'
const PNPM_WARNING_PREFIX = 'WARN'
const NPM_WARNING_PREFIX = 'npm warn'
const LOCKFILE_VERSION_PATTERN = /^\s*"?lockfileVersion"?\s*:\s*['"]?([0-9][\w.]*)/m

export class DryRunError extends Error {
  readonly cancelled: boolean

  constructor(message: string, cancelled = false) {
    super(message)
    this.cancelled = cancelled
  }
}

export type DryRunInput = {
  previewId: string
  root: RootGraph
  scope: FileScope
  sharedManifests: ReadonlyMap<string, readonly SharingRoot[]>
  lockfile: string
  manager: ManagerInfo
  overridesFile: OverridesFile
  items: readonly ChangeItem[]
  view: EnrichmentView
  assess: (packages: readonly { name: string; version: string }[]) => Promise<AssessedPackage[]>
  runner: ProcessRunner
  env: Record<string, string | undefined>
  secrets: SecretSet
  signal: AbortSignal
  onPhase: (phase: JobPhase) => void
  onLine: (line: string) => void
  now: () => Date
}

export type DryRunResult = {
  preview: Preview
  written: Map<string, string>
  originals: Map<string, string | null>
  sources: Map<string, string | null>
  lockfileDiff: { diff: string; truncated: boolean }
}

type PackageQuery = { name: string; version: string }
type Texts = Map<string, string | null>
type OutputLog = { warnings: Set<string>; onLine(line: string): void }

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DryRunError(CANCELED_MESSAGE, true)
}

function manifestPaths(root: RootGraph): string[] {
  return [...new Set([ROOT_MANIFEST, ...root.importers.map((importer) => manifestPathOf(importer.id))])].sort()
}

async function readTexts(sandbox: Sandbox, paths: readonly string[]): Promise<Texts> {
  const texts: Texts = new Map()
  for (const path of paths) texts.set(path, await sandbox.readText(path))
  return texts
}

function editedTexts(texts: ReadonlyMap<string, string | null>, steps: readonly Step[]): Map<string, string> {
  const changed = new Map<string, string>()
  for (const path of stepPaths(steps)) {
    const stepsOfPath = steps.filter((step) => stepPaths([step])[0] === path)
    try {
      for (const [changedPath, text] of applySteps(texts, stepsOfPath)) changed.set(changedPath, text)
    } catch (failure) {
      throw new DryRunError(`could not edit ${path}: ${messageOf(failure)}`)
    }
  }
  return changed
}

async function editSandbox(sandbox: Sandbox, texts: Texts, steps: readonly Step[]): Promise<Texts> {
  const previous: Texts = new Map()
  for (const [path, text] of editedTexts(texts, steps)) {
    previous.set(path, texts.get(path) ?? null)
    texts.set(path, text)
    await sandbox.writeText(path, text)
  }
  return previous
}

async function restoreSandbox(sandbox: Sandbox, previous: Texts): Promise<void> {
  for (const [path, text] of previous) {
    if (text === null) await sandbox.deleteFile(path)
    else await sandbox.writeText(path, text)
  }
}

function isWarningLine(line: string): boolean {
  return line.startsWith(PNPM_WARNING_PREFIX) || line.toLowerCase().startsWith(NPM_WARNING_PREFIX)
}

function createOutputLog(input: DryRunInput): OutputLog {
  const warnings = new Set<string>()
  return {
    warnings,
    onLine(line) {
      const redacted = input.secrets.redact(line)
      const trimmed = redacted.trim()
      if (warnings.size < OUTPUT_WARNING_LIMIT && isWarningLine(trimmed)) warnings.add(trimmed)
      input.onLine(redacted)
    },
  }
}

function failureMessage(command: string, result: ProcessResult, secrets: SecretSet): string {
  const output = secrets.redact([result.stdout.trim(), result.stderr.trim()].filter((text) => text !== '').join('\n'))
  const hint = output.includes(EOVERRIDE_CODE) ? EOVERRIDE_HINT : ''
  return `${command} failed: ${output.slice(-STDERR_TAIL_CHARS)}${hint}`
}

function startFailureMessage(input: DryRunInput, command: string, failure: unknown): string {
  if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return `${input.manager.name} was not found`
  return `${command} could not be started: ${input.secrets.redact(messageOf(failure))}`
}

type ManagerRun = { args: readonly string[]; cwd: string; timeoutMs: number; timeoutText: string; onLine?: (line: string) => void }

async function runManager(input: DryRunInput, run: ManagerRun): Promise<ProcessResult> {
  const command = commandText(input.manager.name, run.args)
  let result: ProcessResult
  try {
    result = await input.runner.run({
      command: input.manager.name,
      args: run.args,
      cwd: run.cwd,
      env: input.env,
      timeoutMs: run.timeoutMs,
      signal: input.signal,
      ...(run.onLine === undefined ? {} : { onLine: run.onLine }),
    })
  } catch (failure) {
    throw new DryRunError(startFailureMessage(input, command, failure))
  }
  if (result.cancelled) throw new DryRunError(CANCELED_MESSAGE, true)
  if (result.timedOut) throw new DryRunError(`${command} did not finish within ${run.timeoutText}`)
  if (result.code !== 0) throw new DryRunError(failureMessage(command, result, input.secrets))
  return result
}

async function checkSandboxManager(input: DryRunInput, cwd: string): Promise<void> {
  const result = await runManager(input, { args: VERSION_ARGS, cwd, timeoutMs: PROBE_TIMEOUT_MS, timeoutText: PROBE_TIMEOUT_TEXT })
  const found = parseManagerVersion(result.stdout)
  if (found === undefined) throw new DryRunError(`${commandText(input.manager.name, VERSION_ARGS)} printed no version in the temporary copy`)
  if (found !== input.manager.version) throw new DryRunError(`the temporary copy runs ${input.manager.name} ${found} instead of ${input.manager.version}`)
}

async function resolveLockfile(input: DryRunInput, cwd: string, output: OutputLog): Promise<void> {
  await runManager(input, { args: LOCKFILE_ONLY_ARGS[input.manager.name], cwd, timeoutMs: SANDBOX_TIMEOUT_MS, timeoutText: SANDBOX_TIMEOUT_TEXT, onLine: output.onLine })
}

function lockfileVersionOf(text: string | null): string | undefined {
  return text === null ? undefined : LOCKFILE_VERSION_PATTERN.exec(text)?.[1]
}

function lockfileVersionWarning(before: string | null, after: string | null): string[] {
  const from = lockfileVersionOf(before)
  const to = lockfileVersionOf(after)
  return from !== undefined && to !== undefined && from !== to ? [`Lockfile format version changes from ${from} to ${to}`] : []
}

function writtenTexts(paths: readonly string[], originals: Texts, finals: Texts): Map<string, string> {
  const written = new Map<string, string>()
  for (const path of paths) {
    const text = finals.get(path) ?? null
    if (text !== null && text !== originals.get(path)) written.set(path, text)
  }
  return written
}

function previewFiles(written: ReadonlyMap<string, string>, originals: Texts, lockfile: string, shared: ReadonlyMap<string, readonly SharingRoot[]>): { files: PreviewFile[]; lockfileDiff: DryRunResult['lockfileDiff'] } {
  const files: PreviewFile[] = []
  let lockfileDiff = { diff: '', truncated: false }
  for (const [path, text] of written) {
    const original = originals.get(path) ?? null
    const { diff, added, removed } = unifiedDiff(path, original, text)
    const change = original === null ? 'created' : 'modified'
    const sharedWith = (shared.get(path) ?? []).map((sharing) => sharing.id)
    const sharedMark = sharedWith.length > 0 ? { sharedWith } : {}
    if (path !== lockfile) {
      files.push({ path, change, added, removed, diff, ...sharedMark })
      continue
    }
    const cut = truncateUtf8(diff, LOCKFILE_DIFF_MAX_BYTES)
    lockfileDiff = { diff: cut.text, truncated: cut.truncated }
    files.push({ path, change, added, removed, ...sharedMark, ...(cut.truncated ? { diffTruncated: true as const } : {}) })
  }
  return { files, lockfileDiff }
}

function isRegistryPackage(node: PackageNode): boolean {
  return node.nonRegistry !== true && !node.id.startsWith(PLACEHOLDER_PREFIX)
}

function newPackages(before: RootGraph, after: RootGraph): PackageQuery[] {
  const known = packageVersions(before)
  const fresh = new Map<string, PackageQuery>()
  for (const node of after.packages.values()) {
    if (!isRegistryPackage(node) || known.get(node.name)?.has(node.version)) continue
    fresh.set(`${node.name}@${node.version}`, { name: node.name, version: node.version })
  }
  return [...fresh.values()].sort((left, right) => (left.name === right.name ? compareVersions(left.version, right.version) : left.name < right.name ? -1 : 1))
}

function severityRank(issue: NewIssue): number {
  return issue.severity === undefined ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(issue.severity)
}

function compareIssues(left: NewIssue, right: NewIssue): number {
  const bySeverity = severityRank(left) - severityRank(right)
  if (bySeverity !== 0) return bySeverity
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  return compareVersions(left.version, right.version)
}

function issueOf(assessed: AssessedPackage): NewIssue | undefined {
  if (assessed.severity === undefined && assessed.deprecated === undefined && assessed.notChecked === undefined) return undefined
  return {
    name: assessed.name,
    version: assessed.version,
    ...(assessed.severity === undefined ? {} : { severity: assessed.severity }),
    vulnIds: assessed.vulnIds,
    ...(assessed.deprecated === undefined ? {} : { deprecated: assessed.deprecated }),
    ...(assessed.notChecked === undefined ? {} : { notChecked: assessed.notChecked }),
  }
}

async function newIssues(input: DryRunInput, after: RootGraph): Promise<NewIssue[]> {
  const packages = newPackages(input.root, after)
  if (packages.length === 0) return []
  const assessed = await input.assess(packages)
  return assessed.flatMap((entry) => issueOf(entry) ?? []).sort(compareIssues)
}

function parsedLockfile(input: DryRunInput, text: string | null): RootGraph {
  if (text === null) throw new DryRunError(`could not parse the new lockfile: ${input.lockfile} was not written`)
  const parsed = parseRootLockfile(input.root, input.lockfile, text)
  if ('error' in parsed) throw new DryRunError(`could not parse the new lockfile: ${input.secrets.redact(parsed.error)}`)
  return parsed.graph
}

export async function runDryRun(input: DryRunInput): Promise<DryRunResult> {
  input.onPhase('staging')
  const manifests = manifestPaths(input.root)
  const writeList = [...manifests, WORKSPACE_FILE, input.lockfile]
  const sandbox = await createSandbox({
    scope: input.scope,
    manager: input.manager,
    importerPaths: manifests.map((path) => posix.dirname(path)),
    lockfile: input.lockfile,
  })
  try {
    throwIfCancelled(input.signal)
    const originals = await readTexts(sandbox, writeList)
    const steps = input.items.flatMap((item) => item.steps)
    const texts: Texts = new Map(originals)
    await editSandbox(sandbox, texts, steps)
    const relocks = steps.filter((step): step is RelockStep => step.kind === 'relock')
    const pins = relockPins(input.root, input.manager.name, relocks, input.overridesFile)
    const beforePins = await editSandbox(sandbox, texts, pins)
    throwIfCancelled(input.signal)
    input.onPhase('resolving')
    const output = createOutputLog(input)
    await checkSandboxManager(input, sandbox.dir)
    await resolveLockfile(input, sandbox.dir, output)
    if (beforePins.size > 0) {
      await restoreSandbox(sandbox, beforePins)
      await resolveLockfile(input, sandbox.dir, output)
    }
    input.onPhase('checking')
    const finals = await readTexts(sandbox, writeList)
    const after = parsedLockfile(input, finals.get(input.lockfile) ?? null)
    const issues = await newIssues(input, after)
    throwIfCancelled(input.signal)
    const written = writtenTexts(writeList, originals, finals)
    const { files, lockfileDiff } = previewFiles(written, originals, input.lockfile, input.sharedManifests)
    const warnings = [
      ...input.items.flatMap((item) => item.warnings),
      ...lockfileVersionWarning(originals.get(input.lockfile) ?? null, finals.get(input.lockfile) ?? null),
      ...edgeMoveWarnings(steps, input.root, after),
      ...sharedRootWarnings([...written.keys()], input.sharedManifests),
      ...output.warnings,
    ]
    const preview: Preview = {
      id: input.previewId,
      rootId: input.root.id,
      createdAt: input.now().toISOString(),
      stale: false,
      manager: { name: input.manager.name, version: input.manager.version },
      goals: checkGoals(input.items, input.root, after, input.view),
      newIssues: issues,
      warnings: [...new Set(warnings)],
      files,
      packageChanges: graphDiff(input.root, after),
      ...(input.scope.outsideManifests.length > 0 ? { outsidePackages: input.scope.outsideManifests.length } : {}),
    }
    return { preview, written, originals, sources: new Map(sandbox.sources), lockfileDiff }
  } finally {
    await sandbox.remove()
  }
}
