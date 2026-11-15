import { posix } from 'node:path'
import { parse } from 'yaml'
import type { FileReader } from '../sources/file-reader.ts'
import type { RootConfig } from '../model.ts'
import { readManifest } from '../adapters/package-manifest.ts'
import { npmConfigEnv, parseNpmrc, stripRegistryCredentials, withoutVariableReferences, type NpmrcValues } from './npmrc.ts'

type ConfigSources = { userNpmrc: string | null; env: Record<string, string | undefined>; expandProjectVariables?: boolean }
type UnknownRecord = Record<string, unknown>

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const DEFAULT_CATALOG = 'default'
const NESTED_SELF_KEY = '.'
const USER_NPMRC_LABEL = 'user .npmrc'
const PROJECT_NPMRC_LABEL = 'project .npmrc'

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function stringEntries(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => typeof entry === 'string')) as Record<
    string,
    string
  >
}

function flattenOverrides(value: unknown, parentSelector: string | null, flattened: Record<string, string>): void {
  const record = asRecord(value)
  if (!record) return
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      const selector = key === NESTED_SELF_KEY && parentSelector !== null ? parentSelector : joinSelector(parentSelector, key)
      flattened[selector] = entry
    } else {
      flattenOverrides(entry, joinSelector(parentSelector, key), flattened)
    }
  }
}

function joinSelector(parentSelector: string | null, key: string): string {
  return parentSelector === null ? key : `${parentSelector} > ${key}`
}

function unscopedAuthWarnings(npmrc: NpmrcValues, label: string): string[] {
  return npmrc.unscopedAuthKeys.map((key) => `${key} in ${label} is not scoped to a registry and is ignored`)
}

async function readWorkspaceYaml(reader: FileReader, rootPath: string): Promise<UnknownRecord> {
  const text = await reader.readText(posix.join(rootPath, 'pnpm-workspace.yaml'))
  if (text === null) return {}
  try {
    return asRecord(parse(text)) ?? {}
  } catch {
    return {}
  }
}

async function readManifestRecord(reader: FileReader, rootPath: string): Promise<UnknownRecord> {
  const result = await readManifest(reader, rootPath)
  return 'manifest' in result ? result.manifest.record : {}
}

function workspacePatternsOf(workspaceYaml: UnknownRecord, manifest: UnknownRecord): string[] {
  const fromYaml = asStringArray(workspaceYaml.packages)
  if (fromYaml.length > 0) return fromYaml
  const workspaces = manifest.workspaces
  return Array.isArray(workspaces) ? asStringArray(workspaces) : asStringArray(asRecord(workspaces)?.packages)
}

export async function readWorkspacePatterns(reader: FileReader, rootPath: string): Promise<string[]> {
  const workspaceYaml = await readWorkspaceYaml(reader, rootPath)
  const manifest = await readManifestRecord(reader, rootPath)
  return workspacePatternsOf(workspaceYaml, manifest)
}

function catalogsOf(workspaceYaml: UnknownRecord): Record<string, Record<string, string>> {
  const catalogs: Record<string, Record<string, string>> = {}
  const defaultCatalog = stringEntries(workspaceYaml.catalog)
  if (Object.keys(defaultCatalog).length > 0) catalogs[DEFAULT_CATALOG] = defaultCatalog
  for (const [name, entries] of Object.entries(asRecord(workspaceYaml.catalogs) ?? {})) {
    catalogs[name] = stringEntries(entries)
  }
  return catalogs
}

function overridesOf(workspaceYaml: UnknownRecord, manifest: UnknownRecord): Record<string, string> {
  const overrides: Record<string, string> = {}
  flattenOverrides(workspaceYaml.overrides, null, overrides)
  flattenOverrides(manifest.overrides, null, overrides)
  flattenOverrides(asRecord(manifest.pnpm)?.overrides, null, overrides)
  return overrides
}

export async function readRootConfig(reader: FileReader, rootPath: string, sources: ConfigSources): Promise<RootConfig> {
  const projectNpmrcText = await reader.readText(posix.join(rootPath, '.npmrc'))
  const userNpmrc = parseNpmrc(sources.userNpmrc ?? '', sources.env)
  const projectText = projectNpmrcText ?? ''
  const projectNpmrc = parseNpmrc(sources.expandProjectVariables === false ? withoutVariableReferences(projectText) : projectText, sources.env)
  const workspaceYaml = await readWorkspaceYaml(reader, rootPath)
  const manifest = await readManifestRecord(reader, rootPath)

  const envRegistry = stripRegistryCredentials(npmConfigEnv(sources.env, 'registry') ?? '')

  return {
    registry: envRegistry.url || projectNpmrc.registry || userNpmrc.registry || DEFAULT_REGISTRY,
    scopedRegistries: { ...userNpmrc.scopedRegistries, ...projectNpmrc.scopedRegistries },
    hasAuth: userNpmrc.hasAuth || projectNpmrc.hasAuth || envRegistry.hadCredentials,
    catalogs: catalogsOf(workspaceYaml),
    overrides: overridesOf(workspaceYaml, manifest),
    workspacePatterns: workspacePatternsOf(workspaceYaml, manifest),
    warnings: [...unscopedAuthWarnings(userNpmrc, USER_NPMRC_LABEL), ...unscopedAuthWarnings(projectNpmrc, PROJECT_NPMRC_LABEL)],
  }
}
