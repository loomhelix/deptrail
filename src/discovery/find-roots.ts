import { posix } from 'node:path'
import type { FileReader } from '../sources/file-reader.ts'
import type { Manager, RootDescriptor } from '../model.ts'
import { readManifest } from '../adapters/package-manifest.ts'
import { compileWorkspacePatterns } from '../config/glob.ts'
import { readWorkspacePatterns } from '../config/root-config.ts'

type DirectoryFacts = {
  path: string
  files: Set<string>
}

type FoundRoot = {
  descriptor: RootDescriptor
  isMember: (path: string) => boolean
}

type IgnoreRule = {
  directory: string
  matches: (relativePath: string) => boolean
}

const ALWAYS_SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])
const GITIGNORE_FILE = '.gitignore'
const PNPM_LOCKFILE = 'pnpm-lock.yaml'
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json']
const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml'
const MANIFEST_FILE = 'package.json'
const NO_MEMBERS = () => false

function createIgnoreMatcher(gitignoreText: string | null): (path: string) => boolean {
  const names = new Set<string>()
  const anchoredPaths = new Set<string>()
  for (const rawLine of (gitignoreText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!') || /[*?[\\]/.test(line)) continue
    const withoutTrailingSlash = line.replace(/\/+$/, '')
    if (withoutTrailingSlash.startsWith('/')) {
      anchoredPaths.add(withoutTrailingSlash.slice(1))
    } else if (withoutTrailingSlash.includes('/')) {
      anchoredPaths.add(withoutTrailingSlash)
    } else if (withoutTrailingSlash !== '') {
      names.add(withoutTrailingSlash)
    }
  }
  return (path) => anchoredPaths.has(path) || names.has(posix.basename(path))
}

function isIgnoredBy(rules: readonly IgnoreRule[], path: string): boolean {
  return rules.some((rule) => isInside(path, rule.directory) && rule.matches(posix.relative(rule.directory, path)))
}

function packageManagerFromField(field: unknown): Manager {
  if (typeof field !== 'string') return 'unknown'
  const name = field.split('@')[0]
  return name === 'pnpm' || name === 'npm' ? name : 'unknown'
}

async function describeRoot(reader: FileReader, facts: DirectoryFacts): Promise<RootDescriptor | null> {
  const { path, files } = facts
  const inDirectory = (name: string) => posix.join(path, name)
  const base = { id: path, path, importerPaths: [path] }

  if (files.has(PNPM_LOCKFILE)) return { ...base, manager: 'pnpm', lockfile: inDirectory(PNPM_LOCKFILE) }
  const npmLockfile = NPM_LOCKFILES.find((name) => files.has(name))
  if (npmLockfile) return { ...base, manager: 'npm', lockfile: inDirectory(npmLockfile) }
  if (files.has(PNPM_WORKSPACE_FILE)) return { ...base, manager: 'pnpm' }
  if (!files.has(MANIFEST_FILE)) return null

  const result = await readManifest(reader, path)
  const record = 'manifest' in result ? result.manifest.record : {}
  if (record.workspaces !== undefined) return { ...base, manager: 'npm' }
  return { ...base, manager: packageManagerFromField(record.packageManager) }
}

async function createMemberMatcher(reader: FileReader, root: RootDescriptor): Promise<(path: string) => boolean> {
  const patterns = await readWorkspacePatterns(reader, root.path)
  if (patterns.length === 0) return NO_MEMBERS
  const matchesPatterns = compileWorkspacePatterns(patterns)
  return (path) => path !== root.path && matchesPatterns(posix.relative(root.path, path))
}

function isInside(directory: string, ancestor: string): boolean {
  return ancestor === '.' || directory.startsWith(`${ancestor}/`)
}

export async function findRoots(reader: FileReader, startPath = '.'): Promise<RootDescriptor[]> {
  const ignoreRules: IgnoreRule[] = [{ directory: '.', matches: createIgnoreMatcher(await reader.readText(GITIGNORE_FILE)) }]
  const foundRoots: FoundRoot[] = []
  const manifestDirectories: string[] = []
  const queue: string[] = [posix.normalize(startPath)]

  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index]
    const entries = await reader.listDir(directory)
    const files = new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name))
    if (directory !== '.' && files.has(GITIGNORE_FILE)) {
      ignoreRules.push({ directory, matches: createIgnoreMatcher(await reader.readText(posix.join(directory, GITIGNORE_FILE))) })
    }
    const subdirectories = entries
      .filter((entry) => entry.kind === 'dir' && !ALWAYS_SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => posix.join(directory, entry.name))
      .filter((path) => !isIgnoredBy(ignoreRules, path))
      .sort()
    queue.push(...subdirectories)

    if (files.has(MANIFEST_FILE)) manifestDirectories.push(directory)

    const enclosing = foundRoots.some((root) => isInside(directory, root.descriptor.path) && root.isMember(directory))
    if (enclosing && files.has(MANIFEST_FILE)) continue

    const descriptor = await describeRoot(reader, { path: directory, files })
    if (descriptor) foundRoots.push({ descriptor, isMember: await createMemberMatcher(reader, descriptor) })
  }

  for (const root of foundRoots) {
    const members = manifestDirectories
      .filter((path) => isInside(path, root.descriptor.path) && root.isMember(path))
      .filter((path) => !isOwnedByOtherRoot(path, root, foundRoots))
    root.descriptor.importerPaths = [root.descriptor.path, ...members.sort()]
  }

  return foundRoots.map((root) => root.descriptor).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function isOwnedByOtherRoot(path: string, candidate: FoundRoot, allRoots: FoundRoot[]): boolean {
  return allRoots.some((other) => other !== candidate && other.descriptor.path === path)
}
