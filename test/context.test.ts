import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSelection,
  exploreAnchor,
  focusOn,
  followSelectionTo,
  openInRoot,
  openRootChanges,
  openRootIssues,
  openTrail,
  openTree,
  openWorkspacePackage,
  orderByScope,
  orderHitsByScope,
  pickSearchOption,
  readContext,
  selectInExplore,
  selectPackage,
  setCompareBase,
  setFilters,
  setMergeBase,
  setMode,
  setScope,
  setView,
  writeContext,
  exploreRoot,
  type UiContext,
} from '../ui/src/context.ts'

const ALL_KINDS = ['prod', 'dev', 'optional', 'peer']
const ALL_TYPES = ['vulnerability', 'deprecated', 'outdated']

function assertScopeInvariant(context: UiContext): void {
  if (context.root !== undefined && context.selection !== undefined) {
    assert.equal(context.selection.root, context.root)
  }
}

describe('context state', () => {
  it('reads the defaults from an empty query', () => {
    assert.deepEqual(readContext(''), {
      view: 'issues',
      mode: 'trail',
      kinds: ALL_KINDS,
      types: ALL_TYPES,
      group: 'package',
      duplicatesOnly: false,
      up: 3,
      down: 1,
      mergeBase: false,
    })
  })

  it('reads and writes ref, base and merge base', () => {
    const context = readContext('?ref=refs/heads/%C3%BC&view=compare&base=work&mb=1')
    assert.equal(context.ref, 'refs/heads/ü')
    assert.equal(context.view, 'compare')
    assert.equal(context.base, 'work')
    assert.equal(context.mergeBase, true)
    assert.deepEqual(readContext(writeContext(context)), context)
    assert.ok(writeContext(context).startsWith('?ref='))
    assert.equal(readContext('?view=compare').mergeBase, false)
    const unusual = readContext(`?ref=${encodeURIComponent('refs/heads/fix/@scope#1')}`)
    assert.equal(readContext(writeContext(unusual)).ref, 'refs/heads/fix/@scope#1')
  })

  it('changes the compare base and merge base in place', () => {
    const context = readContext('?view=compare')
    const based = setCompareBase(context, 'refs/heads/main')
    assert.equal(based.history, 'replace')
    assert.equal(based.context.base, 'refs/heads/main')
    assert.equal(setCompareBase(based.context, undefined).context.base, undefined)
    const merged = setMergeBase(context, true)
    assert.equal(merged.history, 'replace')
    assert.equal(merged.context.mergeBase, true)
  })

  it('writes an empty string for the defaults', () => {
    assert.equal(writeContext(readContext('')), '')
  })

  it('reads a scoped selection from root and focus', () => {
    const context = readContext('?root=shop&focus=helper@1.0.0')
    assert.equal(context.root, 'shop')
    assert.deepEqual(context.selection, { root: 'shop', node: 'helper@1.0.0' })
  })

  it('reads the selection root from in when the scope is all roots', () => {
    const context = readContext('?in=shop-npm&focus=helper@1.0.0')
    assert.equal(context.root, undefined)
    assert.deepEqual(context.selection, { root: 'shop-npm', node: 'helper@1.0.0' })
  })

  it('ignores in when it disagrees with root', () => {
    const context = readContext('?root=shop&in=other&focus=helper@1.0.0')
    assert.deepEqual(context.selection, { root: 'shop', node: 'helper@1.0.0' })
  })

  it('yields no selection for focus without root and without in', () => {
    assert.equal(readContext('?focus=helper@1.0.0').selection, undefined)
  })

  it('ignores the scope parameter and unknown parameters', () => {
    assert.deepEqual(readContext('?scope=root&bogus=1'), readContext(''))
  })

  it('reads the old view names as explore modes', () => {
    for (const mode of ['tree', 'trail', 'graph']) {
      const context = readContext(`?view=${mode}`)
      assert.deepEqual([context.view, context.mode], ['explore', mode])
    }
  })

  it('reads the view, the mode and the anchor', () => {
    const context = readContext('?root=shop&view=explore&mode=graph&at=helper@1.0.0')
    assert.deepEqual([context.view, context.mode, context.anchor], ['explore', 'graph', { root: 'shop', node: 'helper@1.0.0' }])
  })

  it('falls back to defaults for unknown values', () => {
    const context = readContext('?view=table&mode=bogus&kinds=bogus&types=bogus&group=bogus&dup=yes&up=-1&down=1.5&root=&focus=')
    assert.deepEqual(context, readContext(''))
  })

  it('keeps known kinds and types in canonical order and drops unknown ones', () => {
    assert.deepEqual(readContext('?kinds=peer,bogus,prod,prod').kinds, ['prod', 'peer'])
    assert.deepEqual(readContext('?types=outdated,vulnerability').types, ['vulnerability', 'outdated'])
  })

  it('writes the selection root as in only when the scope is all roots', () => {
    assert.equal(writeContext(readContext('?in=shop-npm&focus=helper@1.0.0')), '?in=shop-npm&focus=helper@1.0.0')
    assert.equal(writeContext(readContext('?root=shop&focus=helper@1.0.0')), '?root=shop&focus=helper@1.0.0')
  })

  it('omits default values and keeps reserved characters readable', () => {
    const query = writeContext(readContext('?root=npm-package&focus=%40scope%2Fpkg%401.0.0'))
    assert.equal(query, '?root=npm-package&focus=@scope/pkg@1.0.0')
  })

  it('round-trips every parameter', () => {
    const context = readContext('?root=shop&focus=helper@1.0.0&view=explore&mode=graph&at=lib@2.0.0&kinds=prod,peer&types=vulnerability&group=direct&dup=1&up=5&down=0')
    assert.deepEqual(readContext(writeContext(context)), context)
  })

  it('round-trips slash and repository root ids and peer suffixes', () => {
    for (const root of ['legacy/admin', '.']) {
      const context = readContext(`?in=${encodeURIComponent(root)}&focus=${encodeURIComponent('vue-eslint-parser@9.4.3(eslint@9.17.0)')}`)
      assert.deepEqual(readContext(writeContext(context)), context)
    }
  })

  it('keeps reserved characters inside values intact', () => {
    const context = readContext(`?root=${encodeURIComponent('a&b=c')}&focus=${encodeURIComponent('x+y@1.0.0#tag')}`)
    assert.deepEqual(readContext(writeContext(context)), context)
  })

  it('names the explore root as the scope root or the selection root', () => {
    assert.equal(exploreRoot(readContext('?root=shop')), 'shop')
    assert.equal(exploreRoot(readContext('?in=shop-npm&focus=a@1.0.0')), 'shop-npm')
    assert.equal(exploreRoot(readContext('')), undefined)
  })

  it('names the anchor node only when the anchor belongs to the explore root', () => {
    assert.equal(exploreAnchor(readContext('?root=shop&focus=a@1.0.0&at=b@1.0.0')), 'b@1.0.0')
    assert.equal(exploreAnchor(readContext('?in=shop-npm&focus=a@1.0.0&at=b@1.0.0')), 'b@1.0.0')
    assert.equal(exploreAnchor(readContext('?root=shop&focus=a@1.0.0')), undefined)
    const stale = { ...readContext('?root=shop&focus=a@1.0.0'), anchor: { root: 'admin', node: 'b@1.0.0' } }
    assert.equal(exploreAnchor(stale), undefined)
  })
})

describe('context transitions', () => {
  it('keeps the node and moves the selection when the scope changes to a root', () => {
    const start = readContext('?in=shop-npm&focus=helper@1.0.0')
    const { context, history } = setScope(start, 'shop')
    assert.equal(context.root, 'shop')
    assert.deepEqual(context.selection, { root: 'shop', node: 'helper@1.0.0' })
    assert.equal(history, 'push')
  })

  it('keeps the selection root when the scope changes to all roots', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0')
    const { context } = setScope(start, undefined)
    assert.equal(context.root, undefined)
    assert.deepEqual(context.selection, { root: 'shop', node: 'helper@1.0.0' })
  })

  it('gives the anchor the explore root of the url and drops it without one', () => {
    assert.deepEqual(readContext('?in=shop&focus=a@1.0.0&at=b@1.0.0').anchor, { root: 'shop', node: 'b@1.0.0' })
    assert.equal(readContext('?at=b@1.0.0').anchor, undefined)
  })

  it('writes only the anchor node', () => {
    assert.equal(writeContext(readContext('?root=shop&at=b@1.0.0')), '?root=shop&at=b@1.0.0')
  })

  it('resets the anchor to the selection node when the explore root changes', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=explore&at=other@1.0.0')
    const { context } = setScope(start, 'admin')
    assert.deepEqual(context.anchor, { root: 'admin', node: 'helper@1.0.0' })
  })

  it('keeps the anchor when the explore root stays', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=explore&at=other@1.0.0')
    assert.deepEqual(setScope(start, 'shop').context.anchor, { root: 'shop', node: 'other@1.0.0' })
  })

  it('resets the anchor when openInRoot, openWorkspacePackage, openRootIssues or openRootChanges change the explore root', () => {
    const start = readContext('?root=shop&focus=a@1.0.0&view=explore&at=other@1.0.0')
    const selection = { root: 'admin', node: 'b@1.0.0' }
    assert.deepEqual(openInRoot(start, selection).context.anchor, selection)
    assert.deepEqual(openWorkspacePackage(start, selection).context.anchor, selection)
    assert.deepEqual(openRootIssues(start, 'admin', 'outdated').context.anchor, { root: 'admin', node: 'a@1.0.0' })
    assert.deepEqual(openRootChanges(start, 'admin').context.anchor, { root: 'admin', node: 'a@1.0.0' })
  })

  it('selects a package in scope without changing anything else', () => {
    const start = readContext('?root=shop&view=changes')
    const { context, history } = selectPackage(start, { root: 'shop', node: 'helper@1.0.0' })
    assert.deepEqual(context, { ...start, selection: { root: 'shop', node: 'helper@1.0.0' } })
    assert.equal(history, 'push')
  })

  it('selects a package of another root under all roots without a scope', () => {
    const start = readContext('?in=shop&focus=a@1.0.0')
    const { context } = selectPackage(start, { root: 'admin', node: 'b@1.0.0' })
    assert.equal(context.root, undefined)
    assert.deepEqual(context.selection, { root: 'admin', node: 'b@1.0.0' })
  })

  it('moves the anchor in explore to a package selected outside the explore content', () => {
    const start = readContext('?root=shop-npm&focus=child-lib@1.0.0&view=explore&at=child-lib@1.0.0')
    const { context, history } = selectPackage(start, { root: 'shop-npm', node: 'helper@1.0.0' })
    assert.deepEqual(context.selection, { root: 'shop-npm', node: 'helper@1.0.0' })
    assert.deepEqual(context.anchor, { root: 'shop-npm', node: 'helper@1.0.0' })
    assert.equal(history, 'push')
  })

  it('keeps the anchor when a package is selected inside the explore content', () => {
    const start = readContext('?root=shop-npm&focus=child-lib@1.0.0&view=explore&at=child-lib@1.0.0')
    const { context, history } = selectInExplore(start, { root: 'shop-npm', node: 'helper@1.0.0' })
    assert.deepEqual(context.selection, { root: 'shop-npm', node: 'helper@1.0.0' })
    assert.deepEqual(context.anchor, { root: 'shop-npm', node: 'child-lib@1.0.0' })
    assert.equal(history, 'push')
  })

  it('moves the anchor in explore to a workspace package opened from the roots panel in the same root', () => {
    const start = readContext('?root=shop&focus=importer:api&view=explore&mode=tree&at=importer:api')
    const selection = { root: 'shop', node: 'importer:web' }
    const { context } = openWorkspacePackage(start, selection)
    assert.deepEqual(context.anchor, selection)
    assert.equal(writeContext(context), '?root=shop&focus=importer:web&view=explore&mode=tree&at=importer:web')
  })

  it('moves the anchor in explore to a search pick in the same root', () => {
    const start = readContext('?root=shop&focus=a@1.0.0&view=explore&at=a@1.0.0')
    const selection = { root: 'shop', node: 'b@1.0.0' }
    assert.deepEqual(pickSearchOption(start, selection).context.anchor, selection)
  })

  it('leaves the anchor alone when a package is selected outside explore', () => {
    const start = readContext('?root=shop&focus=a@1.0.0&at=a@1.0.0')
    const selection = { root: 'shop', node: 'b@1.0.0' }
    assert.deepEqual(selectPackage(start, selection).context.anchor, { root: 'shop', node: 'a@1.0.0' })
    assert.deepEqual(openWorkspacePackage(start, selection).context.anchor, { root: 'shop', node: 'a@1.0.0' })
  })

  it('resets the anchor when a selection under all roots moves the explore root', () => {
    const start = readContext('?in=shop&focus=a@1.0.0&view=explore&at=a@1.0.0')
    const selection = { root: 'admin', node: 'b@1.0.0' }
    assert.deepEqual(selectPackage(start, selection).context.anchor, selection)
  })

  it('behaves like openInRoot when selecting a package of another root than the scope', () => {
    const start = readContext('?root=shop')
    const selection = { root: 'admin', node: 'b@1.0.0' }
    const result = selectPackage(start, selection)
    assert.deepEqual(result, openInRoot(start, selection))
    assert.equal(result.context.root, 'admin')
    assertScopeInvariant(result.context)
  })

  it('opens in the selection root for a single-root scope', () => {
    const start = readContext('?root=shop')
    const { context, history } = openInRoot(start, { root: 'admin', node: 'b@1.0.0' })
    assert.equal(context.root, 'admin')
    assert.deepEqual(context.selection, { root: 'admin', node: 'b@1.0.0' })
    assert.equal(history, 'push')
  })

  it('leaves the scope unset when opening in a root under all roots', () => {
    const { context } = openInRoot(readContext(''), { root: 'admin', node: 'b@1.0.0' })
    assert.equal(context.root, undefined)
    assert.deepEqual(context.selection, { root: 'admin', node: 'b@1.0.0' })
  })

  it('opens a workspace package by scoping to its root', () => {
    const { context, history } = openWorkspacePackage(readContext(''), { root: 'admin', node: 'importer:admin' })
    assert.equal(context.root, 'admin')
    assert.deepEqual(context.selection, { root: 'admin', node: 'importer:admin' })
    assert.equal(history, 'push')
  })

  it('picks a search option in scope like selectPackage', () => {
    const start = readContext('?root=shop')
    const selection = { root: 'shop', node: 'helper@1.0.0' }
    const result = pickSearchOption(start, selection)
    assert.deepEqual({ context: result.context, history: result.history }, selectPackage(start, selection))
    assert.equal(result.switchedTo, undefined)
  })

  it('switches the scope when a search option names another root', () => {
    const start = readContext('?root=shop-npm')
    const result = pickSearchOption(start, { root: 'shop', node: 'helper@1.0.0' })
    assert.equal(result.context.root, 'shop')
    assert.equal(result.switchedTo, 'shop')
    assert.equal(result.history, 'push')
  })

  it('picks a search option under all roots without switching', () => {
    const result = pickSearchOption(readContext(''), { root: 'shop', node: 'helper@1.0.0' })
    assert.equal(result.context.root, undefined)
    assert.equal(result.switchedTo, undefined)
  })

  it('opens the issues of a root for one kind', () => {
    const { context, history } = openRootIssues(readContext('?view=changes'), 'shop', 'vulnerability')
    assert.deepEqual([context.root, context.view, context.types], ['shop', 'issues', ['vulnerability']])
    assert.equal(history, 'push')
  })

  it('opens the changes of a root', () => {
    const { context, history } = openRootChanges(readContext(''), 'shop')
    assert.deepEqual([context.root, context.view], ['shop', 'changes'])
    assert.equal(history, 'push')
  })

  it('keeps the invariant when opening a root with a selection from another root', () => {
    const start = readContext('?in=admin&focus=a@1.0.0')
    assertScopeInvariant(openRootIssues(start, 'shop', 'outdated').context)
    assertScopeInvariant(openRootChanges(start, 'shop').context)
  })

  it('re-roots the selection like setScope when opening the issues or changes of a root', () => {
    const start = readContext('?in=admin&focus=a@1.0.0')
    const expected = { root: 'shop', node: 'a@1.0.0' }
    assert.deepEqual(openRootIssues(start, 'shop', 'outdated').context.selection, expected)
    assert.deepEqual(openRootChanges(start, 'shop').context.selection, expected)
  })

  it('opens the trail around the selection', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=issues&mode=graph')
    const { context, history } = openTrail(start)
    assert.deepEqual([context.view, context.mode, context.anchor], ['explore', 'trail', { root: 'shop', node: 'helper@1.0.0' }])
    assert.equal(history, 'push')
  })

  it('opens what the selection pulls in', () => {
    const start = readContext('?root=shop&focus=importer:web&view=issues')
    const { context, history } = openTree(start)
    assert.deepEqual([context.view, context.mode, context.anchor], ['explore', 'tree', { root: 'shop', node: 'importer:web' }])
    assert.equal(history, 'push')
  })

  it('clears the selection with a history entry', () => {
    const { context, history } = clearSelection(readContext('?root=shop&focus=helper@1.0.0'))
    assert.equal(context.selection, undefined)
    assert.equal(context.root, 'shop')
    assert.equal(history, 'push')
  })

  it('anchors on the selection when entering explore without an anchor', () => {
    const { context, history } = setView(readContext('?root=shop&focus=helper@1.0.0'), 'explore')
    assert.deepEqual([context.view, context.anchor], ['explore', { root: 'shop', node: 'helper@1.0.0' }])
    assert.equal(history, 'replace')
  })

  it('anchors on the selection when entering explore from another view, replacing an older anchor of the same root', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&at=other@1.0.0')
    assert.deepEqual(setView(start, 'explore').context.anchor, { root: 'shop', node: 'helper@1.0.0' })
  })

  it('resets a stale anchor of another explore root when entering explore', () => {
    const stale = { ...readContext('?root=shop&focus=helper@1.0.0&at=other@1.0.0'), anchor: { root: 'admin', node: 'other@1.0.0' } }
    assert.deepEqual(setView(stale, 'explore').context.anchor, { root: 'shop', node: 'helper@1.0.0' })
  })

  it('drops the anchor when entering explore without a selection', () => {
    const start = readContext('?root=shop&at=other@1.0.0')
    assert.equal(setView(start, 'explore').context.anchor, undefined)
  })

  it('keeps the anchor when the explore tab is chosen again inside explore', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=explore&at=other@1.0.0')
    assert.deepEqual(setView(start, 'explore').context.anchor, { root: 'shop', node: 'other@1.0.0' })
  })

  it('keeps the anchor across mode changes inside explore', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=explore&at=other@1.0.0')
    assert.deepEqual(setMode(start, 'graph').context.anchor, { root: 'shop', node: 'other@1.0.0' })
  })

  it('leaves the anchor alone for other views', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=explore&at=other@1.0.0')
    const { context, history } = setView(start, 'changes')
    assert.deepEqual(context.anchor, { root: 'shop', node: 'other@1.0.0' })
    assert.equal(context.view, 'changes')
    assert.equal(history, 'replace')
  })

  it('sets the explore mode with a replaced history entry', () => {
    const { context, history } = setMode(readContext(''), 'tree')
    assert.equal(context.mode, 'tree')
    assert.equal(history, 'replace')
  })

  it('focuses the anchor on the selection with a history entry', () => {
    const start = readContext('?root=shop&focus=helper@1.0.0&view=explore&at=other@1.0.0')
    const { context, history } = focusOn(start)
    assert.deepEqual(context.anchor, { root: 'shop', node: 'helper@1.0.0' })
    assert.equal(history, 'push')
  })

  it('moves the anchor with the selection when it follows the package to its new version', () => {
    const start = readContext('?root=shop-npm&focus=helper@1.0.0&view=explore&at=helper@1.0.0')
    const next = { root: 'shop-npm', node: 'helper@1.1.0' }
    const { context, history } = followSelectionTo(start, next)
    assert.deepEqual(context.selection, next)
    assert.deepEqual(context.anchor, next)
    assert.equal(history, 'replace')
  })

  it('moves the anchor under all roots when it was the followed node', () => {
    const start = readContext('?in=shop-npm&focus=helper@1.0.0&view=explore&at=helper@1.0.0')
    const next = { root: 'shop-npm', node: 'helper@1.1.0' }
    assert.deepEqual(followSelectionTo(start, next).context.anchor, next)
  })

  it('leaves an anchor on another package where it is when the selection follows outside explore', () => {
    const start = readContext('?root=shop-npm&focus=helper@1.0.0&at=child-lib@1.0.0')
    const { context } = followSelectionTo(start, { root: 'shop-npm', node: 'helper@1.1.0' })
    assert.deepEqual(context.selection, { root: 'shop-npm', node: 'helper@1.1.0' })
    assert.deepEqual(context.anchor, { root: 'shop-npm', node: 'child-lib@1.0.0' })
  })

  it('moves an anchor on another package to the followed package in explore', () => {
    const start = readContext('?root=shop-npm&focus=helper@1.0.0&view=explore&at=child-lib@1.0.0')
    const next = { root: 'shop-npm', node: 'helper@1.1.0' }
    const { context } = followSelectionTo(start, next)
    assert.deepEqual(context.selection, next)
    assert.deepEqual(context.anchor, next)
  })

  it('adds no anchor when the selection follows without one', () => {
    const start = readContext('?root=shop-npm&focus=helper@1.0.0')
    assert.equal(followSelectionTo(start, { root: 'shop-npm', node: 'helper@1.1.0' }).context.anchor, undefined)
  })

  it('merges filter changes with a replaced history entry', () => {
    const { context, history } = setFilters(readContext(''), { kinds: ['prod'], up: 5, duplicatesOnly: true })
    assert.deepEqual([context.kinds, context.up, context.duplicatesOnly, context.down], [['prod'], 5, true, 1])
    assert.equal(history, 'replace')
  })

  it('never lets a transition break the scope invariant', () => {
    const starts = [readContext(''), readContext('?root=shop&focus=a@1.0.0'), readContext('?in=admin&focus=a@1.0.0')]
    const selection = { root: 'legacy', node: 'b@1.0.0' }
    for (const start of starts) {
      const results = [
        setScope(start, 'shop'),
        setScope(start, undefined),
        selectPackage(start, selection),
        openInRoot(start, selection),
        openWorkspacePackage(start, selection),
        pickSearchOption(start, selection),
        openRootIssues(start, 'legacy', 'deprecated'),
        openRootChanges(start, 'legacy'),
        openTrail(start),
        openTree(start),
        clearSelection(start),
        setView(start, 'explore'),
        focusOn(start),
        followSelectionTo(start, selection),
      ]
      for (const result of results) assertScopeInvariant(result.context)
    }
  })
})

describe('order by scope', () => {
  const options = [
    { rootId: 'a', name: 'one' },
    { rootId: 'b', name: 'two' },
    { rootId: 'a', name: 'three' },
    { rootId: 'c', name: 'four' },
  ]

  it('puts the options of the root first and keeps the order otherwise', () => {
    assert.deepEqual(orderByScope(options, 'c').map((option) => option.name), ['four', 'one', 'two', 'three'])
    assert.deepEqual(orderByScope(options, 'a').map((option) => option.name), ['one', 'three', 'two', 'four'])
  })

  it('keeps the order under all roots', () => {
    assert.deepEqual(orderByScope(options, undefined), options)
  })
})

describe('orderHitsByScope', () => {
  const hits = [
    { name: 'alpha', versions: [{ version: '1.0.0', roots: [{ rootId: 'shop', nodeId: 'a1' }] }] },
    {
      name: 'helper',
      versions: [
        { version: '1.0.0', roots: [{ rootId: 'shop', nodeId: 'h1' }, { rootId: 'shop-npm', nodeId: 'h1' }] },
        { version: '2.0.0', roots: [{ rootId: 'shop', nodeId: 'h2' }] },
      ],
    },
    { name: 'zeta', versions: [{ version: '1.0.0', roots: [{ rootId: 'shop-npm', nodeId: 'z1' }] }] },
  ]

  it('lists names with a hit in scope first and the scope root first within a version', () => {
    const ordered = orderHitsByScope(hits, 'shop-npm')
    assert.deepEqual(ordered.map((hit) => hit.name), ['helper', 'zeta', 'alpha'])
    assert.deepEqual(ordered[0]?.versions.map((version) => version.version), ['1.0.0', '2.0.0'])
    assert.deepEqual(ordered[0]?.versions[0]?.roots.map((root) => root.rootId), ['shop-npm', 'shop'])
  })

  it('keeps the order when there is no scope', () => {
    assert.deepEqual(orderHitsByScope(hits, undefined).map((hit) => hit.name), ['alpha', 'helper', 'zeta'])
  })
})
