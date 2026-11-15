import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsReader, type FileReader } from '../src/sources/file-reader.ts'

const fixtureSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader')

describe('createFsReader', () => {
  let sandbox: string
  let repoPath: string
  let outsidePath: string
  let reader: FileReader

  before(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-reader-'))
    repoPath = path.join(sandbox, 'repo')
    outsidePath = path.join(sandbox, 'outside')
    await cp(fixtureSource, repoPath, { recursive: true })
    await cp(fixtureSource, outsidePath, { recursive: true })
    await symlink('file.txt', path.join(repoPath, 'link-to-file'))
    await symlink('subdir', path.join(repoPath, 'link-to-dir'))
    await symlink('../outside/file.txt', path.join(repoPath, 'link-outside'))
    await symlink('missing.txt', path.join(repoPath, 'link-broken'))
    reader = createFsReader(repoPath)
  })

  after(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('readText returns content of an existing file', async () => {
    assert.equal(await reader.readText('file.txt'), 'hello\n')
  })

  it('readText returns null for a missing file', async () => {
    assert.equal(await reader.readText('nope.txt'), null)
  })

  it('exists reports true for files and dirs and false for missing paths', async () => {
    assert.equal(await reader.exists('file.txt'), true)
    assert.equal(await reader.exists('subdir'), true)
    assert.equal(await reader.exists('nope.txt'), false)
  })

  it('listDir reports file, dir and symlink kinds', async () => {
    const entries = await reader.listDir('.')
    const kinds = Object.fromEntries(entries.map((entry) => [entry.name, entry.kind]))
    assert.equal(kinds['file.txt'], 'file')
    assert.equal(kinds['subdir'], 'dir')
    assert.equal(kinds['link-to-file'], 'symlink')
    assert.equal(kinds['link-to-dir'], 'symlink')
  })

  it('listDir returns an empty list for a missing dir', async () => {
    assert.deepEqual(await reader.listDir('nope'), [])
  })

  it('realpath resolves a symlink to its repo-relative target', async () => {
    assert.equal(await reader.realpath('link-to-file'), 'file.txt')
    assert.equal(await reader.realpath('link-to-dir'), 'subdir')
  })

  it('realpath of a regular path returns it unchanged', async () => {
    assert.equal(await reader.realpath('subdir/inner.txt'), 'subdir/inner.txt')
    assert.equal(await reader.realpath('.'), '.')
  })

  it('realpath returns null for a link pointing outside the repo', async () => {
    assert.equal(await reader.realpath('link-outside'), null)
  })

  it('realpath returns null for a broken link', async () => {
    assert.equal(await reader.realpath('link-broken'), null)
  })
})
