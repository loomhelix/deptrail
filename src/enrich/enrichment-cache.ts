import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const ENRICHMENT_CACHE_FORMAT = 1
export const ENRICHMENT_TTL_MS = 43_200_000

export type EnrichmentCacheKind = 'registry' | 'osv-matches' | 'osv-packages' | 'registry-versions'

export type EnrichmentCache = {
  read(kind: EnrichmentCacheKind, keyParts: readonly string[]): Promise<unknown | null>
  write(kind: EnrichmentCacheKind, keyParts: readonly string[], value: unknown): Promise<void>
}

const KEY_SEPARATOR = '\0'

const DIRECTORY_SEGMENTS_BY_KIND: Record<EnrichmentCacheKind, readonly string[]> = {
  registry: ['registry'],
  'osv-matches': ['osv', 'matches'],
  'osv-packages': ['osv', 'packages'],
  'registry-versions': ['registry-versions'],
}

export function createEnrichmentCache(dir: string): EnrichmentCache {
  const directoryOf = (kind: EnrichmentCacheKind) => path.join(dir, ...DIRECTORY_SEGMENTS_BY_KIND[kind])
  const fileOf = (kind: EnrichmentCacheKind, keyParts: readonly string[]) => {
    const hash = createHash('sha256')
      .update([String(ENRICHMENT_CACHE_FORMAT), ...keyParts].join(KEY_SEPARATOR))
      .digest('hex')
    return path.join(directoryOf(kind), `${hash}.json`)
  }

  return {
    async read(kind, keyParts) {
      try {
        return JSON.parse(await readFile(fileOf(kind, keyParts), 'utf8')) as unknown
      } catch {
        return null
      }
    },

    async write(kind, keyParts, value) {
      await mkdir(directoryOf(kind), { recursive: true })
      const file = fileOf(kind, keyParts)
      const temporaryFile = `${file}.${randomUUID()}.tmp`
      await writeFile(temporaryFile, JSON.stringify(value))
      await rename(temporaryFile, file)
    },
  }
}

export function isFresh(fetchedAt: string, now: number, ttlMs = ENRICHMENT_TTL_MS): boolean {
  const fetchedAtMs = Date.parse(fetchedAt)
  return Number.isFinite(fetchedAtMs) && now - fetchedAtMs < ttlMs
}
