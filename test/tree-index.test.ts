import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TreeTooLargeError, parseTree } from '../src/git/tree-index.ts'
import { treeBuffer } from './helpers/git-tree.ts'

const ID = '1'.repeat(40)
const ID_2 = '2'.repeat(40)

const SAMPLE = treeBuffer([
  ['040000', 'tree', ID, 'apps'],
  ['120000', 'blob', ID, 'apps/link'],
  ['040000', 'tree', ID, 'apps/web'],
  ['100644', 'blob', ID_2, 'apps/web/package.json'],
  ['100644', 'blob', ID, 'README.md'],
])

describe('parseTree', () => {
  it('indexes directories, files and symlinks at the top', () => {
    const index = parseTree(SAMPLE, '', 100)
    assert.deepEqual(index.directories.get('.'), [
      { name: 'apps', kind: 'dir' },
      { name: 'README.md', kind: 'file' },
    ])
    assert.deepEqual(index.directories.get('apps'), [
      { name: 'link', kind: 'symlink' },
      { name: 'web', kind: 'dir' },
    ])
    assert.equal(index.blobs.get('apps/web/package.json'), ID_2)
    assert.equal(index.kinds.get('apps/link'), 'symlink')
    assert.equal(index.kinds.get('apps'), 'dir')
  })

  it('re-roots under a prefix', () => {
    for (const prefix of ['apps/', 'apps']) {
      const index = parseTree(SAMPLE, prefix, 100)
      assert.deepEqual(index.directories.get('.'), [
        { name: 'link', kind: 'symlink' },
        { name: 'web', kind: 'dir' },
      ])
      assert.equal(index.blobs.get('web/package.json'), ID_2)
      assert.equal(index.kinds.has('README.md'), false)
      assert.equal(index.kinds.has('apps'), false)
      assert.equal(index.blobs.has('apps/web/package.json'), false)
    }
  })

  it('keys entries above the prefix with parent segments', () => {
    const index = parseTree(SAMPLE, 'apps/web/', 100)
    assert.equal(index.blobs.get('package.json'), ID_2)
    assert.equal(index.blobs.get('../../README.md'), ID)
    assert.equal(index.kinds.get('..'), 'dir')
    assert.equal(index.kinds.get('../link'), 'symlink')
    assert.deepEqual(index.directories.get('..'), [
      { name: 'link', kind: 'symlink' },
      { name: 'web', kind: 'dir' },
    ])
    assert.deepEqual(index.directories.get('../..'), [
      { name: 'apps', kind: 'dir' },
      { name: 'README.md', kind: 'file' },
    ])
  })

  it('keeps an empty top for a prefix that does not exist', () => {
    const index = parseTree(SAMPLE, 'missing/', 100)
    assert.deepEqual(index.directories.get('.'), [])
    assert.deepEqual([...index.blobs.keys()].sort(), ['../README.md', '../apps/web/package.json'])
  })

  it('leaves submodules out', () => {
    const index = parseTree(
      treeBuffer([
        ['040000', 'tree', ID, 'vendor'],
        ['160000', 'commit', ID, 'vendor/lib'],
      ]),
      '',
      100,
    )
    assert.equal(index.kinds.has('vendor/lib'), false)
    assert.deepEqual(index.directories.get('vendor'), [])
    assert.deepEqual(index.submodules, ['vendor/lib'])
  })

  it('lists only the submodules at or under the prefix', () => {
    const output = treeBuffer([
      ['160000', 'commit', ID, 'apps/web/vendor'],
      ['160000', 'commit', ID, 'apps/web'],
      ['160000', 'commit', ID, 'tools'],
    ])
    assert.deepEqual(parseTree(output, 'apps/web/', 100).submodules, ['vendor', '.'])
  })

  it('keeps exact names with spaces, non-ASCII and newlines', () => {
    const index = parseTree(
      treeBuffer([
        ['040000', 'tree', ID, 'docs'],
        ['100644', 'blob', ID, 'docs/naïve file.md'],
        ['040000', 'tree', ID, 'odd\nname'],
        ['100644', 'blob', ID_2, 'odd\nname/package.json'],
      ]),
      '',
      100,
    )
    assert.equal(index.blobs.get('docs/naïve file.md'), ID)
    assert.equal(index.blobs.get('odd\nname/package.json'), ID_2)
    assert.deepEqual(index.directories.get('odd\nname'), [{ name: 'package.json', kind: 'file' }])
  })

  it('refuses a tree above the cap', () => {
    const buffer = treeBuffer([
      ['100644', 'blob', ID, 'a'],
      ['100644', 'blob', ID, 'b'],
      ['100644', 'blob', ID, 'c'],
    ])
    assert.throws(
      () => parseTree(buffer, '', 2),
      (error: unknown) => error instanceof TreeTooLargeError && error.message === 'the tree has more than 2 entries',
    )
    assert.doesNotThrow(() => parseTree(buffer, '', 3))
  })
})
