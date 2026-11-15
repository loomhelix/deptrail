import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findRoots } from '../src/discovery/find-roots.ts'
import { createFsReader } from '../src/sources/file-reader.ts'
import type { FileReader } from '../src/sources/file-reader.ts'
import type { RootDescriptor } from '../src/model.ts'

const fixtureDirectory = new URL('./fixtures/monolith', import.meta.url)

async function writeIn(base: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(base, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

describe('findRoots on the fixture monolith', () => {
  let tmpRoot: string
  let monolithCopy: string

  before(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'deptrail-find-roots-'))
    monolithCopy = path.join(tmpRoot, 'monolith')
    await cp(fixtureDirectory, monolithCopy, { recursive: true })
    await writeIn(monolithCopy, 'ignored-dir/package.json', '{"name":"ignored"}')
    await writeIn(monolithCopy, 'ignored-dir/pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    await writeIn(monolithCopy, 'generated/package.json', '{"name":"generated"}')
    await writeIn(monolithCopy, 'npm-package/node_modules/some-pkg/package.json', '{"name":"some-pkg"}')
    await writeIn(monolithCopy, 'npm-package/node_modules/some-pkg/package-lock.json', '{"lockfileVersion":3}')
    await writeIn(monolithCopy, '.git/package.json', '{"name":"git-internal"}')
  })

  after(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns the expected roots sorted by path', async () => {
    const expected: RootDescriptor[] = [
      {
        id: 'legacy/admin',
        path: 'legacy/admin',
        manager: 'npm',
        lockfile: 'legacy/admin/package-lock.json',
        importerPaths: ['legacy/admin'],
      },
      {
        id: 'npm-package',
        path: 'npm-package',
        manager: 'pnpm',
        lockfile: 'npm-package/pnpm-lock.yaml',
        importerPaths: [
          'npm-package',
          'npm-package/commerce-ui',
          'npm-package/storefront',
          'npm-package/tools/build',
        ],
      },
      { id: 'scripts/release', path: 'scripts/release', manager: 'pnpm', importerPaths: ['scripts/release'] },
      { id: 'services/api', path: 'services/api', manager: 'pnpm', importerPaths: ['services/api'] },
    ]
    assert.deepEqual(await findRoots(createFsReader(monolithCopy)), expected)
  })

  it('walks from a start path and reports repository-relative paths', async () => {
    const roots = await findRoots(createFsReader(monolithCopy), 'legacy')
    assert.deepEqual(
      roots.map((root) => root.path),
      ['legacy/admin'],
    )
  })
})

type FakeFile = string | null

function fakeReader(files: Record<string, FakeFile>): FileReader {
  const paths = Object.keys(files)
  return {
    async readText(target) {
      return files[target] ?? null
    },
    async exists(target) {
      return target in files
    },
    async listDir(directory) {
      const prefix = directory === '.' ? '' : `${directory}/`
      const entries = new Map<string, 'file' | 'dir'>()
      for (const filePath of paths) {
        if (!filePath.startsWith(prefix)) continue
        const [first, ...rest] = filePath.slice(prefix.length).split('/')
        entries.set(first, rest.length === 0 ? 'file' : 'dir')
      }
      return [...entries].map(([name, kind]) => ({ name, kind }))
    },
    async realpath(target) {
      return target
    },
  }
}

describe('findRoots rules', () => {
  it('makes a root of the repository directory itself with id and path "."', async () => {
    const reader = fakeReader({ 'package.json': '{}', 'package-lock.json': '{}' })
    assert.deepEqual(await findRoots(reader), [
      { id: '.', path: '.', manager: 'npm', lockfile: 'package-lock.json', importerPaths: ['.'] },
    ])
  })

  it('prefers pnpm-lock.yaml over package-lock.json', async () => {
    const reader = fakeReader({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })
    const [root] = await findRoots(reader)
    assert.equal(root.manager, 'pnpm')
    assert.equal(root.lockfile, 'pnpm-lock.yaml')
  })

  it('accepts npm-shrinkwrap.json as an npm lockfile', async () => {
    const reader = fakeReader({ 'app/package.json': '{}', 'app/npm-shrinkwrap.json': '{}' })
    const [root] = await findRoots(reader)
    assert.deepEqual(root, {
      id: 'app',
      path: 'app',
      manager: 'npm',
      lockfile: 'app/npm-shrinkwrap.json',
      importerPaths: ['app'],
    })
  })

  it('makes an npm root of a package.json with workspaces and no lockfile', async () => {
    const reader = fakeReader({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/a/package.json': '{}',
      'packages/b/package.json': '{}',
    })
    assert.deepEqual(await findRoots(reader), [
      { id: '.', path: '.', manager: 'npm', importerPaths: ['.', 'packages/a', 'packages/b'] },
    ])
  })

  it('reads workspaces given as an object with packages', async () => {
    const reader = fakeReader({
      'package.json': '{"workspaces":{"packages":["libs/*"]}}',
      'libs/x/package.json': '{}',
    })
    const [root] = await findRoots(reader)
    assert.deepEqual(root.importerPaths, ['.', 'libs/x'])
  })

  it('takes the manager of a lone package.json from packageManager, else unknown', async () => {
    const reader = fakeReader({
      'a/package.json': '{"packageManager":"npm@10.2.0"}',
      'b/package.json': '{}',
      'c/package.json': '{"packageManager":"yarn@4.0.0"}',
    })
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => [root.path, root.manager]),
      [
        ['a', 'npm'],
        ['b', 'unknown'],
        ['c', 'unknown'],
      ],
    )
  })

  it('treats a package.json outside every workspace pattern as its own root', async () => {
    const reader = fakeReader({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'package.json': '{}',
      'packages/a/package.json': '{}',
      'tools/x/package.json': '{}',
    })
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => [root.path, root.importerPaths]),
      [
        ['.', ['.', 'packages/a']],
        ['tools/x', ['tools/x']],
      ],
    )
  })

  it('makes members of a root workspace importers even when they carry their own lockfile', async () => {
    const reader = fakeReader({
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/a/package.json': '{}',
      'packages/a/package-lock.json': '{}',
    })
    const roots = await findRoots(reader)
    assert.equal(roots.length, 1)
    assert.deepEqual(roots[0].importerPaths, ['.', 'packages/a'])
  })

  it('honors negated workspace patterns', async () => {
    const reader = fakeReader({
      'package.json': '{"workspaces":["packages/*","!packages/skip"]}',
      'packages/keep/package.json': '{}',
      'packages/skip/package.json': '{}',
    })
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => [root.path, root.importerPaths]),
      [
        ['.', ['.', 'packages/keep']],
        ['packages/skip', ['packages/skip']],
      ],
    )
  })

  it('applies plain, directory and anchored .gitignore lines and ignores other lines', async () => {
    const reader = fakeReader({
      '.gitignore': '# comment\nbuild\ncache/\n/only-top\n*.log\n!keep\n',
      'build/package.json': '{}',
      'deep/build/package.json': '{}',
      'deep/cache/package.json': '{}',
      'only-top/package.json': '{}',
      'deep/only-top/package.json': '{}',
      'deep/app/package.json': '{}',
    })
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => root.path),
      ['deep/app', 'deep/only-top'],
    )
  })

  it('applies a nested .gitignore to its own folder and below, anchoring a line with a slash there', async () => {
    const reader = fakeReader({
      'app/package.json': '{}',
      'app/.gitignore': '/vendor\n.output\ndev/copy\n',
      'app/vendor/lib/package.json': '{}',
      'app/src/vendor/package.json': '{}',
      'app/web/.output/server/package.json': '{}',
      'app/dev/copy/package.json': '{}',
      'app/x/dev/copy/package.json': '{}',
      'other/vendor/package.json': '{}',
      'other/.output/package.json': '{}',
    })
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => root.path),
      ['app', 'app/src/vendor', 'app/x/dev/copy', 'other/.output', 'other/vendor'],
    )
  })

  it('anchors a top-level .gitignore line with a slash in the middle to the repository', async () => {
    const reader = fakeReader({
      '.gitignore': 'tools/generated\n',
      'tools/generated/package.json': '{}',
      'deep/tools/generated/package.json': '{}',
    })
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => root.path),
      ['deep/tools/generated'],
    )
  })

  it('does not descend into node_modules or .git', async () => {
    const reader = fakeReader({
      'node_modules/x/package.json': '{}',
      '.git/package.json': '{}',
      'a/node_modules/y/package-lock.json': '{}',
    })
    assert.deepEqual(await findRoots(reader), [])
  })

  it('does not follow symlinked directories', async () => {
    const base = fakeReader({ 'real/package.json': '{}' })
    const reader: FileReader = {
      ...base,
      async listDir(directory) {
        const entries = await base.listDir(directory)
        return directory === '.' ? [...entries, { name: 'linked', kind: 'symlink' }] : entries
      },
    }
    const roots = await findRoots(reader)
    assert.deepEqual(
      roots.map((root) => root.path),
      ['real'],
    )
  })

  it('returns no roots for an empty repository', async () => {
    assert.deepEqual(await findRoots(fakeReader({})), [])
  })
})
