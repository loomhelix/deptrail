import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { createBlobReader, type BlobProcess } from '../src/git/blob-reader.ts'
import { InvalidObjectIdError } from '../src/git/git-commands.ts'

const FIRST_ID = 'a'.repeat(40)
const SECOND_ID = 'b'.repeat(40)
const THIRD_ID = 'c'.repeat(40)

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  killed = false
  written = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString('utf8')
    })
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

function setup(limits = { maxBlobBytes: 1000, responseTimeoutMs: 1000 }) {
  const processes: FakeProcess[] = []
  const reader = createBlobReader(() => {
    const fake = new FakeProcess()
    processes.push(fake)
    return fake as unknown as BlobProcess
  }, limits)
  return { processes, reader }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('blob reader', () => {
  it('reads one blob', async () => {
    const { processes, reader } = setup()
    const pending = reader.read(FIRST_ID)
    processes[0]!.stdout.write(`${FIRST_ID} blob 5\nhello\n`)
    assert.deepEqual(await pending, Buffer.from('hello'))
    assert.equal(processes[0]!.written, `${FIRST_ID}\n`)
    reader.close()
  })

  it('answers pipelined reads in order across split chunks', async () => {
    const { processes, reader } = setup()
    const first = reader.read(FIRST_ID)
    const second = reader.read(SECOND_ID)
    const wire = Buffer.from(`${FIRST_ID} blob 5\nhello\n${SECOND_ID} blob 6\nworld!\n`)
    for (let offset = 0; offset < wire.length; offset += 3) {
      processes[0]!.stdout.write(wire.subarray(offset, offset + 3))
      await tick()
    }
    assert.deepEqual(await first, Buffer.from('hello'))
    assert.deepEqual(await second, Buffer.from('world!'))
    assert.equal(processes.length, 1)
    reader.close()
  })

  it('reads null for a missing object, a non-blob and an oversized blob', async () => {
    const { processes, reader } = setup({ maxBlobBytes: 4, responseTimeoutMs: 1000 })
    const missing = reader.read(FIRST_ID)
    const tree = reader.read(SECOND_ID)
    const oversized = reader.read(THIRD_ID)
    const after = reader.read(FIRST_ID)
    processes[0]!.stdout.write(`${FIRST_ID} missing\n${SECOND_ID} tree 10\n0123456789\n${THIRD_ID} blob 10\n0123`)
    await tick()
    processes[0]!.stdout.write(`456789\n${FIRST_ID} blob 2\nok\n`)
    assert.equal(await missing, null)
    assert.equal(await tree, null)
    assert.equal(await oversized, null)
    assert.deepEqual(await after, Buffer.from('ok'))
    reader.close()
  })

  it('rejects pending reads when the process exits and restarts on the next read', async () => {
    const { processes, reader } = setup()
    const pending = reader.read(FIRST_ID)
    processes[0]!.emit('exit', 1)
    await assert.rejects(pending, /^Error: git cat-file stopped/)
    const next = reader.read(SECOND_ID)
    assert.equal(processes.length, 2)
    processes[1]!.stdout.write(`${SECOND_ID} blob 1\nx\n`)
    assert.deepEqual(await next, Buffer.from('x'))
    reader.close()
  })

  it('forgets a process that exits with nothing pending', async () => {
    const { processes, reader } = setup()
    const first = reader.read(FIRST_ID)
    processes[0]!.stdout.write(`${FIRST_ID} blob 1\nx\n`)
    await first
    processes[0]!.emit('exit', 0)
    const next = reader.read(SECOND_ID)
    assert.equal(processes.length, 2)
    processes[1]!.stdout.write(`${SECOND_ID} blob 1\ny\n`)
    assert.deepEqual(await next, Buffer.from('y'))
    reader.close()
  })

  it('times out a silent process', async () => {
    const { processes, reader } = setup({ maxBlobBytes: 1000, responseTimeoutMs: 20 })
    await assert.rejects(reader.read(FIRST_ID), /^Error: git cat-file stopped/)
    assert.equal(processes[0]!.killed, true)
  })

  it('does not time out while idle', async () => {
    const { processes, reader } = setup({ maxBlobBytes: 1000, responseTimeoutMs: 20 })
    const pending = reader.read(FIRST_ID)
    processes[0]!.stdout.write(`${FIRST_ID} blob 1\nx\n`)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(processes[0]!.killed, false)
    reader.close()
  })

  it('refuses an invalid id without writing', async () => {
    const { processes, reader } = setup()
    await assert.rejects(reader.read('HEAD'), InvalidObjectIdError)
    assert.equal(processes.length, 0)
  })

  it('close kills the process and rejects pending reads', async () => {
    const { processes, reader } = setup()
    const pending = reader.read(FIRST_ID)
    reader.close()
    assert.equal(processes[0]!.killed, true)
    await assert.rejects(pending, /^Error: git cat-file stopped/)
  })

  it('refuses reads after close without starting a process', async () => {
    const { processes, reader } = setup()
    const first = reader.read(FIRST_ID)
    processes[0]!.stdout.write(`${FIRST_ID} missing\n`)
    assert.equal(await first, null)
    reader.close()
    await assert.rejects(reader.read(SECOND_ID), /^Error: git cat-file stopped: closed/)
    assert.equal(processes.length, 1)
  })

  for (const header of ['blob abc', 'blob', 'blob -3', 'blob 1.5', 'blob 99999999999999999999']) {
    it(`fails the process on the malformed header "${header}"`, async () => {
      const { processes, reader } = setup()
      const pending = reader.read(FIRST_ID)
      processes[0]!.stdout.write(`${FIRST_ID} ${header}\nhello\n`)
      await assert.rejects(pending, /^Error: git cat-file stopped: malformed response/)
      assert.equal(processes[0]!.killed, true)
    })
  }

  it('fails the process on output nobody asked for', async () => {
    const { processes, reader } = setup()
    const pending = reader.read(FIRST_ID)
    processes[0]!.stdout.write(`${FIRST_ID} blob 1\nx\n${SECOND_ID} blob 1\ny\n`)
    assert.deepEqual(await pending, Buffer.from('x'))
    await tick()
    assert.equal(processes[0]!.killed, true)
  })

  it('fails the process on an endless header line', async () => {
    const { processes, reader } = setup()
    const pending = reader.read(FIRST_ID)
    processes[0]!.stdout.write('x'.repeat(2000))
    await assert.rejects(pending, /malformed response/)
  })

  it('times out stalled reads although new reads keep arriving', async () => {
    const { reader } = setup({ maxBlobBytes: 1000, responseTimeoutMs: 60 })
    const first = reader.read(FIRST_ID)
    const outcome = first.then(
      () => 'resolved',
      () => 'rejected',
    )
    const feeder = setInterval(() => void reader.read(SECOND_ID).catch(() => undefined), 20)
    const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('still pending'), 300))])
    clearInterval(feeder)
    assert.equal(result, 'rejected')
    reader.close()
  })

  it('rejects pending reads when writing to stdin fails', async () => {
    const { processes, reader } = setup()
    const pending = reader.read(FIRST_ID)
    processes[0]!.stdin.emit('error', new Error('write EPIPE'))
    await assert.rejects(pending, /^Error: git cat-file stopped: write EPIPE/)
    assert.equal(processes[0]!.killed, true)
  })
})
