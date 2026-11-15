import { posix } from 'node:path'
import type { FileReader } from '../sources/file-reader.ts'
import type { DepKind } from '../model.ts'

export type DeclaredDependency = { name: string; range: string; kind: DepKind }
export type Manifest = { name?: string; version?: string; record: Record<string, unknown> }
export type ManifestRead = { manifest: Manifest } | { problem: string }

type DependencyBlocks = ReadonlyArray<readonly [blockName: string, kind: DepKind]>

const MANIFEST_FILE = 'package.json'
const NON_REGISTRY_PREFIXES = ['git+', 'git:', 'github:', 'gitlab:', 'bitbucket:', 'gist:', 'file:', 'link:', 'workspace:', 'http:', 'https:']
const GITHUB_SHORTHAND_PATTERN = /^[\w.-]+\/[\w.-]+(#.+)?$/

export const IMPORTER_BLOCKS: DependencyBlocks = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
]

export const PACKAGE_BLOCKS: DependencyBlocks = [
  ['dependencies', 'prod'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
]

export async function readManifest(reader: FileReader, directory: string): Promise<ManifestRead> {
  const manifestPath = posix.join(directory, MANIFEST_FILE)
  const text = await reader.readText(manifestPath)
  if (text === null) return { problem: `Could not read ${manifestPath}` }
  try {
    const record = JSON.parse(text) as unknown
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return { problem: `${manifestPath} is not a JSON object` }
    }
    const fields = record as Record<string, unknown>
    return {
      manifest: {
        record: fields,
        name: typeof fields.name === 'string' ? fields.name : undefined,
        version: typeof fields.version === 'string' ? fields.version : undefined,
      },
    }
  } catch {
    return { problem: `Could not parse ${manifestPath}` }
  }
}

export function declaredDependencies(manifest: Manifest, blocks: DependencyBlocks): DeclaredDependency[] {
  const declared: DeclaredDependency[] = []
  for (const [blockName, kind] of blocks) {
    const block = manifest.record[blockName]
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === 'string') declared.push({ name, range, kind })
    }
  }
  return declared
}

export function isNonRegistrySpec(spec: string): boolean {
  return NON_REGISTRY_PREFIXES.some((prefix) => spec.startsWith(prefix)) || GITHUB_SHORTHAND_PATTERN.test(spec)
}

export function importerKeyOf(root: { path: string }, importerPath: string): string {
  return posix.relative(root.path, importerPath) || '.'
}
