import type { Readable, Writable } from 'node:stream'
import { InvalidObjectIdError, isObjectId } from './git-commands.ts'

export type BlobProcess = {
  stdin: Writable
  stdout: Readable
  on(event: 'exit' | 'error', listener: (value: unknown) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}
export type BlobReaderLimits = { maxBlobBytes: number; responseTimeoutMs: number }
export type BlobReader = { read(blobId: string): Promise<Buffer | null>; close(): void }

type PendingRead = { resolve: (blob: Buffer | null) => void; reject: (error: Error) => void }

const NEWLINE = 0x0a
const STOPPED_PREFIX = 'git cat-file stopped: '
const BLOB_TYPE = 'blob'
const MISSING_MARKER = 'missing'
const SEPARATOR_BYTES = 1
const MAX_HEADER_BYTES = 512
const MALFORMED_RESPONSE = 'malformed response'
const DIGITS_ONLY = /^\d+$/

function describeExit(value: unknown): string {
  return typeof value === 'number' ? `exited with code ${value}` : 'exited'
}

export function createBlobReader(start: () => BlobProcess, limits: BlobReaderLimits): BlobReader {
  let current: BlobProcess | null = null
  let closed = false
  let pending: PendingRead[] = []
  let chunks: Buffer[] = []
  let bufferedBytes = 0
  let bodyBytes: number | null = null
  let bytesToSkip = 0
  let timer: NodeJS.Timeout | null = null

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const resetStream = (): void => {
    chunks = []
    bufferedBytes = 0
    bodyBytes = null
    bytesToSkip = 0
  }

  const fail = (reason: string): void => {
    const process = current
    const rejected = pending
    current = null
    pending = []
    clearTimer()
    resetStream()
    process?.kill('SIGTERM')
    const error = new Error(`${STOPPED_PREFIX}${reason}`)
    for (const read of rejected) read.reject(error)
  }

  const armTimer = (): void => {
    clearTimer()
    if (pending.length === 0) return
    timer = setTimeout(() => fail(`no response within ${limits.responseTimeoutMs} ms`), limits.responseTimeoutMs)
  }

  const settle = (blob: Buffer | null): void => {
    pending.shift()?.resolve(blob)
  }

  const skipBytes = (): void => {
    while (bytesToSkip > 0 && chunks.length > 0) {
      const head = chunks[0]!
      if (head.length <= bytesToSkip) {
        bytesToSkip -= head.length
        bufferedBytes -= head.length
        chunks.shift()
      } else {
        chunks[0] = head.subarray(bytesToSkip)
        bufferedBytes -= bytesToSkip
        bytesToSkip = 0
      }
    }
  }

  const keepRest = (rest: Buffer): void => {
    chunks = rest.length > 0 ? [rest] : []
    bufferedBytes = rest.length
  }

  const readHeader = (): boolean => {
    const merged = Buffer.concat(chunks)
    const newlineAt = merged.indexOf(NEWLINE)
    if (newlineAt < 0) {
      if (merged.length > MAX_HEADER_BYTES) fail(MALFORMED_RESPONSE)
      else keepRest(merged)
      return false
    }
    const fields = merged.toString('latin1', 0, newlineAt).split(' ')
    const [, type, sizeText] = fields
    const size = Number(sizeText)
    const isMissing = fields.length === 2 && type === MISSING_MARKER
    const isTyped = fields.length === 3 && DIGITS_ONLY.test(sizeText ?? '') && Number.isSafeInteger(size)
    if (pending.length === 0 || (!isMissing && !isTyped)) {
      fail(MALFORMED_RESPONSE)
      return false
    }
    keepRest(merged.subarray(newlineAt + SEPARATOR_BYTES))
    if (isMissing) {
      settle(null)
      return true
    }
    if (type === BLOB_TYPE && size <= limits.maxBlobBytes) {
      bodyBytes = size
      return true
    }
    settle(null)
    bytesToSkip = size + SEPARATOR_BYTES
    return true
  }

  const readBody = (size: number): boolean => {
    if (bufferedBytes < size + SEPARATOR_BYTES) return false
    const merged = Buffer.concat(chunks)
    const body = Buffer.from(merged.subarray(0, size))
    keepRest(merged.subarray(size + SEPARATOR_BYTES))
    bodyBytes = null
    settle(body)
    return true
  }

  const drain = (): void => {
    for (;;) {
      skipBytes()
      if (bytesToSkip > 0 || bufferedBytes === 0) return
      const progressed = bodyBytes === null ? readHeader() : readBody(bodyBytes)
      if (!progressed) return
    }
  }

  const receive = (chunk: Buffer): void => {
    chunks.push(chunk)
    bufferedBytes += chunk.length
    drain()
    armTimer()
  }

  const launch = (): BlobProcess => {
    const process = start()
    current = process
    process.stdin.on('error', (error) => {
      if (current === process) fail(error.message)
    })
    process.stdout.on('data', (chunk: Buffer) => {
      if (current === process) receive(chunk)
    })
    process.on('exit', (code) => {
      if (current !== process) return
      if (pending.length > 0) fail(describeExit(code))
      else current = null
    })
    process.on('error', (error) => {
      if (current !== process) return
      if (pending.length > 0) fail(error instanceof Error ? error.message : 'process error')
      else current = null
    })
    return process
  }

  return {
    read(blobId) {
      return new Promise<Buffer | null>((resolve, reject) => {
        if (!isObjectId(blobId)) throw new InvalidObjectIdError(blobId)
        if (closed) throw new Error(`${STOPPED_PREFIX}closed`)
        const process = current ?? launch()
        const wasIdle = pending.length === 0
        pending.push({ resolve, reject })
        if (wasIdle) armTimer()
        process.stdin.write(`${blobId}\n`)
      })
    },
    close() {
      closed = true
      fail('closed')
    },
  }
}
