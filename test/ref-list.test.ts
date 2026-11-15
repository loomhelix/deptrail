import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRefs } from '../src/git/ref-list.ts'

const ID_A = 'a'.repeat(40)
const ID_B = 'b'.repeat(40)
const ID_C = 'c'.repeat(40)
const ID_D = 'd'.repeat(40)
const ID_TAG = 'e'.repeat(40)

function record(fields: string[]): string {
  return fields.join('\0')
}

function commitRecord(name: string, id: string, seconds: number): string {
  return record([name, 'commit', id, '', '', String(seconds), '', ''])
}

function output(records: string[]): string {
  return records.join('\n') + '\n'
}

describe('parseRefs', () => {
  it('lists branches, remotes and tags with their commits', () => {
    const listing = parseRefs(
      output([
        commitRecord('refs/heads/main', ID_A, 1000),
        commitRecord('refs/heads/maintenance/6.1', ID_B, 2000),
        commitRecord('refs/remotes/origin/main', ID_C, 3000),
        commitRecord('refs/tags/v1', ID_D, 4000),
        record(['refs/tags/v2', 'tag', ID_TAG, 'commit', ID_A, '5000', '6000', '']),
      ]),
    )
    assert.deepEqual(
      listing.refs.map((ref) => [ref.kind, ref.short]),
      [
        ['branch', 'maintenance/6.1'],
        ['branch', 'main'],
        ['remote', 'origin/main'],
        ['tag', 'v2'],
        ['tag', 'v1'],
      ],
    )
    const annotated = listing.refs.find((ref) => ref.short === 'v2')
    assert.equal(annotated?.commit, ID_A)
    assert.equal(annotated?.committedAt, new Date(6000 * 1000).toISOString())
    assert.equal(annotated?.name, 'refs/tags/v2')
  })

  it('takes the default branch from the remote HEAD', () => {
    const listing = parseRefs(
      output([
        commitRecord('refs/remotes/origin/main', ID_A, 1000),
        record(['refs/remotes/origin/HEAD', 'commit', ID_A, '', '', '1000', '', 'refs/remotes/origin/main']),
      ]),
    )
    assert.equal(listing.defaultBranch, 'refs/remotes/origin/main')
    assert.deepEqual(
      listing.refs.map((ref) => ref.name),
      ['refs/remotes/origin/main'],
    )
  })

  it('falls back to main, then master', () => {
    assert.equal(parseRefs(output([commitRecord('refs/heads/main', ID_A, 1), commitRecord('refs/heads/master', ID_B, 2)])).defaultBranch, 'refs/heads/main')
    assert.equal(parseRefs(output([commitRecord('refs/heads/master', ID_B, 2)])).defaultBranch, 'refs/heads/master')
    assert.equal(parseRefs(output([commitRecord('refs/heads/dev', ID_B, 2)])).defaultBranch, undefined)
  })

  it('drops refs that do not point at commits and names starting with a dash', () => {
    const listing = parseRefs(
      output([
        record(['refs/tags/tree-tag', 'tag', ID_TAG, 'tree', ID_B, '1', '1', '']),
        commitRecord('refs/heads/-x', ID_A, 1),
        commitRecord('refs/heads/bad', 'zz', 1),
        commitRecord('refs/heads/good', ID_A, 1),
      ]),
    )
    assert.deepEqual(
      listing.refs.map((ref) => ref.name),
      ['refs/heads/good'],
    )
  })

  it('sorts by kind, newest first, then name', () => {
    const listing = parseRefs(
      output([
        commitRecord('refs/tags/t', ID_A, 5),
        commitRecord('refs/remotes/origin/x', ID_A, 5),
        commitRecord('refs/heads/b', ID_A, 5),
        commitRecord('refs/heads/a', ID_A, 5),
        commitRecord('refs/heads/new', ID_A, 9),
      ]),
    )
    assert.deepEqual(
      listing.refs.map((ref) => ref.short),
      ['new', 'a', 'b', 'origin/x', 't'],
    )
  })

  it('tolerates empty output', () => {
    assert.deepEqual(parseRefs(''), { refs: [], defaultBranch: undefined })
  })
})
