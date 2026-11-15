import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computed, nextTick, ref } from 'vue'
import type { DeptrailApi, DuplicateEntry, RootSummary, ScanSummary } from '../ui/src/api.ts'
import { useDuplicateNames } from '../ui/src/duplicate-names.ts'
import { scanRevision } from '../ui/src/scan-state.ts'
import { offlineStatus } from '../src/enrich/enrichment-status.ts'

const ENRICHMENT = offlineStatus(0)

const SEMVER: DuplicateEntry = {
  name: 'semver',
  versions: [
    { version: '7.6.3', roots: ['npm-package'] },
    { version: '6.3.1', roots: ['legacy/admin'] },
  ],
}

function fakeApi(calls: { count: number }, entries: DuplicateEntry[] = [SEMVER]): DeptrailApi {
  return {
    duplicates: async () => {
      calls.count += 1
      return entries
    },
  } as unknown as DeptrailApi
}

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useDuplicateNames', () => {
  it('loads once per scan and again only when the scan time changes', async () => {
    const calls = { count: 0 }
    const scannedAt = ref<string | undefined>(undefined)
    const { versionsByName } = useDuplicateNames(fakeApi(calls), scannedAt)
    await settle()
    assert.equal(calls.count, 0)
    scannedAt.value = '2026-10-24T10:00:00Z'
    await settle()
    assert.equal(calls.count, 1)
    assert.equal(versionsByName.value.get('semver'), '7.6.3 (npm-package); 6.3.1 (legacy/admin)')
    scannedAt.value = '2026-10-24T10:00:00Z'
    await settle()
    assert.equal(calls.count, 1)
    scannedAt.value = '2026-10-24T11:00:00Z'
    await settle()
    assert.equal(calls.count, 2)
  })

  it('reloads when a root of a cold scan finishes or changes source, not on idle polls', async () => {
    const calls = { count: 0 }
    const root = (id: string, status: RootSummary['status'], source: RootSummary['source'] = 'lockfile') =>
      ({ id, path: id, manager: 'pnpm', source, status, warnings: [], importers: [], packageCount: 0, duplicateCount: 0, hasAuth: false, actions: { available: false, changeCount: 0, revertable: false } }) as RootSummary
    const scan = ref<ScanSummary | null>(null)
    useDuplicateNames(fakeApi(calls), computed(() => scanRevision(scan.value)))
    const scannedAt = '2026-10-24T10:00:00Z'
    scan.value = { repoPath: '/repo', scannedAt, roots: [root('one', 'scanning'), root('two', 'scanning')], enrichment: ENRICHMENT }
    await settle()
    assert.equal(calls.count, 1)
    scan.value = { repoPath: '/repo', scannedAt, roots: [root('one', 'scanning'), root('two', 'scanning')], enrichment: ENRICHMENT }
    await settle()
    assert.equal(calls.count, 1)
    scan.value = { repoPath: '/repo', scannedAt, roots: [root('one', 'ready'), root('two', 'scanning')], enrichment: ENRICHMENT }
    await settle()
    assert.equal(calls.count, 2)
    scan.value = { repoPath: '/repo', scannedAt, roots: [root('one', 'ready'), root('two', 'ready', 'resolved-today')], enrichment: ENRICHMENT }
    await settle()
    assert.equal(calls.count, 3)
  })

  it('reports a failed load', async () => {
    const api = {
      duplicates: async () => {
        throw new Error('boom')
      },
    } as unknown as DeptrailApi
    const { error } = useDuplicateNames(api, ref('now'))
    await settle()
    assert.equal(error.value, 'Could not load the duplicates: boom')
  })
})
