import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>
export type SpawnRunner = CommandRunner & { killRunning(): void }
export type SpawnRunnerOptions = { timeoutMs: number }
export type ProcessRequest = {
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
  signal?: AbortSignal
  onLine?: (line: string) => void
}
export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }
export type ProcessRunner = { run(request: ProcessRequest): Promise<ProcessResult>; killRunning(): void }

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const KILL_GRACE_MS = 5000
const TIMED_OUT_EXIT_CODE = 124
const NOT_STARTED_EXIT_CODE = 1

function terminate(child: ChildProcess): void {
  if (child.pid === undefined) return
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
}

export function createSpawnRunner(options: SpawnRunnerOptions): SpawnRunner {
  const running = new Set<ChildProcess>()

  const run: CommandRunner = (command, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, shell: false })
      running.add(child)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        terminate(child)
      }, options.timeoutMs)
      const settle = (): void => {
        clearTimeout(timer)
        running.delete(child)
      }
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
      child.on('error', (error) => {
        settle()
        reject(error)
      })
      child.on('close', (code) => {
        settle()
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        resolve({
          code: timedOut ? TIMED_OUT_EXIT_CODE : (code ?? 1),
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: timedOut ? `${stderr}\n${command} timed out after ${options.timeoutMs} ms` : stderr,
        })
      })
    })

  return Object.assign(run, {
    killRunning() {
      for (const child of running) terminate(child)
    },
  })
}

function createLineSplitter(onLine: ((line: string) => void) | undefined) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const emit = (line: string): void => onLine?.(line.endsWith('\r') ? line.slice(0, -1) : line)
  return {
    write(chunk: Buffer): string {
      const text = decoder.write(chunk)
      const parts = (pending + text).split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) emit(line)
      return text
    },
    flush(): void {
      const rest = pending + decoder.end()
      pending = ''
      if (rest !== '') emit(rest)
    },
  }
}

export function createProcessRunner(): ProcessRunner {
  const running = new Set<ChildProcess>()

  const run = (request: ProcessRequest): Promise<ProcessResult> => {
    if (request.signal?.aborted) return Promise.resolve({ code: NOT_STARTED_EXIT_CODE, stdout: '', stderr: '', timedOut: false, cancelled: true })
    return new Promise((resolve, reject) => {
      const child = spawn(request.command, [...request.args], { cwd: request.cwd, env: request.env, shell: false })
      running.add(child)
      let timedOut = false
      let cancelled = false
      const timer = setTimeout(() => {
        timedOut = true
        terminate(child)
      }, request.timeoutMs)
      const cancel = (): void => {
        cancelled = true
        terminate(child)
      }
      request.signal?.addEventListener('abort', cancel, { once: true })
      const settle = (): void => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', cancel)
        running.delete(child)
      }
      const stdoutSplitter = createLineSplitter(request.onLine)
      const stderrSplitter = createLineSplitter(request.onLine)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += stdoutSplitter.write(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += stderrSplitter.write(chunk)
      })
      child.on('error', (error) => {
        settle()
        reject(error)
      })
      child.on('close', (code) => {
        settle()
        stdoutSplitter.flush()
        stderrSplitter.flush()
        resolve({ code: timedOut ? TIMED_OUT_EXIT_CODE : (code ?? 1), stdout, stderr, timedOut, cancelled })
      })
    })
  }

  return {
    run,
    killRunning() {
      for (const child of running) terminate(child)
    },
  }
}

export const spawnRunner = createSpawnRunner({ timeoutMs: DEFAULT_TIMEOUT_MS })
