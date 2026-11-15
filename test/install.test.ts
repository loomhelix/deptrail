import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProcessRunner } from '../src/adapters/command-runner.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import { runFrozenInstall } from '../src/actions/install.ts'
import { installFakePackageManager } from './helpers/fake-package-manager.ts'

const tempDirs: string[] = []

async function setup(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-install-test-'))
  tempDirs.push(dir)
  const rootDir = path.join(dir, 'root')
  await (await import('node:fs/promises')).mkdir(rootDir)
  const fake = await installFakePackageManager(dir, 'pnpm')
  const lines: string[] = []
  const secrets = createSecretSet()
  const base = {
    manager: 'pnpm' as const,
    rootDir,
    runner: createProcessRunner(),
    env: fake.env(extra),
    secrets,
    signal: new AbortController().signal,
    onLine: (line: string) => lines.push(line),
  }
  return { fake, lines, secrets, rootDir, base }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('runFrozenInstall', () => {
  it('runs the frozen install in the root and streams its lines', async () => {
    const { base, fake, lines, rootDir } = await setup({ DEPTRAIL_FAKE_PM_LINES: '3' })
    assert.deepEqual(await runFrozenInstall(base), { ok: true })
    const runs = await fake.runs()
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]?.args, ['install', '--frozen-lockfile'])
    assert.equal(await (await import('node:fs/promises')).realpath(runs[0]?.cwd ?? ''), await (await import('node:fs/promises')).realpath(rootDir))
    assert.deepEqual(lines, ['line 1', 'line 2', 'line 3'])
  })

  it('reports a non-zero exit', async () => {
    const { base } = await setup({ DEPTRAIL_FAKE_PM_EXIT: '3' })
    assert.deepEqual(await runFrozenInstall(base), { ok: false, reason: 'pnpm install --frozen-lockfile exited with code 3', cancelled: false })
  })

  it('reports a missing package manager', async () => {
    const { base } = await setup()
    assert.deepEqual(await runFrozenInstall({ ...base, env: { PATH: '/nonexistent' } }), { ok: false, reason: 'pnpm was not found', cancelled: false })
  })

  it('reports cancellation', async () => {
    const controller = new AbortController()
    const { base } = await setup({ DEPTRAIL_FAKE_PM_SLEEP_MS: '10000' })
    const pending = runFrozenInstall({ ...base, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    assert.deepEqual(await pending, { ok: false, reason: 'canceled', cancelled: true })
  })

  it('redacts secrets from streamed lines', async () => {
    const { base, secrets, lines } = await setup({ DEPTRAIL_FAKE_PM_STDOUT: 'token canary-secret-value here' })
    secrets.add('canary-secret-value')
    await runFrozenInstall(base)
    assert.deepEqual(lines, ['token [redacted] here'])
  })
})
