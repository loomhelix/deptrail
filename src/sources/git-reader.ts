import { posix } from 'node:path'
import type { TreeIndex } from '../git/tree-index.ts'
import type { FileReader } from './file-reader.ts'

const TOP = '.'
const PARENT_SEGMENT = '..'

function indexPathOf(relativePath: string): string | null {
  if (relativePath === '' || relativePath === TOP) return TOP
  if (posix.isAbsolute(relativePath)) return null
  const normalized = posix.normalize(relativePath).replace(/\/+$/, '')
  return normalized === '' ? TOP : normalized
}

function isAboveTop(indexPath: string): boolean {
  return indexPath === PARENT_SEGMENT || indexPath.startsWith(`${PARENT_SEGMENT}/`)
}

export function createGitReader(index: TreeIndex, readBlob: (blobId: string) => Promise<Buffer | null>): FileReader {
  const isListed = (indexPath: string) => indexPath === TOP || index.kinds.has(indexPath) || index.directories.has(indexPath)

  return {
    async readText(relativePath) {
      const indexPath = indexPathOf(relativePath)
      const blobId = indexPath === null ? undefined : index.blobs.get(indexPath)
      if (blobId === undefined) return null
      try {
        return (await readBlob(blobId))?.toString('utf8') ?? null
      } catch {
        return null
      }
    },

    async exists(relativePath) {
      const indexPath = indexPathOf(relativePath)
      return indexPath !== null && isListed(indexPath)
    },

    async listDir(relativePath) {
      const indexPath = indexPathOf(relativePath)
      return indexPath === null ? [] : [...(index.directories.get(indexPath) ?? [])]
    },

    async realpath(relativePath) {
      const indexPath = indexPathOf(relativePath)
      if (indexPath === null || isAboveTop(indexPath) || !isListed(indexPath) || index.kinds.get(indexPath) === 'symlink') return null
      return indexPath
    },
  }
}
