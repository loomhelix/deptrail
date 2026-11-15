import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type DirEntry = { name: string; kind: 'file' | 'dir' | 'symlink' }

export interface FileReader {
  readText(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  listDir(path: string): Promise<DirEntry[]>
  realpath(path: string): Promise<string | null>
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

export function createFsReader(repoPath: string): FileReader {
  const absoluteRepoPath = path.resolve(repoPath)

  const resolve = (relativePath: string) => path.resolve(absoluteRepoPath, relativePath)

  return {
    async readText(relativePath) {
      try {
        return await readFile(resolve(relativePath), 'utf8')
      } catch {
        return null
      }
    },

    async exists(relativePath) {
      try {
        await stat(resolve(relativePath))
        return true
      } catch {
        return false
      }
    },

    async listDir(relativePath) {
      try {
        const entries = await readdir(resolve(relativePath), { withFileTypes: true })
        return entries.map((entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file',
        }))
      } catch {
        return []
      }
    },

    async realpath(relativePath) {
      try {
        const [resolvedRepo, resolvedTarget] = await Promise.all([
          realpath(absoluteRepoPath),
          realpath(resolve(relativePath)),
        ])
        const relative = path.relative(resolvedRepo, resolvedTarget)
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null
        return relative === '' ? '.' : toPosix(relative)
      } catch {
        return null
      }
    },
  }
}
