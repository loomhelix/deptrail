import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { GitFailure, gitEnvironment, killGitProcesses, runGit, startGit, type GitSpawn, type GitSpawnOptions } from '../src/git/git-process.ts'

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal?: string): boolean; signals: (string | undefined)[]; stdinEnded: boolean }

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 4242
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.signals = []
  child.stdinEnded = false
  child.stdin.on('finish', () => {
    child.stdinEnded = true
  })
  child.kill = (signal) => {
    child.signals.push(signal)
    return true
  }
  return child
}

function createFakeSpawn() {
  const children: FakeChild[] = []
  const calls: { command: string; args: readonly string[]; options: GitSpawnOptions }[] = []
  const spawn: GitSpawn = (command, args, options) => {
    const child = createFakeChild()
    children.push(child)
    calls.push({ command, args, options })
    return child as unknown as ChildProcess
  }
  return { spawn, children, calls }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const LIMITS = { timeoutMs: 5000, maxBytes: 1024 }

describe('git process', () => {
  it('cleans the environment', () => {
    assert.deepEqual(
      gitEnvironment({ PATH: '/bin', HOME: '/h', GIT_DIR: 'x', GIT_WORK_TREE: 'y', GIT_CONFIG_GLOBAL: 'z', git_lower: 'kept', MISSING: undefined }),
      { PATH: '/bin', HOME: '/h', git_lower: 'kept', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' },
    )
  })

  it('spawns git without a shell in the scanned directory', async () => {
    const fake = createFakeSpawn()
    const env = { PATH: '/bin', GIT_DIR: 'x' }
    const running = runGit({ cwd: '/repo', env, spawn: fake.spawn }, ['--version'], LIMITS)
    assert.deepEqual(fake.calls, [{ command: 'git', args: ['--version'], options: { cwd: '/repo', env: gitEnvironment(env), shell: false, stdio: ['pipe', 'pipe', 'pipe'] } }])
    await settle()
    assert.equal(fake.children[0]?.stdinEnded, true)
    fake.children[0]?.emit('close', 0)
    await running
  })

  it('collects stdout as a buffer and stderr as text with the exit code', async () => {
    const fake = createFakeSpawn()
    const running = runGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['x'], LIMITS)
    const child = fake.children[0] as FakeChild
    child.stdout.write(Buffer.from('he'))
    child.stdout.write(Buffer.from('llo'))
    child.stderr.write('warn')
    await settle()
    child.emit('close', 3)
    const result = await running
    assert.equal(result.code, 3)
    assert.ok(Buffer.isBuffer(result.stdout))
    assert.equal(result.stdout.toString(), 'hello')
    assert.equal(result.stderr, 'warn')
  })

  it('kills and rejects on timeout', async () => {
    const fake = createFakeSpawn()
    const running = runGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['x'], { timeoutMs: 20, maxBytes: 1024 })
    await assert.rejects(running, (error: unknown) => error instanceof GitFailure && error.kind === 'timeout' && /^git did not finish within /.test(error.message))
    assert.deepEqual(fake.children[0]?.signals, ['SIGTERM'])
  })

  it('kills and rejects when output is too large', async () => {
    const fake = createFakeSpawn()
    const running = runGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['x'], { timeoutMs: 5000, maxBytes: 4 })
    const child = fake.children[0] as FakeChild
    child.stdout.write(Buffer.alloc(10))
    await assert.rejects(running, (error: unknown) => error instanceof GitFailure && error.kind === 'too-large' && /^git output exceeded /.test(error.message))
    assert.deepEqual(child.signals, ['SIGTERM'])
  })

  it('reports a missing git', async () => {
    const fake = createFakeSpawn()
    const running = runGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['x'], LIMITS)
    fake.children[0]?.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    await assert.rejects(running, (error: unknown) => error instanceof GitFailure && error.kind === 'not-found' && error.message === 'git was not found')
  })

  it('reports any other spawn error with its message', async () => {
    const fake = createFakeSpawn()
    const running = runGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['x'], LIMITS)
    fake.children[0]?.emit('error', new Error('boom'))
    await assert.rejects(running, (error: unknown) => error instanceof GitFailure && error.kind === 'spawn' && error.message === 'boom')
  })

  it('leaves stdin open for a started process', () => {
    const fake = createFakeSpawn()
    startGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['cat-file', '--batch'])
    assert.equal(fake.children[0]?.stdinEnded, false)
  })

  it('killGitProcesses stops running processes', async () => {
    const fake = createFakeSpawn()
    startGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['cat-file', '--batch'])
    const running = runGit({ cwd: '/repo', env: {}, spawn: fake.spawn }, ['x'], LIMITS)
    killGitProcesses()
    assert.deepEqual(fake.children.map((child) => child.signals), [['SIGTERM'], ['SIGTERM']])
    fake.children[1]?.emit('close', null)
    await running
  })
})
