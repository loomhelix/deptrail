import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

export type GitSpawnOptions = { cwd: string; env: Record<string, string>; shell: false; stdio: ['pipe', 'pipe', 'pipe'] }
export type GitSpawn = (command: 'git', args: readonly string[], options: GitSpawnOptions) => ChildProcess
export type GitProcessOptions = { cwd: string; env: Record<string, string | undefined>; spawn?: GitSpawn }
export type GitResult = { code: number; stdout: Buffer; stderr: string }
export type GitFailureKind = 'not-found' | 'timeout' | 'too-large' | 'spawn'

export class GitFailure extends Error {
  readonly kind: GitFailureKind

  constructor(kind: GitFailureKind, message: string) {
    super(message)
    this.name = 'GitFailure'
    this.kind = kind
  }
}

const GIT_VARIABLE_PREFIX = 'GIT_'
const BYTES_PER_MEGABYTE = 1024 * 1024
const MILLISECONDS_PER_SECOND = 1000
const NOT_STARTED_EXIT_CODE = 1
const FIXED_GIT_ENVIRONMENT = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' }

const running = new Set<ChildProcess>()

const defaultSpawn: GitSpawn = (command, args, options) => nodeSpawn(command, [...args], options)

export function gitEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const cleaned: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith(GIT_VARIABLE_PREFIX)) cleaned[name] = value
  }
  return { ...cleaned, ...FIXED_GIT_ENVIRONMENT }
}

export function startGit(options: GitProcessOptions, args: readonly string[]): ChildProcess {
  const spawn = options.spawn ?? defaultSpawn
  const child = spawn('git', args, { cwd: options.cwd, env: gitEnvironment(options.env), shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  running.add(child)
  child.once('close', () => running.delete(child))
  child.once('error', () => running.delete(child))
  return child
}

export function runGit(options: GitProcessOptions, args: readonly string[], limits: { timeoutMs: number; maxBytes: number }): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = startGit(options, args)
    child.stdin?.on('error', () => undefined)
    child.stdin?.end()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let finished = false
    const finish = (settleOutcome: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      running.delete(child)
      settleOutcome()
    }
    const abort = (failure: GitFailure): void =>
      finish(() => {
        child.kill('SIGTERM')
        reject(failure)
      })
    const timer = setTimeout(
      () => abort(new GitFailure('timeout', `git did not finish within ${limits.timeoutMs / MILLISECONDS_PER_SECOND} s`)),
      limits.timeoutMs,
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > limits.maxBytes) {
        abort(new GitFailure('too-large', `git output exceeded ${limits.maxBytes / BYTES_PER_MEGABYTE} MB`))
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(() => reject(error.code === 'ENOENT' ? new GitFailure('not-found', 'git was not found') : new GitFailure('spawn', error.message))),
    )
    child.on('close', (code) =>
      finish(() =>
        resolve({ code: code ?? NOT_STARTED_EXIT_CODE, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks).toString('utf8') }),
      ),
    )
  })
}

export function killGitProcesses(): void {
  for (const child of running) child.kill('SIGTERM')
}
