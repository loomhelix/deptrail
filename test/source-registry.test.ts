import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RootGraph } from '../src/model.ts'
import type { ScanSession } from '../src/scan/scan-session.ts'
import { COMMIT_SOURCE_LIMIT, createSourceRegistry } from '../src/scan/source-registry.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

function graph(id: string): RootGraph {
  return { id, path: id, manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
}

function stubSession(rootId: string): ScanSession {
  return { scan: { repoPath: '/repo', roots: [graph(rootId)], scannedAt: '' } } as unknown as ScanSession
}

function rootIds(roots: readonly RootGraph[]): string[] {
  return roots.map((root) => root.id)
}

describe('source registry', () => {
  it('keeps four commit sources by default', () => {
    assert.equal(COMMIT_SOURCE_LIMIT, 4)
  })

  it('opens a commit once for concurrent requests', async () => {
    let opened = 0
    const registry = createSourceRegistry({
      working: stubSession('work'),
      openSession: async (commit) => {
        opened += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return stubSession(commit)
      },
      onRootsChanged: () => {},
    })
    const [first, second] = await Promise.all([registry.openCommit(A), registry.openCommit(A)])
    assert.equal(opened, 1)
    assert.equal(first, second)
    assert.equal(first.commit, A)
    assert.equal(registry.commit(A), first)
    assert.equal(await registry.openCommit(A), first)
    assert.equal(opened, 1)
  })

  it('drops the least recently used source beyond the limit', async () => {
    const registry = createSourceRegistry({
      working: stubSession('work'),
      openSession: async (commit) => stubSession(commit),
      onRootsChanged: () => {},
      limit: 2,
    })
    await registry.openCommit(A)
    await registry.openCommit(B)
    registry.commit(A)
    await registry.openCommit(C)
    assert.equal(registry.commit(B), undefined)
    assert.ok(registry.commit(A))
    assert.ok(registry.commit(C))
  })

  it('reports roots after opening and dropping', async () => {
    const reports: string[][] = []
    const registry = createSourceRegistry({
      working: stubSession('work'),
      openSession: async (commit) => stubSession(commit),
      onRootsChanged: (roots) => reports.push(rootIds(roots)),
      limit: 1,
    })
    await registry.openCommit(A)
    assert.deepEqual(reports.at(-1), ['work', A])
    await registry.openCommit(B)
    assert.deepEqual(reports.at(-1), ['work', B])
    assert.deepEqual(rootIds(registry.allRoots()), ['work', B])
    registry.rootsChanged()
    assert.deepEqual(reports.at(-1), ['work', B])
    assert.equal(reports.length, 3)
  })

  it('retries a failed open', async () => {
    let attempts = 0
    const registry = createSourceRegistry({
      working: stubSession('work'),
      openSession: async (commit) => {
        attempts += 1
        if (attempts === 1) throw new Error('tree failed')
        return stubSession(commit)
      },
      onRootsChanged: () => {},
    })
    await assert.rejects(registry.openCommit(A), /tree failed/)
    assert.equal(registry.commit(A), undefined)
    assert.equal((await registry.openCommit(A)).commit, A)
    assert.equal(attempts, 2)
  })

  it('retries after an open that throws synchronously', async () => {
    let attempts = 0
    const registry = createSourceRegistry({
      working: stubSession('work'),
      openSession: (commit) => {
        attempts += 1
        if (attempts === 1) throw new Error('spawn failed')
        return Promise.resolve(stubSession(commit))
      },
      onRootsChanged: () => {},
    })
    await assert.rejects(registry.openCommit(A), /spawn failed/)
    assert.equal((await registry.openCommit(A)).commit, A)
  })

  it('forgets every commit source on close', async () => {
    const registry = createSourceRegistry({ working: stubSession('work'), openSession: async (commit) => stubSession(commit), onRootsChanged: () => {} })
    await registry.openCommit(A)
    registry.close()
    assert.equal(registry.commit(A), undefined)
    assert.deepEqual(rootIds(registry.allRoots()), ['work'])
  })
})
