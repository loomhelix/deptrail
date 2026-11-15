import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RootGraph } from '../model.ts'
import { ROOT_MANIFEST, WORKSPACE_FILE } from './edit-plan.ts'
import { declaredOverridesFiles, overridesLocation, type OverridesLocation } from './overrides-location.ts'
import type { ManagerInfo, PackageManagerName } from './types.ts'

const PNPM_LOCKFILE = 'pnpm-lock.yaml'
const NPM_SHRINKWRAP = 'npm-shrinkwrap.json'
const NPM_LOCKFILE = 'package-lock.json'

export function rootDirOf(repoPath: string, root: Pick<RootGraph, 'path'>): string {
  return path.join(repoPath, root.path)
}

export async function pathExists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  )
}

export async function readTextOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8')
  } catch {
    return null
  }
}

export async function lockfileNameOf(rootDir: string, manager: PackageManagerName): Promise<string> {
  if (manager === 'pnpm') return PNPM_LOCKFILE
  return (await pathExists(path.join(rootDir, NPM_SHRINKWRAP))) ? NPM_SHRINKWRAP : NPM_LOCKFILE
}

export async function overridesLocationOf(rootDir: string, manager: ManagerInfo): Promise<OverridesLocation> {
  const [workspaceYaml, rootManifest] = await Promise.all([readTextOrNull(path.join(rootDir, WORKSPACE_FILE)), readTextOrNull(path.join(rootDir, ROOT_MANIFEST))])
  return overridesLocation(manager, declaredOverridesFiles({ workspaceYaml, rootManifest }))
}
