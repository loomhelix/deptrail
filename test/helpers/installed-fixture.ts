import { readdir, rename } from 'node:fs/promises'
import path from 'node:path'

export const PLACEHOLDER_MODULES_NAME = '_node_modules'

export async function restoreModulesNames(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(directory, entry.name)
    const restoredPath = entry.name === PLACEHOLDER_MODULES_NAME ? path.join(directory, 'node_modules') : entryPath
    if (restoredPath !== entryPath) await rename(entryPath, restoredPath)
    await restoreModulesNames(restoredPath)
  }
}
