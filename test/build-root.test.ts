import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandRunner } from '../src/adapters/command-runner.ts'
import { buildRoot, parseRootLockfile } from '../src/scan/build-root.ts'
import { findRoots } from '../src/discovery/find-roots.ts'
import { createFsReader, type FileReader } from '../src/sources/file-reader.ts'
import { createGitReader } from '../src/sources/git-reader.ts'
import { memoryTree } from './helpers/git-tree.ts'
import { restoreModulesNames } from './helpers/installed-fixture.ts'
import type { RootDescriptor } from '../src/model.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(testDir, 'fixtures')

function neverCalledRunner(): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = []
  const runner: CommandRunner = async (command) => {
    calls.push(command)
    throw new Error('runner must not be called')
  }
  return { runner, calls }
}

function pnpmWritingRunner(lockfileSource: string): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = []
  const runner: CommandRunner = async (command, args, cwd) => {
    calls.push(`${command} ${args.join(' ')}`)
    if (command === 'pnpm' && args[0] === 'install') {
      await writeFile(path.join(cwd, 'pnpm-lock.yaml'), await readFile(lockfileSource, 'utf8'))
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

describe('buildRoot', () => {
  let sandbox: string
  let installedRepo: string
  let manifestRepo: string

  before(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-build-root-'))
    installedRepo = path.join(sandbox, 'installed')
    await cp(path.join(fixtures, 'installed', 'npm-layout'), installedRepo, { recursive: true })
    await restoreModulesNames(installedRepo)
    await cp(path.join(fixtures, 'pnpm', 'v5.yaml'), path.join(installedRepo, 'pnpm-lock.yaml'))
    manifestRepo = path.join(sandbox, 'manifest')
    await cp(path.join(fixtures, 'monolith', 'services', 'api'), manifestRepo, { recursive: true })
  })

  after(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  const installedRoot: RootDescriptor = { id: '.', path: '.', manager: 'pnpm', lockfile: 'pnpm-lock.yaml', importerPaths: ['.'] }
  const manifestRoot: RootDescriptor = { id: '.', path: '.', manager: 'pnpm', importerPaths: ['.'] }

  it('falls back from an unsupported lockfile to installed node_modules with a warning', async () => {
    const { runner, calls } = neverCalledRunner()
    const graph = await buildRoot(installedRoot, { reader: createFsReader(installedRepo), runner, allowResolve: false })
    assert.equal(graph.status, 'ready')
    assert.equal(graph.source, 'installed')
    assert.equal(calls.length, 0)
    assert.ok(graph.warnings.some((warning) => /not supported.*built from installed node_modules/.test(warning)))
    assert.ok(graph.packages.size > 0)
  })

  it('ends manifest-only without calling the runner when resolving is not allowed', async () => {
    const { runner, calls } = neverCalledRunner()
    const graph = await buildRoot(manifestRoot, { reader: createFsReader(manifestRepo), runner, allowResolve: false })
    assert.equal(graph.source, 'manifest-only')
    assert.equal(graph.status, 'ready')
    assert.equal(calls.length, 0)
    assert.match(graph.warnings.join('\n'), /built from package\.json manifests only/)
  })

  it('skips installed node_modules when not allowed', async () => {
    const { runner } = neverCalledRunner()
    const tree = memoryTree({
      'package.json': '{"name":"app","dependencies":{"a":"1.0.0"}}',
      'node_modules/a/package.json': '{"name":"a","version":"1.0.0"}',
    })
    const reader = createGitReader(tree.index, tree.readBlob)
    const skipped = await buildRoot(manifestRoot, { reader, runner, allowResolve: false, allowInstalled: false })
    assert.equal(skipped.source, 'manifest-only')
    assert.doesNotMatch(skipped.warnings.join('\n'), /no installed node_modules/)
    const walked = await buildRoot(manifestRoot, { reader, runner, allowResolve: false })
    assert.equal(walked.source, 'installed')
  })

  it('falls back when the lockfile is a symlink', async () => {
    const { runner } = neverCalledRunner()
    const tree = memoryTree({
      'package.json': '{"name":"app","dependencies":{"a":"1.0.0"}}',
      'pnpm-lock.yaml': { symlink: 'locks/pnpm-lock.yaml' },
      'locks/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    })
    const reader = createGitReader(tree.index, tree.readBlob)
    const [descriptor] = await findRoots(reader)
    assert.equal(descriptor?.lockfile, undefined)
    const graph = await buildRoot(descriptor!, { reader, runner, allowResolve: false, allowInstalled: false })
    assert.equal(graph.source, 'manifest-only')
    assert.equal(graph.status, 'ready')
  })

  it('resolves current versions when allowed', async () => {
    const { runner, calls } = pnpmWritingRunner(path.join(fixtures, 'pnpm', 'v9-workspace.yaml'))
    const graph = await buildRoot(manifestRoot, { reader: createFsReader(manifestRepo), runner, allowResolve: true })
    assert.equal(graph.source, 'resolved-today')
    assert.ok(calls.some((call) => call.startsWith('pnpm install')))
    assert.match(graph.warnings.join('\n'), /built from versions resolved today/)
  })

  it('falls to manifest-only with the error text when resolving fails', async () => {
    const runner: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'registry unreachable' })
    const graph = await buildRoot(manifestRoot, { reader: createFsReader(manifestRepo), runner, allowResolve: true })
    assert.equal(graph.source, 'manifest-only')
    assert.match(graph.warnings.join('\n'), /registry unreachable/)
  })

  it('uses repo-relative importer paths and package.json names for lockfile roots', async () => {
    const monolith = createFsReader(path.join(fixtures, 'monolith'))
    const root: RootDescriptor = {
      id: 'npm-package',
      path: 'npm-package',
      manager: 'pnpm',
      lockfile: 'npm-package/pnpm-lock.yaml',
      importerPaths: ['npm-package', 'npm-package/commerce-ui', 'npm-package/storefront', 'npm-package/tools/build'],
    }
    const graph = await buildRoot(root, { reader: monolith, runner: neverCalledRunner().runner, allowResolve: false })
    assert.equal(graph.source, 'lockfile')
    assert.deepStrictEqual(
      graph.importers.map((importer) => importer.path).sort(),
      ['npm-package', 'npm-package/commerce-ui', 'npm-package/storefront', 'npm-package/tools/build'],
    )
    assert.deepStrictEqual(
      graph.importers.map((importer) => importer.name).sort(),
      ['@fixture/build', '@fixture/commerce-ui', '@fixture/storefront', 'npm-package'],
    )
    assert.ok(graph.importers.every((importer) => importer.id.startsWith('importer:')))
  })

  it('keeps the warnings gathered before a throw on a failed root', async () => {
    const inner = createFsReader(manifestRepo)
    const reader: FileReader = {
      ...inner,
      async readText(target) {
        if (target === 'package.json') throw new Error('manifest exploded')
        return inner.readText(target)
      },
    }
    const graph = await buildRoot(manifestRoot, { reader, runner: neverCalledRunner().runner, allowResolve: false })
    assert.equal(graph.status, 'failed')
    assert.match(graph.warnings.join('\n'), /no lockfile; no installed node_modules/)
  })

  it('marks only the throwing root as failed', async () => {
    const monolith = createFsReader(path.join(fixtures, 'monolith'))
    const throwingReader: FileReader = {
      ...monolith,
      async readText(target) {
        if (target === 'legacy/admin/package-lock.json') throw new Error('disk exploded')
        return monolith.readText(target)
      },
    }
    const legacy: RootDescriptor = {
      id: 'legacy/admin',
      path: 'legacy/admin',
      manager: 'npm',
      lockfile: 'legacy/admin/package-lock.json',
      importerPaths: ['legacy/admin'],
    }
    const failed = await buildRoot(legacy, { reader: throwingReader, runner: neverCalledRunner().runner, allowResolve: false })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'disk exploded')
    assert.equal(failed.source, 'lockfile')
    assert.equal(failed.packages.size, 0)
    const healthy = await buildRoot(legacy, { reader: monolith, runner: neverCalledRunner().runner, allowResolve: false })
    assert.equal(healthy.status, 'ready')
  })
})

describe('parseRootLockfile', () => {
  const root = { id: 'npm-package', path: 'npm-package', manager: 'pnpm' as const }

  it('parses a pnpm lockfile text into a ready lockfile graph', async () => {
    const text = await readFile(path.join(fixtures, 'monolith/npm-package/pnpm-lock.yaml'), 'utf8')
    const result = parseRootLockfile(root, 'pnpm-lock.yaml', text)
    assert.ok('graph' in result)
    assert.equal(result.graph.source, 'lockfile')
    assert.equal(result.graph.status, 'ready')
    assert.ok(result.graph.packages.has('semver@5.7.2'))
  })

  it('returns an error for an unsupported lockfile version', () => {
    const result = parseRootLockfile(root, 'pnpm-lock.yaml', "lockfileVersion: '4.0'\n")
    assert.ok('error' in result)
  })

  it('returns an error for an unknown lockfile name', () => {
    const result = parseRootLockfile(root, 'yarn.lock', '')
    assert.ok('error' in result)
  })

  it('returns an error instead of throwing on malformed text', () => {
    const result = parseRootLockfile({ ...root, manager: 'npm' }, 'package-lock.json', '{not json')
    assert.ok('error' in result)
  })
})
