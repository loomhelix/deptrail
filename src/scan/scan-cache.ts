import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deserializeRootGraph, serializeRootGraph } from '../graph/serialize.ts'
import type { RootGraph } from '../model.ts'
import { isRootGraphShape } from './cache-shape.ts'

export type ScanCache = {
  get(key: string): Promise<RootGraph | null>
  set(key: string, graph: RootGraph): Promise<void>
}

const KEY_SEPARATOR = '\0'
export const CACHE_FORMAT = 2

export function cacheKeyOf(repoPath: string, rootPath: string, lockfileText: string, format = CACHE_FORMAT): string {
  return createHash('sha256')
    .update([String(format), repoPath, rootPath, lockfileText].join(KEY_SEPARATOR))
    .digest('hex')
}

export function createScanCache(dir: string): ScanCache {
  const fileOf = (key: string) => path.join(dir, `${key}.json`)

  return {
    async get(key) {
      try {
        const json: unknown = JSON.parse(await readFile(fileOf(key), 'utf8'))
        return isRootGraphShape(json) ? deserializeRootGraph(json) : null
      } catch {
        return null
      }
    },

    async set(key, graph) {
      await mkdir(dir, { recursive: true })
      const temporaryFile = `${fileOf(key)}.${randomUUID()}.tmp`
      await writeFile(temporaryFile, JSON.stringify(serializeRootGraph(graph)))
      await rename(temporaryFile, fileOf(key))
    },
  }
}
