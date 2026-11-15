#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createActionService, type ActionService } from '../actions/action-service.ts'
import { createProcessRunner, spawnRunner } from '../adapters/command-runner.ts'
import { removeResolveTempDirs } from '../adapters/resolve-today.ts'
import { serializeScan } from '../graph/serialize.ts'
import { userNpmrcPath } from '../config/npmrc.ts'
import { processSecrets } from '../config/secrets.ts'
import { createEnrichmentCache } from '../enrich/enrichment-cache.ts'
import { createEnrichmentService, type EnrichmentService } from '../enrich/enrichment-service.ts'
import { createHttpClient } from '../enrich/http.ts'
import { OSV_DEFAULT_URL } from '../enrich/osv-client.ts'
import { createScanCache } from '../scan/scan-cache.ts'
import { killGitProcesses } from '../git/git-process.ts'
import { isGitRepository, openGitRepository, type GitRepository, type GitUnavailable } from '../git/git-repository.ts'
import { startScanSession, type ScanSession, type ScanSessionOptions } from '../scan/scan-session.ts'
import { createSourceRegistry, type SourceRegistry } from '../scan/source-registry.ts'
import { createBranches } from '../server/branches.ts'
import { startServer } from '../server/server.ts'
import { createFsReader, type FileReader } from '../sources/file-reader.ts'
import { createGitReader } from '../sources/git-reader.ts'
import { openBrowser } from './open-browser.ts'
import { readPackageVersion } from './package-version.ts'
import { USAGE_HINT, USAGE_TEXT } from './usage-text.ts'

export type CliIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  openBrowser: (url: string) => void
}

const EXIT_OK = 0
const EXIT_PORT_IN_USE = 1
const EXIT_USAGE = 2

const OPTIONS = {
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  json: { type: 'boolean' },
  offline: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

type EnrichmentSetup = {
  reader: FileReader
  env: Record<string, string | undefined>
  userNpmrc: string | null
  cacheDir: string
  offline: boolean
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function readUserNpmrc(env: Record<string, string | undefined>): Promise<string | null> {
  try {
    return await readFile(userNpmrcPath(env, env.HOME ?? homedir()), 'utf8')
  } catch {
    return null
  }
}

function parsePort(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null
}

function startEnrichment(setup: EnrichmentSetup): EnrichmentService {
  const abort = new AbortController()
  return createEnrichmentService({
    reader: setup.reader,
    env: setup.env,
    userNpmrc: setup.userNpmrc,
    http: createHttpClient({ userAgent: `deptrail/${readPackageVersion()} node/${process.version}`, signal: abort.signal }),
    osvUrl: setup.env.DEPTRAIL_OSV_URL ?? OSV_DEFAULT_URL,
    cache: createEnrichmentCache(setup.cacheDir),
    secrets: processSecrets,
    offline: setup.offline,
    abort,
  })
}

async function openCommitSession(
  git: GitRepository | GitUnavailable,
  commit: string,
  sessionOptions: ScanSessionOptions,
  onRootPublished: () => void,
): Promise<ScanSession> {
  if (!isGitRepository(git)) throw new Error(git.unavailable)
  const index = await git.tree(commit)
  return startScanSession({
    ...sessionOptions,
    reader: createGitReader(index, (blobId) => git.readBlob(blobId)),
    useInstalled: false,
    expandNpmrcVariables: false,
    skippedSubmodules: index.submodules,
    onRootPublished,
  })
}

function waitForTermination(shutdown: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      shutdown().finally(resolve)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE_HINT}\n`)
    return EXIT_USAGE
  }
  if (parsed.values.help) {
    io.stdout(USAGE_TEXT)
    return EXIT_OK
  }
  if (parsed.values.version) {
    io.stdout(`${readPackageVersion()}\n`)
    return EXIT_OK
  }
  const port = parsePort(parsed.values.port)
  if (port === null) {
    io.stderr('Invalid --port: expected an integer between 0 and 65535\n')
    return EXIT_USAGE
  }
  const repoPath = path.resolve(parsed.positionals[0] ?? '.')
  if (!(await isDirectory(repoPath))) {
    io.stderr(`Not a directory: ${repoPath}\n`)
    return EXIT_USAGE
  }

  const reader = createFsReader(repoPath)
  const userNpmrc = await readUserNpmrc(env)
  const cacheDir = env.DEPTRAIL_CACHE_DIR ?? path.join(homedir(), '.cache', 'deptrail')
  const sessionOptions: ScanSessionOptions = { repoPath, reader, runner: spawnRunner, cache: createScanCache(cacheDir), env, userNpmrc }

  if (parsed.values.json) {
    const session = await startScanSession(sessionOptions)
    await session.ready
    io.stdout(`${JSON.stringify(serializeScan(session.scan))}\n`)
    return EXIT_OK
  }

  const enrichment = startEnrichment({ reader, env, userNpmrc, cacheDir, offline: parsed.values.offline === true })
  let actions: ActionService | undefined
  let sources: SourceRegistry | undefined
  const session = await startScanSession({
    ...sessionOptions,
    onRootPublished: (roots) => {
      if (sources) sources.rootsChanged()
      else enrichment.track(roots)
      actions?.track(roots)
    },
  })
  const git = await openGitRepository({ cwd: repoPath, env, redact: (text) => processSecrets.redact(text) })
  const registry = createSourceRegistry({
    working: session,
    openSession: (commit) => openCommitSession(git, commit, sessionOptions, () => registry.rootsChanged()),
    onRootsChanged: (roots) => enrichment.track(roots),
  })
  sources = registry
  const closeGit = (): void => {
    registry.close()
    if (isGitRepository(git)) git.close()
    killGitProcesses()
  }
  const actionService = createActionService({
    repoPath,
    session,
    enrichment,
    runner: createProcessRunner(),
    env,
    offline: parsed.values.offline === true,
    secrets: processSecrets,
  })
  actions = actionService
  actionService.track(session.scan.roots)

  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({
      session,
      enrichment,
      actions: actionService,
      branches: createBranches(git, registry),
      port,
      staticDir: fileURLToPath(new URL('../ui', import.meta.url)),
      errorStream: { write: io.stderr },
    })
  } catch (error) {
    enrichment.close()
    closeGit()
    await actionService.close()
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && port !== undefined && port !== 0) {
      io.stderr(`Port ${port} is in use\n`)
      return EXIT_PORT_IN_USE
    }
    throw error
  }
  io.stdout(`deptrail: ${server.url}\n`)
  if (!parsed.values['no-open']) io.openBrowser(server.url)
  await waitForTermination(async () => {
    enrichment.close()
    spawnRunner.killRunning()
    closeGit()
    await Promise.all([removeResolveTempDirs(), server.close(), actionService.close()])
  })
  return EXIT_OK
}

function isInvokedDirectly(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  main(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    openBrowser,
  }).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
