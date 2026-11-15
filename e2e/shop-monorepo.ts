import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startFakeServer, type FakeReply, type FakeServer, type RecordedRequest } from '../test/helpers/fake-http.ts'
import { startFakeNpmRegistry, type FakeNpmRegistry, type FakePackages } from '../test/helpers/fake-npm-registry.ts'
import { installedVersion, lockProject, packageManagerEnv } from '../test/helpers/package-managers.ts'
import { createWorkDirs, startDeptrail, type RunningDeptrail, type WorkDirs } from './global-setup.ts'
import { initGitHistory, type GitHistory } from './git-history.ts'

export const SHOP_ROOT = 'shop'
export const SHOP_NPM_ROOT = 'shop-npm'
export const OUTSIDE_ROOT = 'apps/store'
export const LIBS_ROOT = 'libs'
export const CHILD_ADVISORY_ID = 'GHSA-e2e0-chld-0001'

export type ShopMonorepoOptions = { npmRoot: boolean; outsideRoot?: boolean; undeclaredOutsidePackage?: boolean; git?: boolean }
export type ShopMonorepo = {
  url: string
  repoDir: string
  rootDirs: Record<string, string>
  registry: FakeNpmRegistry
  history?: GitHistory
  stop(): Promise<void>
}

type BatchQuery = { package?: { name?: unknown }; version?: unknown }

const UNDECLARED_WORKSPACE = 'packages: []\n'
const VULNERABLE_NAME = 'child-lib'
const VULNERABLE_VERSION = '1.0.0'
const ADVISORY_MODIFIED = '2026-01-01T00:00:00Z'
const PACKAGE_MANAGER_ENV_KEYS = ['npm_config_cache', 'npm_config_store_dir', 'npm_config_cache_dir', 'npm_config_update_notifier'] as const

const PACKAGES: FakePackages = {
  'child-lib': { '1.0.0': {}, '1.0.1': {}, '2.0.0': {} },
  'parent-lib': { '1.0.0': { dependencies: { 'child-lib': '1.0.0' } }, '1.1.0': { dependencies: { 'child-lib': '^1.0.1' } } },
  helper: { '1.0.0': { dependencies: { 'child-lib': '^1.0.0' } }, '1.1.0': { dependencies: { 'child-lib': '^1.0.1' } } },
  'wide-lib': { '1.0.0': { dependencies: { 'child-lib': '*' } } },
  toolkit: { '2.0.0': {}, '2.1.0': {}, '3.0.0': {} },
}

const HIDDEN_WHILE_LOCKING = ['child-lib@1.0.1', 'parent-lib@1.1.0', 'helper@1.1.0', 'toolkit@2.1.0', 'toolkit@3.0.0']

const CHILD_ADVISORY = {
  id: CHILD_ADVISORY_ID,
  modified: ADVISORY_MODIFIED,
  summary: 'Fixture advisory for child-lib',
  aliases: [],
  database_specific: { severity: 'HIGH' },
  affected: [
    {
      package: { ecosystem: 'npm', name: VULNERABLE_NAME },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }],
      versions: [],
    },
  ],
}

function parsedBody(request: RecordedRequest): unknown {
  try {
    return JSON.parse(request.body)
  } catch {
    return undefined
  }
}

function isVulnerableQuery(query: BatchQuery): boolean {
  return query.package?.name === VULNERABLE_NAME && query.version === VULNERABLE_VERSION
}

function osvReply(request: RecordedRequest): FakeReply {
  if (request.method !== 'POST') return { status: 404 }
  const body = parsedBody(request) as { queries?: unknown; package?: { name?: unknown } } | undefined
  if (request.path === '/v1/querybatch') {
    if (!Array.isArray(body?.queries)) return { status: 400 }
    const results = (body.queries as BatchQuery[]).map((query) =>
      isVulnerableQuery(query) ? { vulns: [{ id: CHILD_ADVISORY_ID, modified: ADVISORY_MODIFIED }] } : {},
    )
    return { body: { results } }
  }
  if (request.path === '/v1/query') {
    if (body === undefined) return { status: 400 }
    return { body: body.package?.name === VULNERABLE_NAME ? { vulns: [CHILD_ADVISORY] } : {} }
  }
  return { status: 404 }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeWorkspaces(rootDir: string): Promise<void> {
  await writeJson(path.join(rootDir, 'web', 'package.json'), {
    name: 'web',
    version: '1.0.0',
    private: true,
    dependencies: { 'parent-lib': '1.0.0', toolkit: '^2.0.0' },
  })
  await writeJson(path.join(rootDir, 'api', 'package.json'), {
    name: 'api',
    version: '1.0.0',
    private: true,
    dependencies: { helper: '^1.0.0', toolkit: '^2.0.0' },
  })
}

async function writePnpmShop(rootDir: string, registryUrl: string): Promise<void> {
  const pnpmVersion = installedVersion('pnpm')
  if (pnpmVersion === undefined) throw new Error('pnpm is not on PATH')
  await writeJson(path.join(rootDir, 'package.json'), { name: SHOP_ROOT, private: true, packageManager: `pnpm@${pnpmVersion}` })
  await writeFile(path.join(rootDir, 'pnpm-workspace.yaml'), 'packages:\n  - web\n  - api\n')
  await writeFile(path.join(rootDir, '.npmrc'), `registry=${registryUrl}/\n`)
  await writeWorkspaces(rootDir)
}

async function writeNpmShop(rootDir: string, registryUrl: string): Promise<void> {
  await writeJson(path.join(rootDir, 'package.json'), { name: SHOP_NPM_ROOT, private: true, workspaces: ['web', 'api'] })
  await writeFile(path.join(rootDir, '.npmrc'), `registry=${registryUrl}/\n`)
  await writeWorkspaces(rootDir)
}

async function writeOutsideRoots(repoDir: string, registryUrl: string): Promise<void> {
  const pnpmVersion = installedVersion('pnpm')
  if (pnpmVersion === undefined) throw new Error('pnpm is not on PATH')
  const roots = [
    { dir: path.join(repoDir, OUTSIDE_ROOT), name: 'store', workspace: 'packages:\n  - ../../libs/ui\n' },
    { dir: path.join(repoDir, LIBS_ROOT), name: 'libs', workspace: 'packages:\n  - ui\n' },
  ]
  for (const root of roots) {
    await writeJson(path.join(root.dir, 'package.json'), { name: root.name, private: true, packageManager: `pnpm@${pnpmVersion}` })
    await writeFile(path.join(root.dir, 'pnpm-workspace.yaml'), root.workspace)
    await writeFile(path.join(root.dir, '.npmrc'), `registry=${registryUrl}/\n`)
  }
  await writeJson(path.join(repoDir, LIBS_ROOT, 'ui', 'package.json'), {
    name: 'ui',
    version: '1.0.0',
    private: true,
    dependencies: { 'parent-lib': '1.0.0' },
  })
}

function deptrailEnv(registryUrl: string, osvUrl: string, managerEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { npm_config_registry: `${registryUrl}/`, DEPTRAIL_OSV_URL: osvUrl }
  for (const key of PACKAGE_MANAGER_ENV_KEYS) {
    const value = managerEnv[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export async function startShopMonorepo(options: ShopMonorepoOptions): Promise<ShopMonorepo> {
  const dirs: WorkDirs = await createWorkDirs()
  let registry: FakeNpmRegistry | undefined
  let osv: FakeServer | undefined
  let deptrail: RunningDeptrail | undefined
  const stop = async (): Promise<void> => {
    await deptrail?.stop()
    await Promise.all([registry?.close(), osv?.close()])
    await rm(dirs.base, { recursive: true, force: true })
  }
  try {
    registry = await startFakeNpmRegistry(PACKAGES, { hidden: HIDDEN_WHILE_LOCKING })
    osv = await startFakeServer(osvReply)
    const managerEnv = packageManagerEnv(dirs.base, registry.url)
    const rootDirs: Record<string, string> = { [SHOP_ROOT]: path.join(dirs.repo, SHOP_ROOT) }
    await writePnpmShop(rootDirs[SHOP_ROOT], registry.url)
    await lockProject(rootDirs[SHOP_ROOT], 'pnpm', managerEnv)
    if (options.npmRoot) {
      rootDirs[SHOP_NPM_ROOT] = path.join(dirs.repo, SHOP_NPM_ROOT)
      await writeNpmShop(rootDirs[SHOP_NPM_ROOT], registry.url)
      await lockProject(rootDirs[SHOP_NPM_ROOT], 'npm', managerEnv)
    }
    if (options.outsideRoot === true) {
      await writeOutsideRoots(dirs.repo, registry.url)
      for (const rootId of [LIBS_ROOT, OUTSIDE_ROOT]) {
        rootDirs[rootId] = path.join(dirs.repo, rootId)
        await lockProject(rootDirs[rootId], 'pnpm', managerEnv)
      }
      if (options.undeclaredOutsidePackage === true) await writeFile(path.join(rootDirs[OUTSIDE_ROOT], 'pnpm-workspace.yaml'), UNDECLARED_WORKSPACE)
    }
    const revealed = registry
    const history =
      options.git === true
        ? await initGitHistory(dirs.repo, rootDirs[SHOP_ROOT], () => lockProject(rootDirs[SHOP_ROOT]!, 'pnpm', managerEnv), () => revealed.reveal())
        : undefined
    if (history === undefined) registry.reveal()
    deptrail = await startDeptrail(dirs, deptrailEnv(registry.url, osv.url, managerEnv))
    return { url: deptrail.url, repoDir: dirs.repo, rootDirs, registry, ...(history === undefined ? {} : { history }), stop }
  } catch (error) {
    await stop()
    throw error
  }
}
