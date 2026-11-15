import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkNodeModules } from '../src/adapters/node-modules.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import { restoreModulesNames } from './helpers/installed-fixture.ts'
import { createFsReader } from '../src/sources/file-reader.ts'
import type { RootDescriptor, RootGraph } from '../src/model.ts'

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'installed')

type WalkResult = { found: boolean; graph: RootGraph }

function link(repoPath: string, linkPath: string, target: string): Promise<void> {
  return symlink(target, path.join(repoPath, linkPath))
}

async function walk(repoPath: string, root: RootDescriptor): Promise<WalkResult> {
  const builder = new RootGraphBuilder({ id: root.id, path: root.path, manager: root.manager, source: 'installed' })
  const found = await walkNodeModules(createFsReader(repoPath), root, builder)
  return { found, graph: builder.build() }
}

function rootAt(rootPath: string, importerPaths: string[] = [rootPath]): RootDescriptor {
  return { id: rootPath, path: rootPath, manager: 'unknown', importerPaths }
}

function edgeTriples(graph: RootGraph): string[] {
  const nodes = [...graph.importers, ...graph.packages.values()]
  return nodes.flatMap((node) => node.deps.map((edge) => `${node.id} ${edge.kind} ${edge.to}`)).sort()
}

describe('walkNodeModules', () => {
  let sandbox: string
  const repoPaths = { npm: '', pnpm: '', loop: '', bare: '', workspace: '' }

  before(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'deptrail-installed-'))
    const layouts = { npm: 'npm-layout', pnpm: 'pnpm-layout', loop: 'loop', bare: 'no-modules', workspace: 'workspace' }
    for (const [key, layout] of Object.entries(layouts) as Array<[keyof typeof repoPaths, string]>) {
      repoPaths[key] = path.join(sandbox, layout)
      await cp(path.join(fixturesPath, layout), repoPaths[key], { recursive: true })
      await restoreModulesNames(repoPaths[key])
    }
    const store = 'node_modules/.pnpm'
    await mkdir(path.join(repoPaths.pnpm, 'node_modules/@scope'), { recursive: true })
    await link(repoPaths.pnpm, 'node_modules/a', '.pnpm/a@1.0.0/node_modules/a')
    await link(repoPaths.pnpm, 'node_modules/d', '.pnpm/d@1.0.0/node_modules/d')
    await link(repoPaths.pnpm, 'node_modules/@scope/lib', '../.pnpm/@scope+lib@1.0.0/node_modules/@scope/lib')
    await link(repoPaths.pnpm, `${store}/a@1.0.0/node_modules/b`, '../../b@1.0.0/node_modules/b')
    await link(repoPaths.pnpm, `${store}/b@1.0.0/node_modules/a`, '../../a@1.0.0/node_modules/a')
    await link(repoPaths.pnpm, `${store}/d@1.0.0/node_modules/b`, '../../b@1.0.0/node_modules/b')
    await link(repoPaths.loop, 'node_modules/selfloop', 'selfloop')
    await mkdir(path.join(repoPaths.workspace, 'node_modules/@ws'), { recursive: true })
    await link(repoPaths.workspace, 'node_modules/@ws/lib', '../../packages/lib')
  })

  after(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('walks a flat npm layout with nested dependency cycles and a scoped package', async () => {
    const { found, graph } = await walk(repoPaths.npm, rootAt('.'))
    assert.equal(found, true)
    assert.deepEqual(edgeTriples(graph), [
      'a@1.0.0 prod b@1.0.0',
      'b@1.0.0 prod a@1.0.0',
      'd@1.0.0 prod b@1.0.0',
      'importer:. dev d@1.0.0',
      'importer:. prod ?:ghost@^2.0.0',
      'importer:. prod @scope/lib@1.0.0',
      'importer:. prod a@1.0.0',
    ].sort())
    assert.deepEqual(graph.warnings, ['Unresolved dependency ghost@^2.0.0'])
  })

  it('yields the same edges for a pnpm symlinked store as for the npm layout', async () => {
    const npm = await walk(repoPaths.npm, rootAt('.'))
    const pnpm = await walk(repoPaths.pnpm, rootAt('.'))
    assert.equal(pnpm.found, true)
    assert.deepEqual(edgeTriples(pnpm.graph), edgeTriples(npm.graph))
    assert.deepEqual([...pnpm.graph.packages.keys()].sort(), [...npm.graph.packages.keys()].sort())
  })

  it('keeps edge ranges from the declaring manifest', async () => {
    const { graph } = await walk(repoPaths.pnpm, rootAt('.'))
    const importer = graph.importers[0]
    assert.equal(importer.name, 'app')
    assert.equal(importer.deps.find((edge) => edge.to === 'a@1.0.0')?.range, '^1.0.0')
  })

  it('terminates on looping links and cyclic dependencies with a warning', async () => {
    const { found, graph } = await walk(repoPaths.loop, rootAt('.'))
    assert.equal(found, true)
    assert.ok(graph.warnings.some((warning) => warning.includes('node_modules/selfloop')))
    assert.ok(graph.packages.has('?:selfloop@^1.0.0'))
    assert.ok(graph.packages.has('a@1.0.0'))
    assert.ok(graph.packages.has('b@1.0.0'))
  })

  it('returns false when no importer has a node_modules directory', async () => {
    const { found, graph } = await walk(repoPaths.bare, rootAt('.'))
    assert.equal(found, false)
    assert.equal(graph.packages.size, 0)
  })

  it('links workspace members as importers using root-relative ids', async () => {
    const root = rootAt('workspace', ['workspace', 'workspace/packages/lib'])
    const repoPath = path.dirname(repoPaths.workspace)
    const { found, graph } = await walk(repoPath, root)
    assert.equal(found, true)
    assert.deepEqual(edgeTriples(graph), [
      'a@1.0.0 prod b@1.0.0',
      'b@1.0.0 prod a@1.0.0',
      'importer:. prod importer:packages/lib',
      'importer:packages/lib prod a@1.0.0',
    ].sort())
    assert.deepEqual(graph.importers.map((importer) => importer.name), ['ws-root', '@ws/lib'])
  })

  it('marks an installed package whose manifest declares a git spec', async () => {
    const repoPath = path.join(sandbox, 'git-declared')
    await mkdir(path.join(repoPath, 'node_modules/gitdep'), { recursive: true })
    await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'app', dependencies: { gitdep: 'github:u/gitdep', lodash: '^4.0.0' } }))
    await writeFile(path.join(repoPath, 'node_modules/gitdep/package.json'), JSON.stringify({ name: 'gitdep', version: '1.0.0' }))
    await mkdir(path.join(repoPath, 'node_modules/lodash'), { recursive: true })
    await writeFile(path.join(repoPath, 'node_modules/lodash/package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
    const { graph } = await walk(repoPath, rootAt('.'))
    assert.equal(graph.packages.get('gitdep@1.0.0')?.nonRegistry, true)
    assert.equal(graph.packages.get('lodash@4.17.21')?.nonRegistry, undefined)
  })
})
