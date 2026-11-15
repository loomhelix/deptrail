import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createEnrichmentCache, ENRICHMENT_TTL_MS, isFresh } from '../src/enrich/enrichment-cache.ts'

const REGISTRY_URL = 'https://r.example/'
const PACKAGE_NAME = 'lodash'
const HEX_FILE_NAME = /^[0-9a-f]{64}\.json$/

async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
}

describe('enrichment cache', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'deptrail-enrichment-cache-'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a written value', async () => {
    const cache = createEnrichmentCache(path.join(dir, 'round-trip'))
    const value = { fetchedAt: '2026-01-01T00:00:00.000Z', versions: ['1.0.0'] }
    await cache.write('registry', [REGISTRY_URL, PACKAGE_NAME], value)
    assert.deepEqual(await cache.read('registry', [REGISTRY_URL, PACKAGE_NAME]), value)
  })

  it('reads null for a missing entry', async () => {
    const cache = createEnrichmentCache(path.join(dir, 'missing'))
    assert.equal(await cache.read('osv-matches', ['nothing']), null)
  })

  it('stores each kind in its own directory under a hex file name without key parts', async () => {
    const root = path.join(dir, 'layout')
    const cache = createEnrichmentCache(root)
    await cache.write('registry', [REGISTRY_URL, PACKAGE_NAME], 1)
    await cache.write('osv-matches', [REGISTRY_URL, PACKAGE_NAME], 2)
    await cache.write('osv-packages', [REGISTRY_URL, PACKAGE_NAME], 3)

    const files = (await listFilesRecursively(root)).map((file) => path.relative(root, file))
    assert.equal(files.length, 3)
    assert.deepEqual(
      files.map((file) => path.dirname(file)).sort(),
      [path.join('osv', 'matches'), path.join('osv', 'packages'), 'registry'],
    )
    for (const file of files) {
      assert.match(path.basename(file), HEX_FILE_NAME)
      assert.ok(!file.includes('lodash'))
      assert.ok(!file.includes('r.example'))
    }
  })

  it('stores published versions under registry-versions with a hex file name', async () => {
    const root = path.join(dir, 'registry-versions')
    const cache = createEnrichmentCache(root)
    await cache.write('registry-versions', [REGISTRY_URL, PACKAGE_NAME], { ok: true })
    const files = (await listFilesRecursively(root)).map((file) => path.relative(root, file))
    assert.equal(files.length, 1)
    assert.equal(path.dirname(files[0]), 'registry-versions')
    assert.match(path.basename(files[0]), HEX_FILE_NAME)
    assert.deepEqual(await cache.read('registry-versions', [REGISTRY_URL, PACKAGE_NAME]), { ok: true })
    assert.equal(await cache.read('registry', [REGISTRY_URL, PACKAGE_NAME]), null)
  })

  it('reads a corrupt file as null', async () => {
    const root = path.join(dir, 'corrupt')
    const cache = createEnrichmentCache(root)
    await cache.write('registry', ['a'], { ok: true })
    const [file] = await listFilesRecursively(root)
    await writeFile(file, '{not json')
    assert.equal(await cache.read('registry', ['a']), null)
  })

  it('leaves no temporary file after write', async () => {
    const root = path.join(dir, 'temporary')
    const cache = createEnrichmentCache(root)
    await cache.write('osv-packages', ['a'], { ok: true })
    const files = await listFilesRecursively(root)
    assert.ok(files.every((file) => !file.endsWith('.tmp')))
  })

  it('distinguishes different key parts', async () => {
    const cache = createEnrichmentCache(path.join(dir, 'distinct'))
    await cache.write('registry', ['a', 'b'], 'first')
    assert.equal(await cache.read('registry', ['a', 'c']), null)
    assert.equal(await cache.read('registry', ['a', 'b']), 'first')
  })
})

describe('isFresh', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z')

  it('is true just inside the time to live', () => {
    assert.equal(isFresh(new Date(now - ENRICHMENT_TTL_MS + 1).toISOString(), now), true)
  })

  it('is false just outside the time to live', () => {
    assert.equal(isFresh(new Date(now - ENRICHMENT_TTL_MS - 1).toISOString(), now), false)
  })

  it('is false for an invalid date', () => {
    assert.equal(isFresh('not a date', now), false)
  })
})
