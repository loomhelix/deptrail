import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ProcessRunner } from '../src/adapters/command-runner.ts'
import { createAvailability } from '../src/actions/availability.ts'
import { createSecretSet } from '../src/config/secrets.ts'
import type { Manager, RootGraph } from '../src/model.ts'

const REPO_PATH = '/repo'

const runner: ProcessRunner = {
  run: async () => ({ code: 0, stdout: '10.34.3\n', stderr: '', timedOut: false, cancelled: false }),
  killRunning: () => undefined,
}

function rootWith(options: { manager?: Manager; path?: string; patterns: string[]; importers: [string, string][] }): RootGraph {
  return {
    path: options.path ?? '.',
    manager: options.manager ?? 'pnpm',
    status: 'ready',
    source: 'lockfile',
    importers: options.importers.map(([rootRelative, repoRelative]) => ({ id: `importer:${rootRelative}`, path: repoRelative, name: rootRelative, deps: [], dependents: [] })),
    config: { registry: '', scopedRegistries: {}, hasAuth: false, catalogs: {}, overrides: {}, workspacePatterns: options.patterns, warnings: [] },
  } as unknown as RootGraph
}

async function checkOf(root: RootGraph) {
  const availability = createAvailability({ repoPath: REPO_PATH, runner, env: {}, offline: false, secrets: createSecretSet() })
  await availability.probe(root)
  return availability.check(root)
}

describe('availability for outside workspace packages', () => {
  it('offers actions for a pnpm root whose outside packages are declared', async () => {
    const root = rootWith({ path: 'apps/shop', patterns: ['../../libs/*'], importers: [['.', 'apps/shop'], ['../../libs/ui', 'libs/ui']] })
    assert.deepEqual(await checkOf(root), { manager: { name: 'pnpm', version: '10.34.3' } })
  })

  it('names an outside package outside the repository', async () => {
    const apps = rootWith({ path: 'apps', patterns: ['../*'], importers: [['../../shared', '../shared']] })
    assert.deepEqual(await checkOf(apps), { reason: 'Actions do not support workspace packages outside the repository (../../shared)' })
    const top = rootWith({ patterns: ['../x'], importers: [['../x', '../x']] })
    assert.deepEqual(await checkOf(top), { reason: 'Actions do not support workspace packages outside the repository (../x)' })
  })

  it('keeps the npm reason', async () => {
    const root = rootWith({ manager: 'npm', path: 'app', patterns: [], importers: [['../shared', 'shared']] })
    assert.deepEqual(await checkOf(root), { reason: 'Actions do not support workspace packages outside the root (../shared)' })
  })

  it('names a lockfile importer that pnpm-workspace.yaml does not declare', async () => {
    const root = rootWith({ path: 'app', patterns: ['packages/*'], importers: [['../shared', 'shared']] })
    assert.deepEqual(await checkOf(root), { reason: 'The lockfile lists ../shared, which pnpm-workspace.yaml does not declare' })
  })

  it('does not let the ** pattern declare a package above the root', async () => {
    const root = rootWith({ path: 'apps/shop', patterns: ['**'], importers: [['../../libs/ui', 'libs/ui']] })
    assert.deepEqual(await checkOf(root), { reason: 'The lockfile lists ../../libs/ui, which pnpm-workspace.yaml does not declare' })
  })
})
