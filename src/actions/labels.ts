import type { DepKind, NodeId } from '../model.ts'
import type { DependencyField, Goal } from './types.ts'

const IMPORTER_ID_PREFIX = 'importer:'
export const REPOSITORY_ROOT_ID = '.'
export const INSTALL_FAILURE_PREFIX = 'install failed:'
const ROOT_IMPORTER_ID = `${IMPORTER_ID_PREFIX}${REPOSITORY_ROOT_ID}`
const REPOSITORY_ROOT_LABEL = 'repository root'
const LISTED_LABEL_LIMIT = 3

const FIELD_BY_KIND: Record<DepKind, DependencyField | undefined> = {
  prod: 'dependencies',
  dev: 'devDependencies',
  optional: 'optionalDependencies',
  peer: undefined,
}

export function rootLabel(rootId: string): string {
  return rootId === REPOSITORY_ROOT_ID ? REPOSITORY_ROOT_LABEL : rootId
}

export function importerLabel(id: NodeId): string {
  if (id === ROOT_IMPORTER_ID) return 'the root package'
  return id.startsWith(IMPORTER_ID_PREFIX) ? id.slice(IMPORTER_ID_PREFIX.length) : id
}

export function goalText(goal: Goal): string {
  return goal.kind === 'fix' ? `Fix ${goal.name} ${goal.version}` : `Update ${goal.name} to ${goal.target}`
}

export function acceptedClause(labels: readonly string[]): string {
  if (labels.length === 1) return `${labels[0]} accepts it`
  if (labels.length === 2) return `${labels[0]} and ${labels[1]} accept it`
  if (labels.length <= LISTED_LABEL_LIMIT) return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]} accept it`
  return `${labels.slice(0, LISTED_LABEL_LIMIT).join(', ')}, and ${labels.length - LISTED_LABEL_LIMIT} more accept it`
}

export function fieldOf(kind: DepKind): DependencyField | undefined {
  return FIELD_BY_KIND[kind]
}
