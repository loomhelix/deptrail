import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProcessRunner } from '../src/adapters/command-runner.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import { FROZEN_INSTALL_ARGS, LOCKFILE_ONLY_ARGS, commandText, probeManager } from '../src/actions/recipes.ts'
import { hashSources, type FileScope } from '../src/actions/file-scope.ts'
import { createSandbox, removeActionSandboxes } from '../src/actions/sandbox.ts'

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'monolith', 'npm-package')
const IMPORTER_PATHS = ['.', 'commerce-ui', 'storefront', 'tools/build']
const PNPM = { name: 'pnpm', version: '10.34.3' } as const
const NPM = { name: 'npm', version: '11.19.0' } as const
const tempDirs: string[] = []

function scopeOf(root: string, outsideManifests: readonly string[] = []): FileScope {
  return { rootDir: root, repoDir: path.dirname(root), outsideManifests }
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-sandbox-test-'))
  tempDirs.push(dir)
  return dir
}

async function writeRelative(root: string, relative: string, text: string) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

async function prepareRoot(): Promise<string> {
  const parent = await makeTempDir()
  const root = path.join(parent, 'root')
  await cp(fixturePath, root, { recursive: true })
  await writeRelative(root, 'patches/x.patch', 'patch x\n')
  await writeRelative(root, '.pnpmfile.cjs', 'module.exports = {}\n')
  await writeRelative(root, 'hooks/extra.cjs', 'module.exports = {}\n')
  await writeRelative(parent, 'outside.patch', 'outside\n')
  await writeRelative(root, '.npmrc', 'pnpmfile=hooks/extra.cjs\nregistry=https://registry.example.test/\n')
  const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
  await writeFile(
    path.join(root, 'pnpm-workspace.yaml'),
    `${workspace}patchedDependencies:\n  left-pad@1.0.0: patches/x.patch\n  escape@1.0.0: ../outside.patch\n`,
  )
  return root
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

afterEach(async () => {
  await removeActionSandboxes()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

describe('action sandbox', () => {
  it('copies manifests, configuration, the lockfile, pnpmfiles and patches but nothing outside the root', async () => {
    const root = await prepareRoot()
    const sandbox = await createSandbox({ scope: scopeOf(root), manager: PNPM, importerPaths: IMPORTER_PATHS, lockfile: 'pnpm-lock.yaml' })
    const copied = ['package.json', 'commerce-ui/package.json', 'storefront/package.json', 'tools/build/package.json', '.npmrc', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.pnpmfile.cjs', 'hooks/extra.cjs', 'patches/x.patch']
    for (const relative of copied) {
      assert.equal(await readFile(path.join(sandbox.dir, relative), 'utf8'), await readFile(path.join(root, relative), 'utf8'), relative)
    }
    assert.equal(await exists(path.join(sandbox.dir, '..', 'outside.patch')), false)
    assert.equal(await exists(path.join(sandbox.dir, '.pnpmfile.mjs')), false)
    assert.equal((await stat(sandbox.dir)).mode & 0o777, 0o700)
    assert.equal(sandbox.sources.get('patches/x.patch'), sha256('patch x\n'))
    assert.equal(sandbox.sources.get('.pnpmfile.mjs'), null)
    assert.equal(sandbox.sources.get('../outside.patch'), undefined)
  })

  it('does not copy a path whose realpath leaves the root', async () => {
    const root = await prepareRoot()
    await symlinkOutside(root)
    const sandbox = await createSandbox({ scope: scopeOf(root), manager: PNPM, importerPaths: ['.'], lockfile: 'pnpm-lock.yaml' })
    assert.equal(await exists(path.join(sandbox.dir, '.pnpmfile.mjs')), false)
  })

  it('maps a missing pnpm-workspace.yaml to null and reads, writes and deletes sandbox files', async () => {
    const root = await prepareRoot()
    await rm(path.join(root, 'pnpm-workspace.yaml'))
    const sandbox = await createSandbox({ scope: scopeOf(root), manager: NPM, importerPaths: ['.'], lockfile: 'package-lock.json' })
    assert.equal(sandbox.sources.get('pnpm-workspace.yaml'), null)
    assert.equal(sandbox.sources.get('package-lock.json'), null)
    assert.equal(await sandbox.readText('package.json'), await readFile(path.join(root, 'package.json'), 'utf8'))
    await sandbox.writeText('nested/file.txt', 'text')
    assert.equal(await sandbox.readText('nested/file.txt'), 'text')
    await sandbox.deleteFile('nested/file.txt')
    assert.equal(await sandbox.readText('nested/file.txt'), null)
  })

  it('hashes the same paths in the repository', async () => {
    const root = await prepareRoot()
    const sandbox = await createSandbox({ scope: scopeOf(root), manager: PNPM, importerPaths: IMPORTER_PATHS, lockfile: 'pnpm-lock.yaml' })
    const hashes = await hashSources(scopeOf(root), [...sandbox.sources.keys()])
    assert.deepEqual([...hashes], [...sandbox.sources])
  })

  it('removes one sandbox and every live sandbox', async () => {
    const root = await prepareRoot()
    const request = { scope: scopeOf(root), manager: PNPM, importerPaths: ['.'], lockfile: 'pnpm-lock.yaml' }
    const first = await createSandbox(request)
    const second = await createSandbox(request)
    const third = await createSandbox(request)
    await first.remove()
    assert.equal(await exists(path.dirname(first.dir)), false)
    assert.equal(await exists(second.dir), true)
    await removeActionSandboxes()
    assert.equal(await exists(path.dirname(second.dir)), false)
    assert.equal(await exists(path.dirname(third.dir)), false)
  })

  it('nests the copy in a private directory that pins the probed manager when the root names none', async () => {
    const root = await prepareRoot()
    const sandbox = await createSandbox({ scope: scopeOf(root), manager: PNPM, importerPaths: ['.'], lockfile: 'pnpm-lock.yaml' })
    const tempDir = path.dirname(sandbox.dir)
    assert.equal(path.basename(sandbox.dir), 'root')
    assert.match(path.basename(tempDir), /^deptrail-action-/)
    assert.equal((await stat(tempDir)).mode & 0o777, 0o700)
    assert.equal((await stat(sandbox.dir)).mode & 0o777, 0o700)
    assert.deepEqual(JSON.parse(await readFile(path.join(tempDir, 'package.json'), 'utf8')), { private: true, packageManager: 'pnpm@10.34.3' })
    assert.equal(await sandbox.readText('package.json'), await readFile(path.join(root, 'package.json'), 'utf8'))
    await sandbox.remove()
    assert.equal(await exists(tempDir), false)
  })

  it('adds no pin when the root names its package manager', async () => {
    const root = await prepareRoot()
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ ...manifest, packageManager: 'pnpm@9.15.0' }, null, 2)}\n`)
    const sandbox = await createSandbox({ scope: scopeOf(root), manager: PNPM, importerPaths: ['.'], lockfile: 'pnpm-lock.yaml' })
    assert.equal(await exists(path.join(path.dirname(sandbox.dir), 'package.json')), false)
    assert.equal(JSON.parse((await sandbox.readText('package.json')) ?? '{}').packageManager, 'pnpm@9.15.0')
  })
})

describe('action sandbox with outside packages', () => {
  const OUTSIDE_MANIFEST = '../../libs/ui/package.json'
  const OUTSIDE_MANIFEST_TEXT = '{ "name": "ui" }\n'

  async function prepareRepository(): Promise<{ repo: string; root: string }> {
    const repo = await makeTempDir()
    const root = path.join(repo, 'apps', 'shop')
    await cp(fixturePath, root, { recursive: true })
    await writeRelative(repo, 'libs/ui/package.json', OUTSIDE_MANIFEST_TEXT)
    return { repo, root }
  }

  function request(repo: string, root: string, outsideManifests: readonly string[] = [OUTSIDE_MANIFEST]) {
    return {
      scope: { rootDir: root, repoDir: repo, outsideManifests },
      manager: PNPM,
      importerPaths: ['.', 'commerce-ui', '../../libs/ui'],
      lockfile: 'pnpm-lock.yaml',
    }
  }

  it('lays out outside packages at their place relative to the root', async () => {
    const { repo, root } = await prepareRepository()
    const sandbox = await createSandbox(request(repo, root))
    assert.ok(sandbox.dir.endsWith(path.join('root', 'apps', 'shop')))
    assert.equal(await readFile(path.join(sandbox.dir, '../../libs/ui/package.json'), 'utf8'), OUTSIDE_MANIFEST_TEXT)
    assert.equal(sandbox.sources.get(OUTSIDE_MANIFEST), sha256(OUTSIDE_MANIFEST_TEXT))
    await sandbox.writeText(OUTSIDE_MANIFEST, 'x')
    assert.equal(await sandbox.readText(OUTSIDE_MANIFEST), 'x')
    assert.equal((await stat(path.join(sandbox.dir, '../..'))).mode & 0o777, 0o700)
  })

  it('keeps the copy at root/ for a root without outside packages', async () => {
    const { repo, root } = await prepareRepository()
    const sandbox = await createSandbox({ ...request(repo, root, []), importerPaths: ['.'] })
    assert.equal(path.basename(sandbox.dir), 'root')
  })

  it('refuses a sandbox path that leaves the copy', async () => {
    const { repo, root } = await prepareRepository()
    const sandbox = await createSandbox(request(repo, root))
    await assert.rejects(sandbox.writeText('../../../x', 'y'), /Path leaves the sandbox/)
  })

  it('refuses an absolute sandbox path', async () => {
    const { repo, root } = await prepareRepository()
    const sandbox = await createSandbox(request(repo, root))
    await assert.rejects(sandbox.writeText('/etc/x', 'y'), /Path leaves the sandbox/)
  })

  it('does not copy a pnpmfile outside the root', async () => {
    const { repo, root } = await prepareRepository()
    await writeRelative(repo, 'apps/hooks.cjs', 'module.exports = {}\n')
    const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), `${workspace}pnpmfile: ../hooks.cjs\n`)
    const sandbox = await createSandbox(request(repo, root))
    assert.equal(sandbox.sources.get('../hooks.cjs'), undefined)
  })

  it('refuses a scope that lifts above the repository', async () => {
    const { repo, root } = await prepareRepository()
    const sandboxParent = await makeTempDir()
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = sandboxParent
    try {
      await assert.rejects(createSandbox(request(repo, root, ['../../../x/package.json'])), /Path leaves the sandbox/)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
    }
    assert.deepEqual(await readdir(sandboxParent), [])
  })
})

async function symlinkOutside(root: string) {
  const { symlink } = await import('node:fs/promises')
  const outside = path.join(path.dirname(root), 'outside.cjs')
  await writeFile(outside, 'module.exports = {}\n')
  await symlink(outside, path.join(root, '.pnpmfile.mjs'))
}

describe('recipes', () => {
  it('names the lockfile-only and frozen install arguments of each manager', () => {
    assert.deepEqual(LOCKFILE_ONLY_ARGS.pnpm, ['install', '--lockfile-only', '--ignore-scripts'])
    assert.deepEqual(FROZEN_INSTALL_ARGS.pnpm, ['install', '--frozen-lockfile'])
    assert.deepEqual(LOCKFILE_ONLY_ARGS.npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
    assert.deepEqual(FROZEN_INSTALL_ARGS.npm, ['ci'])
    assert.equal(commandText('pnpm', FROZEN_INSTALL_ARGS.pnpm), 'pnpm install --frozen-lockfile')
  })

  it('probes the manager version through the PATH of the request', async () => {
    const binDir = await makeTempDir()
    const fake = path.join(binDir, 'pnpm')
    await writeFile(fake, '#!/usr/bin/env node\nconsole.log("10.34.3")\n')
    await chmod(fake, 0o755)
    const secrets = createSecretSet()
    const found = await probeManager(createProcessRunner(), 'pnpm', binDir, { PATH: `${binDir}:${path.dirname(process.execPath)}` }, secrets)
    assert.deepEqual(found, { ok: true, version: '10.34.3' })
    const missing = await probeManager(createProcessRunner(), 'pnpm', await makeTempDir(), { PATH: '' }, secrets)
    assert.deepEqual(missing, { ok: false, reason: 'pnpm was not found' })
  })

  it('reports a failing probe with the redacted tail of stderr', async () => {
    const binDir = await makeTempDir()
    const fake = path.join(binDir, 'npm')
    await writeFile(fake, '#!/usr/bin/env node\nconsole.error("boom secret-token")\nprocess.exit(2)\n')
    await chmod(fake, 0o755)
    const secrets = createSecretSet()
    secrets.add('secret-token')
    const result = await probeManager(createProcessRunner(), 'npm', binDir, { PATH: `${binDir}:${path.dirname(process.execPath)}` }, secrets)
    assert.deepEqual(result, { ok: false, reason: 'npm --version failed: boom [redacted]' })
  })
})
