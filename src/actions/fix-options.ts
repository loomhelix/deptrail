import semver from 'semver'
import { IMPORTER_PREFIX, type PackageNode, type RootGraph } from '../model.ts'
import type { Advisory, EnrichmentView } from '../enrich/types.ts'
import { nodeAdvisories, nodeMeta, worstSeverity } from '../query/enrichment-lookup.ts'
import { combineFixes, type NodeFix } from '../query/fixes.ts'
import { findNode, type KindFilter } from '../query/lookup.ts'
import { edgeFixes, normalizedRequestedRange, safeCandidates, type ParentEdgeFix } from '../query/node-fix.ts'
import { acceptedClause, importerLabel } from './labels.ts'
import type { OverridesLocation } from './overrides-location.ts'
import { parentChain, type VersionsLoader } from './parent-chain.ts'
import type { FixActions, FixChoice, FixGoal, ManagerInfo, OverrideStep, RelockStep, Step } from './types.ts'

export type OptionsContext = { view: EnrichmentView; root: RootGraph; kinds: KindFilter; manager: ManagerInfo; overrides: OverridesLocation; loadVersions: VersionsLoader }

type RequestingRange = { label: string; declared: string; range: string | undefined }
type OfferedOption = { choice: FixChoice; steps: Step[]; warnings: string[] }
type UnavailableOption = { choice: FixChoice; reason: string }
type OptionOutcome = OfferedOption | UnavailableOption
type OverrideTarget = { version: string; majorJump: boolean }

const ROOT_IMPORTER_ID = `${IMPORTER_PREFIX}.`
const NO_COMMON_SAFE_VERSION = 'the requesting ranges have no safe version in common'
const NPM_DIRECT_DEPENDENCY = 'npm does not allow an override of a direct dependency of the root package; update it instead'
const MAJOR_JUMP = 'major jump'
export const NPM_LOCKFILE_OVERRIDES_VERSION = '11.2.0'

export function npmIgnoresLockfileOverrides(manager: ManagerInfo): boolean {
  if (manager.name !== 'npm') return false
  const version = semver.coerce(manager.version)
  return version !== null && semver.lt(version, NPM_LOCKFILE_OVERRIDES_VERSION)
}

function lockfileOverridesReason(manager: ManagerInfo): string {
  return `npm ${manager.version} does not apply overrides to an existing lockfile, npm ${NPM_LOCKFILE_OVERRIDES_VERSION} and later do`
}

function knownRanges(ranges: readonly (string | undefined)[]): string[] | undefined {
  const known = ranges.filter((range): range is string => range !== undefined)
  return known.length === ranges.length ? known : undefined
}

export function relockTarget(ranges: readonly (string | undefined)[], candidates: readonly string[]): string | undefined {
  const known = knownRanges(ranges)
  if (known === undefined) return undefined
  return candidates
    .filter((candidate) => semver.valid(candidate) !== null && known.every((range) => semver.satisfies(candidate, range)))
    .sort(semver.compare)
    .at(-1)
}

function fixGoal(node: PackageNode, advisories: readonly Advisory[]): FixGoal {
  return {
    kind: 'fix',
    name: node.name,
    version: node.version,
    advisoryIds: advisories.map((advisory) => advisory.id),
    severity: worstSeverity(advisories.map((advisory) => advisory.severity)) ?? 'unknown',
  }
}

function parentLabel(root: RootGraph, edge: ParentEdgeFix): string {
  if (edge.parentIsImporter) return importerLabel(edge.parent)
  return findNode(root, edge.parent)?.name ?? edge.parent
}

function requestingRanges(context: OptionsContext, node: PackageNode, edges: readonly ParentEdgeFix[]): RequestingRange[] {
  const meta = nodeMeta(context.view, context.root, node)
  return edges.map((edge) => ({
    label: parentLabel(context.root, edge),
    declared: edge.range.range,
    range: normalizedRequestedRange(context.root, node, meta, edge.range),
  }))
}

function relockOption(node: PackageNode, target: string, requesting: readonly RequestingRange[]): OfferedOption {
  const labels = [...new Set(requesting.map((entry) => entry.label))]
  const step: RelockStep = { kind: 'relock', name: node.name, from: node.version, to: target, reason: acceptedClause(labels) }
  return { choice: 'relock', steps: [step], warnings: [] }
}

async function chainOption(context: OptionsContext, node: PackageNode, safe: readonly string[]): Promise<OptionOutcome> {
  const chain = await parentChain({ view: context.view, root: context.root, node, safe, kinds: context.kinds, loadVersions: context.loadVersions })
  return 'steps' in chain ? { choice: 'chain', steps: chain.steps, warnings: [] } : { choice: 'chain', reason: chain.unavailable }
}

function overrideTarget(current: string, safe: readonly string[]): OverrideTarget | undefined {
  if (semver.valid(current) === null) return undefined
  const above = safe.filter((version) => semver.valid(version) !== null && semver.gt(version, current)).sort(semver.compare)
  const highestSameMajor = above.filter((version) => semver.major(version) === semver.major(current)).at(-1)
  if (highestSameMajor !== undefined) return { version: highestSameMajor, majorJump: false }
  const lowest = above[0]
  return lowest === undefined ? undefined : { version: lowest, majorJump: true }
}

function rootDeclares(root: RootGraph, name: string): boolean {
  const rootImporter = root.importers.find((importer) => importer.id === ROOT_IMPORTER_ID)
  return rootImporter?.deps.some((edge) => findNode(root, edge.to)?.name === name) ?? false
}

function overrideReason(target: string, requesting: readonly RequestingRange[]): string {
  const excluding = requesting.find((entry) => entry.range !== undefined && !semver.satisfies(target, entry.range))
  return excluding === undefined ? `forces ${target}` : `forces ${target} although ${excluding.label} declares ${excluding.declared}`
}

function overrideOption(context: OptionsContext, node: PackageNode, safe: readonly string[], requesting: readonly RequestingRange[]): OptionOutcome {
  const target = overrideTarget(node.version, safe)
  if (target === undefined) return { choice: 'override', reason: `no safe version of ${node.name} above ${node.version}` }
  if (context.manager.name === 'npm' && rootDeclares(context.root, node.name)) return { choice: 'override', reason: NPM_DIRECT_DEPENDENCY }
  if (npmIgnoresLockfileOverrides(context.manager)) return { choice: 'override', reason: lockfileOverridesReason(context.manager) }
  const step: OverrideStep = {
    kind: 'override',
    selector: `${node.name}@<${target.version}`,
    value: target.version,
    file: context.overrides.file,
    reason: overrideReason(target.version, requesting),
  }
  const locationWarnings = context.overrides.warning === undefined ? [] : [context.overrides.warning]
  return { choice: 'override', steps: [step], warnings: [...(target.majorJump ? [MAJOR_JUMP] : []), ...locationWarnings] }
}

async function optionOutcomes(context: OptionsContext, node: PackageNode, kind: NodeFix['kind'], edges: readonly ParentEdgeFix[]): Promise<OptionOutcome[]> {
  const safe = safeCandidates(context.view, context.root, node, nodeMeta(context.view, context.root, node)) ?? []
  const requesting = requestingRanges(context, node, edges)
  if (kind === 'relock') {
    const target = relockTarget(requesting.map((entry) => entry.range), safe)
    const needsLockfileOverride = edges.some((edge) => !edge.parentIsImporter)
    if (target !== undefined && needsLockfileOverride && npmIgnoresLockfileOverrides(context.manager)) {
      return [{ choice: 'relock', reason: lockfileOverridesReason(context.manager) }, overrideOption(context, node, safe, requesting)]
    }
    if (target !== undefined) return [relockOption(node, target, requesting)]
    return [{ choice: 'relock', reason: NO_COMMON_SAFE_VERSION }, overrideOption(context, node, safe, requesting)]
  }
  return [await chainOption(context, node, safe), overrideOption(context, node, safe, requesting)]
}

function isUnavailable(outcome: OptionOutcome): outcome is UnavailableOption {
  return 'reason' in outcome
}

function collectOptions(goal: FixGoal, outcomes: readonly OptionOutcome[]): FixActions {
  const offered = outcomes.filter((outcome): outcome is OfferedOption => !isUnavailable(outcome))
  return {
    goal,
    options: offered.map((option, index) => ({ choice: option.choice, recommended: index === 0, steps: option.steps, warnings: option.warnings })),
    unavailable: outcomes.filter(isUnavailable),
  }
}

export async function fixActions(context: OptionsContext, node: PackageNode): Promise<FixActions | undefined> {
  const advisories = nodeAdvisories(context.view, context.root, node)
  if (advisories.length === 0) return undefined
  const goal = fixGoal(node, advisories)
  const edges = edgeFixes(context.view, context.root, node, context.kinds)
  const { kind } = combineFixes(edges)
  if (kind === 'no-fix') return { goal, options: [], unavailable: [], reason: `No published version of ${node.name} is free of these advisories` }
  if (kind === 'unknown') return { goal, options: [], unavailable: [], reason: `Registry or advisory data for ${node.name} is incomplete` }
  return collectOptions(goal, await optionOutcomes(context, node, kind, edges))
}
