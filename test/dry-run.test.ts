import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProcessRunner, type ProcessRequest, type ProcessRunner } from '../src/adapters/command-runner.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import { DryRunError, LOCKFILE_DIFF_MAX_BYTES, STDERR_TAIL_CHARS, checkGoals, runDryRun, type DryRunInput } from '../src/actions/dry-run.ts'
import { removeActionSandboxes } from '../src/actions/sandbox.ts'
import type { ChangeItem, FixGoal, JobPhase, OverrideStep, PackageManagerName, RelockStep, SetRangeStep, UpdateGoal } from '../src/actions/types.ts'
import type { AssessedPackage } from '../src/enrich/types.ts'
import type { RootGraph } from '../src/model.ts'
import { parseRootLockfile } from '../src/scan/build-root.ts'
import { installFakePackageManager, type FakeManager } from './helpers/fake-package-manager.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'monolith', 'npm-package')
const fixtureLockfile = await readFile(path.join(fixturePath, 'pnpm-lock.yaml'), 'utf8')
const fixtureWorkspace = await readFile(path.join(fixturePath, 'pnpm-workspace.yaml'), 'utf8')
const fixtureStorefront = await readFile(path.join(fixturePath, 'storefront', 'package.json'), 'utf8')
const tempDirs: string[] = []

const CANARY = 'canary-secret-9'
const CREATED_AT = new Date('2026-10-25T12:00:00.000Z')
const SEMVER_ADVISORY = makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })

const lockfileWithSemverFixed = fixtureLockfile.replaceAll('5.7.2', '5.7.3')
const lockfileKeepingParserSemver = fixtureLockfile
  .replace('normalize-package-data@2.5.0:\n    dependencies:\n      semver: 5.7.2', 'normalize-package-data@2.5.0:\n    dependencies:\n      semver: 5.7.3')
  .replace('  semver@7.6.3:\n    resolution', '  semver@5.7.3:\n    resolution: {integrity: sha512-fixture-semver-5-7-3}\n\n  semver@7.6.3:\n    resolution')
  .replace('  semver@7.6.3: {}', '  semver@5.7.3: {}\n\n  semver@7.6.3: {}')
const lockfileWithNewPackages = fixtureLockfile
  .replace(
    'packages:\n\n',
    [
      'packages:',
      '',
      '  esbuild@0.24.0:',
      '    resolution: {integrity: sha512-fixture-esbuild}',
      '',
      '  zod@3.0.0:',
      '    resolution: {integrity: sha512-fixture-zod}',
      '',
      "  '@corp/tool@1.0.0':",
      '    resolution: {integrity: sha512-fixture-corp-tool}',
      '',
      '  old-lib@1.0.0:',
      '    resolution: {integrity: sha512-fixture-old-lib}',
      '',
      '  clean-lib@1.0.0:',
      '    resolution: {integrity: sha512-fixture-clean-lib}',
      '',
      "  'local-lib@file:vendor/local-lib':",
      '    resolution: {directory: vendor/local-lib, type: directory}',
      '',
      '',
    ].join('\n'),
  )
  .replace(
    'snapshots:\n\n',
    [
      'snapshots:',
      '',
      '  esbuild@0.24.0: {}',
      '',
      '  zod@3.0.0: {}',
      '',
      "  '@corp/tool@1.0.0': {}",
      '',
      '  old-lib@1.0.0: {}',
      '',
      '  clean-lib@1.0.0: {}',
      '',
      "  'local-lib@file:vendor/local-lib': {}",
      '',
      '',
    ].join('\n'),
  )
const lockfileWithNewFormat = fixtureLockfile.replace("lockfileVersion: '9.0'", "lockfileVersion: '9.1'")
const lockfileMovingStorefrontDown = lockfileWithSemverFixed.replace(
  '  storefront:\n    dependencies:\n      semver:\n        specifier: ^7.6.3\n        version: 7.6.3',
  '  storefront:\n    dependencies:\n      semver:\n        specifier: ^7.6.3\n        version: 5.7.3',
)

function parseGraph(text: string): RootGraph {
  const parsed = parseRootLockfile({ id: 'npm-package', path: 'npm-package', manager: 'pnpm' }, 'pnpm-lock.yaml', text)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.graph
}

const fixtureGraph = parseGraph(fixtureLockfile)

const semverView = makeEnrichmentView({
  meta: { semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.6.3', '7.7.1'] }) },
  vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
  advisories: { semver: [SEMVER_ADVISORY] },
})

const fixSemver: FixGoal = { kind: 'fix', name: 'semver', version: '5.7.2', advisoryIds: ['GHSA-test-0001'], severity: 'high' }
const updateStorefront: UpdateGoal = { kind: 'update', name: 'semver', importers: ['importer:storefront'], target: '7.7.0' }

function setRange(overrides: Partial<SetRangeStep> = {}): SetRangeStep {
  return { kind: 'set-range', importer: 'importer:storefront', dependency: 'semver', field: 'dependencies', place: 'manifest', from: '^7.6.3', to: '^7.7.0', reason: 'r', ...overrides }
}

function relock(overrides: Partial<RelockStep> = {}): RelockStep {
  return { kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'r', ...overrides }
}

function override(overrides: Partial<OverrideStep> = {}): OverrideStep {
  return { kind: 'override', selector: 'semver@<5.7.3', value: '5.7.3', file: 'pnpm-workspace.yaml', reason: 'r', ...overrides }
}

const updateItem: ChangeItem = { id: 'item-update', goal: updateStorefront, choice: 'version', steps: [setRange()], warnings: [] }
const relockItem: ChangeItem = { id: 'item-relock', goal: fixSemver, choice: 'relock', steps: [relock()], warnings: [] }

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-dry-run-test-'))
  tempDirs.push(dir)
  return dir
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

async function assertDryRunFailure(promise: Promise<unknown>, expected: string | RegExp, cancelled = false): Promise<void> {
  await assert.rejects(promise, (failure: unknown) => {
    assert.ok(failure instanceof DryRunError)
    if (typeof expected === 'string') assert.equal(failure.message, expected)
    else assert.match(failure.message, expected)
    assert.equal(failure.cancelled, cancelled)
    return true
  })
}

type Harness = {
  workDir: string
  rootDir: string
  fake: FakeManager
  phases: JobPhase[]
  lines: string[]
  assessCalls: { name: string; version: string }[][]
  lockfiles(texts: string[]): Promise<string>
  input(overrides?: Partial<DryRunInput>, assessed?: Record<string, Partial<AssessedPackage>>): DryRunInput
}

async function setup(manager: PackageManagerName = 'pnpm'): Promise<Harness> {
  const workDir = await makeTempDir()
  const rootDir = path.join(workDir, 'root')
  await cp(fixturePath, rootDir, { recursive: true })
  const fake = await installFakePackageManager(workDir, manager)
  const phases: JobPhase[] = []
  const lines: string[] = []
  const assessCalls: { name: string; version: string }[][] = []
  let lockfileCount = 0
  const harness: Harness = {
    workDir,
    rootDir,
    fake,
    phases,
    lines,
    assessCalls,
    async lockfiles(texts) {
      const paths: string[] = []
      for (const text of texts) {
        const file = path.join(workDir, `prepared-${lockfileCount++}.lock`)
        await writeFile(file, text)
        paths.push(file)
      }
      return JSON.stringify(paths)
    },
    input(overrides = {}, assessed = {}) {
      const secrets = createSecretSet()
      secrets.add(CANARY)
      return {
        previewId: 'preview-1',
        root: fixtureGraph,
        scope: { rootDir, repoDir: workDir, outsideManifests: [] },
        sharedManifests: new Map(),
        lockfile: manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json',
        manager: { name: manager, version: manager === 'pnpm' ? '10.34.3' : '11.6.2' },
        overridesFile: manager === 'pnpm' ? 'pnpm-workspace.yaml' : 'package.json#overrides',
        items: [],
        view: semverView,
        async assess(packages) {
          assessCalls.push([...packages])
          return packages.map(({ name, version }) => ({ name, version, vulnIds: [], ...assessed[`${name}@${version}`] }))
        },
        runner: createProcessRunner(),
        env: fake.env(),
        secrets,
        signal: new AbortController().signal,
        onPhase: (phase) => phases.push(phase),
        onLine: (line) => lines.push(line),
        now: () => CREATED_AT,
        ...overrides,
      }
    },
  }
  return harness
}

afterEach(async () => {
  await removeActionSandboxes()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('runDryRun', () => {
  it('previews an edited manifest and the new lockfile', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([lockfileWithSemverFixed])
    const result = await runDryRun(harness.input({ items: [updateItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    const { preview } = result
    assert.deepEqual(
      preview.files.map((file) => [file.path, file.change, file.added, file.removed, file.diff !== undefined]),
      [
        ['storefront/package.json', 'modified', 1, 1, true],
        ['pnpm-lock.yaml', 'modified', preview.files[1].added, preview.files[1].removed, false],
      ],
    )
    assert.match(preview.files[0].diff ?? '', /^- {4}"semver": "\^7\.6\.3"$/m)
    assert.match(preview.files[0].diff ?? '', /^\+ {4}"semver": "\^7\.7\.0"$/m)
    assert.equal(preview.files[1].diffTruncated, undefined)
    assert.deepEqual([...result.written.keys()], ['storefront/package.json', 'pnpm-lock.yaml'])
    assert.equal(result.written.get('pnpm-lock.yaml'), lockfileWithSemverFixed)
    assert.equal(result.originals.get('storefront/package.json'), fixtureStorefront)
    assert.equal(result.originals.get('pnpm-lock.yaml'), fixtureLockfile)
    assert.ok(result.sources.has('.npmrc'))
    assert.equal(result.lockfileDiff.truncated, false)
    assert.match(result.lockfileDiff.diff, /^\+ {2}semver@5\.7\.3:$/m)
    assert.deepEqual(preview.packageChanges, [{ name: 'semver', removed: ['5.7.2'], added: ['5.7.3'] }])
    assert.deepEqual(preview.goals, [{ itemId: 'item-update', met: false, detail: 'storefront resolves semver 7.6.3, below 7.7.0' }])
    assert.equal(preview.id, 'preview-1')
    assert.equal(preview.rootId, 'npm-package')
    assert.equal(preview.createdAt, CREATED_AT.toISOString())
    assert.equal(preview.stale, false)
    assert.deepEqual(preview.manager, { name: 'pnpm', version: '10.34.3' })
    assert.deepEqual(harness.phases, ['staging', 'resolving', 'checking'])
    const runs = await harness.fake.runs()
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0].args, ['install', '--lockfile-only', '--ignore-scripts'])
    assert.equal(runs[0].files['pnpm-lock.yaml'], fixtureLockfile)
    assert.equal(await exists(runs[0].cwd), false)
  })

  it('previews an edited outside manifest', async () => {
    const harness = await setup()
    const outsideDir = path.join(harness.workDir, 'libs', 'ui')
    const outsideManifestText = '{ "name": "ui", "dependencies": { "semver": "^5.7.2" } }\n'
    await mkdir(outsideDir, { recursive: true })
    await writeFile(path.join(outsideDir, 'package.json'), outsideManifestText)
    const lockfileWithOutside = fixtureLockfile.replace(
      '  tools/build:',
      '  ../libs/ui:\n    dependencies:\n      semver:\n        specifier: ^5.7.2\n        version: 5.7.2\n\n  tools/build:',
    )
    const lockfiles = await harness.lockfiles([lockfileWithOutside])
    const step = setRange({ importer: 'importer:../libs/ui', from: '^5.7.2', to: '^5.7.3' })
    const item: ChangeItem = { id: 'item-outside', goal: updateStorefront, choice: 'version', steps: [step], warnings: [] }
    const result = await runDryRun(
      harness.input({
        root: parseGraph(lockfileWithOutside),
        scope: { rootDir: harness.rootDir, repoDir: harness.workDir, outsideManifests: ['../libs/ui/package.json'] },
        items: [item],
        env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }),
      }),
    )
    const previewed = result.preview.files.find((file) => file.path === '../libs/ui/package.json')
    assert.deepEqual([previewed?.change, previewed?.added, previewed?.removed, previewed?.diff !== undefined], ['modified', 1, 1, true])
    assert.match(result.written.get('../libs/ui/package.json') ?? '', /"semver": "\^5\.7\.3"/)
    assert.equal(result.originals.get('../libs/ui/package.json'), outsideManifestText)
    assert.equal(await readFile(path.join(outsideDir, 'package.json'), 'utf8'), outsideManifestText)
  })

  it('marks shared manifests and warns about their roots', async () => {
    const harness = await setup()
    const outsideDir = path.join(harness.workDir, 'libs', 'ui')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(path.join(outsideDir, 'package.json'), '{ "name": "ui", "dependencies": { "semver": "^5.7.2" } }\n')
    const lockfileWithOutside = fixtureLockfile.replace(
      '  tools/build:',
      '  ../libs/ui:\n    dependencies:\n      semver:\n        specifier: ^5.7.2\n        version: 5.7.2\n\n  tools/build:',
    )
    const lockfiles = await harness.lockfiles([lockfileWithOutside])
    const step = setRange({ importer: 'importer:../libs/ui', from: '^5.7.2', to: '^5.7.3' })
    const item: ChangeItem = { id: 'item-outside', goal: updateStorefront, choice: 'version', steps: [step], warnings: [] }
    const { preview } = await runDryRun(
      harness.input({
        root: parseGraph(lockfileWithOutside),
        scope: { rootDir: harness.rootDir, repoDir: harness.workDir, outsideManifests: ['../libs/ui/package.json'] },
        sharedManifests: new Map([['../libs/ui/package.json', [{ id: 'libs', manager: 'pnpm' }]]]),
        items: [item],
        env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }),
      }),
    )
    assert.deepEqual(preview.files.find((file) => file.path === '../libs/ui/package.json')?.sharedWith, ['libs'])
    assert.ok(preview.warnings.includes('libs also uses ../libs/ui/package.json: its lockfile is not updated; run pnpm install in libs'))
    assert.equal(preview.outsidePackages, 1)
  })

  it('meets a fix goal when no affected version is left', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([lockfileWithSemverFixed])
    const { preview } = await runDryRun(harness.input({ items: [relockItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.deepEqual(preview.goals, [{ itemId: 'item-relock', met: true, detail: 'no affected version left (5.7.3, 7.6.3)' }])
  })

  it('pins a relock with a temporary override, then runs again on the restored files', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([lockfileWithSemverFixed])
    const result = await runDryRun(harness.input({ items: [relockItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    const runs = await harness.fake.runs()
    assert.equal(runs.length, 2)
    assert.match(runs[0].files['pnpm-workspace.yaml'] ?? '', /^ {2}semver@5\.7\.2: 5\.7\.3$/m)
    assert.equal(runs[1].files['pnpm-workspace.yaml'], fixtureWorkspace)
    assert.deepEqual([...result.written.keys()], ['pnpm-lock.yaml'])
    assert.equal(await exists(runs[1].cwd), false)
  })

  it('deletes a workspace file the pins created before the second run', async () => {
    const harness = await setup()
    await rm(path.join(harness.rootDir, 'pnpm-workspace.yaml'))
    const lockfiles = await harness.lockfiles([lockfileWithSemverFixed])
    const result = await runDryRun(harness.input({ items: [relockItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    const runs = await harness.fake.runs()
    assert.match(runs[0].files['pnpm-workspace.yaml'] ?? '', /semver@5\.7\.2: 5\.7\.3/)
    assert.equal(runs[1].files['pnpm-workspace.yaml'], null)
    assert.equal(result.written.has('pnpm-workspace.yaml'), false)
    assert.equal(result.originals.get('pnpm-workspace.yaml'), null)
  })

  it('lists a created workspace file for an override', async () => {
    const harness = await setup()
    await rm(path.join(harness.rootDir, 'pnpm-workspace.yaml'))
    const lockfiles = await harness.lockfiles([lockfileWithSemverFixed])
    const overrideItem: ChangeItem = { id: 'item-override', goal: fixSemver, choice: 'override', steps: [override()], warnings: [] }
    const { preview } = await runDryRun(harness.input({ items: [overrideItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.deepEqual(
      preview.files.map((file) => [file.path, file.change]),
      [['pnpm-workspace.yaml', 'created'], ['pnpm-lock.yaml', 'modified']],
    )
    assert.match(preview.files[0].diff ?? '', /^--- \/dev\/null$/m)
  })

  it('names the parent that still pulls in the targeted version', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([lockfileKeepingParserSemver])
    const { preview } = await runDryRun(harness.input({ items: [relockItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.deepEqual(preview.goals, [{ itemId: 'item-relock', met: false, detail: '5.7.2 is still required by vue-eslint-parser 9.4.3' }])
  })

  it('warns about a parent the re-lock moves to another version', async () => {
    const harness = await setup()
    assert.notEqual(lockfileMovingStorefrontDown, lockfileWithSemverFixed)
    const lockfiles = await harness.lockfiles([lockfileMovingStorefrontDown])
    const { preview } = await runDryRun(harness.input({ items: [relockItem], env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.deepEqual(preview.warnings, ['storefront moves semver 7.6.3 → 5.7.3 (downgrade)'])
  })

  it('assesses new registry packages and lists their issues by severity, then name', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([lockfileWithNewPackages])
    const assessed: Record<string, Partial<AssessedPackage>> = {
      'esbuild@0.24.0': { severity: 'moderate', vulnIds: ['GHSA-esbuild-0001'] },
      'zod@3.0.0': { severity: 'critical', vulnIds: ['GHSA-zod-0001'] },
      '@corp/tool@1.0.0': { notChecked: 'private scope' },
      'old-lib@1.0.0': { deprecated: 'use new-lib' },
    }
    const { preview } = await runDryRun(harness.input({ env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }, assessed))
    assert.deepEqual(harness.assessCalls, [
      [
        { name: '@corp/tool', version: '1.0.0' },
        { name: 'clean-lib', version: '1.0.0' },
        { name: 'esbuild', version: '0.24.0' },
        { name: 'old-lib', version: '1.0.0' },
        { name: 'zod', version: '3.0.0' },
      ],
    ])
    assert.deepEqual(preview.newIssues, [
      { name: 'zod', version: '3.0.0', severity: 'critical', vulnIds: ['GHSA-zod-0001'] },
      { name: 'esbuild', version: '0.24.0', severity: 'moderate', vulnIds: ['GHSA-esbuild-0001'] },
      { name: '@corp/tool', version: '1.0.0', vulnIds: [], notChecked: 'private scope' },
      { name: 'old-lib', version: '1.0.0', vulnIds: [], deprecated: 'use new-lib' },
    ])
  })

  it('does not call assess when no package is new', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([fixtureLockfile])
    const { preview } = await runDryRun(harness.input({ env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.deepEqual(harness.assessCalls, [])
    assert.deepEqual(preview.newIssues, [])
    assert.deepEqual(preview.files, [])
    assert.deepEqual(preview.packageChanges, [])
  })

  it('collects item warnings, a lockfile format change and package-manager warnings', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles([lockfileWithNewFormat])
    const extraWarnings = Array.from({ length: 24 }, (_, index) => `WARN  extra ${index + 1}`)
    const stdout = [' WARN  deprecated x', ' WARN  deprecated x', 'npm WARN config x', 'Progress: resolved 1', ...extraWarnings].join('\n')
    const items: ChangeItem[] = [
      { ...updateItem, warnings: ['major update'] },
      { ...relockItem, steps: [], warnings: ['major update'] },
    ]
    const { preview } = await runDryRun(harness.input({ items, env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles, DEPTRAIL_FAKE_PM_STDOUT: stdout }) }))
    assert.deepEqual(preview.warnings, [
      'major update',
      'Lockfile format version changes from 9.0 to 9.1',
      'WARN  deprecated x',
      'npm WARN config x',
      ...extraWarnings.slice(0, 18),
    ])
  })

  it('fails with the redacted output tail when the package manager exits non-zero', async () => {
    const harness = await setup()
    const stderr = `ERR_PNPM_FETCH_401 GET https://registry.example.test/semver: Unauthorized ${CANARY}`
    const env = harness.fake.env({ DEPTRAIL_FAKE_PM_EXIT: '1', DEPTRAIL_FAKE_PM_STDOUT: `WARN token ${CANARY}`, DEPTRAIL_FAKE_PM_STDERR: stderr })
    await assert.rejects(runDryRun(harness.input({ items: [updateItem], env })), (failure: unknown) => {
      assert.ok(failure instanceof DryRunError)
      assert.equal(failure.cancelled, false)
      assert.match(failure.message, /^pnpm install --lockfile-only --ignore-scripts failed: /)
      assert.match(failure.message, /Unauthorized \[redacted\]$/)
      assert.equal(failure.message.includes(CANARY), false)
      return true
    })
    assert.ok(harness.lines.length > 0)
    assert.equal(harness.lines.some((line) => line.includes(CANARY)), false)
    const runs = await harness.fake.runs()
    assert.equal(await exists(runs[0].cwd), false)
  })

  it('keeps only the last characters of a long failure output', async () => {
    const harness = await setup()
    const env = harness.fake.env({ DEPTRAIL_FAKE_PM_EXIT: '2', DEPTRAIL_FAKE_PM_LINES: '200' })
    await assert.rejects(runDryRun(harness.input({ env })), (failure: unknown) => {
      assert.ok(failure instanceof DryRunError)
      const prefix = 'pnpm install --lockfile-only --ignore-scripts failed: '
      assert.ok(failure.message.startsWith(prefix))
      assert.equal(failure.message.length, prefix.length + STDERR_TAIL_CHARS)
      assert.match(failure.message, /line 200$/)
      return true
    })
  })

  it('adds a hint when npm refuses an override of a direct dependency', async () => {
    const harness = await setup('npm')
    const env = harness.fake.env({ DEPTRAIL_FAKE_PM_EXIT: '1', DEPTRAIL_FAKE_PM_STDERR: 'npm error code EOVERRIDE\nnpm error Override for semver@^7.6.3 conflicts with direct dependency' })
    await assert.rejects(runDryRun(harness.input({ env })), (failure: unknown) => {
      assert.ok(failure instanceof DryRunError)
      assert.match(failure.message, /^npm install --package-lock-only --ignore-scripts --no-audit --no-fund failed: npm error code EOVERRIDE\n/)
      assert.ok(failure.message.endsWith('conflicts with direct dependency npm refused an override of a direct dependency; update the direct dependency instead.'))
      return true
    })
  })

  it('rejects as cancelled when aborted while the package manager runs', async () => {
    const harness = await setup()
    const controller = new AbortController()
    const env = harness.fake.env({ DEPTRAIL_FAKE_PM_SLEEP_MS: '5000', DEPTRAIL_FAKE_PM_STDOUT: 'started' })
    const onLine = (line: string) => {
      if (line === 'started') controller.abort()
    }
    await assertDryRunFailure(runDryRun(harness.input({ env, signal: controller.signal, onLine })), 'canceled', true)
    const runs = await harness.fake.runs()
    assert.equal(runs.length, 1)
    assert.equal(await exists(runs[0].cwd), false)
  })

  it('rejects as cancelled without running when the signal is already aborted', async () => {
    const harness = await setup()
    const controller = new AbortController()
    controller.abort()
    await assertDryRunFailure(runDryRun(harness.input({ signal: controller.signal })), 'canceled', true)
    assert.deepEqual(await harness.fake.runs(), [])
  })

  it('reports a package manager that did not finish in time', async () => {
    const harness = await setup()
    const requests: ProcessRequest[] = []
    const runner: ProcessRunner = {
      async run(request) {
        requests.push(request)
        if (request.args[0] === '--version') return { code: 0, stdout: '10.34.3\n', stderr: '', timedOut: false, cancelled: false }
        return { code: 124, stdout: '', stderr: '', timedOut: true, cancelled: false }
      },
      killRunning() {},
    }
    await assertDryRunFailure(runDryRun(harness.input({ runner })), 'pnpm install --lockfile-only --ignore-scripts did not finish within 5 minutes')
    assert.equal(requests[0].timeoutMs, 60_000)
    assert.equal(requests[1].timeoutMs, 300_000)
    assert.equal(await exists(requests[1].cwd), false)
  })

  it('checks the package-manager version in the temporary copy before resolving', async () => {
    const harness = await setup()
    const requests: ProcessRequest[] = []
    const inner = createProcessRunner()
    const runner: ProcessRunner = {
      run(request) {
        requests.push(request)
        return inner.run(request)
      },
      killRunning: () => inner.killRunning(),
    }
    const lockfiles = await harness.lockfiles([lockfileWithSemverFixed])
    await runDryRun(harness.input({ items: [updateItem], runner, env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.deepEqual(requests.map((request) => request.args), [['--version'], ['install', '--lockfile-only', '--ignore-scripts']])
    assert.equal(requests[0].cwd, requests[1].cwd)
    assert.equal(path.basename(requests[0].cwd), 'root')
    assert.equal(requests[0].signal, requests[1].signal)
    assert.equal(requests[0].env, requests[1].env)
  })

  it('fails when the temporary copy runs another package-manager version', async () => {
    const harness = await setup()
    const env = harness.fake.env({ DEPTRAIL_FAKE_PM_VERSION: '12.12.1' })
    await assertDryRunFailure(runDryRun(harness.input({ items: [updateItem], env })), 'the temporary copy runs pnpm 12.12.1 instead of 10.34.3')
    assert.deepEqual(await harness.fake.runs(), [])
  })

  it('reports a package manager that is not on the PATH', async () => {
    const harness = await setup()
    await assertDryRunFailure(runDryRun(harness.input({ env: { PATH: '' } })), 'pnpm was not found')
  })

  it('fails when the new lockfile cannot be parsed', async () => {
    const harness = await setup()
    const lockfiles = await harness.lockfiles(["lockfileVersion: '4.0'\n"])
    await assertDryRunFailure(
      runDryRun(harness.input({ env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) })),
      'could not parse the new lockfile: pnpm lockfile version 4.0 is not supported',
    )
  })

  it('fails with the file that could not be edited, before running the package manager', async () => {
    const harness = await setup()
    const ghostItem: ChangeItem = { ...updateItem, steps: [setRange({ importer: 'importer:ghost' })] }
    await assertDryRunFailure(runDryRun(harness.input({ items: [ghostItem] })), 'could not edit ghost/package.json: ghost/package.json is missing')
    await writeFile(path.join(harness.rootDir, 'pnpm-workspace.yaml'), 'packages: [\n')
    const overrideItem: ChangeItem = { id: 'item-override', goal: fixSemver, choice: 'override', steps: [override()], warnings: [] }
    await assertDryRunFailure(runDryRun(harness.input({ items: [overrideItem] })), /^could not edit pnpm-workspace\.yaml: /)
    await writeFile(path.join(harness.rootDir, 'storefront', 'package.json'), '{ "dependencies": ')
    await assertDryRunFailure(runDryRun(harness.input({ items: [updateItem] })), /^could not edit storefront\/package\.json: Malformed JSON/)
    assert.deepEqual(await harness.fake.runs(), [])
  })

  it('truncates the lockfile diff at the size limit and keeps the whole lockfile to write', async () => {
    const harness = await setup()
    const longComment = Array.from({ length: 3000 }, (_, index) => `# ${index} ${'x'.repeat(800)}`).join('\n')
    const largeLockfile = `${fixtureLockfile}${longComment}\n`
    const lockfiles = await harness.lockfiles([largeLockfile])
    const result = await runDryRun(harness.input({ env: harness.fake.env({ DEPTRAIL_FAKE_PM_LOCKFILES: lockfiles }) }))
    assert.equal(LOCKFILE_DIFF_MAX_BYTES, 2_097_152)
    assert.equal(result.lockfileDiff.truncated, true)
    assert.ok(Buffer.byteLength(result.lockfileDiff.diff) <= LOCKFILE_DIFF_MAX_BYTES)
    assert.ok(result.lockfileDiff.diff.startsWith('--- a/pnpm-lock.yaml\n'))
    assert.deepEqual(result.preview.files, [{ path: 'pnpm-lock.yaml', change: 'modified', added: 3000, removed: 0, diffTruncated: true }])
    assert.equal(result.written.get('pnpm-lock.yaml'), largeLockfile)
  })
})

describe('checkGoals', () => {
  const before = makeGraph({
    importers: { '.': ['semver@7.6.3 ^7.6.3'], storefront: ['semver@7.6.3 ^7.6.3', 'vue-eslint-parser@9.4.3 ^9.4.3'], web: ['semver@7.6.3 ^7.6.0'] },
    packages: { 'semver@7.6.3': [], 'semver@5.7.2': [], 'vue-eslint-parser@9.4.3': ['semver@5.7.2 ^5.7.0'] },
  })
  const fixItem: ChangeItem = { id: 'fix', goal: fixSemver, choice: 'relock', steps: [], warnings: [] }

  function updateGoalItem(importers: string[]): ChangeItem {
    return { id: 'update', goal: { kind: 'update', name: 'semver', importers, target: '7.7.0' }, choice: 'version', steps: [], warnings: [] }
  }

  it('names an importer that still depends on the targeted version', () => {
    const after = makeGraph({ importers: { '.': ['semver@5.7.2 ^5.7.0'] }, packages: { 'semver@5.7.2': [] } })
    assert.deepEqual(checkGoals([fixItem], before, after, semverView), [{ itemId: 'fix', met: false, detail: '5.7.2 is still required by the root package' }])
  })

  it('reports a new version that an advisory of the package affects', () => {
    const view = makeEnrichmentView({
      advisories: { semver: [SEMVER_ADVISORY, makeAdvisory({ id: 'GHSA-test-0002', events: [{ introduced: '5.7.3' }, { fixed: '5.7.5' }] })] },
    })
    const after = makeGraph({
      importers: { storefront: ['vue-eslint-parser@9.4.3 ^9.4.3'] },
      packages: { 'vue-eslint-parser@9.4.3': ['semver@5.7.4 ^5.7.0'], 'semver@5.7.4': [] },
    })
    assert.deepEqual(checkGoals([fixItem], before, after, view), [{ itemId: 'fix', met: false, detail: '5.7.4 is affected by GHSA-test-0002' }])
  })

  it('meets a fix goal when the package left the lockfile', () => {
    const after = makeGraph({ importers: { '.': [] }, packages: {} })
    assert.deepEqual(checkGoals([fixItem], before, after, semverView), [{ itemId: 'fix', met: true, detail: 'semver is no longer in the lockfile' }])
  })

  it('meets an update goal with the resolved versions of every selected importer', () => {
    const after = makeGraph({
      importers: { '.': ['semver@7.7.1 ^7.7.0'], storefront: ['dev:semver@7.7.1 ^7.7.0'], web: ['semver@7.8.0 ^7.8.0'] },
      packages: { 'semver@7.7.1': [], 'semver@7.8.0': [] },
    })
    assert.deepEqual(checkGoals([updateGoalItem(['importer:.', 'importer:storefront', 'importer:web'])], before, after, semverView), [
      { itemId: 'update', met: true, detail: 'semver 7.7.1, 7.8.0 in the root package, storefront, and web' },
    ])
    assert.deepEqual(checkGoals([updateGoalItem(['importer:storefront', 'importer:web'])], before, after, semverView), [
      { itemId: 'update', met: true, detail: 'semver 7.7.1, 7.8.0 in storefront and web' },
    ])
  })

  it('reports an importer below the target or without the dependency', () => {
    const after = makeGraph({
      importers: { '.': ['semver@7.6.3 ^7.6.3'], storefront: [], web: ['semver@7.7.1 ^8.0.0'] },
      packages: { 'semver@7.6.3': [], 'semver@7.7.1': [] },
    })
    assert.deepEqual(checkGoals([updateGoalItem(['importer:.'])], before, after, semverView), [
      { itemId: 'update', met: false, detail: 'the root package resolves semver 7.6.3, below 7.7.0' },
    ])
    assert.deepEqual(checkGoals([updateGoalItem(['importer:storefront'])], before, after, semverView), [
      { itemId: 'update', met: false, detail: 'storefront no longer depends on semver' },
    ])
    assert.deepEqual(checkGoals([updateGoalItem(['importer:web'])], before, after, semverView), [
      { itemId: 'update', met: false, detail: 'web resolves semver 7.7.1, outside ^8.0.0' },
    ])
  })
})
