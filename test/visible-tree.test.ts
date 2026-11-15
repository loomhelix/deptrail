import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChildRow } from '../src/query/children.ts'
import type { NodeView } from '../src/query/lookup.ts'
import type { RootSummary } from '../ui/src/api.ts'
import { flattenVisible, overviewRows, rangeText, ROW_HEIGHT, windowRange, type VisibleRow } from '../ui/src/visible-tree.ts'

function view(name: string, version = '1.0.0'): NodeView {
  return { id: `${name}@${version}`, name, version, isImporter: false, isPlaceholder: false }
}

function child(name: string, options: { hasChildren?: boolean; repeated?: boolean } = {}): ChildRow {
  return { node: view(name), kind: 'prod', range: '1.0.0', hasChildren: options.hasChildren ?? false, repeated: options.repeated ?? false }
}

const START = view('start')

function outline(rows: VisibleRow[]): string[] {
  return rows.map((row) => `${'  '.repeat(row.depth)}${row.node.name}${row.shownAbove ? ' shown above' : ''}`)
}

function expandedSet(...names: string[]): Set<string> {
  return new Set(names.map((name) => `${name}@1.0.0`))
}

describe('flattenVisible', () => {
  it('lists the start row and its children when the start is expanded', () => {
    const children = new Map([[START.id, [child('a', { hasChildren: true }), child('b')]]])
    const rows = flattenVisible(START, children, expandedSet('start'), null)
    assert.deepEqual(outline(rows), ['start', '  a', '  b'])
    assert.equal(rows[0]!.expanded, true)
    assert.equal(rows[1]!.hasChildren, true)
    assert.equal(rows[1]!.expanded, false)
  })

  it('marks only the rows directly under an importer start as having an importer parent', () => {
    const importer: NodeView = { id: 'importer:app', name: 'app', version: '', isImporter: true, isPlaceholder: false }
    const children = new Map([
      [importer.id, [child('a', { hasChildren: true })]],
      ['a@1.0.0', [child('b')]],
    ])
    const rows = flattenVisible(importer, children, new Set([importer.id, 'a@1.0.0']), null)
    assert.deepEqual(
      rows.map((row) => row.parentIsImporter),
      [false, true, false],
    )
    const plain = flattenVisible(START, new Map([[START.id, [child('a')]]]), expandedSet('start'), null)
    assert.deepEqual(
      plain.map((row) => row.parentIsImporter),
      [false, false],
    )
  })

  it('inserts the children of an expanded row below it and flags a still-loading expansion', () => {
    const children = new Map([
      [START.id, [child('a', { hasChildren: true }), child('b', { hasChildren: true })]],
      ['a@1.0.0', [child('leaf')]],
    ])
    const rows = flattenVisible(START, children, expandedSet('start', 'a', 'b'), null)
    assert.deepEqual(outline(rows), ['start', '  a', '    leaf', '  b'])
    assert.equal(rows.find((row) => row.node.name === 'b')!.loading, true)
    assert.equal(rows.find((row) => row.node.name === 'a')!.loading, false)
  })

  it('marks a row whose id is already expanded higher up as shown above without an expander', () => {
    const children = new Map([
      [START.id, [child('a', { hasChildren: true }), child('b', { hasChildren: true })]],
      ['a@1.0.0', [child('shared', { hasChildren: true })]],
      ['b@1.0.0', [child('shared', { hasChildren: true })]],
      ['shared@1.0.0', [child('deep')]],
    ])
    const rows = flattenVisible(START, children, expandedSet('start', 'a', 'b', 'shared'), null)
    assert.deepEqual(outline(rows), ['start', '  a', '    shared', '      deep', '  b', '    shared shown above'])
    const repeated = rows.at(-1)!
    assert.equal(repeated.hasChildren, false)
    assert.equal(repeated.expanded, false)
  })

  it('treats a row the server marked repeated as shown above', () => {
    const children = new Map([[START.id, [child('loop', { hasChildren: true, repeated: true })]]])
    const rows = flattenVisible(START, children, expandedSet('start'), null)
    assert.deepEqual(outline(rows), ['start', '  loop shown above'])
    assert.equal(rows[1]!.hasChildren, false)
  })

  it('hides names that are not duplicates unless they are expanded', () => {
    const children = new Map([
      [START.id, [child('plain'), child('path-to-dup', { hasChildren: true }), child('dup')]],
      ['path-to-dup@1.0.0', [child('dup'), child('other')]],
    ])
    const duplicateNames = new Set(['dup'])
    const rows = flattenVisible(START, children, expandedSet('start', 'path-to-dup'), duplicateNames)
    assert.deepEqual(outline(rows), ['start', '  path-to-dup', '    dup', '  dup'])
  })

  it('stops at a cycle because every id is expanded once', () => {
    const children = new Map([
      [START.id, [child('a', { hasChildren: true })]],
      ['a@1.0.0', [{ ...child('start', { hasChildren: true }), node: START }]],
    ])
    const rows = flattenVisible(START, children, expandedSet('start', 'a'), null)
    assert.deepEqual(outline(rows), ['start', '  a', '    start shown above'])
  })
})

describe('row keys', () => {
  it('give each row a unique key, also for a package listed under two parents', () => {
    const children = new Map([
      [START.id, [child('a', { hasChildren: true }), child('b', { hasChildren: true })]],
      ['a@1.0.0', [child('shared')]],
      ['b@1.0.0', [child('shared')]],
    ])
    const rows = flattenVisible(START, children, expandedSet('start', 'a', 'b'), null)
    assert.deepEqual(outline(rows), ['start', '  a', '    shared', '  b', '    shared'])
    assert.equal(new Set(rows.map((row) => row.key)).size, rows.length)
  })

  it('point each row to the key of its parent row', () => {
    const children = new Map([
      [START.id, [child('a', { hasChildren: true })]],
      ['a@1.0.0', [child('leaf')]],
    ])
    const rows = flattenVisible(START, children, expandedSet('start', 'a'), null)
    assert.deepEqual(
      rows.map((row) => row.parentKey),
      [undefined, rows[0]!.key, rows[1]!.key],
    )
  })

  it('keep the key of a row when a row above it expands', () => {
    const children = new Map([
      [START.id, [child('a', { hasChildren: true }), child('b')]],
      ['a@1.0.0', [child('leaf')]],
    ])
    const collapsed = flattenVisible(START, children, expandedSet('start'), null)
    const expanded = flattenVisible(START, children, expandedSet('start', 'a'), null)
    const keyOf = (rows: VisibleRow[], name: string) => rows.find((row) => row.node.name === name)!.key
    assert.equal(keyOf(expanded, 'b'), keyOf(collapsed, 'b'))
  })

  it('count the position of each row among its visible siblings', () => {
    const children = new Map([[START.id, [child('a'), child('b'), child('c')]]])
    const rows = flattenVisible(START, children, expandedSet('start'), null)
    assert.deepEqual(
      rows.map((row) => `${row.position}/${row.setSize}`),
      ['1/1', '1/3', '2/3', '3/3'],
    )
  })
})

function workspacePackage(path: string, name: string, dependencyCount: number): RootSummary['importers'][number] {
  return { id: `importer:${path}`, path: path === '.' ? 'shop' : `shop/${path}`, name, dependencyCount }
}

function importerView(path: string, name: string): NodeView {
  return { id: `importer:${path}`, name, version: '', isImporter: true, isPlaceholder: false }
}

describe('overviewRows', () => {
  const API = workspacePackage('apps/api', 'api', 2)
  const WEB = workspacePackage('apps/web', 'web', 1)
  const EMPTY = workspacePackage('tools/empty', 'empty', 0)

  it('lists the workspace packages at the top level and leaves out a root package without dependencies', () => {
    const rows = overviewRows([workspacePackage('.', 'shop', 0), API, WEB, EMPTY], new Map(), new Set())
    assert.deepEqual(outline(rows), ['api', 'web', 'empty'])
    assert.deepEqual(
      rows.map((row) => [row.depth, row.hasChildren, row.expanded, row.node.isImporter]),
      [
        [0, true, false, true],
        [0, true, false, true],
        [0, false, false, true],
      ],
    )
    assert.deepEqual(rows[0]!.node, importerView('apps/api', 'api'))
  })

  it('lists a root package that has dependencies first, like any workspace package', () => {
    const rows = overviewRows([workspacePackage('.', 'shop', 3), API], new Map(), new Set())
    assert.deepEqual(outline(rows), ['shop', 'api'])
    assert.equal(rows[0]!.node.id, 'importer:.')
  })

  it('shows the dependencies of an expanded workspace package as direct ones and flags one still loading', () => {
    const children = new Map([[API.id, [child('a', { hasChildren: true }), child('b')]]])
    const rows = overviewRows([API, WEB], children, new Set([API.id, WEB.id]))
    assert.deepEqual(outline(rows), ['api', '  a', '  b', 'web'])
    assert.deepEqual(
      rows.map((row) => row.parentIsImporter),
      [false, true, true, false],
    )
    assert.equal(rows.at(-1)!.loading, true)
    assert.equal(rows[0]!.loading, false)
    assert.deepEqual(
      rows.map((row) => `${row.position}/${row.setSize}`),
      ['1/2', '1/2', '2/2', '2/2'],
    )
  })

  it('marks a package already expanded under another workspace package as shown above', () => {
    const children = new Map([
      [API.id, [child('shared', { hasChildren: true })]],
      [WEB.id, [child('shared', { hasChildren: true })]],
      ['shared@1.0.0', [child('deep')]],
    ])
    const rows = overviewRows([API, WEB], children, new Set([API.id, WEB.id, 'shared@1.0.0']))
    assert.deepEqual(outline(rows), ['api', '  shared', '    deep', 'web', '  shared shown above'])
  })

  describe('a workspace package that another one depends on', () => {
    const UI = workspacePackage('packages/ui', 'ui', 1)
    const linkTo = (target: RootSummary['importers'][number], hasChildren = true): ChildRow => ({
      node: importerView(target.path.slice('shop/'.length), target.name),
      kind: 'prod',
      range: 'workspace:*',
      hasChildren,
      repeated: false,
    })
    const topLevelState = (rows: VisibleRow[]) =>
      rows.filter((row) => row.depth === 0).map((row) => [row.node.name, row.hasChildren, row.expanded, row.shownAbove])
    const nestedLink = (rows: VisibleRow[]) => rows.find((row) => row.depth > 0 && row.node.isImporter)!

    it('lists the nested copy as listed below, without a toggle, when the depending package comes first', () => {
      const children = new Map([
        [WEB.id, [linkTo(UI), child('react')]],
        [UI.id, [child('lodash')]],
      ])
      const rows = overviewRows([WEB, UI], children, new Set([WEB.id, UI.id]))
      assert.deepEqual(outline(rows), ['web', '  ui', '  react', 'ui', '  lodash'])
      assert.deepEqual(topLevelState(rows), [
        ['web', true, true, false],
        ['ui', true, true, false],
      ])
      const nested = nestedLink(rows)
      assert.deepEqual([nested.hasChildren, nested.expanded, nested.shownAbove, nested.listed], [false, false, false, 'below'])
    })

    it('lists the nested copy as listed above, without a toggle, when the depending package comes second', () => {
      const children = new Map([
        [UI.id, [child('lodash')]],
        [WEB.id, [linkTo(UI), child('react')]],
      ])
      const rows = overviewRows([UI, WEB], children, new Set([UI.id, WEB.id]))
      assert.deepEqual(outline(rows), ['ui', '  lodash', 'web', '  ui', '  react'])
      assert.deepEqual(topLevelState(rows), [
        ['ui', true, true, false],
        ['web', true, true, false],
      ])
      const nested = nestedLink(rows)
      assert.deepEqual([nested.hasChildren, nested.expanded, nested.shownAbove, nested.listed], [false, false, false, 'above'])
    })

    it('expands only the top-level row of a workspace package whose nested copy comes first', () => {
      const children = new Map([
        [WEB.id, [linkTo(UI)]],
        [UI.id, [child('lodash')]],
      ])
      const onlyUi = overviewRows([WEB, UI], children, new Set([UI.id]))
      assert.deepEqual(outline(onlyUi), ['web', 'ui', '  lodash'])
      const both = overviewRows([WEB, UI], children, new Set([WEB.id, UI.id]))
      assert.deepEqual(outline(both), ['web', '  ui', 'ui', '  lodash'])
      assert.deepEqual(topLevelState(both), [
        ['web', true, true, false],
        ['ui', true, true, false],
      ])
    })

    it('keeps both top-level rows in charge of their own expansion when each depends on the other', () => {
      const children = new Map([
        [WEB.id, [linkTo(UI), child('react')]],
        [UI.id, [linkTo(WEB), child('lodash')]],
      ])
      const rows = overviewRows([WEB, UI], children, new Set([WEB.id, UI.id]))
      assert.deepEqual(outline(rows), ['web', '  ui', '  react', 'ui', '  web', '  lodash'])
      assert.deepEqual(topLevelState(rows), [
        ['web', true, true, false],
        ['ui', true, true, false],
      ])
      assert.deepEqual(
        rows.filter((row) => row.depth > 0 && row.node.isImporter).map((row) => [row.node.name, row.hasChildren, row.expanded, row.listed]),
        [
          ['ui', false, false, 'below'],
          ['web', false, false, 'above'],
        ],
      )
      const collapsedWeb = overviewRows([WEB, UI], children, new Set([UI.id]))
      assert.deepEqual(outline(collapsedWeb), ['web', 'ui', '  web', '  lodash'])
      assert.deepEqual(topLevelState(collapsedWeb), [
        ['web', true, false, false],
        ['ui', true, true, false],
      ])
    })

    it('says listed above for a link back to the workspace package it sits under', () => {
      const children = new Map([[WEB.id, [linkTo(WEB)]]])
      const rows = overviewRows([WEB], children, new Set([WEB.id]))
      assert.deepEqual(outline(rows), ['web', '  web'])
      assert.equal(rows[1]!.listed, 'above')
    })

    it('hides a nested copy under the duplicates filter, since nothing below it can be a duplicate on this path', () => {
      const children = new Map([[WEB.id, [linkTo(UI), child('dup')]]])
      const rows = overviewRows([WEB, UI], children, new Set([WEB.id, UI.id]), new Set(['dup']))
      assert.deepEqual(outline(rows), ['web', '  dup', 'ui'])
    })
  })

  it('keeps every workspace package but filters their dependencies to duplicates', () => {
    const children = new Map([[API.id, [child('plain'), child('dup')]]])
    const rows = overviewRows([API, WEB], children, new Set([API.id]), new Set(['dup']))
    assert.deepEqual(outline(rows), ['api', '  dup', 'web'])
  })
})

describe('rangeText', () => {
  it('says what a range requires', () => {
    assert.equal(rangeText('^2.0.0', '2.0.0'), 'requires ^2.0.0')
    assert.equal(rangeText('workspace:*', ''), 'requires workspace:*')
  })

  it('says nothing when the range is the exact version of the child', () => {
    assert.equal(rangeText('2.0.0', '2.0.0'), undefined)
    assert.equal(rangeText('1.0.0', '1.0.0'), undefined)
  })

  it('keeps an exact range that differs from the version', () => {
    assert.equal(rangeText('1.0.0', '1.0.1'), 'requires 1.0.0')
  })

  it('says nothing without a range', () => {
    assert.equal(rangeText(undefined, '2.0.0'), undefined)
    assert.equal(rangeText('', '2.0.0'), undefined)
  })
})

describe('windowRange', () => {
  it('returns the rows in the viewport plus the overscan', () => {
    const range = windowRange(ROW_HEIGHT * 100, ROW_HEIGHT * 10, 2000, 5)
    assert.deepEqual(range, { start: 95, end: 115 })
  })

  it('clamps at both ends of the list', () => {
    assert.deepEqual(windowRange(0, ROW_HEIGHT * 10, 2000, 5), { start: 0, end: 15 })
    assert.deepEqual(windowRange(ROW_HEIGHT * 1990, ROW_HEIGHT * 10, 2000, 5), { start: 1985, end: 2000 })
    assert.deepEqual(windowRange(0, ROW_HEIGHT * 10, 3, 5), { start: 0, end: 3 })
    assert.deepEqual(windowRange(0, ROW_HEIGHT * 10, 0, 5), { start: 0, end: 0 })
  })

  it('includes a partially visible last row', () => {
    assert.deepEqual(windowRange(ROW_HEIGHT * 2 + 10, ROW_HEIGHT * 2, 100, 0), { start: 2, end: 5 })
  })
})
