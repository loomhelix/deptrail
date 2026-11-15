import type { RootGraph } from '../model.ts'
import { manifestPathOf } from './edit-plan.ts'
import type { SharingRoot } from './types.ts'

const SHARING_MANAGERS: readonly string[] = ['pnpm', 'npm']
const NAMED_FILES_LIMIT = 3
const REPOSITORY_ROOT_ID = '.'

function canShare(root: RootGraph): boolean {
  return root.source === 'lockfile' && SHARING_MANAGERS.includes(root.manager)
}

function importerPaths(root: RootGraph): Set<string> {
  return new Set(root.importers.map((importer) => importer.path))
}

export function sharesWorkspacePackage(left: RootGraph, right: RootGraph): boolean {
  if (left.id === right.id) return false
  const rightPaths = importerPaths(right)
  return left.importers.some((importer) => rightPaths.has(importer.path))
}

export function sharingRoots(root: RootGraph, roots: readonly RootGraph[]): Map<string, SharingRoot[]> {
  const others = roots.filter((other) => other.id !== root.id && canShare(other)).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const shared = new Map<string, SharingRoot[]>()
  for (const importer of root.importers) {
    const sharing = others.filter((other) => importerPaths(other).has(importer.path)).map((other) => ({ id: other.id, manager: other.manager as SharingRoot['manager'] }))
    if (sharing.length > 0) shared.set(manifestPathOf(importer.id), sharing)
  }
  return shared
}

function filesText(paths: readonly string[]): string {
  const named = paths.slice(0, NAMED_FILES_LIMIT).join(', ')
  const rest = paths.length - NAMED_FILES_LIMIT
  if (rest <= 0) return named
  return `${named}, and ${rest} more file${rest === 1 ? '' : 's'}`
}

export function sharedRootWarnings(paths: readonly string[], shared: ReadonlyMap<string, readonly SharingRoot[]>): string[] {
  const filesByRoot = new Map<string, { manager: SharingRoot['manager']; files: string[] }>()
  for (const path of paths) {
    for (const sharing of shared.get(path) ?? []) {
      const entry = filesByRoot.get(sharing.id) ?? { manager: sharing.manager, files: [] }
      entry.files.push(path)
      filesByRoot.set(sharing.id, entry)
    }
  }
  return [...filesByRoot.keys()]
    .sort()
    .map((id) => {
      const { manager, files } = filesByRoot.get(id)!
      const isRepositoryRoot = id === REPOSITORY_ROOT_ID
      return `${isRepositoryRoot ? 'The repository root' : id} also uses ${filesText(files)}: its lockfile is not updated; run ${manager} install in ${isRepositoryRoot ? 'the repository root' : id}`
    })
}
