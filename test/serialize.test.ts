import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildGlobalIndex } from '../src/graph/global-index.ts'
import { deserializeRootGraph, serializeRootGraph, serializeScan } from '../src/graph/serialize.ts'
import { isRootGraphShape } from '../src/scan/cache-shape.ts'
import { CACHE_FORMAT } from '../src/scan/scan-cache.ts'
import type { PackageNode, RootGraph } from '../src/model.ts'

function packageNode(id: string, name: string, version: string, peerSuffix?: string): PackageNode {
  const node: PackageNode = { id, name, version, deps: [{ to: 'b@2.0.0', kind: 'prod', range: '^2.0.0' }], dependents: [] }
  if (peerSuffix) node.peerSuffix = peerSuffix
  return node
}

function graphOf(id: string, nodes: PackageNode[], overrides: Partial<RootGraph> = {}): RootGraph {
  return {
    id,
    path: id,
    manager: 'pnpm',
    source: 'lockfile',
    status: 'ready',
    importers: [{ id: 'importer:.', path: id, name: id, deps: [], dependents: [] }],
    packages: new Map(nodes.map((node) => [node.id, node])),
    warnings: ['a warning'],
    ...overrides,
  }
}

describe('serialization', () => {
  it('round-trips a root graph through JSON text without its config', () => {
    const config = {
      registry: 'https://deploy:secret@registry.example.test/',
      scopedRegistries: { '@s': 'https://s.example.test/path-token/' },
      hasAuth: false,
      catalogs: { default: { a: '^1.0.0' } },
      overrides: { a: '1.0.0' },
      workspacePatterns: ['packages/*'],
      warnings: [],
    }
    const graph = graphOf('app', [packageNode('a@1.0.0', 'a', '1.0.0'), packageNode('a@1.0.0(b@2.0.0)', 'a', '1.0.0', '(b@2.0.0)')], { config })
    const text = JSON.stringify(serializeRootGraph(graph))
    assert.equal(text.includes('secret'), false)
    assert.equal(text.includes('path-token'), false)
    const { config: _omitted, ...withoutConfig } = graph
    assert.deepStrictEqual(deserializeRootGraph(JSON.parse(text)), withoutConfig)
  })

  it('carries only whether a root has registry authentication', () => {
    const authenticated = graphOf('app', [], { config: { registry: 'https://r.test/', scopedRegistries: {}, hasAuth: true, catalogs: {}, overrides: {}, workspacePatterns: [], warnings: [] } })
    const serialized = serializeRootGraph(authenticated) as Record<string, unknown>
    assert.equal(serialized.hasAuth, true)
    assert.equal('config' in serialized, false)
    assert.equal((serializeRootGraph(graphOf('bare', [])) as Record<string, unknown>).hasAuth, false)
  })

  it('round-trips a failed graph with an error', () => {
    const graph = graphOf('broken', [], { status: 'failed', error: 'boom', importers: [] })
    assert.deepStrictEqual(deserializeRootGraph(JSON.parse(JSON.stringify(serializeRootGraph(graph)))), graph)
  })

  it('rejects malformed input', () => {
    assert.throws(() => deserializeRootGraph({ id: 'x' }))
    assert.throws(() => deserializeRootGraph(null))
  })

  it('serializes a scan with packages as arrays', () => {
    const graph = graphOf('app', [packageNode('a@1.0.0', 'a', '1.0.0')])
    const result = serializeScan({ repoPath: '/repo', scannedAt: '2026-10-25T00:00:00.000Z', roots: [graph] }) as {
      repoPath: string
      scannedAt: string
      roots: { packages: PackageNode[]; hasAuth: boolean }[]
    }
    assert.equal(result.repoPath, '/repo')
    assert.equal(result.roots[0].hasAuth, false)
    assert.equal(result.scannedAt, '2026-10-25T00:00:00.000Z')
    assert.equal(result.roots[0].packages.length, 1)
    assert.equal(result.roots[0].packages[0].id, 'a@1.0.0')
  })
})

describe('non-registry flag', () => {
  it('survives a serialization round trip', () => {
    const node: PackageNode = { ...packageNode('g@1.0.0', 'g', '1.0.0'), nonRegistry: true }
    const restored = deserializeRootGraph(JSON.parse(JSON.stringify(serializeRootGraph(graphOf('app', [node])))))
    assert.equal(restored.packages.get('g@1.0.0')?.nonRegistry, true)
  })

  it('is accepted as true and rejected as any other value by the cache shape check', () => {
    const shapeWith = (nonRegistry: unknown) => {
      const node = { ...packageNode('g@1.0.0', 'g', '1.0.0'), nonRegistry }
      return isRootGraphShape(serializeRootGraph(graphOf('app', [node as PackageNode])))
    }
    assert.equal(shapeWith(true), true)
    assert.equal(shapeWith(undefined), true)
    assert.equal(shapeWith('yes'), false)
    assert.equal(shapeWith(false), false)
  })

  it('bumps the cache format', () => {
    assert.equal(CACHE_FORMAT, 2)
  })
})

describe('buildGlobalIndex', () => {
  it('lists a package with versions from several roots and skips placeholders and non-ready roots', () => {
    const placeholder: PackageNode = { id: '?:x@1', name: '?', version: '', deps: [], dependents: [] }
    const roots = [
      graphOf('one', [packageNode('semver@5.7.2', 'semver', '5.7.2'), placeholder]),
      graphOf('two', [packageNode('semver@7.6.3', 'semver', '7.6.3'), packageNode('semver@7.6.3(x@1)', 'semver', '7.6.3', '(x@1)')]),
      graphOf('three', [packageNode('semver@1.0.0', 'semver', '1.0.0')], { status: 'scanning' }),
    ]
    const index = buildGlobalIndex(roots)
    assert.deepStrictEqual(index.get('semver'), [
      { rootId: 'one', nodeId: 'semver@5.7.2', version: '5.7.2' },
      { rootId: 'two', nodeId: 'semver@7.6.3', version: '7.6.3' },
      { rootId: 'two', nodeId: 'semver@7.6.3(x@1)', version: '7.6.3' },
    ])
    assert.equal(index.has('?'), false)
  })
})
