import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import { children } from '../src/query/children.ts'
import { dependents } from '../src/query/dependents.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import { buildTrailColumns, chipTitle, movedTrailPosition, trailPathIds, type TrailColumn } from '../ui/src/trail-columns.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { peerVariantText } from '../ui/src/vocabulary.ts'

function monolith() {
  return makeGraph({
    importers: { 'apps/web': ['ui@1.0.0'], 'tools/build': ['reader@1.0.0'] },
    packages: {
      'ui@1.0.0': ['parser@1.0.0'],
      'reader@1.0.0': ['normalizer@1.0.0'],
      'parser@1.0.0': ['semver@5.7.2'],
      'normalizer@1.0.0': ['semver@5.7.2'],
      'semver@5.7.2': ['tiny@1.0.0'],
      'tiny@1.0.0': [],
    },
  })
}

function outline(columns: TrailColumn[]): string[][] {
  return columns.map((column) => column.chips.map((chip) => chip.label))
}

describe('buildTrailColumns', () => {
  it('lays out importers, direct dependencies, intermediates, the anchor and its children', () => {
    const graph = monolith()
    const columns = buildTrailColumns(
      dependents(graph, 'semver@5.7.2', 50, ALL_KINDS),
      children(graph, 'semver@5.7.2', 1, ALL_KINDS),
    )
    assert.deepEqual(outline(columns), [
      ['apps/web', 'tools/build'],
      ['reader 1.0.0', 'ui 1.0.0'],
      ['normalizer 1.0.0', 'parser 1.0.0'],
      ['semver 5.7.2'],
      ['tiny 1.0.0'],
    ])
    assert.deepEqual(
      columns.map((column) => column.chips.filter((chip) => chip.isAnchor).length),
      [0, 0, 0, 1, 0],
    )
  })

  it('titles the columns with fixed names whatever is selected', () => {
    const graph = monolith()
    const columns = buildTrailColumns(dependents(graph, 'semver@5.7.2', 50, ALL_KINDS), children(graph, 'semver@5.7.2', 1, ALL_KINDS))
    assert.deepEqual(
      columns.map((column) => column.title),
      ['Workspace packages', 'Direct dependencies', 'Via', 'This package', 'Depends on'],
    )
  })

  it('orders deeper intermediates first and omits empty columns', () => {
    const graph = makeGraph({
      importers: { app: ['top@1.0.0'] },
      packages: { 'top@1.0.0': ['mid@1.0.0'], 'mid@1.0.0': ['low@1.0.0'], 'low@1.0.0': ['leaf@1.0.0'], 'leaf@1.0.0': [] },
    })
    const columns = buildTrailColumns(dependents(graph, 'leaf@1.0.0', 50, ALL_KINDS), children(graph, 'leaf@1.0.0', 1, ALL_KINDS))
    assert.deepEqual(outline(columns), [['app'], ['top 1.0.0'], ['mid 1.0.0'], ['low 1.0.0'], ['leaf 1.0.0']])
  })

  it('shows only the anchor and its children when the anchor is an importer', () => {
    const graph = monolith()
    const columns = buildTrailColumns(
      dependents(graph, 'importer:apps/web', 50, ALL_KINDS),
      children(graph, 'importer:apps/web', 1, ALL_KINDS),
    )
    assert.deepEqual(outline(columns), [['apps/web'], ['ui 1.0.0']])
    assert.equal(columns[0]!.chips[0]!.isAnchor, true)
  })

  it('lists a direct-dependency anchor once, in the anchor column only', () => {
    const graph = monolith()
    const columns = buildTrailColumns(dependents(graph, 'ui@1.0.0', 50, ALL_KINDS), children(graph, 'ui@1.0.0', 1, ALL_KINDS))
    assert.deepEqual(outline(columns), [['apps/web'], ['ui 1.0.0'], ['parser 1.0.0']])
    assert.equal(columns.flatMap((column) => column.chips).filter((chip) => chip.isAnchor).length, 1)
  })

  it('marks only the chips of the direct dependencies column as direct', () => {
    const graph = monolith()
    const columns = buildTrailColumns(dependents(graph, 'semver@5.7.2', 50, ALL_KINDS), children(graph, 'semver@5.7.2', 1, ALL_KINDS))
    assert.deepEqual(
      columns.map((column) => [column.key, column.chips.filter((chip) => chip.isDirect).length]),
      [
        ['importers', 0],
        ['direct', 2],
        ['via-1', 0],
        ['anchor', 0],
        ['children', 0],
      ],
    )
  })

  it('keeps node ids on the chips', () => {
    const graph = monolith()
    const columns = buildTrailColumns(dependents(graph, 'semver@5.7.2', 50, ALL_KINDS), children(graph, 'semver@5.7.2', 1, ALL_KINDS))
    assert.deepEqual(
      columns[0]!.chips.map((chip) => chip.id),
      ['importer:apps/web', 'importer:tools/build'],
    )
  })
})

describe('trail chips', () => {
  it('show the path of a workspace package only when it differs from its name', () => {
    const builder = new RootGraphBuilder({ id: 'test-root', path: '.', manager: 'pnpm', source: 'lockfile' })
    const named = builder.addImporter('apps/web', '@shop/web')
    const plain = builder.addImporter('tools', 'tools')
    builder.addPackage('ui@1.0.0', 'ui', '1.0.0')
    builder.addEdge(named, { to: 'ui@1.0.0', kind: 'prod', range: '^1.0.0' })
    builder.addEdge(plain, { to: 'ui@1.0.0', kind: 'prod', range: '^1.0.0' })
    const graph = builder.build()
    const columns = buildTrailColumns(dependents(graph, 'ui@1.0.0', 50, ALL_KINDS), children(graph, 'ui@1.0.0', 1, ALL_KINDS))
    assert.deepEqual(
      columns[0]!.chips.map((chip) => [chip.label, chip.path]),
      [
        ['@shop/web', 'apps/web'],
        ['tools', undefined],
      ],
    )
  })
})

describe('peer variants in the trail', () => {
  it('are numbered with the peers that tell them apart and keep the full suffix in the title', () => {
    const builder = new RootGraphBuilder({ id: 'test-root', path: '.', manager: 'pnpm', source: 'lockfile' })
    const web = builder.addImporter('web', 'web')
    const admin = builder.addImporter('admin', 'admin')
    builder.addPackage('nuxt@4.6.1(vite@7.0.0)', 'nuxt', '4.6.1')
    builder.addPackage('nuxt@4.6.1(vite@6.0.0)', 'nuxt', '4.6.1')
    builder.addPackage('devtools@3.4.2', 'devtools', '3.4.2')
    builder.addEdge(web, { to: 'nuxt@4.6.1(vite@7.0.0)', kind: 'prod', range: '^4.6.1' })
    builder.addEdge(admin, { to: 'nuxt@4.6.1(vite@6.0.0)', kind: 'prod', range: '^4.6.1' })
    builder.addEdge('nuxt@4.6.1(vite@7.0.0)', { to: 'devtools@3.4.2', kind: 'prod', range: '^3.4.2' })
    builder.addEdge('nuxt@4.6.1(vite@6.0.0)', { to: 'devtools@3.4.2', kind: 'prod', range: '^3.4.2' })
    const graph = builder.build()
    const columns = buildTrailColumns(dependents(graph, 'devtools@3.4.2', 50, ALL_KINDS), children(graph, 'devtools@3.4.2', 1, ALL_KINDS))
    const direct = [...columns[1]!.chips].sort((left, right) => left.id.localeCompare(right.id, 'en'))
    assert.deepEqual(
      direct.map((chip) => [chip.label, chip.variant === undefined ? undefined : peerVariantText(chip.variant), chipTitle(chip)]),
      [
        ['nuxt 4.6.1', 'variant 1 of 2 (vite 6.0.0)', 'nuxt 4.6.1 (vite@6.0.0)'],
        ['nuxt 4.6.1', 'variant 2 of 2 (vite 7.0.0)', 'nuxt 4.6.1 (vite@7.0.0)'],
      ],
    )
    assert.equal(columns[2]!.chips[0]!.variant, undefined)
  })
})

describe('chipTitle', () => {
  const chipBase = { path: undefined, isAnchor: false, isDirect: false }

  it('names a workspace package as one, never by its node id', () => {
    const title = chipTitle({ ...chipBase, id: 'importer:apps/api', label: 'api', name: 'api', version: '', isImporter: true })
    assert.equal(title, 'workspace package api')
  })

  it('names a package by its name and version', () => {
    const title = chipTitle({ ...chipBase, id: 'helper@1.0.0(react@18.2.0)', label: 'helper 1.0.0', name: 'helper', version: '1.0.0', isImporter: false })
    assert.equal(title, 'helper 1.0.0')
  })
})

function diamond() {
  return makeGraph({
    importers: { web: ['top@1.0.0'], admin: ['right@1.0.0'] },
    packages: {
      'top@1.0.0': ['left@1.0.0', 'right@1.0.0'],
      'left@1.0.0': ['bottom@1.0.0'],
      'right@1.0.0': ['bottom@1.0.0'],
      'bottom@1.0.0': ['leaf@1.0.0'],
      'leaf@1.0.0': [],
    },
  })
}

function sorted(ids: ReadonlySet<string>): string[] {
  return [...ids].sort()
}

describe('trailPathIds', () => {
  const upward = dependents(diamond(), 'bottom@1.0.0', 50, ALL_KINDS)

  it('keeps one side of a diamond: the chip, its ancestors and its way down to the anchor', () => {
    assert.deepEqual(sorted(trailPathIds(upward, 'left@1.0.0')), ['bottom@1.0.0', 'importer:web', 'left@1.0.0', 'top@1.0.0'])
  })

  it('includes every workspace package above the chip', () => {
    assert.deepEqual(sorted(trailPathIds(upward, 'right@1.0.0')), ['bottom@1.0.0', 'importer:admin', 'importer:web', 'right@1.0.0', 'top@1.0.0'])
  })

  it('includes both sides of the diamond below the chip, but not a workspace package that only reaches one side', () => {
    assert.deepEqual(sorted(trailPathIds(upward, 'top@1.0.0')), ['bottom@1.0.0', 'importer:web', 'left@1.0.0', 'right@1.0.0', 'top@1.0.0'])
  })

  it('follows a workspace package down to the anchor', () => {
    assert.deepEqual(sorted(trailPathIds(upward, 'importer:admin')), ['bottom@1.0.0', 'importer:admin', 'right@1.0.0'])
  })

  it('keeps every path for the anchor itself', () => {
    assert.deepEqual(sorted(trailPathIds(upward, 'bottom@1.0.0')), [
      'bottom@1.0.0',
      'importer:admin',
      'importer:web',
      'left@1.0.0',
      'right@1.0.0',
      'top@1.0.0',
    ])
  })

  it('routes a package the anchor pulls in through every path to the anchor', () => {
    assert.deepEqual(sorted(trailPathIds(upward, 'leaf@1.0.0')), [
      'bottom@1.0.0',
      'importer:admin',
      'importer:web',
      'leaf@1.0.0',
      'left@1.0.0',
      'right@1.0.0',
      'top@1.0.0',
    ])
  })
})

describe('movedTrailPosition', () => {
  const graph = diamond()
  const upward = dependents(graph, 'bottom@1.0.0', 50, ALL_KINDS)
  const columns = buildTrailColumns(upward, children(graph, 'bottom@1.0.0', 1, ALL_KINDS))
  const none: ReadonlySet<string> = new Set()

  it('lays out the diamond the way the moves expect', () => {
    assert.deepEqual(outline(columns), [['admin', 'web'], ['right 1.0.0', 'top 1.0.0'], ['left 1.0.0'], ['bottom 1.0.0'], ['leaf 1.0.0']])
  })

  it('moves up and down inside a column without wrapping', () => {
    assert.deepEqual(movedTrailPosition(columns, { column: 1, chip: 0 }, 'ArrowDown', none), { column: 1, chip: 1 })
    assert.equal(movedTrailPosition(columns, { column: 1, chip: 1 }, 'ArrowDown', none), undefined)
    assert.deepEqual(movedTrailPosition(columns, { column: 1, chip: 1 }, 'ArrowUp', none), { column: 1, chip: 0 })
    assert.equal(movedTrailPosition(columns, { column: 1, chip: 0 }, 'ArrowUp', none), undefined)
  })

  it('jumps to the first and last chip of a column with Home and End', () => {
    assert.deepEqual(movedTrailPosition(columns, { column: 0, chip: 0 }, 'End', none), { column: 0, chip: 1 })
    assert.deepEqual(movedTrailPosition(columns, { column: 0, chip: 1 }, 'Home', none), { column: 0, chip: 0 })
  })

  it('moves to the neighboring column onto the first chip on the paths through the current chip', () => {
    assert.deepEqual(movedTrailPosition(columns, { column: 2, chip: 0 }, 'ArrowLeft', trailPathIds(upward, 'left@1.0.0')), { column: 1, chip: 1 })
    assert.deepEqual(movedTrailPosition(columns, { column: 1, chip: 1 }, 'ArrowLeft', trailPathIds(upward, 'top@1.0.0')), { column: 0, chip: 1 })
    assert.deepEqual(movedTrailPosition(columns, { column: 2, chip: 0 }, 'ArrowRight', trailPathIds(upward, 'left@1.0.0')), { column: 3, chip: 0 })
  })

  it('keeps the row, as far as the neighboring column allows, when no chip there is on a path', () => {
    assert.deepEqual(movedTrailPosition(columns, { column: 0, chip: 1 }, 'ArrowRight', none), { column: 1, chip: 1 })
    assert.deepEqual(movedTrailPosition(columns, { column: 1, chip: 1 }, 'ArrowRight', none), { column: 2, chip: 0 })
  })

  it('stops at the first and the last column and ignores other keys', () => {
    assert.equal(movedTrailPosition(columns, { column: 0, chip: 0 }, 'ArrowLeft', none), undefined)
    assert.equal(movedTrailPosition(columns, { column: 4, chip: 0 }, 'ArrowRight', none), undefined)
    assert.equal(movedTrailPosition(columns, { column: 0, chip: 0 }, 'a', none), undefined)
  })
})
