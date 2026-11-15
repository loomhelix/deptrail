import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsReader } from '../src/sources/file-reader.ts'
import type { RootDescriptor } from '../src/model.ts'
import type { CommandRunner } from '../src/adapters/command-runner.ts'
import { processSecrets } from '../src/config/secrets.ts'
import { removeResolveTempDirs, resolveToday } from '../src/adapters/resolve-today.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const monolithPath = path.join(testDir, 'fixtures', 'monolith')
const pnpmFixturePath = path.join(testDir, 'fixtures', 'pnpm', 'v9-workspace.yaml')

const apiRoot: RootDescriptor = {
  id: 'services/api',
  path: 'services/api',
  manager: 'pnpm',
  importerPaths: ['services/api'],
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name)
      return entry.isDirectory() ? listFiles(full) : [full]
    }),
  )
  return nested.flat().sort()
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of await listFiles(directory)) {
    hash.update(path.relative(directory, file))
    hash.update(await readFile(file))
  }
  return hash.digest('hex')
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

type Call = { command: string; args: string[]; cwd: string }

function recordingRunner(handler: (call: Call) => Promise<{ code: number; stdout?: string; stderr?: string }>) {
  const calls: Call[] = []
  const runner: CommandRunner = async (command, args, cwd) => {
    const call = { command, args, cwd }
    calls.push(call)
    const result = await handler(call)
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { runner, calls }
}

const pnpmWritingRunner = () =>
  recordingRunner(async ({ command, args, cwd }) => {
    if (args[0] === '--version') return { code: 0, stdout: '10.0.0' }
    const lockName = command === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'
    await writeFile(path.join(cwd, lockName), await readFile(pnpmFixturePath, 'utf8'))
    return { code: 0 }
  })

describe('resolveToday', () => {
  it('returns the lockfile text produced by pnpm and leaves the repository untouched', async () => {
    const before = await hashDirectory(monolithPath)
    const { runner, calls } = pnpmWritingRunner()
    const result = await resolveToday(createFsReader(monolithPath), apiRoot, runner)
    assert.deepEqual(result, { manager: 'pnpm', lockfileText: await readFile(pnpmFixturePath, 'utf8') })
    assert.deepEqual(calls[0]?.args, ['install', '--lockfile-only', '--ignore-scripts'])
    assert.equal(await hashDirectory(monolithPath), before)
  })

  it('stages manifests and workspace files in the temp directory and removes it afterwards', async () => {
    let staged: string[] = []
    const { runner, calls } = recordingRunner(async ({ cwd }) => {
      staged = (await listFiles(cwd)).map((file) => path.relative(cwd, file).split(path.sep).join('/'))
      await writeFile(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
      return { code: 0 }
    })
    await resolveToday(createFsReader(monolithPath), apiRoot, runner)
    assert.deepEqual(staged, ['package.json', 'pnpm-workspace.yaml'])
    assert.equal(await exists(calls[0]!.cwd), false)
  })

  it('preserves workspace layout for nested importers', async () => {
    const workspaceRoot: RootDescriptor = {
      id: 'npm-package',
      path: 'npm-package',
      manager: 'pnpm',
      importerPaths: ['npm-package', 'npm-package/commerce-ui'],
    }
    let staged: string[] = []
    const { runner } = recordingRunner(async ({ cwd }) => {
      staged = (await listFiles(cwd)).map((file) => path.relative(cwd, file).split(path.sep).join('/'))
      await writeFile(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
      return { code: 0 }
    })
    await resolveToday(createFsReader(monolithPath), workspaceRoot, runner)
    assert.ok(staged.includes('package.json'))
    assert.ok(staged.includes('commerce-ui/package.json'))
    assert.ok(staged.includes('.npmrc'))
    assert.ok(staged.includes('pnpm-workspace.yaml'))
  })

  it('reports a missing pnpm binary without falling back to npm', async () => {
    const { runner, calls } = recordingRunner(async () => {
      throw Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' })
    })
    const result = await resolveToday(createFsReader(monolithPath), apiRoot, runner)
    assert.ok('error' in result && result.error.includes('pnpm'))
    assert.deepEqual(
      calls.map((call) => call.command),
      ['pnpm'],
    )
    assert.equal(await exists(calls[0]!.cwd), false)
  })

  it('reports a non-zero exit with the trimmed stderr and removes the temp directory', async () => {
    const { runner, calls } = recordingRunner(async () => ({ code: 1, stderr: '  ERR_PNPM_NO_MATCHING_VERSION boom \n' }))
    const result = await resolveToday(createFsReader(monolithPath), apiRoot, runner)
    assert.ok('error' in result)
    assert.ok(result.error.includes('pnpm install'))
    assert.ok(result.error.endsWith('ERR_PNPM_NO_MATCHING_VERSION boom'))
    assert.equal(await exists(calls[0]!.cwd), false)
  })

  it('redacts credentials echoed by the package manager before they reach the error text', async () => {
    const secret = 'fixture-secret-token'
    const stderr = `fetch https://ci:${secret}@registry.example.test/left-pad failed\n//registry.example.test/:_authToken=${secret}`
    const { runner } = recordingRunner(async () => ({ code: 1, stderr }))
    const result = await resolveToday(createFsReader(monolithPath), { ...apiRoot, importerPaths: ['npm-package'], path: 'npm-package' }, runner)
    assert.ok('error' in result)
    assert.equal(result.error.includes(secret), false)
    assert.equal(result.error.includes(`_authToken=${secret}`), false)
    assert.ok(result.error.includes('registry.example.test'))
  })

  it('redacts known secrets that appear as plain text in stderr', async () => {
    processSecrets.add('canary-secret-2')
    const stderr = 'fetch https://r.example/canary-secret-2/pkg failed'
    const { runner } = recordingRunner(async () => ({ code: 1, stderr }))
    const result = await resolveToday(createFsReader(monolithPath), { ...apiRoot, importerPaths: ['npm-package'], path: 'npm-package' }, runner)
    assert.ok('error' in result)
    assert.equal(result.error.includes('canary-secret-2'), false)
    assert.ok(result.error.includes('r.example'))
  })

  it('removes the temp directory when the runner throws', async () => {
    const { runner, calls } = recordingRunner(async () => {
      throw new Error('exploded')
    })
    const result = await resolveToday(createFsReader(monolithPath), apiRoot, runner)
    assert.ok('error' in result)
    assert.equal(await exists(calls[0]!.cwd), false)
  })

  it('removes the temp directory of a resolve that is still running on shutdown', async () => {
    let stagedDir = ''
    let releaseInstall: () => void = () => {}
    const installStarted = new Promise<void>((started) => {
      const { runner } = recordingRunner(async ({ cwd }) => {
        stagedDir = cwd
        started()
        await new Promise<void>((release) => (releaseInstall = release))
        return { code: 1 }
      })
      void resolveToday(createFsReader(monolithPath), apiRoot, runner).then(() => undefined)
    })
    await installStarted
    assert.equal(await exists(path.join(stagedDir, 'package.json')), true)
    await removeResolveTempDirs()
    assert.equal(await exists(stagedDir), false)
    releaseInstall()
  })

  it('uses pnpm for an unknown root when pnpm is available', async () => {
    const { runner, calls } = pnpmWritingRunner()
    const result = await resolveToday(createFsReader(monolithPath), { ...apiRoot, manager: 'unknown' }, runner)
    assert.ok('lockfileText' in result && result.manager === 'pnpm')
    assert.deepEqual(calls.map((call) => call.command), ['pnpm', 'pnpm'])
  })

  it('falls back to npm for an unknown root without pnpm', async () => {
    const { runner, calls } = recordingRunner(async ({ command, args, cwd }) => {
      if (command === 'pnpm') throw Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' })
      assert.deepEqual(args, ['install', '--package-lock-only', '--ignore-scripts'])
      await writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3}')
      return { code: 0 }
    })
    const result = await resolveToday(createFsReader(monolithPath), { ...apiRoot, manager: 'unknown' }, runner)
    assert.deepEqual(result, { manager: 'npm', lockfileText: '{"lockfileVersion":3}' })
    assert.deepEqual(calls.map((call) => call.command), ['pnpm', 'npm'])
  })

  it('uses npm for an npm root', async () => {
    const { runner, calls } = recordingRunner(async ({ cwd }) => {
      await writeFile(path.join(cwd, 'package-lock.json'), '{}')
      return { code: 0 }
    })
    const result = await resolveToday(createFsReader(monolithPath), { ...apiRoot, manager: 'npm' }, runner)
    assert.deepEqual(result, { manager: 'npm', lockfileText: '{}' })
    assert.deepEqual(calls.map((call) => call.command), ['npm'])
  })
})
