import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { createProcessRunner, createSpawnRunner, spawnRunner } from '../src/adapters/command-runner.ts'

const LONG_RUNNING_SCRIPT = ['-e', 'setTimeout(() => {}, 30000)']

describe('spawn runner', () => {
  it('collects stdout, stderr and the exit code of a finished command', async () => {
    const result = await spawnRunner(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], tmpdir())
    assert.deepEqual(result, { code: 3, stdout: 'out', stderr: 'err' })
  })

  it('rejects when the command cannot be started', async () => {
    await assert.rejects(spawnRunner('deptrail-command-that-does-not-exist', [], tmpdir()), { code: 'ENOENT' })
  })

  it('kills a command that outlives its timeout and resolves with a non-zero timed-out result', async () => {
    const startedAt = Date.now()
    const result = await createSpawnRunner({ timeoutMs: 100 })(process.execPath, LONG_RUNNING_SCRIPT, tmpdir())
    assert.ok(Date.now() - startedAt < 5000)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /timed out after 100 ms/)
  })

  it('kills every running command on request', async () => {
    const runner = createSpawnRunner({ timeoutMs: 60000 })
    const running = runner(process.execPath, LONG_RUNNING_SCRIPT, tmpdir())
    await new Promise((resolve) => setTimeout(resolve, 100))
    runner.killRunning()
    const result = await running
    assert.notEqual(result.code, 0)
  })
})

describe('process runner', () => {
  const baseRequest = { command: process.execPath, cwd: tmpdir(), env: { ...process.env }, timeoutMs: 30000 }

  it('reports every line of both streams without carriage returns and the trailing partial line', async () => {
    const lines: string[] = []
    const script = 'process.stdout.write("a\\r\\n"); setTimeout(() => process.stderr.write("b\\r\\n"), 50); setTimeout(() => process.stdout.write("c"), 100)'
    const result = await createProcessRunner().run({ ...baseRequest, args: ['-e', script], onLine: (line) => lines.push(line) })
    assert.equal(result.code, 0)
    assert.deepEqual(lines, ['a', 'b', 'c'])
  })

  it('marks a run aborted through its signal as cancelled', async () => {
    const controller = new AbortController()
    const running = createProcessRunner().run({ ...baseRequest, args: LONG_RUNNING_SCRIPT, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const result = await running
    assert.equal(result.cancelled, true)
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
  })

  it('resolves as cancelled without starting the command when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const lines: string[] = []
    const result = await createProcessRunner().run({
      ...baseRequest,
      command: 'deptrail-command-that-does-not-exist',
      args: [],
      signal: controller.signal,
      onLine: (line) => lines.push(line),
    })
    assert.deepEqual(result, { code: 1, stdout: '', stderr: '', timedOut: false, cancelled: true })
    assert.deepEqual(lines, [])
  })

  it('marks a run that outlives its timeout as timed out with code 124', async () => {
    const result = await createProcessRunner().run({ ...baseRequest, args: LONG_RUNNING_SCRIPT, timeoutMs: 100 })
    assert.equal(result.timedOut, true)
    assert.equal(result.cancelled, false)
    assert.equal(result.code, 124)
  })

  it('rejects when the command cannot be started', async () => {
    await assert.rejects(createProcessRunner().run({ ...baseRequest, command: 'deptrail-command-that-does-not-exist', args: [] }), { code: 'ENOENT' })
  })

  it('signals nothing when asked to kill a command that could not be started', async () => {
    const runner = createProcessRunner()
    const running = runner.run({ ...baseRequest, command: 'deptrail-command-that-does-not-exist', args: [] })
    runner.killRunning()
    await assert.rejects(running, { code: 'ENOENT' })
  })

  it('kills every running command on request', async () => {
    const runner = createProcessRunner()
    const running = runner.run({ ...baseRequest, args: LONG_RUNNING_SCRIPT })
    await new Promise((resolve) => setTimeout(resolve, 100))
    runner.killRunning()
    assert.notEqual((await running).code, 0)
  })

  it('gives the child the environment of the request', async () => {
    const result = await createProcessRunner().run({
      ...baseRequest,
      args: ['-e', 'process.stdout.write(process.env.DEPTRAIL_PROBE ?? "")'],
      env: { ...process.env, DEPTRAIL_PROBE: 'seen' },
    })
    assert.equal(result.stdout, 'seen')
  })
})
