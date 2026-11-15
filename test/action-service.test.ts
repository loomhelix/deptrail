import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createProcessRunner, type CommandRunner, type ProcessRunner } from '../src/adapters/command-runner.ts'
import { ActionError, createActionService, disabledActions, type ActionService } from '../src/actions/action-service.ts'
import { createChangeSets, type ChangeSets, type PreviewRecord } from '../src/actions/change-sets.ts'
import type { ChangeItem, Job, RelockStep } from '../src/actions/types.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import type { RootGraph } from '../src/model.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import { startScanSession, type ScanSession } from '../src/scan/scan-session.ts'
import { createFsReader } from '../src/sources/file-reader.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta, stubEnrichment } from './helpers/enrichment-view.ts'
import { installFakePackageManager, type FakeManager } from './helpers/fake-package-manager.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const monolithFixture = path.join(testDir, 'fixtures', 'monolith')
const fixtureLockfile = await readFile(path.join(monolithFixture, 'npm-package', 'pnpm-lock.yaml'), 'utf8')
const fixedLockfile = fixtureLockfile.replaceAll('5.7.2', '5.7.3')

const ROOT = 'npm-package'
const PARSER = 'vue-eslint-parser@9.4.3(eslint@9.17.0)'
const SLOW_RUN = { DEPTRAIL_FAKE_PM_SLEEP_MS: '400' }
const STUCK_RUN = { DEPTRAIL_FAKE_PM_SLEEP_MS: '20000', DEPTRAIL_FAKE_PM_STDOUT: 'started' }

const META = {
  semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.6.3', '7.7.1'], latest: '7.7.1' }),
  'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
  'vue-eslint-parser': makeMeta({
    versions: ['9.4.3', '9.4.4', '10.0.0'],
    manifests: { '9.4.3': { semver: '5.7.2' }, '9.4.4': { semver: '^7.3.6' }, '10.0.0': { semver: '^7.6.0' } },
  }),
  'eslint-plugin-vue': makeMeta({ versions: ['9.32.0'], manifests: { '9.32.0': { 'vue-eslint-parser': '^9.4.3' } } }),
}

const VIEW = makeEnrichmentView({
  meta: META,
  vulns: { 'semver@5.7.2': ['GHSA-semver-0001'], 'vue-eslint-parser@9.4.3': ['GHSA-parser-0001'], 'eslint@9.17.0': ['GHSA-eslint-0001'] },
  advisories: {
    semver: [makeAdvisory({ id: 'GHSA-semver-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })],
    'vue-eslint-parser': [makeAdvisory({ id: 'GHSA-parser-0001', severity: 'moderate', events: [{ introduced: '0' }, { fixed: '10.0.0' }] })],
  },
})

const CHAIN_STEPS: RelockStep[] = [
  { kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'normalize-package-data accepts it' },
  { kind: 'relock', name: 'vue-eslint-parser', from: '9.4.3', to: '9.4.4', reason: '9.4.4 requires semver ^7.3.6; eslint-plugin-vue ^9.4.3 accepts it' },
]

const tempDirs: string[] = []
const services: ActionService[] = []

const throwingRunner: CommandRunner = async () => {
  throw new Error('the scan must not run a command')
}

type Harness = { repo: string; rootDir: string; session: ScanSession; service: ActionService; pnpm: FakeManager; root(id?: string): RootGraph }
type SetupOptions = {
  offline?: boolean
  env?: Record<string, string>
  runner?: (inner: ProcessRunner) => ProcessRunner
  session?: (inner: ScanSession) => ScanSession
  prepareRepo?: (repo: string) => Promise<void>
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'deptrail-action-service-test-'))
  tempDirs.push(workDir)
  const repo = path.join(workDir, 'monolith')
  await cp(monolithFixture, repo, { recursive: true })
  await options.prepareRepo?.(repo)
  const pnpm = await installFakePackageManager(workDir, 'pnpm')
  await installFakePackageManager(workDir, 'npm')
  const prepared = path.join(workDir, 'prepared-lock.yaml')
  await writeFile(prepared, fixedLockfile)
  const session = await startScanSession({ repoPath: repo, reader: createFsReader(repo), runner: throwingRunner, cache: null, env: {}, userNpmrc: null })
  await session.ready
  const processRunner = createProcessRunner()
  const service = createActionService({
    repoPath: repo,
    session: options.session ? options.session(session) : session,
    enrichment: stubEnrichment(VIEW, {}, { published: META }),
    runner: options.runner ? options.runner(processRunner) : processRunner,
    env: pnpm.env({ COREPACK_ENABLE_NETWORK: '0', DEPTRAIL_FAKE_PM_LOCKFILES: JSON.stringify([prepared]), ...options.env }),
    offline: options.offline ?? false,
    secrets: createSecretSet(),
  })
  services.push(service)
  return {
    repo,
    rootDir: path.join(repo, ROOT),
    session,
    service,
    pnpm,
    root(id = ROOT) {
      const root = session.root(id)
      assert.ok(root, `root ${id}`)
      return root
    },
  }
}

async function probed(service: ActionService, rootId: string = ROOT): Promise<void> {
  await service.nodeActions(rootId, 'importer:.', ALL_KINDS)
}

async function ready(options: SetupOptions = {}): Promise<Harness> {
  const harness = await setup(options)
  harness.service.track(harness.session.scan.roots)
  await probed(harness.service)
  return harness
}

function frozenInstallRunner(extraEnv: Record<string, string>): (inner: ProcessRunner) => ProcessRunner {
  return (inner) => ({
    run: (request) => inner.run(request.args.includes('--frozen-lockfile') ? { ...request, env: { ...request.env, ...extraEnv } } : request),
    killRunning: () => inner.killRunning(),
  })
}

async function finished(service: ActionService, job: Job): Promise<Job> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const current = service.job(job.id, 0)
    if (current.state !== 'running') return current
    await delay(10)
  }
  throw new Error(`job ${job.id} did not finish`)
}

async function lineLogged(service: ActionService, job: Job, line: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const current = service.job(job.id, 0)
    if (current.log.includes(line)) return
    if (current.state !== 'running') throw new Error(`job ended ${current.state} before logging ${line}: ${current.error}`)
    await delay(10)
  }
  throw new Error(`job ${job.id} never logged ${line}`)
}

async function rejectsWith(action: () => unknown, status: number, message: string, conflictsWith?: string): Promise<void> {
  await assert.rejects(
    async () => action(),
    (failure: unknown) => {
      assert.ok(failure instanceof ActionError, String(failure))
      assert.equal(failure.name, 'ActionError')
      assert.equal(failure.status, status)
      assert.equal(failure.message, message)
      assert.equal(failure.conflictsWith, conflictsWith)
      return true
    },
  )
}

function prepareSharingRoot(rootDirName: string, importerPath: string): (repo: string) => Promise<void> {
  const importerLines = ['  .: {}', '', `  ${importerPath}:`, '    dependencies:', '      semver:', '        specifier: ^7.6.3', '        version: 7.6.3', '']
  const lockfile = ["lockfileVersion: '9.0'", '', 'importers:', '', ...importerLines, 'packages:', '', '  semver@7.6.3:', '    resolution: {integrity: sha512-fixture-semver-7}', '', 'snapshots:', '', '  semver@7.6.3: {}', '', ''].join('\n')
  return async (repo) => {
    const rootDir = path.join(repo, rootDirName)
    await mkdir(rootDir, { recursive: true })
    await writeFile(path.join(rootDir, 'package.json'), '{ "name": "sharing-root" }\n')
    await writeFile(path.join(rootDir, 'pnpm-workspace.yaml'), `packages:\n  - '${importerPath}'\n`)
    await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), lockfile)
  }
}

async function addChainFix(service: ActionService): Promise<ChangeItem> {
  return service.addChange(ROOT, { nodeId: 'semver@5.7.2', choice: 'recommended' })
}

async function freshPreview(service: ActionService): Promise<string> {
  const job = await finished(service, service.startPreview(ROOT))
  assert.equal(job.state, 'done', job.error)
  const previewId = job.result?.previewId
  assert.ok(previewId)
  return previewId
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

async function lastRunDirectoryExists(pnpm: FakeManager): Promise<boolean> {
  const runs = await pnpm.runs()
  const last = runs.at(-1)
  assert.ok(last, 'the package manager ran')
  return exists(last.cwd)
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('action service', () => {
  it('says why actions are unavailable and becomes available once the package manager answers', async () => {
    const offline = await setup({ offline: true })
    offline.service.track(offline.session.scan.roots)
    assert.deepEqual(offline.service.summary(offline.root()), { available: false, reason: 'Actions are unavailable with --offline', changeCount: 0, revertable: false })
    assert.deepEqual(await offline.service.nodeActions(ROOT, 'semver@5.7.2', ALL_KINDS), { unavailable: 'Actions are unavailable with --offline' })
    await rejectsWith(() => offline.service.addChange(ROOT, { nodeId: 'semver@5.7.2', choice: 'recommended' }), 409, 'Actions are unavailable with --offline')

    const harness = await setup()
    const release = harness.root('scripts/release')
    assert.deepEqual(harness.service.summary(release), { available: false, reason: 'Actions require a pnpm or npm lockfile', changeCount: 0, revertable: false })
    assert.equal(harness.service.summary({ ...harness.root(), status: 'scanning' }).reason, 'Waiting for the scan')
    assert.equal(harness.service.summary({ ...harness.root(), status: 'failed' }).reason, 'The root failed to scan')
    assert.equal(harness.service.summary(harness.root()).reason, 'Checking pnpm…')
    harness.service.track(harness.session.scan.roots)
    await probed(harness.service)
    assert.deepEqual(harness.service.summary(harness.root()), { available: true, changeCount: 0, revertable: false })
    await probed(harness.service, 'legacy/admin')
    assert.equal(harness.service.summary(harness.root('legacy/admin')).available, true)
    assert.deepEqual(await harness.service.nodeActions('scripts/release', 'importer:.', ALL_KINDS), { unavailable: 'Actions require a pnpm or npm lockfile' })
    assert.deepEqual(await harness.service.nodeActions(ROOT, 'importer:storefront', ALL_KINDS), {})
    await rejectsWith(() => harness.service.nodeActions(ROOT, 'nope@1.0.0', ALL_KINDS), 404, 'Unknown node nope@1.0.0')
    await rejectsWith(() => harness.service.changes('nope'), 404, 'Unknown root nope')
  })

  it('refuses an apply or revert while a root that shares a workspace package applies', async () => {
    const shopLockfile = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .: {}', '', '  ../npm-package/commerce-ui: {}', '', ''].join('\n')
    const harness = await ready({
      runner: frozenInstallRunner(STUCK_RUN),
      prepareRepo: async (repo) => {
        await mkdir(path.join(repo, 'shop'))
        await writeFile(path.join(repo, 'shop', 'package.json'), '{ "name": "shop" }\n')
        await writeFile(path.join(repo, 'shop', 'pnpm-workspace.yaml'), "packages:\n  - '../npm-package/commerce-ui'\n")
        await writeFile(path.join(repo, 'shop', 'pnpm-lock.yaml'), shopLockfile)
      },
    })
    const { service } = harness
    await addChainFix(service)
    const installing = await service.startApply(ROOT, await freshPreview(service), true)
    await lineLogged(service, installing, 'started')
    assert.equal(service.job(installing.id, 0).phase, 'installing')
    const message = 'An apply or revert is running in npm-package, which shares workspace packages with this root'
    await rejectsWith(() => service.startApply('shop', 'any', false), 409, message)
    await rejectsWith(() => service.startRevert('shop'), 409, message)
    await rejectsWith(() => service.startPreview('shop'), 409, 'There are no changes to preview')
    service.cancelJob(installing.id)
    await finished(service, installing)
  })

  it('refuses an apply or revert while a root that shares a workspace package reverts', async () => {
    let revertGate: (() => void) | undefined
    const harness = await ready({
      prepareRepo: prepareSharingRoot('shop', '../npm-package/storefront'),
      session: (inner) =>
        new Proxy(inner, {
          get(target, property) {
            if (property === 'refreshRoot') {
              return async (rootId: string) => {
                if (revertGate !== undefined) await new Promise<void>((release) => (revertGate = release))
                return target.refreshRoot(rootId)
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
    })
    const { service } = harness
    await addChainFix(service)
    const applying = await service.startApply(ROOT, await freshPreview(service), false)
    assert.equal((await finished(service, applying)).state, 'done')
    revertGate = () => undefined
    const reverting = await service.startRevert(ROOT)
    for (let attempt = 0; attempt < 1000 && service.job(reverting.id, 0).phase !== 'rescanning'; attempt++) await delay(10)
    assert.equal(service.job(reverting.id, 0).phase, 'rescanning')
    const message = 'An apply or revert is running in npm-package, which shares workspace packages with this root'
    await rejectsWith(() => service.startApply('shop', 'any', false), 409, message)
    await rejectsWith(() => service.startRevert('shop'), 409, message)
    await rejectsWith(() => service.startPreview('shop'), 409, 'There are no changes to preview')
    revertGate()
    assert.equal((await finished(service, reverting)).state, 'done')
  })

  it('refuses an apply or revert of the root that shares a workspace package with a root that applies', async () => {
    const harness = await ready({ runner: frozenInstallRunner(STUCK_RUN), prepareRepo: prepareSharingRoot('shop', '../npm-package/storefront') })
    const { service } = harness
    await probed(service, 'shop')
    await service.addChange('shop', { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:../npm-package/storefront'] })
    const preview = await finished(service, service.startPreview('shop'))
    assert.equal(preview.state, 'done', preview.error)
    const installing = await service.startApply('shop', preview.result?.previewId as string, true)
    await lineLogged(service, installing, 'started')
    const message = 'An apply or revert is running in shop, which shares workspace packages with this root'
    await rejectsWith(() => service.startApply(ROOT, 'any', false), 409, message)
    await rejectsWith(() => service.startRevert(ROOT), 409, message)
    service.cancelJob(installing.id)
    await finished(service, installing)
  })

  it('names the repository root when it is the sharing root that applies', async () => {
    const harness = await ready({ runner: frozenInstallRunner(STUCK_RUN), prepareRepo: prepareSharingRoot('.', 'npm-package/storefront') })
    const { service } = harness
    await probed(service, '.')
    await service.addChange('.', { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:npm-package/storefront'] })
    const preview = await finished(service, service.startPreview('.'))
    assert.equal(preview.state, 'done', preview.error)
    const installing = await service.startApply('.', preview.result?.previewId as string, true)
    await lineLogged(service, installing, 'started')
    const message = 'An apply or revert is running in the repository root, which shares workspace packages with this root'
    await rejectsWith(() => service.startApply(ROOT, 'any', false), 409, message)
    await rejectsWith(() => service.startRevert(ROOT), 409, message)
    service.cancelJob(installing.id)
    await finished(service, installing)
  })

  it('keeps the roots whose lockfile was not updated in the revert summary after an apply whose install failed', async () => {
    const shopLockfile = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .: {}', '', '  ../npm-package/storefront: {}', '', ''].join('\n')
    const harness = await ready({
      runner: frozenInstallRunner({ DEPTRAIL_FAKE_PM_EXIT: '3', DEPTRAIL_FAKE_PM_LOCKFILES: '[]', DEPTRAIL_FAKE_PM_STDOUT: 'installing' }),
      prepareRepo: async (repo) => {
        await mkdir(path.join(repo, 'shop'))
        await writeFile(path.join(repo, 'shop', 'package.json'), '{ "name": "shop" }\n')
        await writeFile(path.join(repo, 'shop', 'pnpm-workspace.yaml'), "packages:\n  - '../npm-package/storefront'\n")
        await writeFile(path.join(repo, 'shop', 'pnpm-lock.yaml'), shopLockfile)
      },
    })
    const { service } = harness
    await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    const job = await finished(service, await service.startApply(ROOT, await freshPreview(service), true))
    assert.equal(job.state, 'failed')
    assert.deepEqual((await service.changes(ROOT)).revert?.sharedRoots, [{ id: 'shop', manager: 'pnpm' }])
  })

  it('makes actions unavailable for a root whose lockfile lists an undeclared outside package', async () => {
    const outsideImporter = ['  ../shared:', '    dependencies:', '      semver:', '        specifier: ^7.6.3', '        version: 7.6.3', '', ''].join('\n')
    const harness = await setup({
      prepareRepo: async (repo) => {
        const lockfile = path.join(repo, ROOT, 'pnpm-lock.yaml')
        await writeFile(lockfile, (await readFile(lockfile, 'utf8')).replace('importers:\n\n', `importers:\n\n${outsideImporter}`))
        await mkdir(path.join(repo, 'shared'))
        await writeFile(path.join(repo, 'shared', 'package.json'), '{ "name": "shared", "dependencies": { "semver": "^7.6.3" } }\n')
      },
    })
    const reason = 'The lockfile lists ../shared, which pnpm-workspace.yaml does not declare'
    assert.ok(harness.root().importers.some((importer) => importer.id === 'importer:../shared'))
    harness.service.track(harness.session.scan.roots)
    assert.deepEqual(await harness.service.nodeActions(ROOT, 'semver@5.7.2', ALL_KINDS), { unavailable: reason })
    assert.deepEqual(harness.service.summary(harness.root()), { available: false, reason, changeCount: 0, revertable: false })
    await rejectsWith(() => harness.service.addChange(ROOT, { nodeId: 'semver@5.7.2', choice: 'recommended' }), 409, reason)
    assert.equal((await harness.service.nodeActions('legacy/admin', 'importer:.', ALL_KINDS)).unavailable, undefined)
  })

  it('offers actions for a root whose outside package is declared', async () => {
    const outsideImporter = ['  ../shared:', '    dependencies:', '      semver:', '        specifier: ^7.6.3', '        version: 7.6.3', '', ''].join('\n')
    const harness = await setup({
      prepareRepo: async (repo) => {
        const lockfile = path.join(repo, ROOT, 'pnpm-lock.yaml')
        await writeFile(lockfile, (await readFile(lockfile, 'utf8')).replace('importers:\n\n', `importers:\n\n${outsideImporter}`))
        await mkdir(path.join(repo, 'shared'))
        await writeFile(path.join(repo, 'shared', 'package.json'), '{ "name": "shared", "dependencies": { "semver": "^7.6.3" } }\n')
        await appendFile(path.join(repo, ROOT, 'pnpm-workspace.yaml'), "  - '../shared'\n")
      },
    })
    harness.service.track(harness.session.scan.roots)
    await probed(harness.service)
    assert.equal(harness.service.summary(harness.root()).available, true)
    assert.equal((await harness.service.nodeActions(ROOT, 'semver@5.7.2', ALL_KINDS)).unavailable, undefined)
  })

  it('reports a package manager that does not answer', async () => {
    const harness = await setup({
      runner: (inner) => ({
        run: async () => ({ code: 1, stdout: '', stderr: 'corepack refused', timedOut: false, cancelled: false }),
        killRunning: () => inner.killRunning(),
      }),
    })
    harness.service.track(harness.session.scan.roots)
    await probed(harness.service)
    assert.equal(harness.service.summary(harness.root()).reason, 'pnpm --version failed: corepack refused')
    assert.deepEqual(await harness.service.nodeActions(ROOT, 'semver@5.7.2', ALL_KINDS), { unavailable: 'pnpm --version failed: corepack refused' })
  })

  it('lists fix and update options for a package with the published versions', async () => {
    const { service } = await ready()
    const parser = await service.nodeActions(ROOT, PARSER, ALL_KINDS)
    assert.deepEqual(parser.fix?.options.map((option) => option.choice), ['override'])
    assert.equal(parser.update, undefined)
    const semver = await service.nodeActions(ROOT, 'semver@7.6.3', ALL_KINDS)
    assert.equal(semver.fix, undefined)
    assert.equal(semver.update?.latest, '7.7.1')
    assert.deepEqual(
      semver.update?.importers.map((importer) => [importer.id, importer.specifier]),
      [
        ['importer:.', '^7.6.3'],
        ['importer:storefront', '^7.6.3'],
      ],
    )
  })

  it('adds the recommended chain once and refuses a duplicate goal and a conflicting override', async () => {
    const { service, root } = await ready()
    const item = await addChainFix(service)
    assert.match(item.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(item, {
      id: item.id,
      goal: { kind: 'fix', name: 'semver', version: '5.7.2', advisoryIds: ['GHSA-semver-0001'], severity: 'high' },
      choice: 'chain',
      steps: CHAIN_STEPS,
      warnings: [],
    })
    await rejectsWith(() => addChainFix(service), 409, 'Fix semver 5.7.2 is already in the changes of npm-package')
    await rejectsWith(
      () => service.addChange(ROOT, { nodeId: PARSER, choice: 'override' }),
      409,
      'Conflicts with "Fix semver 5.7.2": the override vue-eslint-parser@<10.0.0 also matches the re-lock of vue-eslint-parser 9.4.3',
      item.id,
    )
    await rejectsWith(() => service.addChange(ROOT, { nodeId: 'nope@1.0.0', choice: 'recommended' }), 404, 'Unknown node nope@1.0.0')
    await rejectsWith(() => service.addChange(ROOT, { nodeId: 'semver@5.7.2', choice: 'recommended', kinds: ['prod', 'build' as 'dev'] }), 400, 'Invalid kinds')
    await rejectsWith(() => service.addChange(ROOT, { nodeId: 'semver@5.7.2', choice: 'relock' }), 400, 'relock is not offered for semver 5.7.2')
    await rejectsWith(() => service.addChange(ROOT, { nodeId: 'eslint@9.17.0', choice: 'recommended' }), 400, 'No fix is available for eslint 9.17.0')
    await rejectsWith(
      () => service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'version', version: '9.9.9', importers: ['importer:storefront'] }),
      400,
      '9.9.9 is not a published version of semver',
    )
    const changes = await service.changes(ROOT)
    assert.deepEqual(changes.items, [item])
    assert.equal(changes.revertable, false)
    assert.equal(service.summary(root()).changeCount, 1)
    await rejectsWith(() => service.removeChange(ROOT, 'missing'), 404, 'Unknown change missing')
    service.removeChange(ROOT, item.id)
    assert.deepEqual((await service.changes(ROOT)).items, [])
  })

  it('previews a change set and marks the preview stale after an edit or a rescan', async () => {
    const harness = await ready()
    const { service, rootDir } = harness
    await rejectsWith(() => service.startPreview(ROOT), 409, 'There are no changes to preview')
    await rejectsWith(() => service.previewFileDiff(ROOT, 0), 404, 'No preview')
    const item = await addChainFix(service)
    const job = await finished(service, service.startPreview(ROOT))
    assert.equal(job.state, 'done', job.error)
    assert.equal(job.kind, 'preview')
    const first = await service.changes(ROOT)
    assert.equal(first.preview?.id, job.result?.previewId)
    assert.equal(first.preview?.stale, false)
    assert.deepEqual(first.preview?.goals, [{ itemId: item.id, met: true, detail: 'no affected version left (5.7.3, 7.6.3)' }])
    assert.deepEqual(first.preview?.files.map((file) => file.path), ['pnpm-lock.yaml'])
    assert.equal(first.job?.id, job.id)
    assert.equal(first.installByDefault, false)
    const lockfileDiff = service.previewFileDiff(ROOT, 0)
    assert.equal(lockfileDiff.truncated, false)
    assert.match(lockfileDiff.diff, /^\+ {2}semver@5\.7\.3:$/m)
    await rejectsWith(() => service.previewFileDiff(ROOT, 1), 404, 'Unknown file 1')
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixtureLockfile)

    await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    assert.equal((await service.changes(ROOT)).preview?.stale, true)

    await freshPreview(service)
    const second = await service.changes(ROOT)
    assert.equal(second.preview?.stale, false)
    assert.deepEqual(second.preview?.files.map((file) => file.path), ['storefront/package.json', 'pnpm-lock.yaml'])
    assert.match(service.previewFileDiff(ROOT, 0).diff, /^\+ {4}"semver": "\^7\.7\.1"$/m)
    await harness.session.refreshRoot(ROOT)
    assert.equal((await service.changes(ROOT)).preview?.stale, true)

    await mkdir(path.join(rootDir, 'node_modules'))
    assert.equal((await service.changes(ROOT)).installByDefault, true)
  })

  it('refuses a second job while a slow preview runs and keeps edits to the change set allowed', async () => {
    const harness = await ready({ env: SLOW_RUN })
    const { service } = harness
    await addChainFix(service)
    const job = service.startPreview(ROOT)
    assert.equal(service.isBusy(ROOT), true)
    assert.equal(service.anyBusy(), true)
    assert.deepEqual(service.summary(harness.root()).job, { id: job.id, kind: 'preview', state: 'running', phase: 'staging' })
    await rejectsWith(() => service.startPreview(ROOT), 409, 'A job is already running for npm-package')
    await rejectsWith(() => service.startCollect(ROOT, ALL_KINDS), 409, 'A job is already running for npm-package')
    const added = await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    assert.equal((await service.changes(ROOT)).job?.state, 'running')
    const done = await finished(service, job)
    assert.equal(done.state, 'done', done.error)
    assert.equal(service.isBusy(ROOT), false)
    assert.equal(service.anyBusy(), false)
    const changes = await service.changes(ROOT)
    assert.equal(changes.preview?.stale, true)
    assert.equal(changes.items.at(-1)?.id, added.id)
    await rejectsWith(() => service.startApply(ROOT, done.result?.previewId as string, false), 409, 'The preview is out of date; preview again')
  })

  it('refuses to apply when a previewed file changed on disk or the preview id is not the latest', async () => {
    const harness = await ready()
    const { service, rootDir } = harness
    await rejectsWith(() => service.startApply(ROOT, 'missing', false), 409, 'The preview is out of date; preview again')
    await addChainFix(service)
    const previewId = await freshPreview(service)
    await rejectsWith(() => service.startApply(ROOT, 'another-preview', false), 409, 'The preview is out of date; preview again')
    await appendFile(path.join(rootDir, 'storefront', 'package.json'), '\n')
    await rejectsWith(() => service.startApply(ROOT, previewId, false), 409, 'Files changed since the preview: storefront/package.json')
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixtureLockfile)
  })

  it('applies a fresh preview, rescans, and reverts until the user edits a written file', async () => {
    const harness = await ready()
    const { service, rootDir } = harness
    const item = await addChainFix(service)
    const previewId = await freshPreview(service)
    const kept = await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    await rejectsWith(() => service.startApply(ROOT, previewId, false), 409, 'The preview is out of date; preview again')
    service.removeChange(ROOT, kept.id)
    const latestId = await freshPreview(service)
    const applied = await finished(service, await service.startApply(ROOT, latestId, false))
    assert.equal(applied.state, 'done', applied.error)
    assert.equal(applied.kind, 'apply')
    assert.deepEqual(applied.result, { goalsMet: 1, install: 'not-run', files: ['pnpm-lock.yaml'] })
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixedLockfile)
    assert.equal(harness.root().packages.has('semver@5.7.3'), true)
    assert.equal(harness.root().packages.has('semver@5.7.2'), false)
    const afterApply = await service.changes(ROOT)
    assert.equal(afterApply.items.some((entry) => entry.id === item.id), false)
    assert.equal(afterApply.preview, undefined)
    assert.equal(afterApply.revertable, true)
    assert.deepEqual(afterApply.revert, { files: ['pnpm-lock.yaml'], itemCount: 1 })
    assert.equal(service.summary(harness.root()).revertable, true)

    const reverted = await finished(service, await service.startRevert(ROOT))
    assert.equal(reverted.state, 'done', reverted.error)
    assert.equal(reverted.kind, 'revert')
    assert.deepEqual(reverted.result, { restored: 1, skipped: [], appliedInstall: 'not-run' })
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixtureLockfile)
    assert.equal(harness.root().packages.has('semver@5.7.2'), true)
    const afterRevert = await service.changes(ROOT)
    assert.equal(afterRevert.revertable, false)
    assert.equal(afterRevert.revert, undefined)
    assert.deepEqual(afterRevert.items, [item])
    await rejectsWith(() => service.startRevert(ROOT), 409, 'Nothing to revert')

    const again = await finished(service, await service.startApply(ROOT, await freshPreview(service), false))
    assert.equal(again.state, 'done', again.error)
    await appendFile(path.join(rootDir, 'pnpm-lock.yaml'), '\n')
    await rejectsWith(() => service.startRevert(ROOT), 409, 'Files changed since they were applied: pnpm-lock.yaml')
    assert.equal((await service.changes(ROOT)).revertable, true)
  })

  it('reverts while actions are unavailable for another reason, but not while the root scans', async () => {
    let reshape: ((root: RootGraph) => RootGraph) | undefined
    const reshaping = (inner: ScanSession): ScanSession =>
      Object.assign(Object.create(inner) as ScanSession, {
        root(id: string) {
          const root = inner.root(id)
          return root === undefined || reshape === undefined ? root : reshape(root)
        },
      })
    const harness = await ready({ session: reshaping })
    const { service, rootDir } = harness
    await addChainFix(service)
    const applied = await finished(service, await service.startApply(ROOT, await freshPreview(service), false))
    assert.equal(applied.state, 'done', applied.error)
    reshape = (root) => ({ ...root, status: 'scanning' })
    await rejectsWith(() => service.startRevert(ROOT), 409, 'Waiting for the scan')
    reshape = (root) => ({ ...root, status: 'failed' })
    await rejectsWith(() => service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest' }), 409, 'The root failed to scan')
    const reverted = await finished(service, await service.startRevert(ROOT))
    assert.equal(reverted.state, 'done', reverted.error)
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixtureLockfile)
    assert.equal((await service.changes(ROOT)).revertable, false)
  })

  it('fails an apply whose install fails, after writing the files and rescanning', async () => {
    const harness = await ready({ runner: frozenInstallRunner({ DEPTRAIL_FAKE_PM_EXIT: '3', DEPTRAIL_FAKE_PM_LOCKFILES: '[]', DEPTRAIL_FAKE_PM_STDOUT: 'installing' }) })
    const { service, rootDir } = harness
    await addChainFix(service)
    const job = await finished(service, await service.startApply(ROOT, await freshPreview(service), true))
    assert.equal(job.state, 'failed')
    assert.equal(job.error, 'install failed: pnpm install --frozen-lockfile exited with code 3')
    assert.ok(job.log.includes('installing'))
    assert.equal(job.phase, 'rescanning')
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixedLockfile)
    assert.equal(harness.root().packages.has('semver@5.7.3'), true)
    const changes = await service.changes(ROOT)
    assert.deepEqual(changes.items, [])
    assert.equal(changes.revertable, true)
    assert.equal(changes.revert !== undefined && 'sharedRoots' in changes.revert, false)
    const reverted = await finished(service, await service.startRevert(ROOT))
    assert.equal(reverted.state, 'done', reverted.error)
    assert.deepEqual(reverted.result, { restored: 1, skipped: [], appliedInstall: 'failed' })
  })

  it('names the written files in the order of the preview and what a revert would restore', async () => {
    const { service } = await ready()
    await addChainFix(service)
    await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    const previewId = await freshPreview(service)
    const previewed = (await service.changes(ROOT)).preview
    assert.ok(previewed)
    const previewedPaths = previewed.files.map((file) => file.path)
    assert.equal(previewedPaths.length, 2)
    assert.equal((await service.changes(ROOT)).revert, undefined)
    const applied = await finished(service, await service.startApply(ROOT, previewId, false))
    assert.equal(applied.state, 'done', applied.error)
    assert.deepEqual(applied.result?.files, previewedPaths)
    assert.deepEqual((await service.changes(ROOT)).job?.result?.files, previewedPaths)
    const revert = (await service.changes(ROOT)).revert
    assert.ok(revert)
    assert.deepEqual([...revert.files].sort(), [...previewedPaths].sort())
    assert.equal(revert.itemCount, 2)
  })

  it('puts every applied change back in its order after a revert', async () => {
    const { service } = await ready()
    const chain = await addChainFix(service)
    const update = await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    const applied = await finished(service, await service.startApply(ROOT, await freshPreview(service), false))
    assert.equal(applied.state, 'done', applied.error)
    assert.deepEqual((await service.changes(ROOT)).items, [])
    const reverted = await finished(service, await service.startRevert(ROOT))
    assert.equal(reverted.state, 'done', reverted.error)
    assert.deepEqual(reverted.result, { restored: 2, skipped: [], appliedInstall: 'not-run' })
    assert.deepEqual((await service.changes(ROOT)).items, [chain, update])
  })

  it('skips an applied change that conflicts with one added since the apply and reports the install of the apply', async () => {
    const { service } = await ready()
    await addChainFix(service)
    const applied = await finished(service, await service.startApply(ROOT, await freshPreview(service), true))
    assert.equal(applied.state, 'done', applied.error)
    assert.equal(applied.result?.install, 'done')
    const override = await service.addChange(ROOT, { nodeId: PARSER, choice: 'override' })
    const reverted = await finished(service, await service.startRevert(ROOT))
    assert.equal(reverted.state, 'done', reverted.error)
    assert.deepEqual(reverted.result, {
      restored: 0,
      skipped: [
        {
          name: 'Fix semver 5.7.2',
          reason: 'Conflicts with "Fix vue-eslint-parser 9.4.3": the override vue-eslint-parser@<10.0.0 also matches the re-lock of vue-eslint-parser 9.4.3',
        },
      ],
      appliedInstall: 'done',
    })
    assert.deepEqual((await service.changes(ROOT)).items, [override])
  })

  it('replaces a change in its place and keeps it when the new one is unknown, invalid, a duplicate or a conflict', async () => {
    const { service } = await ready()
    const update = await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    const chain = await addChainFix(service)
    const replaced = await service.replaceChange(ROOT, update.id, { nodeId: 'semver@7.6.3', choice: 'latest' })
    assert.deepEqual(replaced.goal, { kind: 'update', name: 'semver', importers: ['importer:.', 'importer:storefront'], target: '7.7.1' })
    assert.deepEqual((await service.changes(ROOT)).items, [replaced, chain])
    await rejectsWith(() => service.replaceChange(ROOT, 'missing', { nodeId: 'semver@7.6.3', choice: 'latest' }), 404, 'Unknown change missing')
    await rejectsWith(() => service.replaceChange(ROOT, chain.id, { nodeId: 'semver@5.7.2', choice: 'relock' }), 400, 'relock is not offered for semver 5.7.2')
    await rejectsWith(
      () => service.replaceChange(ROOT, chain.id, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] }),
      409,
      'Update semver to 7.7.1 is already in the changes of npm-package',
    )
    await rejectsWith(
      () => service.replaceChange(ROOT, replaced.id, { nodeId: PARSER, choice: 'override' }),
      409,
      'Conflicts with "Fix semver 5.7.2": the override vue-eslint-parser@<10.0.0 also matches the re-lock of vue-eslint-parser 9.4.3',
      chain.id,
    )
    assert.deepEqual((await service.changes(ROOT)).items, [replaced, chain])
  })

  it('marks a stored preview stale after a replace, a clear and a restore, and refuses to apply it', async () => {
    const { service } = await ready()
    const chain = await addChainFix(service)
    const outOfDate = 'The preview is out of date; preview again'
    const previewId = await freshPreview(service)
    assert.equal((await service.changes(ROOT)).preview?.stale, false)
    await service.replaceChange(ROOT, chain.id, { nodeId: 'semver@5.7.2', choice: 'recommended' })
    assert.equal((await service.changes(ROOT)).preview?.stale, true)
    await rejectsWith(() => service.startApply(ROOT, previewId, false), 409, outOfDate)

    const clearedPreviewId = await freshPreview(service)
    assert.equal((await service.changes(ROOT)).preview?.stale, false)
    service.clearChanges(ROOT)
    assert.equal((await service.changes(ROOT)).preview?.stale, true)
    await rejectsWith(() => service.startApply(ROOT, clearedPreviewId, false), 409, outOfDate)

    service.restoreCleared(ROOT)
    const restoredPreviewId = await freshPreview(service)
    assert.equal((await service.changes(ROOT)).preview?.stale, false)
    service.clearChanges(ROOT)
    service.restoreCleared(ROOT)
    assert.equal((await service.changes(ROOT)).preview?.stale, true)
    await rejectsWith(() => service.startApply(ROOT, restoredPreviewId, false), 409, outOfDate)
  })

  it('restores the cleared changes once and forgets them on the next edit', async () => {
    const { service } = await ready()
    const chain = await addChainFix(service)
    const update = await service.addChange(ROOT, { nodeId: 'semver@7.6.3', choice: 'latest', importers: ['importer:storefront'] })
    service.clearChanges(ROOT)
    assert.deepEqual((await service.changes(ROOT)).items, [])
    assert.deepEqual(service.restoreCleared(ROOT), { restored: 2, skipped: [] })
    assert.deepEqual((await service.changes(ROOT)).items, [chain, update])
    assert.deepEqual(service.restoreCleared(ROOT), { restored: 0, skipped: [] })
    service.clearChanges(ROOT)
    const override = await service.addChange(ROOT, { nodeId: PARSER, choice: 'override' })
    assert.deepEqual(service.restoreCleared(ROOT), { restored: 0, skipped: [] })
    assert.deepEqual((await service.changes(ROOT)).items, [override])
    await rejectsWith(() => service.restoreCleared('nope'), 404, 'Unknown root nope')
  })

  it('cancels a preview in any phase and an apply only while it installs', async () => {
    const stuck = await ready({ env: STUCK_RUN })
    await addChainFix(stuck.service)
    const preview = stuck.service.startPreview(ROOT)
    await lineLogged(stuck.service, preview, 'started')
    assert.equal(stuck.service.job(preview.id, 0).phase, 'resolving')
    stuck.service.cancelJob(preview.id)
    const cancelled = await finished(stuck.service, preview)
    assert.equal(cancelled.state, 'cancelled')
    assert.equal((await stuck.service.changes(ROOT)).preview, undefined)
    await rejectsWith(() => stuck.service.cancelJob(preview.id), 409, 'This job cannot be canceled now')
    await rejectsWith(() => stuck.service.cancelJob('missing'), 404, 'Unknown job missing')
    await rejectsWith(() => stuck.service.job('missing', 0), 404, 'Unknown job missing')
    assert.equal(await lastRunDirectoryExists(stuck.pnpm), false)

    const harness = await ready({ runner: frozenInstallRunner(STUCK_RUN) })
    const { service, rootDir } = harness
    await addChainFix(service)
    const writing = await service.startApply(ROOT, await freshPreview(service), false)
    assert.equal(service.job(writing.id, 0).phase, 'writing')
    await rejectsWith(() => service.cancelJob(writing.id), 409, 'This job cannot be canceled now')
    assert.equal((await finished(service, writing)).state, 'done')

    await service.startRevert(ROOT).then((job) => finished(service, job))
    const installing = await service.startApply(ROOT, await freshPreview(service), true)
    await lineLogged(service, installing, 'started')
    assert.equal(service.job(installing.id, 0).phase, 'installing')
    service.cancelJob(installing.id)
    const stopped = await finished(service, installing)
    assert.equal(stopped.state, 'cancelled')
    assert.equal(await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'), fixedLockfile)
    assert.equal(harness.root().packages.has('semver@5.7.3'), true)
    assert.equal((await service.changes(ROOT)).revertable, true)
  })

  it('collects the recommended fix of every vulnerable package and lists the skipped ones with reasons', async () => {
    const { service } = await ready()
    const job = await finished(service, service.startCollect(ROOT, ALL_KINDS))
    assert.equal(job.state, 'done', job.error)
    assert.equal(job.kind, 'collect')
    assert.deepEqual(job.result, {
      added: 1,
      skipped: [
        {
          name: 'vue-eslint-parser 9.4.3',
          reason: 'Conflicts with "Fix semver 5.7.2": the override vue-eslint-parser@<10.0.0 also matches the re-lock of vue-eslint-parser 9.4.3',
        },
        { name: 'eslint 9.17.0', reason: 'Registry or advisory data for eslint is incomplete' },
      ],
    })
    const changes = await service.changes(ROOT)
    assert.deepEqual(changes.items.map((item) => [item.goal.name, item.choice]), [['semver', 'chain']])
    const prodOnly = await finished(service, service.startCollect(ROOT, new Set(['prod'])))
    assert.deepEqual(prodOnly.result, { added: 0, skipped: [{ name: 'semver 5.7.2', reason: 'Fix semver 5.7.2 is already in the changes of npm-package' }] })
    service.clearChanges(ROOT)
    assert.deepEqual((await service.changes(ROOT)).items, [])
  })

  it('closes without leaving jobs, children or sandboxes behind', async () => {
    const harness = await ready({ env: STUCK_RUN })
    const { service } = harness
    await addChainFix(service)
    const job = service.startPreview(ROOT)
    await lineLogged(service, job, 'started')
    await service.close()
    assert.equal(service.job(job.id, 0).state, 'cancelled')
    assert.equal(service.anyBusy(), false)
    assert.equal(await lastRunDirectoryExists(harness.pnpm), false)
  })
})

describe('change sets', () => {
  const ROOT_ID = 'web'

  function relock(name: string, from: string, to: string): RelockStep {
    return { kind: 'relock', name, from, to, reason: `${to} is accepted` }
  }

  function fixItem(id: string, name: string, version: string, steps: RelockStep[]): ChangeItem {
    return { id, goal: { kind: 'fix', name, version, advisoryIds: [], severity: 'high' }, choice: 'relock', steps, warnings: [] }
  }

  const lib = fixItem('lib', 'lib', '1.0.0', [relock('lib', '1.0.0', '1.0.1')])
  const tool = fixItem('tool', 'tool', '2.0.0', [relock('tool', '2.0.0', '2.0.1')])
  const kit = fixItem('kit', 'kit', '3.0.0', [relock('kit', '3.0.0', '3.0.1')])
  const parent = fixItem('parent', 'parent', '4.0.0', [relock('parent', '4.0.0', '4.0.1'), relock('lib', '1.0.0', '1.0.2')])

  function changeSetOf(...items: ChangeItem[]): ChangeSets {
    const changes = createChangeSets(() => undefined)
    for (const item of items) changes.add(ROOT_ID, item)
    return changes
  }

  function idsOf(changes: ChangeSets): string[] {
    return changes.of(ROOT_ID).items.map((item) => item.id)
  }

  it('replaces an item in its place with one revision', () => {
    const changes = changeSetOf(lib, tool, kit)
    const revision = changes.of(ROOT_ID).revision
    const newTool = fixItem('tool-2', 'tool', '2.0.0', [relock('tool', '2.0.0', '2.0.2')])
    assert.equal(changes.replace(ROOT_ID, 'tool', newTool), newTool)
    assert.deepEqual(idsOf(changes), ['lib', 'tool-2', 'kit'])
    assert.equal(changes.of(ROOT_ID).revision, revision + 1)
  })

  it('keeps the old item and the revision when a replacement is unknown, a duplicate or a conflict', async () => {
    const changes = changeSetOf(lib, tool)
    const revision = changes.of(ROOT_ID).revision
    await rejectsWith(() => changes.replace(ROOT_ID, 'missing', kit), 404, 'Unknown change missing')
    await rejectsWith(() => changes.replace(ROOT_ID, 'tool', fixItem('lib-2', 'lib', '1.0.0', [])), 409, 'Fix lib 1.0.0 is already in the changes of web')
    await rejectsWith(() => changes.replace(ROOT_ID, 'tool', parent), 409, 'Conflicts with "Fix lib 1.0.0": both re-lock lib 1.0.0', 'lib')
    assert.deepEqual(changes.of(ROOT_ID).items, [lib, tool])
    assert.equal(changes.of(ROOT_ID).revision, revision)
  })

  it('names the repository root by its label when it refuses a duplicate', async () => {
    const changes = createChangeSets(() => undefined)
    changes.add('.', lib)
    await rejectsWith(() => changes.add('.', fixItem('lib-2', 'lib', '1.0.0', [])), 409, 'Fix lib 1.0.0 is already in the changes of repository root')
  })

  it('restores items in order, skipping duplicates and conflicts with the current items', () => {
    const changes = changeSetOf(parent)
    const revision = changes.of(ROOT_ID).revision
    assert.deepEqual(changes.restore(ROOT_ID, [tool, lib, parent, kit]), {
      restored: 2,
      skipped: [
        { name: 'Fix lib 1.0.0', reason: 'Conflicts with "Fix parent 4.0.0": both re-lock lib 1.0.0' },
        { name: 'Fix parent 4.0.0', reason: 'Fix parent 4.0.0 is already in the changes of web' },
      ],
    })
    assert.deepEqual(idsOf(changes), ['parent', 'tool', 'kit'])
    assert.equal(changes.of(ROOT_ID).revision, revision + 1)
    assert.deepEqual(changes.restore(ROOT_ID, [kit]).restored, 0)
    assert.equal(changes.of(ROOT_ID).revision, revision + 1)
  })

  it('stores the applied items in the revert record', () => {
    const changes = changeSetOf(lib, tool, kit)
    const record = { itemIds: ['kit', 'lib'], sharedRoots: [] } as unknown as PreviewRecord
    const files = { originals: new Map(), hashes: new Map() }
    const scope = { rootDir: '/repo/web', repoDir: '/repo', outsideManifests: [] }
    const revert = changes.applied(ROOT_ID, record, { scope, files })
    assert.deepEqual(revert, { scope, files, items: [lib, kit], sharedRoots: [] })
    assert.equal(changes.of(ROOT_ID).revert, revert)
    assert.deepEqual(idsOf(changes), ['tool'])
  })

  it('restores the cleared items once and answers nothing restored when none are cleared', () => {
    const changes = changeSetOf(lib, tool)
    assert.deepEqual(changes.restoreCleared(ROOT_ID), { restored: 0, skipped: [] })
    changes.clear(ROOT_ID)
    const revision = changes.of(ROOT_ID).revision
    assert.deepEqual(idsOf(changes), [])
    assert.deepEqual(changes.restoreCleared(ROOT_ID), { restored: 2, skipped: [] })
    assert.deepEqual(idsOf(changes), ['lib', 'tool'])
    assert.equal(changes.of(ROOT_ID).revision, revision + 1)
    assert.deepEqual(changes.restoreCleared(ROOT_ID), { restored: 0, skipped: [] })
  })

  it('forgets the cleared items on the next add, remove, replace or clear, but not on a restore', () => {
    const edits: [string, (changes: ChangeSets) => unknown][] = [
      ['add', (changes) => changes.add(ROOT_ID, tool)],
      ['remove', (changes) => changes.remove(ROOT_ID, 'kit')],
      ['replace', (changes) => changes.replace(ROOT_ID, 'kit', tool)],
      ['clear', (changes) => changes.clear(ROOT_ID)],
    ]
    for (const [name, edit] of edits) {
      const changes = changeSetOf(lib)
      changes.clear(ROOT_ID)
      changes.restore(ROOT_ID, [kit])
      edit(changes)
      changes.restoreCleared(ROOT_ID)
      assert.equal(idsOf(changes).includes('lib'), false, name)
    }
    const restoredOnly = changeSetOf(lib)
    restoredOnly.clear(ROOT_ID)
    restoredOnly.restore(ROOT_ID, [kit])
    assert.deepEqual(restoredOnly.restoreCleared(ROOT_ID), { restored: 1, skipped: [] })
    assert.deepEqual(idsOf(restoredOnly), ['kit', 'lib'])
  })
})

describe('disabled actions', () => {
  it('is unavailable everywhere with its reason and has no jobs', async () => {
    const actions = disabledActions('Actions are not enabled')
    const root: RootGraph = { id: 'r', path: 'r', manager: 'pnpm', source: 'lockfile', status: 'ready', importers: [], packages: new Map(), warnings: [] }
    actions.track([root])
    assert.deepEqual(actions.summary(root), { available: false, reason: 'Actions are not enabled', changeCount: 0, revertable: false })
    assert.equal(actions.isBusy('r'), false)
    assert.equal(actions.anyBusy(), false)
    assert.deepEqual(await actions.nodeActions('r', 'semver@1.0.0', ALL_KINDS), { unavailable: 'Actions are not enabled' })
    assert.deepEqual(await actions.changes('r'), { items: [], revertable: false, installByDefault: false })
    await rejectsWith(() => actions.addChange('r', { nodeId: 'semver@1.0.0', choice: 'recommended' }), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.replaceChange('r', 'item', { nodeId: 'semver@1.0.0', choice: 'recommended' }), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.restoreCleared('r'), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.startPreview('r'), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.startCollect('r', ALL_KINDS), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.startApply('r', 'p', false), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.startRevert('r'), 409, 'Actions are not enabled')
    await rejectsWith(() => actions.previewFileDiff('r', 0), 404, 'No preview')
    await rejectsWith(() => actions.job('j', 0), 404, 'Unknown job j')
    await rejectsWith(() => actions.cancelJob('j'), 404, 'Unknown job j')
    await actions.close()
  })
})
