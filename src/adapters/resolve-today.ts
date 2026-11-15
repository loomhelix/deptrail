import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { posix } from 'node:path'
import { processSecrets } from '../config/secrets.ts'
import type { RootDescriptor } from '../model.ts'
import type { FileReader } from '../sources/file-reader.ts'
import type { CommandRunner } from './command-runner.ts'

type ResolvedManager = 'pnpm' | 'npm'
export type ResolveTodayResult = { manager: ResolvedManager; lockfileText: string } | { error: string }

const STDERR_TAIL_LENGTH = 400
const activeTempDirs = new Set<string>()

const INSTALL_COMMANDS: Record<ResolvedManager, { args: string[]; lockfile: string }> = {
  pnpm: { args: ['install', '--lockfile-only', '--ignore-scripts'], lockfile: 'pnpm-lock.yaml' },
  npm: { args: ['install', '--package-lock-only', '--ignore-scripts'], lockfile: 'package-lock.json' },
}

function describeFailure(command: string, args: string[], detail: string): string {
  const text = `${command} ${args.join(' ')} failed`
  return detail ? `${text}: ${detail}` : text
}

function stderrTail(stderr: string): string {
  return processSecrets.redact(stderr).trim().slice(-STDERR_TAIL_LENGTH)
}

async function copyFromReader(reader: FileReader, repoPath: string, tempDir: string, rootRelativePath: string) {
  const text = await reader.readText(repoPath)
  if (text === null) return
  const target = path.join(tempDir, ...rootRelativePath.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

async function stageRoot(reader: FileReader, root: RootDescriptor, tempDir: string) {
  const manifestPaths = root.importerPaths.map((importerPath) => {
    const rootRelative = posix.relative(root.path, importerPath) || '.'
    return {
      repoPath: posix.join(importerPath, 'package.json'),
      rootRelativePath: posix.join(rootRelative, 'package.json'),
    }
  })
  const rootFiles = ['.npmrc', 'pnpm-workspace.yaml'].map((name) => ({
    repoPath: posix.join(root.path, name),
    rootRelativePath: name,
  }))
  for (const file of [...manifestPaths, ...rootFiles]) {
    await copyFromReader(reader, file.repoPath, tempDir, file.rootRelativePath)
  }
}

async function pnpmIsAvailable(runner: CommandRunner, cwd: string): Promise<boolean> {
  try {
    return (await runner('pnpm', ['--version'], cwd)).code === 0
  } catch {
    return false
  }
}

async function chooseManager(root: RootDescriptor, runner: CommandRunner, cwd: string): Promise<ResolvedManager> {
  if (root.manager === 'pnpm') return 'pnpm'
  if (root.manager === 'npm') return 'npm'
  return (await pnpmIsAvailable(runner, cwd)) ? 'pnpm' : 'npm'
}

async function runInstall(manager: ResolvedManager, runner: CommandRunner, tempDir: string): Promise<ResolveTodayResult> {
  const { args, lockfile } = INSTALL_COMMANDS[manager]
  try {
    const result = await runner(manager, args, tempDir)
    if (result.code !== 0) return { error: describeFailure(manager, args, stderrTail(result.stderr)) }
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code
    return { error: describeFailure(manager, args, code === 'ENOENT' ? `${manager} was not found` : 'could not be started') }
  }
  try {
    return { manager, lockfileText: await readFile(path.join(tempDir, lockfile), 'utf8') }
  } catch {
    return { error: describeFailure(manager, args, `${lockfile} was not produced`) }
  }
}

function removeTempDir(tempDir: string): Promise<void> {
  activeTempDirs.delete(tempDir)
  return rm(tempDir, { recursive: true, force: true })
}

export async function removeResolveTempDirs(): Promise<void> {
  await Promise.all([...activeTempDirs].map(removeTempDir))
}

export async function resolveToday(
  reader: FileReader,
  root: RootDescriptor,
  runner: CommandRunner,
): Promise<ResolveTodayResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'deptrail-'))
  activeTempDirs.add(tempDir)
  try {
    await stageRoot(reader, root, tempDir)
    const manager = await chooseManager(root, runner, tempDir)
    return await runInstall(manager, runner, tempDir)
  } finally {
    await removeTempDir(tempDir)
  }
}
