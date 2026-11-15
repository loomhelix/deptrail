const STATUSES = new Set(['scanning', 'ready', 'failed'])
const SOURCES = new Set(['lockfile', 'installed', 'resolved-today', 'manifest-only'])
const MANAGERS = new Set(['pnpm', 'npm', 'unknown'])
const DEP_KINDS = new Set(['prod', 'dev', 'optional', 'peer'])

type Candidate = Record<string, unknown>

function isRecord(value: unknown): value is Candidate {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isEdge(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.to === 'string' &&
    typeof value.range === 'string' &&
    typeof value.kind === 'string' &&
    DEP_KINDS.has(value.kind)
  )
}

function hasEdgesAndDependents(node: Candidate): boolean {
  return Array.isArray(node.deps) && node.deps.every(isEdge) && isStringArray(node.dependents)
}

function isImporter(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    hasEdgesAndDependents(value)
  )
}

function isPackage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.version === 'string' &&
    (value.peerSuffix === undefined || typeof value.peerSuffix === 'string') &&
    (value.nonRegistry === undefined || value.nonRegistry === true) &&
    hasEdgesAndDependents(value)
  )
}

export function isRootGraphShape(json: unknown): boolean {
  return (
    isRecord(json) &&
    typeof json.id === 'string' &&
    typeof json.path === 'string' &&
    typeof json.manager === 'string' &&
    MANAGERS.has(json.manager) &&
    typeof json.status === 'string' &&
    STATUSES.has(json.status) &&
    typeof json.source === 'string' &&
    SOURCES.has(json.source) &&
    isStringArray(json.warnings) &&
    Array.isArray(json.importers) &&
    json.importers.every(isImporter) &&
    Array.isArray(json.packages) &&
    json.packages.every(isPackage)
  )
}
