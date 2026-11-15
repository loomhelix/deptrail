import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GIT_COMMANDS, InvalidObjectIdError, REF_FORMAT, isObjectId, mergeBaseArgs, treeArgs } from '../src/git/git-commands.ts'

const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const READ_ONLY_COMMANDS = ['--version', 'rev-parse', 'symbolic-ref', 'for-each-ref', 'ls-tree', 'cat-file', 'merge-base']

describe('git commands', () => {
  it('lists only read-only commands', () => {
    const vectors = [...Object.values(GIT_COMMANDS), treeArgs(SHA1), mergeBaseArgs(SHA1, SHA2)]
    for (const vector of vectors) assert.ok(READ_ONLY_COMMANDS.includes(vector[0] as string), vector.join(' '))
  })

  it('builds exact vectors', () => {
    assert.deepEqual(treeArgs(SHA1), ['ls-tree', '-r', '-t', '-z', '--full-tree', '--end-of-options', SHA1])
    assert.deepEqual(mergeBaseArgs(SHA1, SHA2), ['merge-base', '--end-of-options', SHA1, SHA2])
    assert.deepEqual(GIT_COMMANDS.refs, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'])
    assert.deepEqual(GIT_COMMANDS.headCommit, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
    assert.deepEqual(GIT_COMMANDS.version, ['--version'])
    assert.deepEqual(GIT_COMMANDS.detect, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-common-dir'])
    assert.deepEqual(GIT_COMMANDS.symbolicHead, ['symbolic-ref', '-q', 'HEAD'])
    assert.deepEqual(GIT_COMMANDS.blobs, ['cat-file', '--batch'])
  })

  it('refuses anything that is not an object id', () => {
    assert.throws(() => treeArgs('-c'), InvalidObjectIdError)
    assert.throws(() => treeArgs('main'), InvalidObjectIdError)
    assert.throws(() => treeArgs(SHA1.toUpperCase()), InvalidObjectIdError)
    assert.throws(() => mergeBaseArgs(SHA1, '--all'), InvalidObjectIdError)
    assert.deepEqual(treeArgs('c'.repeat(64)).at(-1), 'c'.repeat(64))
    assert.equal(isObjectId(SHA1), true)
    assert.equal(isObjectId('c'.repeat(64)), true)
    assert.equal(isObjectId('c'.repeat(41)), false)
  })
})
