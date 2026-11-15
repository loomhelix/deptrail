import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import type { Edge } from '../src/model.ts'

function createBuilder(): RootGraphBuilder {
  return new RootGraphBuilder({ id: 'apps/web', path: 'apps/web', manager: 'pnpm', source: 'lockfile' })
}

function prod(to: string, range = '^1.0.0'): Edge {
  return { to, kind: 'prod', range }
}

function createCollectGarbage(): () => void {
  setFlagsFromString('--expose-gc')
  return runInNewContext('gc') as () => void
}

function createDistinctLargeString(length: number): string {
  return Buffer.alloc(length, 'x').toString('latin1')
}

describe('RootGraphBuilder', () => {
  describe('build metadata', () => {
    it('copies the init values and reports a ready status', () => {
      const graph = createBuilder().build()

      assert.equal(graph.id, 'apps/web')
      assert.equal(graph.path, 'apps/web')
      assert.equal(graph.manager, 'pnpm')
      assert.equal(graph.source, 'lockfile')
      assert.equal(graph.status, 'ready')
      assert.equal(graph.error, undefined)
      assert.deepEqual(graph.importers, [])
      assert.equal(graph.packages.size, 0)
      assert.deepEqual(graph.warnings, [])
    })

    it('keeps explicit warnings in insertion order before placeholder warnings', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.warn('first')
      builder.addEdge(importerId, prod('missing@1.0.0'))
      builder.warn('second')

      const { warnings } = builder.build()

      assert.equal(warnings.length, 3)
      assert.deepEqual(warnings.slice(0, 2), ['first', 'second'])
      assert.match(warnings[2], /missing@1\.0\.0/)
    })
  })

  describe('importers', () => {
    it('derives the importer id from the path and keeps insertion order', () => {
      const builder = createBuilder()

      const idA = builder.addImporter('packages/a', 'a')
      const idB = builder.addImporter('packages/b', 'b')
      const { importers } = builder.build()

      assert.equal(idA, 'importer:packages/a')
      assert.equal(idB, 'importer:packages/b')
      assert.deepEqual(importers, [
        { id: 'importer:packages/a', path: 'packages/a', name: 'a', deps: [], dependents: [] },
        { id: 'importer:packages/b', path: 'packages/b', name: 'b', deps: [], dependents: [] },
      ])
    })

    it('does not duplicate an importer added twice', () => {
      const builder = createBuilder()

      const first = builder.addImporter('packages/a', 'a')
      const second = builder.addImporter('packages/a', 'renamed')
      const { importers } = builder.build()

      assert.equal(second, first)
      assert.equal(importers.length, 1)
      assert.equal(importers[0].name, 'a')
    })

    it('records an edge from one importer to another as a dependent of the target', () => {
      const builder = createBuilder()
      const idA = builder.addImporter('packages/a', 'a')
      const idB = builder.addImporter('packages/b', 'b')
      builder.addEdge(idA, prod(idB, 'workspace:*'))

      const { importers, warnings } = builder.build()

      assert.deepEqual(importers[0].deps, [prod(idB, 'workspace:*')])
      assert.deepEqual(importers[1].dependents, [idA])
      assert.deepEqual(importers[0].dependents, [])
      assert.deepEqual(warnings, [])
    })
  })

  describe('packages', () => {
    it('stores name, version and peer suffix', () => {
      const builder = createBuilder()
      builder.addPackage('react-dom@18.2.0(react@18.2.0)', 'react-dom', '18.2.0', '(react@18.2.0)')
      builder.addPackage('left-pad@1.3.0', 'left-pad', '1.3.0')

      const { packages } = builder.build()

      assert.deepEqual(packages.get('react-dom@18.2.0(react@18.2.0)'), {
        id: 'react-dom@18.2.0(react@18.2.0)',
        name: 'react-dom',
        version: '18.2.0',
        peerSuffix: '(react@18.2.0)',
        deps: [],
        dependents: [],
      })
      assert.deepEqual(packages.get('left-pad@1.3.0'), {
        id: 'left-pad@1.3.0',
        name: 'left-pad',
        version: '1.3.0',
        deps: [],
        dependents: [],
      })
    })

    it('is idempotent and keeps the first definition', () => {
      const builder = createBuilder()
      builder.addPackage('foo@1.0.0', 'foo', '1.0.0')
      builder.addEdge('foo@1.0.0', prod('bar@2.0.0'))
      builder.addPackage('bar@2.0.0', 'bar', '2.0.0')

      builder.addPackage('foo@1.0.0', 'other', '9.9.9', '(x)')
      const { packages } = builder.build()

      assert.equal(packages.size, 2)
      assert.equal(packages.get('foo@1.0.0')?.name, 'foo')
      assert.equal(packages.get('foo@1.0.0')?.version, '1.0.0')
      assert.equal(packages.get('foo@1.0.0')?.peerSuffix, undefined)
      assert.deepEqual(packages.get('foo@1.0.0')?.deps, [prod('bar@2.0.0')])
    })

    it('reports known packages and importers through hasNode', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addPackage('foo@1.0.0', 'foo', '1.0.0')

      assert.equal(builder.hasNode(importerId), true)
      assert.equal(builder.hasNode('foo@1.0.0'), true)
      assert.equal(builder.hasNode('bar@1.0.0'), false)
    })
  })

  describe('edges', () => {
    it('keeps one edge when the same edge is added twice', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addPackage('foo@1.0.0', 'foo', '1.0.0')
      builder.addEdge(importerId, prod('foo@1.0.0'))
      builder.addEdge(importerId, prod('foo@1.0.0'))

      const { importers } = builder.build()

      assert.deepEqual(importers[0].deps, [prod('foo@1.0.0')])
    })

    it('treats the first edge as authoritative when only the range differs', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addPackage('foo@1.0.0', 'foo', '1.0.0')
      builder.addEdge(importerId, prod('foo@1.0.0', '^1.0.0'))
      builder.addEdge(importerId, prod('foo@1.0.0', '~1.0.0'))

      const { importers } = builder.build()

      assert.deepEqual(importers[0].deps, [prod('foo@1.0.0', '^1.0.0')])
    })

    it('keeps edges to the same target with different kinds', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addPackage('foo@1.0.0', 'foo', '1.0.0')
      builder.addEdge(importerId, prod('foo@1.0.0'))
      builder.addEdge(importerId, { to: 'foo@1.0.0', kind: 'dev', range: '^1.0.0' })

      const { importers } = builder.build()

      assert.deepEqual(
        importers[0].deps.map((edge) => edge.kind),
        ['prod', 'dev'],
      )
    })

    it('rejects an edge that starts at an unknown node', () => {
      const builder = createBuilder()

      assert.throws(() => builder.addEdge('ghost@1.0.0', prod('foo@1.0.0')), /ghost@1\.0\.0/)
    })
  })

  describe('dependents', () => {
    it('lists each parent of a shared package exactly once', () => {
      const builder = createBuilder()
      const idA = builder.addImporter('packages/a', 'a')
      const idB = builder.addImporter('packages/b', 'b')
      builder.addPackage('shared@1.0.0', 'shared', '1.0.0')
      builder.addPackage('parent@1.0.0', 'parent', '1.0.0')
      builder.addEdge(idA, prod('shared@1.0.0'))
      builder.addEdge(idA, { to: 'shared@1.0.0', kind: 'dev', range: '^1.0.0' })
      builder.addEdge(idB, prod('shared@1.0.0'))
      builder.addEdge(idB, prod('parent@1.0.0'))
      builder.addEdge('parent@1.0.0', prod('shared@1.0.0'))

      const { packages } = builder.build()

      assert.deepEqual(packages.get('shared@1.0.0')?.dependents, [idA, idB, 'parent@1.0.0'])
      assert.deepEqual(packages.get('parent@1.0.0')?.dependents, [idB])
    })

    it('is recomputed rather than accumulated when build runs twice', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addPackage('foo@1.0.0', 'foo', '1.0.0')
      builder.addEdge(importerId, prod('foo@1.0.0'))

      builder.build()
      const { packages } = builder.build()

      assert.deepEqual(packages.get('foo@1.0.0')?.dependents, [importerId])
    })
  })

  describe('unresolved targets', () => {
    it('turns an unknown target into a placeholder node and a warning', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addEdge(importerId, prod('foo@1.0.0'))

      const { importers, packages, warnings } = builder.build()

      assert.deepEqual(packages.get('?:foo@1.0.0'), {
        id: '?:foo@1.0.0',
        name: '?',
        version: '',
        deps: [],
        dependents: [importerId],
      })
      assert.deepEqual(importers[0].deps, [prod('?:foo@1.0.0')])
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /foo@1\.0\.0/)
    })

    it('creates one placeholder and one warning per distinct missing target', () => {
      const builder = createBuilder()
      const idA = builder.addImporter('packages/a', 'a')
      const idB = builder.addImporter('packages/b', 'b')
      builder.addPackage('parent@1.0.0', 'parent', '1.0.0')
      builder.addEdge(idA, prod('foo@1.0.0'))
      builder.addEdge(idB, prod('foo@1.0.0'))
      builder.addEdge('parent@1.0.0', prod('foo@1.0.0'))
      builder.addEdge('parent@1.0.0', prod('bar@2.0.0'))

      const { packages, warnings } = builder.build()

      assert.deepEqual(packages.get('?:foo@1.0.0')?.dependents, [idA, idB, 'parent@1.0.0'])
      assert.deepEqual(packages.get('?:bar@2.0.0')?.dependents, ['parent@1.0.0'])
      assert.equal(packages.size, 3)
      assert.equal(warnings.length, 2)
      assert.equal(warnings.filter((message) => message.includes('foo@1.0.0')).length, 1)
      assert.equal(warnings.filter((message) => message.includes('bar@2.0.0')).length, 1)
    })

    it('does not create placeholders for targets that are added after the edge', () => {
      const builder = createBuilder()
      const importerId = builder.addImporter('packages/a', 'a')
      builder.addEdge(importerId, prod('late@1.0.0'))
      builder.addPackage('late@1.0.0', 'late', '1.0.0')

      const { packages, warnings } = builder.build()

      assert.equal(packages.has('?:late@1.0.0'), false)
      assert.deepEqual(packages.get('late@1.0.0')?.dependents, [importerId])
      assert.deepEqual(warnings, [])
    })
  })

  describe('intern', () => {
    it('returns equal strings for equal inputs', () => {
      const builder = createBuilder()
      const first = builder.intern('lodash')
      const second = builder.intern('lodash'.slice())

      assert.equal(first, 'lodash')
      assert.equal(second, first)
      assert.notEqual(builder.intern('left-pad'), first)
    })

    it('keeps one instance in memory for many equal but distinct strings', () => {
      const collectGarbage = createCollectGarbage()
      const copies = 400
      const length = 100_000
      const measureGrowth = (retainCopy: (copy: string) => string): number => {
        collectGarbage()
        const before = process.memoryUsage().heapUsed
        const retained: string[] = []
        for (let index = 0; index < copies; index++) {
          retained.push(retainCopy(createDistinctLargeString(length)))
        }
        collectGarbage()
        const growth = process.memoryUsage().heapUsed - before
        assert.equal(retained.length, copies)
        return growth
      }
      const builder = createBuilder()

      const growthWithoutInterning = measureGrowth((copy) => copy)
      const growthWithInterning = measureGrowth((copy) => builder.intern(copy))

      assert.ok(
        growthWithoutInterning > (copies * length) / 2,
        `control retained only ${growthWithoutInterning} bytes`,
      )
      assert.ok(
        growthWithInterning < (copies * length) / 20,
        `interning retained ${growthWithInterning} bytes`,
      )
    })
  })
})
