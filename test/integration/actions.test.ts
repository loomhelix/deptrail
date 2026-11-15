import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProcessRunner } from '../../src/adapters/command-runner.ts'
import { createSecretSet } from '../../src/config/secrets.ts'
import { writePreviewFiles } from '../../src/actions/apply.ts'
import { runDryRun, type DryRunInput, type DryRunResult } from '../../src/actions/dry-run.ts'
import { runFrozenInstall } from '../../src/actions/install.ts'
import { declaredOverridesFiles, overridesLocation } from '../../src/actions/overrides-location.ts'
import { probeManager } from '../../src/actions/recipes.ts'
import { removeActionSandboxes } from '../../src/actions/sandbox.ts'
import type { ChangeItem, FixGoal, ManagerInfo, OverridesFile, PackageManagerName, Step } from '../../src/actions/types.ts'
import type { RootGraph } from '../../src/model.ts'
import { compareVersions } from '../../src/query/graph-diff.ts'
import { parseRootLockfile } from '../../src/scan/build-root.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from '../helpers/enrichment-view.ts'
import { startFakeNpmRegistry, type FakeNpmRegistry, type FakePackages } from '../helpers/fake-npm-registry.ts'
import { installedVersion, lockProject, missingManager, packageManagerEnv } from '../helpers/package-managers.ts'

const MANAGERS: readonly PackageManagerName[] = ['pnpm', 'npm']
const LOCKFILES: Record<PackageManagerName, string> = { pnpm: 'pnpm-lock.yaml', npm: 'package-lock.json' }
const ADVISORY_ID = 'GHSA-fake-0001'
const CREATED_AT = new Date('2026-10-25T12:00:00.000Z')

const PACKAGES: FakePackages = {
  'child-lib': { '1.0.0': {}, '1.0.1': {}, '2.0.0': {} },
  'parent-lib': { '1.0.0': { dependencies: { 'child-lib': '1.0.0' } }, '1.1.0': { dependencies: { 'child-lib': '^1.0.1' } } },
  helper: { '1.0.0': { dependencies: { 'child-lib': '^1.0.0' } }, '1.1.0': { dependencies: { 'child-lib': '^1.0.1' } } },
  'wide-lib': { '1.0.0': { dependencies: { 'child-lib': '*' } } },
  'other-lib': { '1.0.0': { dependencies: { 'child-lib': '^2.0.0' } } },
}

const VIEW = makeEnrichmentView({
  meta: { 'child-lib': makeMeta({ versions: ['1.0.0', '1.0.1', '2.0.0'], latest: '2.0.0' }) },
  vulns: { 'child-lib@1.0.0': [ADVISORY_ID] },
  advisories: { 'child-lib': [makeAdvisory({ id: ADVISORY_ID, severity: 'high', events: [{ introduced: '0' }, { fixed: '1.0.1' }] })] },
})

const BROAD_RANGE_OUTCOMES: Record<PackageManagerName, { title: string; removed: string[]; remaining: string[] }> = {
  pnpm: { title: 'pnpm moves a broad range locked to a version outside the selector range', removed: ['1.0.0', '2.0.0'], remaining: ['1.0.1'] },
  npm: { title: 'npm keeps a locked version outside the selector range on a broad range', removed: ['1.0.0'], remaining: ['1.0.1', '2.0.0'] },
}

const EDGE_MOVE_OUTCOMES: Record<PackageManagerName, { title: string; wideChild: string; warnings: string[] }> = {
  pnpm: {
    title: 'pnpm re-lock moves another parent of the package down and the preview warns',
    wideChild: '1.0.1',
    warnings: ['wide-lib 1.0.0 moves child-lib 2.0.0 → 1.0.1 (downgrade)'],
  },
  npm: { title: 'npm re-lock leaves the other parents of the package where they were', wideChild: '2.0.0', warnings: [] },
}

const FIX_CHILD: FixGoal ={ kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: [ADVISORY_ID], severity: 'high' }

const tempDirs: string[] = []
const registries: FakeNpmRegistry[] = []

type Project = {
  manager: PackageManagerName
  workDir: string
  dir: string
  lockfile: string
  registry: FakeNpmRegistry
  env: Record<string, string | undefined>
  lines: string[]
}

async function createProject(manager: PackageManagerName, hidden: readonly string[] = []): Promise<Project> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'deptrail-integration-'))
  tempDirs.push(workDir)
  const registry = await startFakeNpmRegistry(PACKAGES, { hidden })
  registries.push(registry)
  const dir = path.join(workDir, 'project')
  await mkdir(dir)
  return { manager, workDir, dir, lockfile: LOCKFILES[manager], registry, env: packageManagerEnv(workDir, registry.url), lines: [] }
}

function pinnedManager(manager: PackageManagerName): Record<string, string> {
  return manager === 'pnpm' ? { packageManager: `pnpm@${installedVersion(manager)}` } : {}
}

async function lockWith(project: Project, dependencies: Record<string, string>): Promise<void> {
  const manifest = { name: 'app', version: '1.0.0', private: true, ...pinnedManager(project.manager), dependencies }
  await writeFile(path.join(project.dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await lockProject(project.dir, project.manager, project.env)
  assert.ok(project.registry.requests.length > 0, 'the package manager did not use the fake registry')
}

function parseGraph(manager: PackageManagerName, text: string | undefined): RootGraph {
  assert.ok(text !== undefined, 'the lockfile was not written')
  const parsed = parseRootLockfile({ id: 'app', path: '.', manager }, LOCKFILES[manager], text)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.graph
}

async function readProject(project: Project, relative: string): Promise<string | null> {
  return readFile(path.join(project.dir, relative), 'utf8').catch(() => null)
}

async function lockedGraph(project: Project): Promise<RootGraph> {
  return parseGraph(project.manager, (await readProject(project, project.lockfile)) ?? undefined)
}

function versionsOf(graph: RootGraph, name: string): string[] {
  return [...new Set([...graph.packages.values()].filter((node) => node.name === name).map((node) => node.version))].sort(compareVersions)
}

function childVersionsOf(graph: RootGraph, parentName: string): string[] {
  const parents = [...graph.packages.values()].filter((node) => node.name === parentName)
  const children = parents.flatMap((parent) => parent.deps.map((edge) => graph.packages.get(edge.to)).filter((child) => child?.name === 'child-lib'))
  return [...new Set(children.map((child) => child?.version as string))].sort(compareVersions)
}

async function managerInfo(project: Project): Promise<ManagerInfo> {
  const probe = await probeManager(createProcessRunner(), project.manager, project.dir, project.env, createSecretSet())
  if (!probe.ok) throw new Error(probe.reason)
  return { name: project.manager, version: probe.version }
}

async function overridesFileOf(project: Project, manager: ManagerInfo): Promise<OverridesFile> {
  const declared = declaredOverridesFiles({ workspaceYaml: await readProject(project, 'pnpm-workspace.yaml'), rootManifest: await readProject(project, 'package.json') })
  return overridesLocation(manager, declared).file
}

function fixItem(choice: ChangeItem['choice'], steps: Step[]): ChangeItem {
  return { id: `item-${choice}`, goal: FIX_CHILD, choice, steps, warnings: [] }
}

type OutsideSetup = Pick<DryRunInput, 'scope' | 'sharedManifests'> & { rootId: string; rootPath: string }

async function dryRun(
  project: Project,
  items: (file: OverridesFile) => ChangeItem[],
  outside?: OutsideSetup,
): Promise<DryRunResult & { before: RootGraph; after: RootGraph }> {
  const before = outside ? parseOutsideGraph(outside, await readProject(project, project.lockfile)) : await lockedGraph(project)
  const manager = await managerInfo(project)
  const overridesFile = await overridesFileOf(project, manager)
  const result = await runDryRun({
    previewId: 'preview-1',
    root: before,
    scope: outside?.scope ?? { rootDir: project.dir, repoDir: project.workDir, outsideManifests: [] },
    sharedManifests: outside?.sharedManifests ?? new Map(),
    lockfile: project.lockfile,
    manager,
    overridesFile,
    items: items(overridesFile),
    view: VIEW,
    async assess(packages) {
      return packages.map(({ name, version }) => ({ name, version, vulnIds: [] }))
    },
    runner: createProcessRunner(),
    env: project.env,
    secrets: createSecretSet(),
    signal: new AbortController().signal,
    onPhase: () => {},
    onLine: (line) => project.lines.push(line),
    now: () => CREATED_AT,
  })
  const after = outside ? parseOutsideGraph(outside, result.written.get(project.lockfile)) : parseGraph(project.manager, result.written.get(project.lockfile))
  return { ...result, before, after }
}

function parseOutsideGraph(outside: OutsideSetup, text: string | null | undefined): RootGraph {
  assert.ok(text !== undefined && text !== null, 'the lockfile was not written')
  const parsed = parseRootLockfile({ id: outside.rootId, path: outside.rootPath, manager: 'pnpm' }, LOCKFILES.pnpm, text)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.graph
}

const SET_PARENT_RANGE: Step = {
  kind: 'set-range',
  importer: 'importer:.',
  dependency: 'parent-lib',
  field: 'dependencies',
  place: 'manifest',
  from: '1.0.0',
  to: '1.1.0',
  reason: 'parent-lib 1.1.0 requests child-lib ^1.0.1',
}

function overrideChild(file: OverridesFile): Step {
  return { kind: 'override', selector: 'child-lib@<1.0.1', value: '1.0.1', file, reason: 'child-lib 1.0.1 fixes the advisory' }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

afterEach(async () => {
  await removeActionSandboxes()
  await Promise.all(registries.splice(0).map((registry) => registry.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

for (const managerName of MANAGERS) {
  describe(`action recipes with real ${managerName}`, () => {
    const skip = missingManager(managerName)

    it('set-range moves the parent and its child to the fixed versions', { skip }, async () => {
      const project = await createProject(managerName)
      await lockWith(project, { 'parent-lib': '1.0.0' })
      const result = await dryRun(project, () => [fixItem('chain', [SET_PARENT_RANGE])])
      assert.deepEqual(result.preview.goals, [{ itemId: 'item-chain', met: true, detail: 'no affected version left (1.0.1)' }])
      assert.deepEqual(versionsOf(result.after, 'parent-lib'), ['1.1.0'])
      assert.deepEqual(versionsOf(result.after, 'child-lib'), ['1.0.1'])
      assert.deepEqual([...result.written.keys()], ['package.json', project.lockfile])
      assert.deepEqual(result.preview.packageChanges, [
        { name: 'child-lib', removed: ['1.0.0'], added: ['1.0.1'] },
        { name: 'parent-lib', removed: ['1.0.0'], added: ['1.1.0'] },
      ])
    })

    it('relock moves a transitive dependency and leaves only the lockfile changed', { skip }, async () => {
      const project = await createProject(managerName, ['child-lib@1.0.1', 'helper@1.1.0'])
      await lockWith(project, { helper: '^1.0.0' })
      assert.deepEqual(versionsOf(await lockedGraph(project), 'child-lib'), ['1.0.0'])
      project.registry.reveal()
      const result = await dryRun(project, () => [fixItem('relock', [{ kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'helper accepts 1.0.1' }])])
      assert.deepEqual(result.preview.goals, [{ itemId: 'item-relock', met: true, detail: 'no affected version left (1.0.1)' }])
      assert.deepEqual([...result.written.keys()], [project.lockfile])
      const lockfileText = result.written.get(project.lockfile) ?? ''
      assert.doesNotMatch(lockfileText, /child-lib@1\.0\.0/)
      assert.doesNotMatch(lockfileText, /overrides/)
      assert.deepEqual(versionsOf(result.after, 'helper'), ['1.0.0'])
      assert.deepEqual(result.preview.packageChanges, [{ name: 'child-lib', removed: ['1.0.0'], added: ['1.0.1'] }])
    })

    it('relock of a root direct dependency reaches the wanted version', { skip }, async () => {
      const project = await createProject(managerName, ['helper@1.1.0'])
      await lockWith(project, { helper: '^1.0.0' })
      assert.deepEqual(versionsOf(await lockedGraph(project), 'helper'), ['1.0.0'])
      project.registry.reveal()
      const wanted: ChangeItem = {
        id: 'item-wanted',
        goal: { kind: 'update', name: 'helper', importers: ['importer:.'], target: '1.1.0' },
        choice: 'wanted',
        steps: [{ kind: 'relock', name: 'helper', from: '1.0.0', to: '1.1.0', reason: 'every requesting range accepts 1.1.0' }],
        warnings: [],
      }
      const result = await dryRun(project, () => [wanted])
      assert.deepEqual(result.preview.goals, [{ itemId: 'item-wanted', met: true, detail: 'helper 1.1.0 in the root package' }])
      assert.deepEqual([...result.written.keys()], [project.lockfile])
      assert.deepEqual(versionsOf(result.after, 'helper'), ['1.1.0'])
      assert.doesNotMatch(result.written.get(project.lockfile) ?? '', /overrides/)
    })

    it('override replaces the affected child version', { skip }, async () => {
      const project = await createProject(managerName)
      await lockWith(project, { 'parent-lib': '1.0.0' })
      const result = await dryRun(project, (file) => [fixItem('override', [overrideChild(file)])])
      assert.deepEqual(result.preview.goals, [{ itemId: 'item-override', met: true, detail: 'no affected version left (1.0.1)' }])
      assert.deepEqual(versionsOf(result.after, 'child-lib'), ['1.0.1'])
      if (managerName === 'pnpm') {
        assert.deepEqual(
          result.preview.files.map((file) => [file.path, file.change]),
          [
            ['pnpm-workspace.yaml', 'created'],
            ['pnpm-lock.yaml', 'modified'],
          ],
        )
      } else {
        assert.deepEqual(
          result.preview.files.map((file) => [file.path, file.change]),
          [
            ['package.json', 'modified'],
            ['package-lock.json', 'modified'],
          ],
        )
        assert.deepEqual(JSON.parse(result.written.get('package.json') ?? '{}').overrides, { 'child-lib@<1.0.1': '1.0.1' })
      }
    })

    const broadRange = BROAD_RANGE_OUTCOMES[managerName]
    it(broadRange.title, { skip }, async () => {
      const project = await createProject(managerName)
      await lockWith(project, { 'wide-lib': '1.0.0' })
      await lockWith(project, { 'parent-lib': '1.0.0', 'wide-lib': '1.0.0' })
      assert.deepEqual(versionsOf(await lockedGraph(project), 'child-lib'), ['1.0.0', '2.0.0'])
      const result = await dryRun(project, (file) => [fixItem('override', [overrideChild(file)])])
      assert.deepEqual(
        result.preview.packageChanges.find((change) => change.name === 'child-lib'),
        { name: 'child-lib', removed: broadRange.removed, added: ['1.0.1'] },
      )
      assert.deepEqual(versionsOf(result.after, 'child-lib'), broadRange.remaining)
      assert.deepEqual(result.preview.goals, [{ itemId: 'item-override', met: true, detail: `no affected version left (${broadRange.remaining.join(', ')})` }])
    })

    const edgeMove = EDGE_MOVE_OUTCOMES[managerName]
    it(edgeMove.title, { skip }, async () => {
      const project = await createProject(managerName, ['child-lib@1.0.1'])
      await lockWith(project, { 'wide-lib': '1.0.0', 'other-lib': '1.0.0' })
      await lockWith(project, { helper: '1.0.0', 'wide-lib': '1.0.0', 'other-lib': '1.0.0' })
      const before = await lockedGraph(project)
      assert.deepEqual(childVersionsOf(before, 'helper'), ['1.0.0'])
      assert.deepEqual(childVersionsOf(before, 'wide-lib'), ['2.0.0'])
      assert.deepEqual(childVersionsOf(before, 'other-lib'), ['2.0.0'])
      project.registry.reveal()
      const result = await dryRun(project, () => [fixItem('relock', [{ kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'helper accepts 1.0.1' }])])
      assert.deepEqual(result.preview.packageChanges, [{ name: 'child-lib', removed: ['1.0.0'], added: ['1.0.1'] }])
      assert.deepEqual(result.preview.goals, [{ itemId: 'item-relock', met: true, detail: 'no affected version left (1.0.1, 2.0.0)' }])
      assert.deepEqual(childVersionsOf(result.after, 'helper'), ['1.0.1'])
      assert.deepEqual(childVersionsOf(result.after, 'wide-lib'), [edgeMove.wideChild])
      assert.deepEqual(childVersionsOf(result.after, 'other-lib'), ['2.0.0'])
      assert.deepEqual(result.preview.warnings.filter((warning) => warning.includes(' moves ')), edgeMove.warnings)
    })

    it('writes the previewed files and installs them with a frozen lockfile', { skip }, async () => {
      const project = await createProject(managerName)
      await lockWith(project, { 'parent-lib': '1.0.0' })
      const result = await dryRun(project, () => [fixItem('chain', [SET_PARENT_RANGE])])
      await writePreviewFiles({ rootDir: project.dir, repoDir: project.workDir, outsideManifests: [] }, result.written, project.lockfile, result.originals)
      assert.equal(await readProject(project, project.lockfile), result.written.get(project.lockfile))
      const outcome = await runFrozenInstall({
        manager: managerName,
        rootDir: project.dir,
        runner: createProcessRunner(),
        env: project.env,
        secrets: createSecretSet(),
        signal: new AbortController().signal,
        onLine: (line) => project.lines.push(line),
      })
      assert.deepEqual(outcome, { ok: true }, project.lines.join('\n'))
      if (managerName === 'pnpm') {
        assert.equal(await exists(path.join(project.dir, 'node_modules', '.pnpm', 'child-lib@1.0.1')), true)
      } else {
        const installed = JSON.parse((await readProject(project, 'node_modules/child-lib/package.json')) ?? '{}') as { version?: string }
        assert.equal(installed.version, '1.0.1')
      }
    })
  })
}

describe('action sandbox with real pnpm', () => {
  const skip = missingManager('pnpm')

  it('previews a root that takes its pnpm version from a parent directory', { skip }, async () => {
    const project = await createProject('pnpm')
    const version = installedVersion('pnpm')
    await writeFile(path.join(project.workDir, 'package.json'), `${JSON.stringify({ private: true, packageManager: `pnpm@${version}` })}\n`)
    const manifest = { name: 'app', version: '1.0.0', private: true, dependencies: { 'parent-lib': '1.0.0' } }
    await writeFile(path.join(project.dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await lockProject(project.dir, 'pnpm', project.env)
    const result = await dryRun(project, (file) => [fixItem('override', [overrideChild(file)])])
    assert.deepEqual(result.preview.manager, { name: 'pnpm', version })
    assert.deepEqual(versionsOf(result.after, 'child-lib'), ['1.0.1'])
  })
})

const OUTSIDE_MANIFEST = '../../libs/ui/package.json'
const OUTSIDE_IMPORTER = 'importer:../../libs/ui'
const SHARED_WARNING = 'libs also uses ../../libs/ui/package.json: its lockfile is not updated; run pnpm install in libs'

const OUTSIDE_WRITTEN_PATHS = [OUTSIDE_MANIFEST, 'pnpm-lock.yaml']

const SET_OUTSIDE_PARENT_RANGE: Step = { ...SET_PARENT_RANGE, importer: OUTSIDE_IMPORTER }

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function createOutsideProject(hidden: readonly string[] = []): Promise<{ project: Project; outside: OutsideSetup; libsDir: string }> {
  const project = await createProject('pnpm', hidden)
  const repoDir = path.join(project.workDir, 'repo')
  const shopDir = path.join(repoDir, 'apps', 'shop')
  const libsDir = path.join(repoDir, 'libs')
  const packageManager = `pnpm@${installedVersion('pnpm')}`
  await writeJson(path.join(shopDir, 'package.json'), { name: 'shop', version: '1.0.0', private: true, packageManager, dependencies: { helper: '1.0.0' } })
  await writeFile(path.join(shopDir, 'pnpm-workspace.yaml'), "packages:\n  - '../../libs/ui'\n")
  await writeJson(path.join(libsDir, 'package.json'), { name: 'libs', version: '1.0.0', private: true, packageManager })
  await writeFile(path.join(libsDir, 'pnpm-workspace.yaml'), 'packages:\n  - ui\n')
  await writeJson(path.join(libsDir, 'ui', 'package.json'), { name: 'ui', version: '1.0.0', dependencies: { 'parent-lib': '1.0.0' } })
  await lockProject(shopDir, 'pnpm', project.env)
  await lockProject(libsDir, 'pnpm', project.env)
  const outsideProject: Project = { ...project, dir: shopDir }
  const outside: OutsideSetup = {
    rootId: 'apps/shop',
    rootPath: 'apps/shop',
    scope: { rootDir: shopDir, repoDir, outsideManifests: [OUTSIDE_MANIFEST] },
    sharedManifests: new Map([[OUTSIDE_MANIFEST, [{ id: 'libs', manager: 'pnpm' }]]]),
  }
  return { project: outsideProject, outside, libsDir }
}

describe('outside workspace packages with real pnpm', () => {
  const skip = missingManager('pnpm')

  it('set-range on the outside manifest moves the parent and its child', { skip }, async () => {
    const { project, outside } = await createOutsideProject()
    const manifestBefore = await readFile(path.join(project.dir, 'package.json'), 'utf8')
    const result = await dryRun(project, () => [fixItem('chain', [SET_OUTSIDE_PARENT_RANGE])], outside)
    assert.deepEqual([...result.written.keys()].sort(), OUTSIDE_WRITTEN_PATHS)
    assert.equal(await readFile(path.join(project.dir, 'package.json'), 'utf8'), manifestBefore)
    assert.ok(versionsOf(result.before, 'child-lib').includes('1.0.0'))
    assert.deepEqual(versionsOf(result.after, 'child-lib'), ['1.0.1'])
    assert.deepEqual(result.preview.files.find((file) => file.path === OUTSIDE_MANIFEST)?.sharedWith, ['libs'])
    assert.ok(result.preview.warnings.includes(SHARED_WARNING), result.preview.warnings.join('\n'))
  })

  it('override in the root workspace reaches the outside package', { skip }, async () => {
    const { project, outside } = await createOutsideProject()
    const result = await dryRun(project, (file) => [fixItem('override', [overrideChild(file)])], outside)
    assert.deepEqual(versionsOf(result.after, 'child-lib'), ['1.0.1'])
    assert.deepEqual(
      result.preview.files.map((file) => file.path),
      ['pnpm-workspace.yaml', 'pnpm-lock.yaml'],
    )
  })

  it('relock in the root lockfile leaves the outside manifest alone', { skip }, async () => {
    const { project, outside } = await createOutsideProject(['child-lib@1.0.1'])
    project.registry.reveal()
    const relock: Step = { kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'helper accepts 1.0.1' }
    const result = await dryRun(project, () => [fixItem('relock', [relock])], outside)
    assert.deepEqual(
      result.preview.files.map((file) => file.path),
      ['pnpm-lock.yaml'],
    )
    assert.equal(result.written.has(OUTSIDE_MANIFEST), false)
    assert.deepEqual(childVersionsOf(result.after, 'helper'), ['1.0.1'])
    assert.deepEqual(childVersionsOf(result.after, 'parent-lib'), ['1.0.0'])
  })

  it('writes the outside manifest, installs the root with a frozen lockfile and leaves the other lockfile alone', { skip }, async () => {
    const { project, outside, libsDir } = await createOutsideProject()
    const otherLockfileBefore = await readFile(path.join(libsDir, 'pnpm-lock.yaml'), 'utf8')
    const shopManifestBefore = await readFile(path.join(project.dir, 'package.json'), 'utf8')
    const result = await dryRun(project, () => [fixItem('chain', [SET_OUTSIDE_PARENT_RANGE])], outside)
    assert.deepEqual([...result.written.keys()].sort(), OUTSIDE_WRITTEN_PATHS)
    await writePreviewFiles(outside.scope, result.written, project.lockfile, result.originals)
    assert.equal(await readFile(path.join(project.dir, 'package.json'), 'utf8'), shopManifestBefore)
    assert.match(await readFile(path.join(libsDir, 'ui', 'package.json'), 'utf8'), /"parent-lib": "1\.1\.0"/)
    const outcome = await runFrozenInstall({
      manager: 'pnpm',
      rootDir: project.dir,
      runner: createProcessRunner(),
      env: project.env,
      secrets: createSecretSet(),
      signal: new AbortController().signal,
      onLine: (line) => project.lines.push(line),
    })
    assert.deepEqual(outcome, { ok: true }, project.lines.join('\n'))
    assert.equal(await readFile(path.join(libsDir, 'pnpm-lock.yaml'), 'utf8'), otherLockfileBefore)
  })
})
