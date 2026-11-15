import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitRepository, GitUnavailable } from '../src/git/git-repository.ts'
import type { GitRef } from '../src/git/ref-list.ts'
import type { ScanSession } from '../src/scan/scan-session.ts'
import { createSourceRegistry } from '../src/scan/source-registry.ts'
import { BranchError, COMMIT_ACTIONS_REASON, createBranches, WORKING_KEY } from '../src/server/branches.ts'
import { handleApi, type ApiContext } from '../src/server/router.ts'
import { WORKING_KEY as SHARED_WORKING_KEY } from '../src/server/source-key.ts'

const HEAD = '1'.repeat(40)
const MAIN = '2'.repeat(40)
const SCOPED = '3'.repeat(40)
const UMLAUT = '4'.repeat(40)
const BASE = '5'.repeat(40)
const DATE = '2026-10-20T10:00:00.000Z'

function ref(name: string, commit: string, kind: GitRef['kind'] = 'branch'): GitRef {
  return { name, short: name.replace(/^refs\/(heads|remotes|tags)\//, ''), kind, commit, committedAt: DATE }
}

const REFS = [ref('refs/heads/main', MAIN), ref('refs/heads/fix/@scope#1', SCOPED), ref('refs/heads/ü', UMLAUT)]

type FakeGit = GitRepository & { mergeBases: string[][] }

function fakeGit(options: { head?: { commit: string; branch?: string }; mergeBase?: string; treeError?: string } = {}): FakeGit {
  const mergeBases: string[][] = []
  return {
    prefix: '',
    mergeBases,
    head: async () => ('head' in options ? options.head : { commit: HEAD, branch: 'refs/heads/main' }),
    refs: async () => ({ refs: REFS, defaultBranch: 'refs/heads/main' }),
    tree: async () => {
      throw new Error('not used')
    },
    mergeBase: async (left, right) => {
      mergeBases.push([left, right])
      return options.mergeBase
    },
    readBlob: async () => null,
    close: () => {},
  }
}

function stubSession(name: string): ScanSession {
  return { name, scan: { repoPath: '/repo', roots: [], scannedAt: '' } } as unknown as ScanSession
}

function setup(git: GitRepository | GitUnavailable, openSession: (commit: string) => Promise<ScanSession> = async (commit) => stubSession(commit)) {
  const working = stubSession('working')
  const sources = createSourceRegistry({ working, openSession, onRootsChanged: () => {} })
  return { working, sources, branches: createBranches(git, sources) }
}

async function rejectsWith(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BranchError)
    assert.equal(error.status, status)
    assert.equal(error.message, message)
    return true
  })
}

describe('branches', () => {
  it('shares one working key', () => {
    assert.equal(WORKING_KEY, 'work')
    assert.equal(SHARED_WORKING_KEY, WORKING_KEY)
    assert.equal(COMMIT_ACTIONS_REASON, 'Actions apply to the working tree. Switch to it to change files.')
  })

  it('reports availability and refs', async () => {
    const unavailable = setup({ unavailable: 'git was not found on the PATH', quiet: false }).branches
    assert.deepEqual(await unavailable.info(), { available: false, reason: 'git was not found on the PATH', quiet: false })
    const available = setup(fakeGit()).branches
    assert.deepEqual(await available.info(), {
      available: true,
      head: { commit: HEAD, branch: 'refs/heads/main' },
      defaultBranch: 'refs/heads/main',
      refs: REFS,
    })
    const unborn = setup(fakeGit({ head: undefined })).branches
    const info = await unborn.info()
    assert.equal(info.available, true)
    assert.equal('head' in info, false)
  })

  it('reports a failing ref listing as unavailable', async () => {
    const git = { ...fakeGit(), refs: async () => Promise.reject(new Error('fatal: bad object')) }
    assert.deepEqual(await setup(git).branches.info(), { available: false, reason: 'fatal: bad object', quiet: false })
  })

  it('opens a listed ref', async () => {
    const { branches, sources } = setup(fakeGit())
    assert.deepEqual(await branches.open({ ref: 'refs/heads/fix/@scope#1' }), { key: SCOPED, commit: SCOPED, ref: 'refs/heads/fix/@scope#1', committedAt: DATE })
    assert.deepEqual(await branches.open({ ref: 'refs/heads/ü' }), { key: UMLAUT, commit: UMLAUT, ref: 'refs/heads/ü', committedAt: DATE })
    assert.ok(sources.commit(SCOPED))
    assert.ok(sources.commit(UMLAUT))
  })

  it('opens HEAD', async () => {
    const { branches } = setup(fakeGit())
    assert.deepEqual(await branches.open({ ref: 'HEAD' }), { key: HEAD, commit: HEAD, ref: 'HEAD' })
  })

  it('refuses refs that are malformed, unknown or empty', async () => {
    const { branches } = setup(fakeGit())
    await rejectsWith(branches.open({ ref: '-c' }), 400, 'Invalid ref')
    await rejectsWith(branches.open({ ref: '--all' }), 400, 'Invalid ref')
    await rejectsWith(branches.open({ ref: 'main' }), 400, 'Invalid ref')
    await rejectsWith(branches.open({ ref: 'refs/heads/gone' }), 404, 'Unknown ref refs/heads/gone')
    await rejectsWith(setup(fakeGit({ head: undefined })).branches.open({ ref: 'HEAD' }), 409, 'The repository has no commits yet')
  })

  it('refuses everything when git is unavailable', async () => {
    const { branches } = setup({ unavailable: 'This directory is not in a git repository', quiet: true })
    await rejectsWith(branches.open({ ref: 'refs/heads/main' }), 409, 'This directory is not in a git repository')
  })

  it('names the submodules that a commit source skips', async () => {
    const { branches } = setup(fakeGit(), async (commit) => {
      const session = stubSession(commit)
      session.scan.skippedSubmodules = ['vendor/sub']
      return session
    })
    assert.deepEqual(await branches.open({ ref: 'refs/heads/main' }), {
      key: MAIN,
      commit: MAIN,
      ref: 'refs/heads/main',
      committedAt: DATE,
      skippedSubmodules: ['vendor/sub'],
    })
  })

  it('reports a source that fails to open', async () => {
    const { branches } = setup(fakeGit(), async () => {
      throw new Error('the tree has more than 2000000 entries')
    })
    await rejectsWith(branches.open({ ref: 'refs/heads/main' }), 409, 'the tree has more than 2000000 entries')
  })

  it('opens the merge base of the working tree and a commit', async () => {
    const git = fakeGit({ mergeBase: BASE })
    const { branches, sources } = setup(git)
    await branches.open({ ref: 'refs/heads/main' })
    assert.deepEqual(await branches.open({ mergeBase: { base: WORKING_KEY, target: MAIN } }), { key: BASE, commit: BASE })
    assert.deepEqual(git.mergeBases, [[HEAD, MAIN]])
    assert.ok(sources.commit(BASE))
  })

  it('refuses merge bases of unknown sources or without common history', async () => {
    const { branches } = setup(fakeGit({ mergeBase: undefined }))
    await rejectsWith(branches.open({ mergeBase: { base: WORKING_KEY, target: MAIN } }), 404, `Unknown source ${MAIN}`)
    await rejectsWith(branches.open({ mergeBase: { base: '../x', target: WORKING_KEY } }), 404, 'Unknown source ../x')
    await branches.open({ ref: 'refs/heads/main' })
    await rejectsWith(branches.open({ mergeBase: { base: WORKING_KEY, target: MAIN } }), 409, 'No merge base')
  })

  it('keeps the target of a compare whose base was dropped', async () => {
    const working = stubSession('working')
    const sources = createSourceRegistry({ working, openSession: async (commit) => stubSession(commit), onRootsChanged: () => {}, limit: 2 })
    const branches = createBranches(fakeGit(), sources)
    const context = { session: working, branches } as unknown as ApiContext
    const compare = (base: string, target: string) =>
      handleApi(context, { method: 'GET', pathname: '/api/compare', searchParams: new URLSearchParams({ base, target }) }, () => {})
    await branches.open({ ref: 'refs/heads/fix/@scope#1' })
    await branches.open({ ref: 'refs/heads/main' })
    branches.sessionOf(SCOPED)
    await branches.open({ ref: 'refs/heads/ü' })
    const dropped = await compare(MAIN, SCOPED)
    assert.equal(dropped.status, 404)
    await branches.open({ ref: 'refs/heads/main' })
    assert.notEqual(branches.sessionOf(SCOPED), undefined)
  })

  it('resolves session keys', async () => {
    const { branches, working } = setup(fakeGit())
    await branches.open({ ref: 'refs/heads/main' })
    assert.equal(branches.sessionOf(WORKING_KEY), working)
    assert.equal((branches.sessionOf(MAIN) as unknown as { name: string }).name, MAIN)
    assert.equal(branches.sessionOf(SCOPED), undefined)
    assert.equal(branches.sessionOf('../x'), undefined)
  })
})
