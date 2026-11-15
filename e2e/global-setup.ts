import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_TOKEN, PRIVATE_REGISTRY_PATH, startFakeEnrichment, type FakeEnrichment } from './fake-enrichment.ts'

export const E2E_URL_ENV = 'DEPTRAIL_E2E_URL'
export const E2E_REGISTRY_URL_ENV = 'DEPTRAIL_E2E_REGISTRY_URL'
export const E2E_OSV_URL_ENV = 'DEPTRAIL_E2E_OSV_URL'
export const WIDE_ROOT_ID = 'bulk/wide'
export const WIDE_ROOT_DEPENDENCY_COUNT = 2000
export const PRIVATE_ROOT_ID = 'bulk/private'
export const PRIVATE_PACKAGE = '@acme/internal'
export const PRIVATE_PACKAGE_VERSION = '1.0.0'
export const LINKED_ROOT_ID = 'bulk/linked'
export const VARIANTS_ROOT_ID = 'bulk/variants'
export const VARIANTS_PACKAGE = 'peer-host'
export const VARIANTS_PACKAGE_VERSION = '1.0.0'

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url))
const CLI_ENTRY = path.join(PROJECT_DIR, 'dist', 'cli', 'cli.js')
const UI_ENTRY = path.join(PROJECT_DIR, 'dist', 'ui', 'index.html')
const FIXTURE_MONOLITH = path.join(PROJECT_DIR, 'test', 'fixtures', 'monolith')
const URL_LINE_PREFIX = 'deptrail: '
const STARTUP_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const CREDENTIALED_ROOT_ID = 'npm-package'
const PRIVATE_SCOPE = PRIVATE_PACKAGE.split('/')[0]
const NPMRC_FILE = '.npmrc'

export type WorkDirs = { base: string; repo: string; cache: string; home: string }
export type RunningDeptrail = { url: string; stop(): Promise<void> }

export function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY) || !existsSync(UI_ENTRY)) throw new Error('Run pnpm build before pnpm e2e')
}

export async function createWorkDirs(): Promise<WorkDirs> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'deptrail-e2e-'))
  const dirs: WorkDirs = { base, repo: path.join(base, 'monorepo'), cache: path.join(base, 'cache'), home: path.join(base, 'home') }
  await mkdir(dirs.cache)
  await mkdir(dirs.home)
  return dirs
}

export async function copyFixtureMonolith(target: string): Promise<void> {
  await cp(FIXTURE_MONOLITH, target, { recursive: true })
}

function wideDependencyName(index: number): string {
  return `pkg-${String(index).padStart(4, '0')}`
}

function wideLockfile(): string {
  const names = Array.from({ length: WIDE_ROOT_DEPENDENCY_COUNT }, (_, index) => wideDependencyName(index))
  const importerEntries = names.map((name) => `      ${name}:\n        specifier: 1.0.0\n        version: 1.0.0`)
  const packageEntries = names.map((name) => `  ${name}@1.0.0:\n    resolution: {integrity: sha512-${name}}`)
  const snapshotEntries = names.map((name) => `  ${name}@1.0.0: {}`)
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    ...importerEntries,
    '',
    'packages:',
    '',
    ...packageEntries.flatMap((entry) => [entry, '']),
    'snapshots:',
    '',
    ...snapshotEntries.flatMap((entry) => [entry, '']),
  ].join('\n')
}

export async function writeWideRoot(repo: string): Promise<void> {
  const rootDir = path.join(repo, ...WIDE_ROOT_ID.split('/'))
  await mkdir(rootDir, { recursive: true })
  const dependencies = Object.fromEntries(
    Array.from({ length: WIDE_ROOT_DEPENDENCY_COUNT }, (_, index) => [wideDependencyName(index), '1.0.0']),
  )
  await writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'wide', private: true, dependencies }))
  await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), wideLockfile())
}

function privateLockfile(): string {
  const key = `'${PRIVATE_PACKAGE}@${PRIVATE_PACKAGE_VERSION}'`
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      '${PRIVATE_PACKAGE}':`,
    `        specifier: ${PRIVATE_PACKAGE_VERSION}`,
    `        version: ${PRIVATE_PACKAGE_VERSION}`,
    '',
    'packages:',
    '',
    `  ${key}:`,
    '    resolution: {integrity: sha512-fixture-acme-internal}',
    '',
    'snapshots:',
    '',
    `  ${key}: {}`,
    '',
  ].join('\n')
}

export async function writePrivateRoot(repo: string, registryUrl: string): Promise<void> {
  const rootDir = path.join(repo, ...PRIVATE_ROOT_ID.split('/'))
  await mkdir(rootDir, { recursive: true })
  const dependencies = { [PRIVATE_PACKAGE]: PRIVATE_PACKAGE_VERSION }
  await writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'private', private: true, dependencies }))
  await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), privateLockfile())
  await writeFile(path.join(rootDir, NPMRC_FILE), `${PRIVATE_SCOPE}:registry=${registryUrl}${PRIVATE_REGISTRY_PATH}\n`)
}

function linkedLockfile(): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .: {}',
    '',
    '  apps/web:',
    '    dependencies:',
    "      '@linked/ui':",
    '        specifier: workspace:*',
    '        version: link:../../packages/ui',
    '',
    '  packages/tokens: {}',
    '',
    '  packages/ui:',
    '    dependencies:',
    "      '@linked/tokens':",
    '        specifier: workspace:*',
    '        version: link:../tokens',
    '',
  ].join('\n')
}

async function writeManifest(directory: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest))
}

export async function writeLinkedRoot(repo: string): Promise<void> {
  const rootDir = path.join(repo, ...LINKED_ROOT_ID.split('/'))
  await writeManifest(rootDir, { name: 'linked', private: true })
  await writeManifest(path.join(rootDir, 'apps', 'web'), { name: '@linked/web', dependencies: { '@linked/ui': 'workspace:*' } })
  await writeManifest(path.join(rootDir, 'packages', 'tokens'), { name: '@linked/tokens' })
  await writeManifest(path.join(rootDir, 'packages', 'ui'), { name: '@linked/ui', dependencies: { '@linked/tokens': 'workspace:*' } })
  await writeFile(path.join(rootDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n')
  await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), linkedLockfile())
}

function variantsLockfile(): string {
  const importer = (name: string, peerVersion: string): string[] => [
    `  apps/${name}:`,
    '    dependencies:',
    `      ${VARIANTS_PACKAGE}:`,
    `        specifier: ${VARIANTS_PACKAGE_VERSION}`,
    `        version: ${VARIANTS_PACKAGE_VERSION}(peer-lib@${peerVersion})`,
    `      peer-lib:`,
    `        specifier: ${peerVersion}`,
    `        version: ${peerVersion}`,
    '',
  ]
  const snapshot = (peerVersion: string): string[] => [
    `  ${VARIANTS_PACKAGE}@${VARIANTS_PACKAGE_VERSION}(peer-lib@${peerVersion}):`,
    '    dependencies:',
    `      peer-lib: ${peerVersion}`,
    '',
  ]
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .: {}',
    '',
    ...importer('first', '1.0.0'),
    ...importer('second', '2.0.0'),
    'packages:',
    '',
    `  ${VARIANTS_PACKAGE}@${VARIANTS_PACKAGE_VERSION}:`,
    '    resolution: {integrity: sha512-fixture-peer-host}',
    '',
    '  peer-lib@1.0.0:',
    '    resolution: {integrity: sha512-fixture-peer-lib-1}',
    '',
    '  peer-lib@2.0.0:',
    '    resolution: {integrity: sha512-fixture-peer-lib-2}',
    '',
    'snapshots:',
    '',
    ...snapshot('1.0.0'),
    ...snapshot('2.0.0'),
    '  peer-lib@1.0.0: {}',
    '',
    '  peer-lib@2.0.0: {}',
    '',
  ].join('\n')
}

export async function writeVariantsRoot(repo: string): Promise<void> {
  const rootDir = path.join(repo, ...VARIANTS_ROOT_ID.split('/'))
  await writeManifest(rootDir, { name: 'variants', private: true })
  for (const name of ['first', 'second']) {
    await writeManifest(path.join(rootDir, 'apps', name), { name: `@variants/${name}`, dependencies: { [VARIANTS_PACKAGE]: VARIANTS_PACKAGE_VERSION } })
  }
  await writeFile(path.join(rootDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), variantsLockfile())
}

export async function writeRegistryConfig(dirs: WorkDirs, fakes: FakeEnrichment): Promise<void> {
  const tokenLine = `//127.0.0.1:${fakes.registryPort}/:_authToken=${FIXTURE_TOKEN}`
  await writeFile(path.join(dirs.repo, CREDENTIALED_ROOT_ID, NPMRC_FILE), `registry=${fakes.registryUrl}/\n${tokenLine}\n`)
  await writeFile(path.join(dirs.home, NPMRC_FILE), `${tokenLine}\n`)
}

export function enrichmentEnv(fakes: FakeEnrichment): Record<string, string> {
  return { npm_config_registry: `${fakes.registryUrl}/`, DEPTRAIL_OSV_URL: fakes.osvUrl }
}

export function waitForTokenizedUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const fail = (reason: string): void => settle(() => reject(new Error(`deptrail did not start: ${reason}\n${stderr}`)))
    const timer = setTimeout(() => fail(`no URL within ${STARTUP_TIMEOUT_MS} ms`), STARTUP_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(URL_LINE_PREFIX))
      if (line) settle(() => resolve(line.slice(URL_LINE_PREFIX.length).trim()))
    })
    child.once('error', (error) => fail(error.message))
    child.once('exit', (code) => fail(`exited with code ${code}`))
  })
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

export async function startDeptrail(
  dirs: WorkDirs,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<RunningDeptrail> {
  const child = spawn(process.execPath, [CLI_ENTRY, dirs.repo, '--no-open', '--port', '0', ...extraArgs], {
    env: {
      ...process.env,
      ...extraEnv,
      COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(os.homedir(), '.cache', 'node', 'corepack'),
      COREPACK_ENABLE_NETWORK: '0',
      DEPTRAIL_CACHE_DIR: dirs.cache,
      HOME: dirs.home,
      npm_config_userconfig: path.join(dirs.home, NPMRC_FILE),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const url = await waitForTokenizedUrl(child)
    return { url, stop: () => stopProcess(child) }
  } catch (error) {
    await stopProcess(child)
    throw error
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run the tests through pnpm e2e`)
  return value
}

export function tokenizedUrl(): string {
  return requiredEnv(E2E_URL_ENV)
}

export function fakeRegistryUrl(): string {
  return requiredEnv(E2E_REGISTRY_URL_ENV)
}

export function fakeOsvUrl(): string {
  return requiredEnv(E2E_OSV_URL_ENV)
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  assertBuilt()
  const dirs = await createWorkDirs()
  let startedFakes: FakeEnrichment | undefined
  try {
    const fakes = await startFakeEnrichment()
    startedFakes = fakes
    await copyFixtureMonolith(dirs.repo)
    await writeWideRoot(dirs.repo)
    await writePrivateRoot(dirs.repo, fakes.registryUrl)
    await writeLinkedRoot(dirs.repo)
    await writeVariantsRoot(dirs.repo)
    await writeRegistryConfig(dirs, fakes)
    const deptrail = await startDeptrail(dirs, enrichmentEnv(fakes))
    process.env[E2E_URL_ENV] = deptrail.url
    process.env[E2E_REGISTRY_URL_ENV] = fakes.registryUrl
    process.env[E2E_OSV_URL_ENV] = fakes.osvUrl
    const session = { url: deptrail.url, repo: dirs.repo, registryUrl: fakes.registryUrl, osvUrl: fakes.osvUrl }
    await writeFile(path.join(dirs.base, 'session.json'), JSON.stringify(session))
    return async () => {
      await deptrail.stop()
      await fakes.close()
      await rm(dirs.base, { recursive: true, force: true })
    }
  } catch (error) {
    await startedFakes?.close()
    await rm(dirs.base, { recursive: true, force: true })
    throw error
  }
}
