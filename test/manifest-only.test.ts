import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifestOnly } from '../src/adapters/manifest-only.ts'
import { isNonRegistrySpec } from '../src/adapters/package-manifest.ts'
import { planKeys } from '../src/enrich/enrichment-keys.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import { createFsReader } from '../src/sources/file-reader.ts'
import type { RootDescriptor, RootGraph } from '../src/model.ts'

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'installed')

async function build(root: RootDescriptor): Promise<RootGraph> {
  const builder = new RootGraphBuilder({ id: root.id, path: root.path, manager: root.manager, source: 'manifest-only' })
  await buildManifestOnly(createFsReader(fixturesPath), root, builder)
  return builder.build()
}

describe('buildManifestOnly', () => {
  it('adds one node per direct dependency with the range as version and no transitive nodes', async () => {
    const graph = await build({ id: 'manifest', path: 'manifest', manager: 'unknown', importerPaths: ['manifest'] })
    const importer = graph.importers[0]
    assert.equal(importer.id, 'importer:.')
    assert.equal(importer.name, 'manifest-app')
    assert.deepEqual(
      importer.deps.map((edge) => `${edge.kind} ${edge.to} ${edge.range}`),
      ['prod a@^1.2.0 ^1.2.0', 'dev d@~2.0.0 ~2.0.0', 'optional o@^3.0.0 ^3.0.0', 'peer p@>=1 >=1'],
    )
    assert.equal(graph.packages.get('a@^1.2.0')?.version, '^1.2.0')
    assert.deepEqual([...graph.packages.keys()].sort(), ['a@^1.2.0', 'd@~2.0.0', 'o@^3.0.0', 'p@>=1'])
    assert.deepEqual(graph.warnings, [])
  })

  it('registers every importer with root-relative ids', async () => {
    const root = { id: 'manifest', path: 'manifest', manager: 'unknown' as const, importerPaths: ['manifest', 'manifest/packages/lib'] }
    const graph = await build(root)
    assert.deepEqual(graph.importers.map((importer) => importer.id), ['importer:.', 'importer:packages/lib'])
    assert.equal(graph.importers[1].deps[0].to, 'x@1.0.0')
  })

  it('warns and keeps an importer without a readable manifest', async () => {
    const graph = await build({ id: 'missing', path: 'missing', manager: 'unknown', importerPaths: ['missing'] })
    assert.deepEqual(graph.importers.map((importer) => importer.id), ['importer:.'])
    assert.deepEqual(graph.warnings, ['Could not read missing/package.json'])
  })

  it('marks a dependency declared with a file spec as non-registry', async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), 'deptrail-manifest-'))
    try {
      await mkdir(path.join(repoPath, 'app'))
      await writeFile(path.join(repoPath, 'app', 'package.json'), JSON.stringify({ name: 'app', dependencies: { x: 'file:../x', y: '^1.0.0' } }))
      const root: RootDescriptor = { id: 'app', path: 'app', manager: 'unknown', importerPaths: ['app'] }
      const builder = new RootGraphBuilder({ id: root.id, path: root.path, manager: root.manager, source: 'manifest-only' })
      await buildManifestOnly(createFsReader(repoPath), root, builder)
      const graph = builder.build()
      assert.equal(graph.packages.get('x@file:../x')?.nonRegistry, true)
      assert.equal(graph.packages.get('y@^1.0.0')?.nonRegistry, undefined)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('marks workspace dependencies as non-registry so no registry key is planned for them', async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), 'deptrail-manifest-'))
    try {
      await mkdir(path.join(repoPath, 'app'))
      const dependencies = { 'shared-utils': 'workspace:*', '@acme/ui': 'workspace:^', lodash: '^4.17.0' }
      await writeFile(path.join(repoPath, 'app', 'package.json'), JSON.stringify({ name: 'app', dependencies }))
      const root: RootDescriptor = { id: 'app', path: 'app', manager: 'pnpm', importerPaths: ['app'] }
      const builder = new RootGraphBuilder({ id: root.id, path: root.path, manager: root.manager, source: 'manifest-only' })
      await buildManifestOnly(createFsReader(repoPath), root, builder)
      const graph = builder.build()
      assert.equal(graph.packages.get('shared-utils@workspace:*')?.nonRegistry, true)
      assert.equal(graph.packages.get('@acme/ui@workspace:^')?.nonRegistry, true)
      graph.status = 'ready'
      graph.config = { registry: 'https://registry.npmjs.org/', scopedRegistries: {}, hasAuth: false, catalogs: {}, overrides: {}, workspacePatterns: [], warnings: [] }
      const plan = planKeys([graph], new Set())
      assert.deepEqual([...plan.registry.values()].map((target) => target.name), ['lodash'])
      assert.equal(plan.versions.size, 0)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})

describe('isNonRegistrySpec', () => {
  it('is true for git, file, link, url, workspace and GitHub shorthand specs', () => {
    for (const spec of ['git+ssh://h/r.git', 'github:u/r', 'file:../x', 'link:../x', 'https://h/x.tgz', 'u/repo', 'u/repo#sha', 'workspace:*', 'workspace:^']) {
      assert.equal(isNonRegistrySpec(spec), true, spec)
    }
  })

  it('is false for ranges, dist-tags, aliases and catalog specs', () => {
    for (const spec of ['^1.2.3', '1.x', 'latest', 'npm:pkg@^1', 'catalog:', '*', '>=1 <2']) {
      assert.equal(isNonRegistrySpec(spec), false, spec)
    }
  })
})
