import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { EnrichmentService } from '../enrich/enrichment-service.ts'
import { IMPORTER_PREFIX, PLACEHOLDER_PREFIX, type DepKind, type Importer, type NodeId, type RootGraph } from '../model.ts'
import { ALL_KINDS, findNode, type GraphNode, type KindFilter } from '../query/lookup.ts'
import { ActionError } from './action-error.ts'
import { ROOT_MANIFEST } from './edit-plan.ts'
import { fixActions, type OptionsContext } from './fix-options.ts'
import { overridesLocationOf, readTextOrNull, rootDirOf } from './root-files.ts'
import type { AddChangeRequest, ChangeItem, Choice, FixChoice, FixOption, Goal, ManagerInfo, NodeActions, Step, UpdateActions, UpdateChoice } from './types.ts'
import { updateActions, updateSteps, type ImporterManifests } from './update-options.ts'

export type NodeActionsContext = { repoPath: string; enrichment: EnrichmentService; root: RootGraph; manager: ManagerInfo; kinds: KindFilter }

const NOT_FROM_REGISTRY = 'This package does not come from a registry'
const INVALID_KINDS = 'Invalid kinds'
const FIX_CHOICES: readonly Choice[] = ['relock', 'chain', 'override']
const UPDATE_CHOICES: readonly Choice[] = ['wanted', 'latest', 'version']

function isImporter(node: GraphNode): node is Importer {
  return node.id.startsWith(IMPORTER_PREFIX)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFixChoice(choice: AddChangeRequest['choice']): choice is FixChoice {
  return FIX_CHOICES.includes(choice as Choice)
}

function isUpdateChoice(choice: AddChangeRequest['choice']): choice is UpdateChoice {
  return UPDATE_CHOICES.includes(choice as Choice)
}

export function nodeLabel(node: GraphNode): string {
  return isImporter(node) ? node.name : `${node.name} ${node.version}`
}

export function kindFilterOf(kinds: readonly DepKind[] | undefined): KindFilter {
  if (kinds === undefined) return ALL_KINDS
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((kind) => ALL_KINDS.has(kind))) throw new ActionError(400, INVALID_KINDS)
  return new Set(kinds)
}

function parsedManifest(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function manifestsDeclaring(repoPath: string, root: RootGraph, name: string): Promise<ImporterManifests> {
  const importers = root.importers.filter((importer) => importer.deps.some((edge) => findNode(root, edge.to)?.name === name))
  const manifests = new Map<NodeId, Record<string, unknown>>()
  await Promise.all(
    importers.map(async (importer) => {
      const manifest = parsedManifest(await readTextOrNull(path.join(repoPath, importer.path, ROOT_MANIFEST)))
      if (manifest !== undefined) manifests.set(importer.id, manifest)
    }),
  )
  return manifests
}

export async function actionsOfNode(context: NodeActionsContext, node: GraphNode): Promise<NodeActions> {
  if (isImporter(node)) return {}
  if (node.id.startsWith(PLACEHOLDER_PREFIX) || node.nonRegistry === true) return { unavailable: NOT_FROM_REGISTRY }
  const { repoPath, enrichment, root, manager, kinds } = context
  const [overrides, manifests] = await Promise.all([overridesLocationOf(rootDirOf(repoPath, root), manager), manifestsDeclaring(repoPath, root, node.name)])
  const options: OptionsContext = { view: enrichment, root, kinds, manager, overrides, loadVersions: (name) => enrichment.publishedVersions(root, name) }
  const fix = await fixActions(options, node)
  const update = updateActions(options, node, manifests)
  return { ...(fix === undefined ? {} : { fix }), ...(update === undefined ? {} : { update }) }
}

function newItem(goal: Goal, choice: Choice, steps: Step[], warnings: string[]): ChangeItem {
  return { id: randomUUID(), goal, choice, steps, warnings }
}

function notOffered(choice: AddChangeRequest['choice'], node: GraphNode): ActionError {
  return new ActionError(400, `${choice} is not offered for ${nodeLabel(node)}`)
}

function editableImporters(update: UpdateActions): NodeId[] {
  return update.importers.filter((importer) => importer.editable).map((importer) => importer.id)
}

function fixItem(goal: Goal, option: FixOption): ChangeItem {
  return newItem(goal, option.choice, option.steps, option.warnings)
}

export function requestedItem(root: RootGraph, node: GraphNode, actions: NodeActions, request: AddChangeRequest): ChangeItem {
  const { choice } = request
  const { fix, update } = actions
  if (choice === 'recommended') {
    const option = fix?.options.find((candidate) => candidate.recommended)
    if (fix === undefined || option === undefined) throw new ActionError(400, `No fix is available for ${nodeLabel(node)}`)
    return fixItem(fix.goal, option)
  }
  if (isFixChoice(choice)) {
    const option = fix?.options.find((candidate) => candidate.choice === choice)
    if (fix === undefined || option === undefined) throw notOffered(choice, node)
    return fixItem(fix.goal, option)
  }
  if (!isUpdateChoice(choice) || update === undefined) throw notOffered(choice, node)
  const plan = updateSteps(update, root, choice, request.version, request.importers ?? editableImporters(update))
  if ('error' in plan) throw new ActionError(400, plan.error)
  return newItem(plan.goal, choice, plan.steps, plan.warnings)
}
