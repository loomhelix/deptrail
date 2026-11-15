import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { posix } from 'node:path'
import { parse } from 'yaml'
import { leavesRoot, readInScope, sha256Hex, type FileScope } from './file-scope.ts'
import type { ManagerInfo } from './types.ts'

export type Sandbox = {
  dir: string
  sources: ReadonlyMap<string, string | null>
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  deleteFile(path: string): Promise<void>
  remove(): Promise<void>
}

export type SandboxRequest = { scope: FileScope; manager: ManagerInfo; importerPaths: readonly string[]; lockfile: string }

const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const ROOT_MANIFEST = 'package.json'
const ROOT_COPY_DIR = 'root'
const PRIVATE_DIR_MODE = 0o700
const PNPMFILE_NAMES = ['.pnpmfile.cjs', '.pnpmfile.mjs']
const activeSandboxDirs = new Set<string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseYamlRecord(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const parsed: unknown = parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseJsonRecord(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function stringValues(value: unknown): string[] {
  return isRecord(value) ? Object.values(value).filter((entry): entry is string => typeof entry === 'string') : []
}

function pnpmfileFromNpmrc(text: string | null): string[] {
  if (text === null) return []
  const values: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator < 0) continue
    if (line.slice(0, separator).trim() === 'pnpmfile') values.push(line.slice(separator + 1).trim())
  }
  return values.filter((value) => value !== '')
}

function isConsidered(scope: FileScope, normalized: string): boolean {
  if (posix.isAbsolute(normalized)) return false
  if (leavesRoot(normalized)) return scope.outsideManifests.includes(normalized)
  return true
}

async function readRootText(scope: FileScope, relative: string): Promise<string | null> {
  return (await readInScope(scope, relative))?.toString('utf8') ?? null
}

async function consideredPaths(request: SandboxRequest): Promise<string[]> {
  const manifests = request.importerPaths.map((importerPath) => posix.join(importerPath, 'package.json'))
  const paths = [...manifests, '.npmrc', WORKSPACE_FILE, request.lockfile]
  if (request.manager.name === 'pnpm') {
    const [workspaceText, npmrcText, rootManifestText] = await Promise.all([
      readRootText(request.scope, WORKSPACE_FILE),
      readRootText(request.scope, '.npmrc'),
      readRootText(request.scope, ROOT_MANIFEST),
    ])
    const workspace = parseYamlRecord(workspaceText)
    const rootManifest = parseJsonRecord(rootManifestText)
    const pnpmSection = isRecord(rootManifest?.pnpm) ? rootManifest.pnpm : undefined
    paths.push(...PNPMFILE_NAMES)
    if (typeof workspace?.pnpmfile === 'string') paths.push(workspace.pnpmfile)
    paths.push(...pnpmfileFromNpmrc(npmrcText))
    paths.push(...stringValues(workspace?.patchedDependencies), ...stringValues(pnpmSection?.patchedDependencies))
  }
  const seen = new Set<string>()
  for (const candidate of paths) {
    const normalized = posix.normalize(candidate)
    if (isConsidered(request.scope, normalized)) seen.add(normalized)
  }
  return [...seen]
}

type Layout = { dir: string; offset: string }

function sandboxFile(layout: Layout, relative: string): string {
  const normalized = posix.join(layout.offset, relative)
  if (posix.isAbsolute(relative) || leavesRoot(normalized)) {
    throw new Error(`Path leaves the sandbox: ${relative}`)
  }
  return path.join(layout.dir, ...normalized.split('/'))
}

async function copyIntoSandbox(scope: FileScope, layout: Layout, relative: string): Promise<string | null> {
  const content = await readInScope(scope, relative)
  if (content === null) return null
  const target = sandboxFile(layout, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  return sha256Hex(content)
}

function removeSandboxDir(dir: string): Promise<void> {
  activeSandboxDirs.delete(dir)
  return rm(dir, { recursive: true, force: true })
}

export async function removeActionSandboxes(): Promise<void> {
  await Promise.all([...activeSandboxDirs].map(removeSandboxDir))
}

async function pinManagerUnlessNamed(request: SandboxRequest, tempDir: string): Promise<void> {
  const manifest = parseJsonRecord(await readRootText(request.scope, ROOT_MANIFEST))
  if (manifest?.packageManager !== undefined) return
  const pin = { private: true, packageManager: `${request.manager.name}@${request.manager.version}` }
  await writeFile(path.join(tempDir, ROOT_MANIFEST), `${JSON.stringify(pin, null, 2)}\n`)
}

function leadingParentCount(manifest: string): number {
  const segments = manifest.split('/')
  const firstOther = segments.findIndex((segment) => segment !== '..')
  return firstOther === -1 ? segments.length : firstOther
}

function outsideDepth(scope: FileScope): number {
  return Math.max(0, ...scope.outsideManifests.map(leadingParentCount))
}

function rootOffset(scope: FileScope): string {
  const segments = path.relative(scope.repoDir, scope.rootDir).split(path.sep).filter((segment) => segment !== '')
  const depth = outsideDepth(scope)
  if (depth > segments.length) throw new Error(`Path leaves the sandbox: ${scope.outsideManifests.join(', ')}`)
  return segments.slice(segments.length - depth).join('/')
}

export async function createSandbox(request: SandboxRequest): Promise<Sandbox> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-'))
  activeSandboxDirs.add(tempDir)
  try {
    const offset = rootOffset(request.scope)
    const copyBase = path.join(tempDir, ROOT_COPY_DIR)
    await mkdir(copyBase, { mode: PRIVATE_DIR_MODE })
    const dir = path.join(copyBase, ...offset.split('/').filter((segment) => segment !== ''))
    await mkdir(dir, { recursive: true })
    const layout: Layout = { dir: copyBase, offset }
    await pinManagerUnlessNamed(request, tempDir)
    const sources = new Map<string, string | null>()
    for (const relative of await consideredPaths(request)) {
      sources.set(relative, await copyIntoSandbox(request.scope, layout, relative))
    }
    return {
      dir,
      sources,
      async readText(relative) {
        try {
          return await readFile(sandboxFile(layout, relative), 'utf8')
        } catch {
          return null
        }
      },
      async writeText(relative, text) {
        const target = sandboxFile(layout, relative)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, text)
      },
      deleteFile(relative) {
        return rm(sandboxFile(layout, relative), { force: true })
      },
      remove: () => removeSandboxDir(tempDir),
    }
  } catch (failure) {
    await removeSandboxDir(tempDir)
    throw failure
  }
}
