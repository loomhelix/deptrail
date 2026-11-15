import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { GitSpawn } from '../src/git/git-process.ts'
import { GIT_COMMANDS, InvalidObjectIdError } from '../src/git/git-commands.ts'
import { isGitRepository, openGitRepository, parseGitVersion } from '../src/git/git-repository.ts'

type Reply = { stdout?: string; stderr?: string; code?: number } | 'enoent'

const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const DETECT = 'rev-parse --show-toplevel --show-prefix --git-common-dir'
const HEAD_COMMIT = 'rev-parse -q --verify HEAD^{commit}'
const SYMBOLIC_HEAD = 'symbolic-ref -q HEAD'

function scriptedSpawn(replies: Record<string, Reply>) {
  const calls: string[] = []
  const spawn: GitSpawn = (_command, args) => {
    const key = args.join(' ')
    calls.push(key)
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const reply = replies[key]
    setImmediate(() => {
      if (reply === 'enoent') {
        child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
        return
      }
      if (reply?.stdout) child.stdout.write(reply.stdout)
      if (reply?.stderr) child.stderr.write(reply.stderr)
      setImmediate(() => child.emit('close', reply?.code ?? 0))
    })
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

function versionReply(version: string): Reply {
  return { stdout: `git version ${version}\n` }
}

function open(replies: Record<string, Reply>, packFiles: string[] = []) {
  const fake = scriptedSpawn(replies)
  const listed: string[] = []
  const result = openGitRepository({
    cwd: '/r',
    env: {},
    spawn: fake.spawn,
    redact: (text) => text.replaceAll('secret', '***'),
    listDir: async (directory) => {
      listed.push(directory)
      return packFiles
    },
  })
  return { result, fake, listed }
}

const healthy = (version = '2.45.0'): Record<string, Reply> => ({
  '--version': versionReply(version),
  [DETECT]: { stdout: '/r\napps/web/\n.git\n' },
  [SYMBOLIC_HEAD]: { stdout: 'refs/heads/main\n' },
  [HEAD_COMMIT]: { stdout: `${COMMIT}\n` },
})

async function openRepository(replies: Record<string, Reply>) {
  const { result, fake } = open(replies)
  const repository = await result
  assert.ok(isGitRepository(repository))
  return { repository, fake }
}

describe('git repository', () => {
  it('parses git versions', () => {
    assert.deepEqual(parseGitVersion('git version 2.39.5 (Apple Git-154)'), [2, 39, 5])
    assert.deepEqual(parseGitVersion('git version 2.24.0.windows.1'), [2, 24, 0])
    assert.equal(parseGitVersion('nonsense'), undefined)
  })

  it('reports git missing from the PATH', async () => {
    const { result } = open({ '--version': 'enoent' })
    assert.deepEqual(await result, { unavailable: 'git was not found on the PATH', quiet: false })
  })

  it('reports git older than 2.24', async () => {
    const { result, fake } = open({ '--version': versionReply('2.23.1') })
    assert.deepEqual(await result, { unavailable: 'git 2.24 or later is required (found 2.23.1)', quiet: false })
    assert.deepEqual(fake.calls, ['--version'])
  })

  it('stays quiet outside a git repository', async () => {
    const { result } = open({ '--version': versionReply('2.45.0'), [DETECT]: { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' } })
    assert.deepEqual(await result, { unavailable: 'This directory is not in a git repository', quiet: true })
  })

  it('reports another detect failure as the first redacted stderr line', async () => {
    const { result } = open({ '--version': versionReply('2.45.0'), [DETECT]: { code: 128, stderr: 'fatal: bad secret\nsecond line\n' } })
    assert.deepEqual(await result, { unavailable: 'fatal: bad ***', quiet: false })
  })

  it('makes branches unavailable when the git version cannot be read', async () => {
    const expected = { unavailable: 'Could not read the git version from "weird ***"', quiet: false }
    const plain = open({ '--version': { stdout: 'weird secret\nmore\n' }, [DETECT]: { stdout: '/r\n\n.git\n' } })
    assert.deepEqual(await plain.result, expected)
    const partial = open({ '--version': { stdout: 'weird secret\n' }, [DETECT]: { stdout: '/r\n\n.git\n' } }, ['pack-1.promisor'])
    assert.deepEqual(await partial.result, expected)
  })

  it('refuses a partial clone before git 2.44 and accepts it from 2.44', async () => {
    const old = open({ ...healthy('2.43.0'), [DETECT]: { stdout: '/r\n\n.git\n' } }, ['pack-1.idx', 'pack-1.promisor'])
    assert.deepEqual(await old.result, {
      unavailable: 'This is a partial clone, and git 2.43.0 could download missing objects while reading. Use git 2.44 or later.',
      quiet: false,
    })
    assert.deepEqual(old.listed, ['/r/.git/objects/pack'])
    const current = open({ ...healthy('2.44.0'), [DETECT]: { stdout: '/r\n\n.git\n' } }, ['pack-1.promisor'])
    assert.ok(isGitRepository(await current.result))
    assert.deepEqual(current.listed, [])
  })

  it('accepts an ordinary repository before git 2.44', async () => {
    const { result } = open({ ...healthy('2.30.0'), [DETECT]: { stdout: '/r\n\n/abs/common\n' } }, ['pack-1.idx'])
    assert.ok(isGitRepository(await result))
  })

  it('resolves an absolute common dir as is', async () => {
    const { result, listed } = open({ ...healthy('2.30.0'), [DETECT]: { stdout: '/r\n\n/abs/common\n' } })
    await result
    assert.deepEqual(listed, ['/abs/common/objects/pack'])
  })

  it('reads the prefix and head', async () => {
    const { repository } = await openRepository(healthy())
    assert.equal(repository.prefix, 'apps/web/')
    assert.deepEqual(await repository.head(), { commit: COMMIT, branch: 'refs/heads/main' })
    const detached = await openRepository({ ...healthy(), [SYMBOLIC_HEAD]: { code: 1 } })
    assert.deepEqual(await detached.repository.head(), { commit: COMMIT })
    const unborn = await openRepository({ ...healthy(), [HEAD_COMMIT]: { code: 1 } })
    assert.equal(await unborn.repository.head(), undefined)
  })

  it('exposes an empty prefix at the top of the work tree', async () => {
    const { repository } = await openRepository({ ...healthy(), [DETECT]: { stdout: '/r\n\n.git\n' } })
    assert.equal(repository.prefix, '')
  })

  it('refuses a malformed commit before spawning', async () => {
    const { repository, fake } = await openRepository(healthy())
    const before = fake.calls.length
    await assert.rejects(() => repository.tree('main'), InvalidObjectIdError)
    await assert.rejects(() => repository.mergeBase(COMMIT, '--all'), InvalidObjectIdError)
    assert.equal(fake.calls.length, before)
  })

  it('reports no merge base', async () => {
    const key = `merge-base --end-of-options ${COMMIT} ${OTHER}`
    const none = await openRepository({ ...healthy(), [key]: { code: 1 } })
    assert.equal(await none.repository.mergeBase(COMMIT, OTHER), undefined)
    const found = await openRepository({ ...healthy(), [key]: { stdout: `${COMMIT}\n` } })
    assert.equal(await found.repository.mergeBase(COMMIT, OTHER), COMMIT)
    const broken = await openRepository({ ...healthy(), [key]: { code: 128, stderr: 'fatal: boom\nmore' } })
    await assert.rejects(() => broken.repository.mergeBase(COMMIT, OTHER), /fatal: boom/)
  })

  it('throws the first redacted stderr line when refs or tree fail', async () => {
    const treeKey = `ls-tree -r -t -z --full-tree --end-of-options ${COMMIT}`
    const refsKey = GIT_COMMANDS.refs.join(' ')
    const { repository } = await openRepository({ ...healthy(), [treeKey]: { code: 128, stderr: 'fatal: secret tree\nx' }, [refsKey]: { code: 128, stderr: 'fatal: secret refs\n' } })
    await assert.rejects(() => repository.tree(COMMIT), /fatal: \*\*\* tree/)
    await assert.rejects(() => repository.refs(), /fatal: \*\*\* refs/)
  })
})
