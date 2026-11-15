import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OutsideScopeError, fileScopeOf, hashSources, outsideImporters, readInScope, resolveInScope, type FileScope } from '../src/actions/file-scope.ts'
import type { Manager, RootGraph } from '../src/model.ts'

const tempDirs: string[] = []
const DECLARED_MANIFEST = '../../libs/ui/package.json'

async function writeRelative(base: string, relative: string, text: string) {
  const target = path.join(base, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

async function makeLayout(): Promise<{ tmp: string; repo: string; scope: FileScope }> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'deptrail-file-scope-test-'))
  tempDirs.push(tmp)
  const repo = path.join(tmp, 'repo')
  await writeRelative(repo, 'apps/shop/package.json', '{"name":"shop"}\n')
  await writeRelative(repo, 'apps/shop/pnpm-lock.yaml', 'lockfileVersion: 9\n')
  await writeRelative(repo, 'libs/ui/package.json', '{"name":"ui"}\n')
  await writeRelative(repo, 'libs/other/package.json', '{"name":"other"}\n')
  await writeRelative(tmp, 'elsewhere/package.json', '{"name":"elsewhere"}\n')
  return { tmp, repo, scope: { rootDir: path.join(repo, 'apps/shop'), repoDir: repo, outsideManifests: [DECLARED_MANIFEST] } }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function graphWith(manager: Manager, patterns: string[] | undefined, importers: [string, string][]): Pick<RootGraph, 'manager' | 'importers' | 'config'> {
  return {
    manager,
    importers: importers.map(([rootRelative, repoRelative]) => ({ id: `importer:${rootRelative}`, path: repoRelative, name: rootRelative, deps: [], dependents: [] })),
    config: patterns === undefined ? undefined : { registry: '', scopedRegistries: {}, hasAuth: false, catalogs: {}, overrides: {}, workspacePatterns: patterns, warnings: [] },
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function isUnresolvedManifest(failure: unknown): boolean {
  assert.ok(failure instanceof OutsideScopeError)
  assert.equal(failure.message, `${DECLARED_MANIFEST} is missing or resolves outside its workspace package`)
  return true
}

describe('file scope', () => {
  it('resolves files inside the root, including a missing file in an existing directory', async () => {
    const { scope } = await makeLayout()
    const realRoot = await realpath(scope.rootDir)
    assert.equal(await resolveInScope(scope, 'package.json'), path.join(realRoot, 'package.json'))
    assert.equal(await resolveInScope(scope, 'new.json'), path.join(realRoot, 'new.json'))
  })

  it('resolves a declared outside manifest to its real path', async () => {
    const { repo, scope } = await makeLayout()
    const expected = path.join(await realpath(repo), 'libs/ui/package.json')
    assert.equal(await resolveInScope(scope, DECLARED_MANIFEST), expected)
    assert.equal(await resolveInScope(scope, '../../libs/./ui/package.json'), expected)
  })

  it('refuses an outside path that is not declared', async () => {
    const { scope } = await makeLayout()
    await assert.rejects(resolveInScope(scope, '../../libs/other/package.json'), (failure: unknown) => {
      assert.ok(failure instanceof OutsideScopeError)
      assert.equal(failure.message, '../../libs/other/package.json is outside the root directory and its declared workspace packages')
      return true
    })
  })

  it('refuses an absolute path', async () => {
    const { scope } = await makeLayout()
    await assert.rejects(resolveInScope(scope, '/etc/passwd'), OutsideScopeError)
  })

  it('refuses a missing declared outside manifest', async () => {
    const { repo, scope } = await makeLayout()
    await rm(path.join(repo, 'libs/ui/package.json'))
    await assert.rejects(resolveInScope(scope, DECLARED_MANIFEST), isUnresolvedManifest)
  })

  it('refuses a declared package directory that is a symlink out of the repository', async () => {
    const { tmp, repo, scope } = await makeLayout()
    await rm(path.join(repo, 'libs/ui'), { recursive: true })
    await symlink(path.join(tmp, 'elsewhere'), path.join(repo, 'libs/ui'))
    await assert.rejects(resolveInScope(scope, DECLARED_MANIFEST), isUnresolvedManifest)
  })

  it('refuses a declared package.json that is a symlink into another directory of the repository', async () => {
    const { repo, scope } = await makeLayout()
    await rm(path.join(repo, 'libs/ui/package.json'))
    await symlink(path.join(repo, 'libs/other/package.json'), path.join(repo, 'libs/ui/package.json'))
    await assert.rejects(resolveInScope(scope, DECLARED_MANIFEST), isUnresolvedManifest)
  })

  it('refuses a declared package.json that is a symlink to its own directory', async () => {
    const { repo, scope } = await makeLayout()
    await rm(path.join(repo, 'libs/ui/package.json'))
    await symlink('.', path.join(repo, 'libs/ui/package.json'))
    await assert.rejects(resolveInScope(scope, DECLARED_MANIFEST), isUnresolvedManifest)
  })

  it('refuses a declared package directory that is a regular file', async () => {
    const { repo, scope } = await makeLayout()
    await rm(path.join(repo, 'libs/ui'), { recursive: true })
    await writeRelative(repo, 'libs/ui', 'not a directory\n')
    await assert.rejects(resolveInScope(scope, DECLARED_MANIFEST), isUnresolvedManifest)
  })

  it('refuses a declared package.json that is a symlink to itself', async () => {
    const { repo, scope } = await makeLayout()
    await rm(path.join(repo, 'libs/ui/package.json'))
    await symlink('package.json', path.join(repo, 'libs/ui/package.json'))
    await assert.rejects(resolveInScope(scope, DECLARED_MANIFEST), isUnresolvedManifest)
  })

  it('refuses a symlink inside the root that points out of it', async () => {
    const { tmp, scope } = await makeLayout()
    await symlink(path.join(tmp, 'elsewhere/package.json'), path.join(scope.rootDir, 'escape.json'))
    await assert.rejects(resolveInScope(scope, 'escape.json'), OutsideScopeError)
  })

  it('refuses a missing file whose parent directory is a symlink out of the root', async () => {
    const { tmp, scope } = await makeLayout()
    await symlink(path.join(tmp, 'elsewhere'), path.join(scope.rootDir, 'linked'))
    await assert.rejects(resolveInScope(scope, 'linked/new.json'), OutsideScopeError)
  })

  it('refuses a path that leaves the root and returns to it unless it is declared', async () => {
    const { scope } = await makeLayout()
    await assert.rejects(resolveInScope(scope, '../shop/package.json'), OutsideScopeError)
  })

  it('builds the scope of a root from its importers', () => {
    const root = {
      ...graphWith('pnpm', ['../../libs/ui'], [['.', 'apps/shop'], ['../../libs/ui', 'libs/ui'], ['../../libs/other', 'libs/other']]),
      path: 'apps/shop',
    } as RootGraph
    assert.deepEqual(fileScopeOf('/work/repo', root), {
      rootDir: path.join('/work/repo', 'apps/shop'),
      repoDir: '/work/repo',
      outsideManifests: ['../../libs/ui/package.json'],
    })
  })

  it('reads null for refused and missing files and hashes through the scope', async () => {
    const { scope } = await makeLayout()
    assert.equal(await readInScope(scope, '../../libs/other/package.json'), null)
    assert.equal(await readInScope(scope, 'missing.json'), null)
    assert.equal((await readInScope(scope, 'package.json'))?.toString('utf8'), '{"name":"shop"}\n')
    const hashes = await hashSources(scope, ['package.json', DECLARED_MANIFEST, '../../libs/other/package.json'])
    assert.deepEqual([...hashes], [
      ['package.json', sha256('{"name":"shop"}\n')],
      [DECLARED_MANIFEST, sha256('{"name":"ui"}\n')],
      ['../../libs/other/package.json', null],
    ])
  })

  describe('classifies outside importers', () => {
    it('declares an outside package matched by the patterns', () => {
      const root = graphWith('pnpm', ['../../libs/ui'], [['.', 'apps/shop'], ['web', 'apps/shop/web'], ['../../libs/ui', 'libs/ui']])
      assert.deepEqual(outsideImporters(root), { declared: ['../../libs/ui'] })
    })

    it('reports a package outside the repository first', () => {
      const root = graphWith('pnpm', ['../../libs/ui'], [['../../../shared', '../shared'], ['../../libs/ui', 'libs/ui']])
      assert.deepEqual(outsideImporters(root), { declared: [], problem: { kind: 'outside-repository', path: '../../../shared' } })
    })

    it('reports a package outside the repository for a root at the repository top', () => {
      const root = graphWith('pnpm', ['../x'], [['.', '.'], ['../x', '../x']])
      assert.deepEqual(outsideImporters(root), { declared: [], problem: { kind: 'outside-repository', path: '../x' } })
    })

    it('reports npm roots', () => {
      const root = graphWith('npm', ['../../libs/ui'], [['../../libs/ui', 'libs/ui']])
      assert.equal(outsideImporters(root).problem?.kind, 'npm')
    })

    it('reports a package excluded by a negated pattern and keeps the declared ones', () => {
      const root = graphWith('pnpm', ['../../libs/*', '!../../libs/other'], [['../../libs/ui', 'libs/ui'], ['../../libs/other', 'libs/other']])
      assert.deepEqual(outsideImporters(root), { declared: ['../../libs/ui'], problem: { kind: 'undeclared', path: '../../libs/other' } })
    })

    it('reports undeclared when there is no config', () => {
      const root = graphWith('pnpm', undefined, [['../../libs/ui', 'libs/ui']])
      assert.equal(outsideImporters(root).problem?.kind, 'undeclared')
    })

    it('normalizes an importer key', () => {
      const root = graphWith('pnpm', ['../../libs/ui'], [['../../libs/./ui', 'libs/ui']])
      assert.deepEqual(outsideImporters(root), { declared: ['../../libs/ui'] })
    })
  })
})
