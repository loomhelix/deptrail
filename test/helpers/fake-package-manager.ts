import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PackageManagerName } from '../../src/actions/types.ts'

export type FakeManagerRun = { args: string[]; cwd: string; files: Record<string, string | null> }

export type FakeManager = {
  binDir: string
  logFile: string
  env(extra?: Record<string, string>): Record<string, string | undefined>
  runs(): Promise<FakeManagerRun[]>
}

const LOCKFILE_NAMES: Record<PackageManagerName, string> = { pnpm: 'pnpm-lock.yaml', npm: 'package-lock.json' }
export const FAKE_MANAGER_VERSIONS: Record<PackageManagerName, string> = { pnpm: '10.34.3', npm: '11.6.2' }

function fakeScript(lockfileName: string, defaultVersion: string): string {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    `const lockfileName = ${JSON.stringify(lockfileName)}`,
    `const defaultVersion = ${JSON.stringify(defaultVersion)}`,
    'const args = process.argv.slice(2)',
    'const env = process.env',
    "if (args[0] === '--version') {",
    "  process.stdout.write((env.DEPTRAIL_FAKE_PM_VERSION || defaultVersion) + '\\n')",
    '} else {',
    '  const cwd = process.cwd()',
    '  const readOrNull = (name) => {',
    '    try {',
    "      return fs.readFileSync(path.join(cwd, name), 'utf8')",
    '    } catch {',
    '      return null',
    '    }',
    '  }',
    '  const files = {}',
    "  for (const name of ['package.json', 'pnpm-workspace.yaml', lockfileName]) files[name] = readOrNull(name)",
    '  let run = 0',
    '  if (env.DEPTRAIL_FAKE_PM_LOG) {',
    "    const logged = fs.existsSync(env.DEPTRAIL_FAKE_PM_LOG) ? fs.readFileSync(env.DEPTRAIL_FAKE_PM_LOG, 'utf8') : ''",
    "    run = logged.split('\\n').filter((line) => line !== '').length",
    "    fs.appendFileSync(env.DEPTRAIL_FAKE_PM_LOG, JSON.stringify({ args, cwd, files }) + '\\n')",
    '  }',
    "  const lockfiles = JSON.parse(env.DEPTRAIL_FAKE_PM_LOCKFILES || '[]')",
    '  if (lockfiles.length > 0) fs.copyFileSync(lockfiles[Math.min(run, lockfiles.length - 1)], path.join(cwd, lockfileName))',
    '  const lineCount = Number(env.DEPTRAIL_FAKE_PM_LINES || 0)',
    "  for (let index = 1; index <= lineCount; index++) process.stdout.write('line ' + index + '\\n')",
    "  if (env.DEPTRAIL_FAKE_PM_STDOUT) process.stdout.write(env.DEPTRAIL_FAKE_PM_STDOUT + '\\n')",
    "  if (env.DEPTRAIL_FAKE_PM_STDERR) process.stderr.write(env.DEPTRAIL_FAKE_PM_STDERR + '\\n')",
    '  const exitCode = Number(env.DEPTRAIL_FAKE_PM_EXIT || 0)',
    '  setTimeout(() => {',
    '    process.exitCode = exitCode',
    '  }, Number(env.DEPTRAIL_FAKE_PM_SLEEP_MS || 0))',
    '}',
    '',
  ].join('\n')
}

export async function installFakePackageManager(dir: string, name: PackageManagerName): Promise<FakeManager> {
  const binDir = path.join(dir, 'fake-bin')
  const logFile = path.join(dir, `fake-${name}-runs.jsonl`)
  await mkdir(binDir, { recursive: true })
  const executable = path.join(binDir, name)
  await writeFile(executable, fakeScript(LOCKFILE_NAMES[name], FAKE_MANAGER_VERSIONS[name]))
  await chmod(executable, 0o755)
  return {
    binDir,
    logFile,
    env(extra = {}) {
      return { ...process.env, PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter), DEPTRAIL_FAKE_PM_LOG: logFile, ...extra }
    },
    async runs() {
      const text = await readFile(logFile, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeManagerRun)
    },
  }
}
