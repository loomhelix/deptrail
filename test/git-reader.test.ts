import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CommandRunner } from '../src/adapters/command-runner.ts'
import { findRoots } from '../src/discovery/find-roots.ts'
import { buildRoot } from '../src/scan/build-root.ts'
import { createFsReader, type FileReader } from '../src/sources/file-reader.ts'
import { createGitReader } from '../src/sources/git-reader.ts'
import { memoryTree } from './helpers/git-tree.ts'

const LAYOUT: Record<string, string> = {
  '.gitignore': 'ignored\n',
  'ignored/package.json': '{"name":"ignored"}',
  'shop/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'shop/pnpm-workspace.yaml': 'packages:\n  - web\n',
  'shop/package.json': '{"name":"shop"}',
  'shop/web/package.json': '{"name":"web"}',
  'tools/package.json': '{"name":"tools"}',
  'tools/.gitignore': 'cache/\n',
  'tools/cache/package.json': '{"name":"cache"}',
}

const OUTSIDE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  "      '@acme/lib':",
  '        specifier: workspace:*',
  '        version: link:../lib',
  '',
  '  ../lib: {}',
  '',
].join('\n')

const neverRunner: CommandRunner = async () => {
  throw new Error('no commands run while reading a commit')
}

describe('git reader', () => {
  it('reads files, lists directories and checks existence', async () => {
    const tree = memoryTree({ 'shop/package.json': '{"name":"shop"}', 'shop/web/index.js': 'x' })
    const reader = createGitReader(tree.index, tree.readBlob)
    assert.equal(await reader.readText('shop/package.json'), '{"name":"shop"}')
    assert.equal(await reader.readText('./shop/package.json'), '{"name":"shop"}')
    assert.equal(await reader.readText('shop'), null)
    assert.equal(await reader.readText('shop/missing.json'), null)
    assert.deepEqual(await reader.listDir('.'), [{ name: 'shop', kind: 'dir' }])
    assert.deepEqual(await reader.listDir(''), [{ name: 'shop', kind: 'dir' }])
    assert.deepEqual(await reader.listDir('shop'), [
      { name: 'package.json', kind: 'file' },
      { name: 'web', kind: 'dir' },
    ])
    assert.deepEqual(await reader.listDir('missing'), [])
    assert.equal(await reader.exists('.'), true)
    assert.equal(await reader.exists('shop/web'), true)
    assert.equal(await reader.exists('shop/web/index.js'), true)
    assert.equal(await reader.exists('nope'), false)
    assert.equal(await reader.realpath('shop/web/../package.json'), 'shop/package.json')
    assert.equal(await reader.realpath('.'), '.')
    assert.equal(await reader.realpath('nope'), null)
  })

  it('does not follow symlinks', async () => {
    const tree = memoryTree({ 'shop/package.json': '{}', link: { symlink: 'shop' }, 'npmrc-link': { symlink: 'shop/package.json' } })
    const reader = createGitReader(tree.index, tree.readBlob)
    assert.equal(await reader.readText('link'), null)
    assert.equal(await reader.readText('link/package.json'), null)
    assert.equal(await reader.readText('npmrc-link'), null)
    assert.equal(await reader.realpath('link'), null)
    assert.equal(await reader.realpath('link/package.json'), null)
    assert.equal(await reader.exists('link'), true)
    assert.deepEqual(await reader.listDir('link'), [])
  })

  it('reads missing for paths that leave the top', async () => {
    const tree = memoryTree({ 'package.json': '{}' })
    const reader = createGitReader(tree.index, tree.readBlob)
    assert.equal(await reader.readText('../x'), null)
    assert.equal(await reader.readText('/package.json'), null)
    assert.equal(await reader.exists('/etc'), false)
    assert.equal(await reader.exists('..'), false)
    assert.deepEqual(await reader.listDir('..'), [])
    assert.equal(await reader.realpath('../package.json'), null)
  })

  it('reads null when the blob cannot be read', async () => {
    const tree = memoryTree({ 'package.json': '{}', 'other.json': '[]' })
    const failing = createGitReader(tree.index, async () => {
      throw new Error('git cat-file stopped')
    })
    assert.equal(await failing.readText('package.json'), null)
    const empty = createGitReader(tree.index, async () => null)
    assert.equal(await empty.readText('other.json'), null)
  })

  it('reads under a prefix as if the prefix were the top', async () => {
    const tree = memoryTree({ 'apps/web/package.json': '{"name":"web"}', 'other/package.json': '{}' }, 'apps/')
    const reader = createGitReader(tree.index, tree.readBlob)
    assert.equal(await reader.readText('web/package.json'), '{"name":"web"}')
    assert.equal(await reader.exists('other'), false)
  })

  it('reads above the prefix inside the repository like the working copy', async () => {
    const tree = memoryTree({ 'app/package.json': '{"name":"app"}', 'lib/package.json': '{"name":"@acme/lib"}', 'lib/link': { symlink: 'x' } }, 'app/')
    const reader = createGitReader(tree.index, tree.readBlob)
    assert.equal(await reader.readText('../lib/package.json'), '{"name":"@acme/lib"}')
    assert.equal(await reader.readText('./../lib/../lib/package.json'), '{"name":"@acme/lib"}')
    assert.equal(await reader.exists('../lib'), true)
    assert.equal(await reader.exists('..'), true)
    assert.deepEqual(
      (await reader.listDir('..')).map((entry) => entry.name),
      ['app', 'lib'],
    )
    assert.equal(await reader.readText('../lib/link'), null)
    assert.equal(await reader.readText('../../package.json'), null)
    assert.equal(await reader.exists('../..'), false)
    assert.equal(await reader.realpath('../lib/package.json'), null)
    assert.deepEqual(
      (await reader.listDir('.')).map((entry) => entry.name),
      ['package.json'],
    )
  })

  it('names outside workspace packages of a subfolder root like the working copy', async () => {
    const files = {
      'app/package.json': '{"name":"app","private":true}',
      'app/pnpm-workspace.yaml': 'packages:\n  - ../lib\n',
      'app/pnpm-lock.yaml': OUTSIDE_LOCKFILE,
      'lib/package.json': '{"name":"@acme/lib","version":"1.0.0"}',
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-git-reader-'))
    try {
      for (const [filePath, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, filePath)), { recursive: true })
        await writeFile(path.join(dir, filePath), content)
      }
      const tree = memoryTree(files, 'app/')
      const names = async (reader: FileReader) => {
        const [descriptor] = await findRoots(reader)
        const graph = await buildRoot(descriptor!, { reader, runner: neverRunner, allowResolve: false, allowInstalled: false })
        return graph.importers.map((importer) => importer.name).sort()
      }
      const fromDisk = await names(createFsReader(path.join(dir, 'app')))
      assert.deepEqual(fromDisk, ['@acme/lib', 'app'])
      assert.deepEqual(await names(createGitReader(tree.index, tree.readBlob)), fromDisk)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finds roots like the working copy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-git-reader-'))
    try {
      for (const [filePath, content] of Object.entries(LAYOUT)) {
        await mkdir(path.dirname(path.join(dir, filePath)), { recursive: true })
        await writeFile(path.join(dir, filePath), content)
      }
      const tree = memoryTree(LAYOUT)
      const fromGit = await findRoots(createGitReader(tree.index, tree.readBlob))
      const fromDisk = await findRoots(createFsReader(dir))
      assert.deepEqual(fromGit, fromDisk)
      assert.deepEqual(
        fromGit.map((root) => root.path),
        ['shop', 'tools'],
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
