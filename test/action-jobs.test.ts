import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessRequest, ProcessRunner } from '../src/adapters/command-runner.ts'
import { applyJob, revertJob, sharedRootsOf, type JobDeps } from '../src/actions/action-jobs.ts'
import type { ActionServiceOptions } from '../src/actions/action-service.ts'
import { PartialWriteError } from '../src/actions/apply.ts'
import { createChangeSets, type PreviewRecord } from '../src/actions/change-sets.ts'
import type { JobContext } from '../src/actions/job-registry.ts'
import type { ChangeItem, JobResult } from '../src/actions/types.ts'
import { hashSources, type FileScope } from '../src/actions/file-scope.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import type { RootGraph } from '../src/model.ts'
import { LockingOriginals } from './helpers/locking-originals.ts'

const ROOT_ID = 'web'
const MANAGER = { name: 'pnpm', version: '10.34.3' } as const
const tempDirs: string[] = []
const lockedDirs: string[] = []

afterEach(async () => {
  for (const dir of lockedDirs.splice(0)) await chmod(dir, 0o755).catch(() => undefined)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeRelative(root: string, relative: string, text: string): Promise<void> {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

function jobContext(signal: AbortSignal = new AbortController().signal, phases: string[] = []): JobContext {
  return { signal, log: () => undefined, phase: (phase) => void phases.push(phase) }
}

function scopeOf(rootDir: string): FileScope {
  return { rootDir, repoDir: path.dirname(rootDir), outsideManifests: [] }
}

function previewRecord(rootDir: string, graph: RootGraph, written: Map<string, string>, originals: Map<string, string | null>, sources: Map<string, string | null>): PreviewRecord {
  return {
    preview: { id: 'preview-1', rootId: ROOT_ID, createdAt: '2026-10-25T00:00:00.000Z', stale: false, manager: MANAGER, goals: [], newIssues: [], warnings: [], files: [], packageChanges: [] },
    graph,
    changeRevision: 0,
    itemIds: [],
    written,
    originals,
    sources,
    lockfileDiff: { diff: '', truncated: false },
    scope: scopeOf(rootDir),
    lockfile: 'pnpm-lock.yaml',
    sharedRoots: [],
  }
}

async function failingApply(sharedRoots: PreviewRecord['sharedRoots']): Promise<{ rootDir: string; changes: ReturnType<typeof createChangeSets>; unrestored: PartialWriteError['unrestored'] | undefined; rescans: () => number }> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-jobs-test-'))
  tempDirs.push(rootDir)
  const paths = ['packages/one/package.json', 'storefront/package.json', 'pnpm-lock.yaml']
  await writeRelative(rootDir, 'packages/one/package.json', '{"name":"one"}\n')
  await writeRelative(rootDir, 'storefront/package.json', '{"name":"storefront"}\n')
  await writeRelative(rootDir, 'pnpm-lock.yaml', 'lock: old\n')
  const graph: RootGraph = { id: ROOT_ID, path: 'web', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
  const changes = createChangeSets(() => graph)
  let rescans = 0
  const options = { session: { refreshRoot: async () => void rescans++ } } as unknown as ActionServiceOptions
  const deps: JobDeps = { options, changes }
  const stuckDir = path.join(rootDir, 'packages/one')
  const lockedDir = path.join(rootDir, 'storefront')
  lockedDirs.push(stuckDir, lockedDir)
  const record = previewRecord(
    rootDir,
    graph,
    new Map([
      ['packages/one/package.json', 'changed one\n'],
      ['storefront/package.json', 'changed storefront\n'],
      ['pnpm-lock.yaml', 'lock: new\n'],
    ]),
    new LockingOriginals(
      new Map([
        ['packages/one/package.json', '{"name":"one"}\n'],
        ['storefront/package.json', '{"name":"storefront"}\n'],
        ['pnpm-lock.yaml', 'lock: old\n'],
      ]),
      'packages/one/package.json',
      stuckDir,
    ),
    await hashSources(scopeOf(rootDir), paths),
  )
  const recordWithShared = { ...record, sharedRoots }
  changes.storePreview(ROOT_ID, recordWithShared)
  await chmod(lockedDir, 0o555)
  let unrestored: PartialWriteError['unrestored'] | undefined
  await assert.rejects(applyJob(deps, { record: recordWithShared, manager: MANAGER, install: false })(jobContext()), (failure: unknown) => {
    assert.ok(failure instanceof PartialWriteError, String(failure))
    assert.match(failure.message, /^could not write storefront\/package\.json: .+; could not restore packages\/one\/package\.json$/)
    unrestored = failure.unrestored
    return true
  })
  return { rootDir, changes, unrestored, rescans: () => rescans }
}

describe('apply job', () => {
  it('keeps the files it could not restore as the revert record when a write fails', async () => {
    const { rootDir, changes, unrestored, rescans } = await failingApply([])
    assert.equal(await readFile(path.join(rootDir, 'packages/one/package.json'), 'utf8'), 'changed one\n')
    assert.deepEqual(changes.of(ROOT_ID).revert, { scope: scopeOf(rootDir), files: unrestored, items: [], sharedRoots: [] })
    assert.equal(rescans(), 0)
  })

  it('keeps the sharing roots on the revert record when a write fails', async () => {
    const { changes } = await failingApply([{ id: 'libs', manager: 'pnpm' }])
    assert.deepEqual(changes.of(ROOT_ID).revert?.sharedRoots, [{ id: 'libs', manager: 'pnpm' }])
  })

  it('skips the install when the job was cancelled before it, then rescans', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-jobs-test-'))
    tempDirs.push(rootDir)
    await writeRelative(rootDir, 'pnpm-lock.yaml', 'lock: old\n')
    const graph: RootGraph = { id: ROOT_ID, path: 'web', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
    const changes = createChangeSets(() => graph)
    const runs: ProcessRequest[] = []
    const runner: ProcessRunner = {
      async run(request) {
        runs.push(request)
        return { code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false }
      },
      killRunning() {},
    }
    let rescans = 0
    const options = { session: { refreshRoot: async () => void rescans++ }, runner, env: {}, secrets: createSecretSet() } as unknown as ActionServiceOptions
    const record = previewRecord(
      rootDir,
      graph,
      new Map([['pnpm-lock.yaml', 'lock: new\n']]),
      new Map([['pnpm-lock.yaml', 'lock: old\n']]),
      await hashSources(scopeOf(rootDir), ['pnpm-lock.yaml']),
    )
    changes.storePreview(ROOT_ID, record)
    const controller = new AbortController()
    controller.abort()
    const phases: string[] = []
    const result = await applyJob({ options, changes }, { record, manager: MANAGER, install: true })(jobContext(controller.signal, phases))
    assert.deepEqual(runs, [])
    assert.deepEqual(phases, ['writing', 'rescanning'])
    assert.equal(rescans, 1)
    assert.deepEqual(result, { goalsMet: 0, install: 'not-run', files: ['pnpm-lock.yaml'] })
    assert.equal(changes.of(ROOT_ID).revert?.install, 'not-run')
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), 'lock: new\n')
  })
})

describe('apply job sharing roots', () => {
  async function applyWith(sharedRoots: PreviewRecord['sharedRoots']): Promise<JobResult> {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-jobs-test-'))
    tempDirs.push(rootDir)
    await writeRelative(rootDir, 'pnpm-lock.yaml', 'lock: old\n')
    const graph: RootGraph = { id: ROOT_ID, path: 'web', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
    const changes = createChangeSets(() => graph)
    const options = { session: { refreshRoot: async () => undefined } } as unknown as ActionServiceOptions
    const record = {
      ...previewRecord(rootDir, graph, new Map([['pnpm-lock.yaml', 'lock: new\n']]), new Map([['pnpm-lock.yaml', 'lock: old\n']]), await hashSources(scopeOf(rootDir), ['pnpm-lock.yaml'])),
      sharedRoots,
    }
    changes.storePreview(ROOT_ID, record)
    return (await applyJob({ options, changes }, { record, manager: MANAGER, install: false })(jobContext())) ?? {}
  }

  it('reports the sharing roots of the written files', async () => {
    const result = await applyWith([{ id: 'libs', manager: 'pnpm' }])
    assert.deepEqual(result.sharedRoots, [{ id: 'libs', manager: 'pnpm' }])
    assert.equal('sharedRoots' in (await applyWith([])), false)
  })

  it('keeps the sharing roots on the revert record when the install fails', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-jobs-test-'))
    tempDirs.push(rootDir)
    await writeRelative(rootDir, 'pnpm-lock.yaml', 'lock: old\n')
    const graph: RootGraph = { id: ROOT_ID, path: 'web', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
    const changes = createChangeSets(() => graph)
    const runner: ProcessRunner = {
      async run() {
        return { code: 1, stdout: '', stderr: 'boom', timedOut: false, cancelled: false }
      },
      killRunning() {},
    }
    const options = { session: { refreshRoot: async () => undefined }, runner, env: {}, secrets: createSecretSet() } as unknown as ActionServiceOptions
    const record = {
      ...previewRecord(rootDir, graph, new Map([['pnpm-lock.yaml', 'lock: new\n']]), new Map([['pnpm-lock.yaml', 'lock: old\n']]), await hashSources(scopeOf(rootDir), ['pnpm-lock.yaml'])),
      sharedRoots: [{ id: 'libs', manager: 'pnpm' as const }],
    }
    changes.storePreview(ROOT_ID, record)
    await assert.rejects(applyJob({ options, changes }, { record, manager: MANAGER, install: true })(jobContext()), /install failed/)
    assert.deepEqual(changes.of(ROOT_ID).revert?.sharedRoots, [{ id: 'libs', manager: 'pnpm' }])
  })
})

describe('shared roots of an apply record', () => {
  it('lists each sharing root once, sorted by id, when two files share the same roots in reverse order', () => {
    const libs = { id: 'libs', manager: 'pnpm' as const }
    const apps = { id: 'apps', manager: 'pnpm' as const }
    const shared = new Map([
      ['packages/one/package.json', [libs, apps]],
      ['packages/two/package.json', [apps, libs]],
    ])
    assert.deepEqual(sharedRootsOf([{ path: 'packages/one/package.json' }, { path: 'packages/two/package.json' }, { path: 'pnpm-lock.yaml' }], shared), [apps, libs])
  })
})

describe('revert job', () => {
  it('restores the files, puts the applied items back and reports the install of the apply', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-jobs-test-'))
    tempDirs.push(rootDir)
    await writeRelative(rootDir, 'pnpm-lock.yaml', 'lock: old\n')
    const graph: RootGraph = { id: ROOT_ID, path: 'web', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
    const changes = createChangeSets(() => graph)
    const item: ChangeItem = {
      id: 'item-1',
      goal: { kind: 'fix', name: 'lib', version: '1.0.0', advisoryIds: ['GHSA-lib-0001'], severity: 'high' },
      choice: 'relock',
      steps: [{ kind: 'relock', name: 'lib', from: '1.0.0', to: '1.0.1', reason: '1.0.1 is accepted' }],
      warnings: [],
    }
    changes.add(ROOT_ID, item)
    const runner: ProcessRunner = {
      run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false }),
      killRunning() {},
    }
    let rescans = 0
    const options = { session: { refreshRoot: async () => void rescans++ }, runner, env: {}, secrets: createSecretSet() } as unknown as ActionServiceOptions
    const deps: JobDeps = { options, changes }
    const record = {
      ...previewRecord(rootDir, graph, new Map([['pnpm-lock.yaml', 'lock: new\n']]), new Map([['pnpm-lock.yaml', 'lock: old\n']]), await hashSources(scopeOf(rootDir), ['pnpm-lock.yaml'])),
      changeRevision: changes.of(ROOT_ID).revision,
      itemIds: [item.id],
    }
    changes.storePreview(ROOT_ID, record)
    assert.deepEqual(await applyJob(deps, { record, manager: MANAGER, install: true })(jobContext()), { goalsMet: 0, install: 'done', files: ['pnpm-lock.yaml'] })
    const revert = changes.of(ROOT_ID).revert
    assert.ok(revert)
    assert.deepEqual(revert.items, [item])
    assert.equal(revert.install, 'done')
    assert.deepEqual(changes.of(ROOT_ID).items, [])
    const phases: string[] = []
    assert.deepEqual(await revertJob(deps, ROOT_ID, revert)(jobContext(undefined, phases)), { restored: 1, skipped: [], appliedInstall: 'done' })
    assert.deepEqual(phases, ['writing', 'rescanning'])
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
    assert.deepEqual(changes.of(ROOT_ID).items, [item])
    assert.equal(changes.of(ROOT_ID).revert, undefined)
    assert.equal(rescans, 2)
  })
})
