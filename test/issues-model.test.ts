import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChangeItem, FixGoal, FixOption, NodeActions, RelockStep, SetRangeStep } from '../src/actions/types.ts'
import type { EnrichmentStatus } from '../src/enrich/types.ts'
import type { DepKind } from '../src/model.ts'
import type { RootSummary } from '../ui/src/api.ts'
import type { DirectGroup, IssueKind, IssueRow } from '../src/query/issues.ts'
import type { IssueLocation } from '../src/query/issues.ts'
import {
  checkGaps,
  checksFinishedWithoutFailures,
  directGroupRows,
  importerLabels,
  issuesEmptyState,
  knownProblemsState,
  narrowsKinds,
  problemCountOf,
  rootNotes,
  rootProblemCount,
  packageGroups,
  recommendedText,
  rowActionState,
  toggledKinds,
  toggledTypes,
  typeCounts,
  viaLabels,
  unlistedProblemCount,
  visibleGroups,
  vulnerableRoots,
  workspaceProblems,
  type RowActionState,
  type ViaName,
} from '../ui/src/issues-model.ts'

const ALL_KINDS: IssueKind[] = ['vulnerability', 'deprecated', 'outdated']

function row(name: string, kinds: IssueKind[]): IssueRow {
  return { name, version: '1.0.0', kinds, vulnIds: [], locations: [] }
}

function group(name: string, decorationKinds: { deprecated?: true; outdated?: boolean }, issueKinds: IssueKind[][]): DirectGroup {
  return {
    rootId: 'npm-package',
    direct: `${name}@1.0.0`,
    name,
    version: '1.0.0',
    importers: [],
    importersTruncated: 0,
    decoration: {
      ...(decorationKinds.deprecated ? { deprecated: true } : {}),
      ...(decorationKinds.outdated ? { outdated: { latest: '2.0.0', level: 'major' } } : {}),
    },
    issues: issueKinds.map((kinds, index) => ({ nodeId: `issue${index}@1.0.0`, name: `issue${index}`, version: '1.0.0', kinds, vulnIds: [] })),
    issuesTruncated: 0,
  } as DirectGroup
}

describe('typeCounts', () => {
  it('counts every row once per kind it has', () => {
    const counts = typeCounts([row('a', ['vulnerability', 'deprecated']), row('b', ['outdated']), row('c', ['vulnerability'])])
    assert.deepEqual(counts, { vulnerability: 2, deprecated: 1, outdated: 1 })
  })
})

describe('visibleGroups', () => {
  const groups = [group('vulnerable-below', {}, [['vulnerability']]), group('old', { outdated: true }, []), group('deprecated', { deprecated: true }, [])]

  it('keeps groups whose own decoration or issues have a shown kind', () => {
    assert.deepEqual(visibleGroups(groups, ['outdated']).map((entry) => entry.name), ['old'])
    assert.deepEqual(visibleGroups(groups, ['vulnerability']).map((entry) => entry.name), ['vulnerable-below'])
    assert.deepEqual(visibleGroups(groups, ['deprecated']).map((entry) => entry.name), ['deprecated'])
    assert.equal(visibleGroups(groups, ALL_KINDS).length, 3)
  })
})

function locationIn(rootId: string, nodeId: string, via: IssueLocation['via'] = [], viaTruncated = 0): IssueLocation {
  return { rootId, nodeId, via, viaTruncated }
}

function issueRow(name: string, kinds: IssueKind[], locations: IssueLocation[]): IssueRow {
  return { name, version: '1.0.0', kinds, vulnIds: [], locations }
}

describe('packageGroups', () => {
  const child = issueRow('child-lib', ['vulnerability'], [locationIn('shop', 'child-lib@1.0.0'), locationIn('shop-npm', 'child-lib@1.0.0')])

  it('lists one location row per root under one package group', () => {
    const groups = packageGroups([child], ALL_KINDS, undefined)
    assert.deepEqual(
      groups.map((entry) => [entry.key, entry.kind, entry.row]),
      [['child-lib@1.0.0', 'vulnerability', child]],
    )
    const [group] = groups
    assert.deepEqual(
      group?.locations.map((entry) => [entry.label, entry.location]),
      [
        ['shop', child.locations[0]],
        ['shop-npm', child.locations[1]],
      ],
    )
    assert.equal(new Set(group?.locations.map((entry) => entry.key)).size, 2)
  })

  it('numbers the peer variants only in a root that holds several nodes of the package and keeps the full suffix as the title', () => {
    const reactDom = issueRow('react-dom', ['deprecated'], [
      locationIn('shop', 'react-dom@1.0.0(react@18.2.0)'),
      locationIn('shop', 'react-dom@1.0.0(react@18.3.1)'),
      locationIn('docs', 'react-dom@1.0.0(react@18.2.0)'),
    ])
    const [group] = packageGroups([reactDom], ALL_KINDS, undefined)
    assert.deepEqual(
      group?.locations.map((entry) => entry.label),
      ['shop, variant 1 of 2 (react 18.2.0)', 'shop, variant 2 of 2 (react 18.3.1)', 'docs'],
    )
    assert.deepEqual(
      group?.locations.map((entry) => entry.title),
      ['(react@18.2.0)', '(react@18.3.1)', undefined],
    )
    assert.equal(new Set(group?.locations.map((entry) => entry.key)).size, 3)
  })

  it('keeps only the locations of a single-root scope and drops groups without one', () => {
    const shopOnly = issueRow('helper', ['outdated'], [locationIn('shop', 'helper@1.0.0')])
    const groups = packageGroups([child, shopOnly], ALL_KINDS, 'shop-npm')
    assert.deepEqual(
      groups.map((entry) => [entry.row.name, entry.locations.map((location) => location.location.rootId)]),
      [['child-lib', ['shop-npm']]],
    )
  })

  it('places each row under its first shown kind and orders the groups by section', () => {
    const both = issueRow('both', ['vulnerability', 'deprecated'], [locationIn('shop', 'both@1.0.0')])
    const old = issueRow('old', ['outdated'], [locationIn('shop', 'old@1.0.0')])
    const kindsOf = (types: IssueKind[]) => packageGroups([old, both], types, undefined).map((entry) => [entry.row.name, entry.kind])
    assert.deepEqual(kindsOf(ALL_KINDS), [
      ['both', 'vulnerability'],
      ['old', 'outdated'],
    ])
    assert.deepEqual(kindsOf(['deprecated', 'outdated']), [
      ['both', 'deprecated'],
      ['old', 'outdated'],
    ])
    assert.deepEqual(kindsOf(['vulnerability']), [['both', 'vulnerability']])
  })

  it('labels the repository root by name', () => {
    const [group] = packageGroups([issueRow('a', ['outdated'], [locationIn('.', 'a@1.0.0')])], ALL_KINDS, undefined)
    assert.deepEqual(group?.locations.map((entry) => entry.label), ['repository root'])
  })
})

function workspace(name: string): ViaName {
  return { name, workspace: true }
}

function thirdParty(name: string): ViaName {
  return { name, workspace: false }
}

describe('viaLabels', () => {
  it('names the direct dependencies that pull in a transitive package', () => {
    const location = locationIn('shop', 'child-lib@1.0.0', [
      { direct: 'parent-lib@1.0.0', importers: ['importer:web'] },
      { direct: 'helper@1.0.0', importers: ['importer:api'] },
    ])
    assert.deepEqual(viaLabels(location), { shown: [thirdParty('parent-lib'), thirdParty('helper')], more: 0, all: [thirdParty('parent-lib'), thirdParty('helper')] })
  })

  it('names the workspace packages that list a direct dependency', () => {
    const location = locationIn('shop', 'toolkit@2.0.0', [{ direct: 'toolkit@2.0.0', importers: ['importer:api', 'importer:web'] }])
    assert.deepEqual(viaLabels(location), { shown: [workspace('api'), workspace('web')], more: 0, all: [workspace('api'), workspace('web')] })
  })

  it('marks importers as workspace names and direct dependencies as packages in one list', () => {
    const location = locationIn('shop', 'helper@1.0.0', [
      { direct: 'helper@1.0.0', importers: ['importer:api'] },
      { direct: 'parent-lib@1.0.0', importers: ['importer:web'] },
    ])
    assert.deepEqual(viaLabels(location).shown, [workspace('api'), thirdParty('parent-lib')])
  })

  it('keeps the workspace flag of names hidden behind more', () => {
    const location = locationIn('shop', 'helper@1.0.0', [
      { direct: 'alpha@1.0.0', importers: ['importer:web'] },
      { direct: 'beta@1.0.0', importers: ['importer:web'] },
      { direct: 'helper@1.0.0', importers: ['importer:api'] },
    ])
    const labels = viaLabels(location)
    assert.equal(labels.more, 1)
    assert.deepEqual(labels.all[2], workspace('api'))
  })

  it('shows two names once each and counts the rest with the truncated entries', () => {
    const location = locationIn(
      'shop',
      'child-lib@1.0.0',
      [
        { direct: '@scope/alpha@1.0.0', importers: ['importer:web'] },
        { direct: 'beta@1.0.0(react@18.2.0)', importers: ['importer:web'] },
        { direct: '@scope/alpha@2.0.0', importers: ['importer:api'] },
        { direct: 'gamma@1.0.0', importers: ['importer:api'] },
      ],
      2,
    )
    assert.deepEqual(viaLabels(location), {
      shown: [thirdParty('@scope/alpha'), thirdParty('beta')],
      more: 3,
      all: [thirdParty('@scope/alpha'), thirdParty('beta'), thirdParty('gamma')],
    })
  })

  it('names a scoped direct dependency of a pnpm v6 lockfile without its slash', () => {
    const location = locationIn('legacy', '/semver@5.7.2', [
      { direct: '/@types/node@20.17.9', importers: ['importer:.'] },
      { direct: '/@typescript-eslint/utils@8.18.0(eslint@9.17.0)', importers: ['importer:.'] },
    ])
    assert.deepEqual(viaLabels(location), {
      shown: [thirdParty('@types/node'), thirdParty('@typescript-eslint/utils')],
      more: 0,
      all: [thirdParty('@types/node'), thirdParty('@typescript-eslint/utils')],
    })
  })
})

describe('workspaceProblems', () => {
  const child = issueRow('child-lib', ['vulnerability'], [
    locationIn('shop', 'child-lib@1.0.0', [
      { direct: 'parent-lib@1.0.0', importers: ['importer:web'] },
      { direct: 'helper@1.0.0', importers: ['importer:api'] },
    ]),
    locationIn('shop-npm', 'child-lib@1.0.0', [{ direct: 'parent-lib@1.0.0', importers: ['importer:admin'] }]),
  ])
  const toolkit: IssueRow = {
    ...issueRow('toolkit', ['outdated'], [
      locationIn('shop', 'toolkit@2.0.0(react@18.2.0)', [{ direct: 'toolkit@2.0.0(react@18.2.0)', importers: ['importer:api', 'importer:web'] }]),
    ]),
    version: '2.0.0',
  }
  const helper = issueRow('helper', ['deprecated'], [locationIn('shop', 'helper@1.0.0', [{ direct: 'helper@1.0.0', importers: ['importer:api'] }])])

  it('lists the problems whose location in the root is pulled in by the workspace package, in the order of the rows', () => {
    assert.deepEqual(workspaceProblems([child, toolkit, helper], 'shop', 'importer:web'), [
      { key: 'shop|child-lib@1.0.0', node: 'child-lib@1.0.0', label: 'child-lib 1.0.0', row: child },
      { key: 'shop|toolkit@2.0.0(react@18.2.0)', node: 'toolkit@2.0.0(react@18.2.0)', label: 'toolkit 2.0.0', row: toolkit },
    ])
  })

  it('ignores the locations of other roots', () => {
    assert.deepEqual(
      workspaceProblems([child, toolkit, helper], 'shop-npm', 'importer:admin').map((problem) => problem.node),
      ['child-lib@1.0.0'],
    )
    assert.deepEqual(workspaceProblems([child, toolkit, helper], 'shop-npm', 'importer:web'), [])
  })

  it('lists each peer variant in the root that the workspace package pulls in', () => {
    const variants = issueRow('ui-kit', ['vulnerability'], [
      locationIn('shop', 'ui-kit@1.0.0(react@17.0.2)', [{ direct: 'ui-kit@1.0.0(react@17.0.2)', importers: ['importer:web'] }]),
      locationIn('shop', 'ui-kit@1.0.0(react@18.2.0)', [{ direct: 'ui-kit@1.0.0(react@18.2.0)', importers: ['importer:web'] }]),
    ])
    assert.deepEqual(
      workspaceProblems([variants], 'shop', 'importer:web').map((problem) => problem.node),
      ['ui-kit@1.0.0(react@17.0.2)', 'ui-kit@1.0.0(react@18.2.0)'],
    )
    assert.deepEqual(
      workspaceProblems([variants], 'shop', 'importer:web').map((problem) => problem.label),
      ['ui-kit 1.0.0, variant 1 of 2 (react 17.0.2)', 'ui-kit 1.0.0, variant 2 of 2 (react 18.2.0)'],
    )
  })
})

describe('unlistedProblemCount', () => {
  const cappedVia = [{ direct: 'a-lib@1.0.0', importers: ['importer:api'] }]
  const semver = issueRow('semver', ['vulnerability'], [locationIn('shop', 'semver@5.7.1', cappedVia, 7)])

  it('counts a package whose capped paths in the root do not list the workspace package', () => {
    assert.deepEqual(workspaceProblems([semver], 'shop', 'importer:web'), [])
    assert.equal(unlistedProblemCount([semver], 'shop', 'importer:web'), 1)
  })

  it('does not count a package whose listed paths already name the workspace package', () => {
    assert.equal(unlistedProblemCount([semver], 'shop', 'importer:api'), 0)
  })

  it('does not count a package whose paths are complete, or capped in another root', () => {
    const complete = issueRow('debug', ['vulnerability'], [locationIn('shop', 'debug@2.6.8', cappedVia, 0)])
    assert.equal(unlistedProblemCount([complete], 'shop', 'importer:web'), 0)
    assert.equal(unlistedProblemCount([semver], 'shop-npm', 'importer:web'), 0)
  })

  it('counts a package once when several of its variants in the root are capped', () => {
    const variants = issueRow('ui-kit', ['vulnerability'], [
      locationIn('shop', 'ui-kit@1.0.0(react@17.0.2)', cappedVia, 3),
      locationIn('shop', 'ui-kit@1.0.0(react@18.2.0)', cappedVia, 4),
    ])
    assert.equal(unlistedProblemCount([variants, semver], 'shop', 'importer:web'), 2)
  })
})

describe('rowActionState', () => {
  const goal: FixGoal = { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: ['GHSA-1'], severity: 'high' }
  const relock: RelockStep = { kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'in range' }
  const raise: SetRangeStep = {
    kind: 'set-range',
    importer: 'importer:web',
    dependency: 'parent-lib',
    field: 'dependencies',
    place: 'manifest',
    from: '1.0.0',
    to: '1.1.0',
    reason: 'allows child-lib 1.0.1',
  }
  const chain: FixOption = { choice: 'chain', recommended: true, steps: [relock, raise], warnings: [] }
  const override: FixOption = {
    choice: 'override',
    recommended: false,
    steps: [{ kind: 'override', selector: 'child-lib@<1.0.1', value: '1.0.1', file: 'pnpm-workspace.yaml', reason: 'forces 1.0.1' }],
    warnings: [],
  }
  const transitive = locationIn('shop', 'child-lib@1.0.0', [{ direct: 'parent-lib@1.0.0', importers: ['importer:web'] }])
  const direct = locationIn('shop', 'toolkit@2.0.0', [{ direct: 'toolkit@2.0.0', importers: ['importer:api'] }])
  const item: ChangeItem = { id: 'item-1', goal, choice: 'chain', steps: [relock, raise], warnings: [] }
  const fixActions = (options: FixOption[], reason?: string): NodeActions => ({
    fix: { goal, options, unavailable: [], ...(reason === undefined ? {} : { reason }) },
  })

  it('reports an item in changes before anything else', () => {
    assert.deepEqual(rowActionState('vulnerability', transitive, undefined, 'boom', item, undefined), { kind: 'in-changes', itemId: 'item-1' })
    assert.deepEqual(rowActionState('outdated', direct, undefined, undefined, item, undefined), { kind: 'in-changes', itemId: 'item-1' })
  })

  it('offers an update for an update and for a deprecated direct dependency', () => {
    assert.deepEqual(rowActionState('outdated', direct, undefined, undefined, undefined, undefined), { kind: 'update' })
    assert.deepEqual(rowActionState('deprecated', direct, undefined, undefined, undefined, undefined), { kind: 'update' })
  })

  it('offers nothing for a deprecated transitive package', () => {
    assert.deepEqual(rowActionState('deprecated', transitive, undefined, undefined, undefined, undefined), { kind: 'none' })
  })

  it('explains a failed request for the fix', () => {
    assert.deepEqual(rowActionState('vulnerability', transitive, undefined, 'Server error', undefined, undefined), {
      kind: 'reason',
      text: 'Could not load the fix: Server error',
    })
  })

  it('waits while the actions of a vulnerable location load', () => {
    assert.deepEqual(rowActionState('vulnerability', transitive, undefined, undefined, undefined, undefined), { kind: 'loading' })
  })

  it('shows why actions are unavailable instead of waiting', () => {
    const state = rowActionState('vulnerability', transitive, { unavailable: 'Actions are unavailable with --offline' }, undefined, undefined, undefined)
    assert.deepEqual(state, { kind: 'reason', text: 'Actions are unavailable with --offline' })
  })

  describe('with a root-level reason', () => {
    const rootReason = 'Actions require a pnpm or npm lockfile'

    it('reports the root reason for a vulnerable location', () => {
      assert.deepEqual(rowActionState('vulnerability', transitive, undefined, undefined, undefined, rootReason), { kind: 'root-unavailable' })
      assert.deepEqual(rowActionState('vulnerability', transitive, undefined, 'boom', undefined, rootReason), { kind: 'root-unavailable' })
    })

    it('keeps an item in changes, an update and a deprecated transitive package', () => {
      assert.deepEqual(rowActionState('vulnerability', transitive, undefined, undefined, item, rootReason), { kind: 'in-changes', itemId: 'item-1' })
      assert.deepEqual(rowActionState('outdated', direct, undefined, undefined, undefined, rootReason), { kind: 'update' })
      assert.deepEqual(rowActionState('deprecated', transitive, undefined, undefined, undefined, rootReason), { kind: 'none' })
    })

    it('loads again once the root is available', () => {
      assert.deepEqual(rowActionState('vulnerability', transitive, undefined, undefined, undefined, undefined), { kind: 'loading' })
    })
  })

  it('adds the recommended option under the title the details panel shows', () => {
    assert.deepEqual(rowActionState('vulnerability', transitive, fixActions([chain, override]), undefined, undefined, undefined), {
      kind: 'add',
      title: 'Re-lock and update parent-lib',
    })
    const overrideFirst = fixActions([{ ...override, recommended: true }, { ...chain, recommended: false }])
    assert.deepEqual(rowActionState('vulnerability', transitive, overrideFirst, undefined, undefined, undefined), { kind: 'add', title: 'Override to 1.0.1' })
  })

  it('explains a fix without an option', () => {
    assert.deepEqual(rowActionState('vulnerability', transitive, fixActions([], 'parent-lib has no newer version'), undefined, undefined, undefined), {
      kind: 'reason',
      text: 'parent-lib has no newer version',
    })
    assert.deepEqual(rowActionState('vulnerability', transitive, fixActions([]), undefined, undefined, undefined), { kind: 'reason', text: 'No fixed version yet' })
    assert.deepEqual(rowActionState('vulnerability', transitive, {}, undefined, undefined, undefined), { kind: 'reason', text: 'No fixed version yet' })
  })
})

describe('recommendedText', () => {
  const goal: FixGoal = { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: [], severity: 'high' }
  const relock: RelockStep = { kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'in range' }
  const fixItem: ChangeItem = { id: 'fix', goal, choice: 'relock', steps: [relock], warnings: [] }
  const updateItem: ChangeItem = { id: 'update', goal: { kind: 'update', name: 'toolkit', importers: [], target: '2.1.0' }, choice: 'wanted', steps: [], warnings: [] }
  const inRange = { ...issueRow('toolkit', ['outdated'], []), version: '2.0.0', wanted: '2.1.0' }
  const exact = { ...issueRow('toolkit', ['outdated'], []), version: '2.0.0', wanted: '2.0.0', latest: '3.0.0', outdatedLevel: 'major' as const }
  const deprecatedAtLatest = { ...issueRow('legacy', ['deprecated'], []), version: '1.0.0', wanted: '1.0.0' }
  const textOf = (state: RowActionState, row: IssueRow = inRange, item?: ChangeItem) => recommendedText(state, row, item)

  it('names what the row would do or why it cannot', () => {
    assert.equal(textOf({ kind: 'loading' }), 'Checking fix…')
    assert.equal(textOf({ kind: 'add', title: 'Re-lock to 1.0.1' }), 'Re-lock to 1.0.1')
    assert.equal(textOf({ kind: 'reason', text: 'No fixed version yet' }), 'No fixed version yet')
    assert.equal(textOf({ kind: 'none' }), '')
  })

  it('says whether an update stays in range', () => {
    assert.equal(textOf({ kind: 'update' }), 'In range: 2.1.0')
    assert.equal(textOf({ kind: 'update' }, exact), 'Needs a range change')
  })

  it('says that no update is available for a deprecated direct dependency without a newer version', () => {
    assert.equal(textOf({ kind: 'update' }, deprecatedAtLatest), 'No update available')
    assert.equal(textOf({ kind: 'update' }, { ...deprecatedAtLatest, wanted: undefined }), 'No update available')
  })

  it('marks a row of an unavailable root', () => {
    assert.equal(textOf({ kind: 'root-unavailable' }), 'Unavailable')
  })

  it('names the fix that is in changes', () => {
    assert.equal(textOf({ kind: 'in-changes', itemId: 'fix' }, inRange, fixItem), 'Re-lock to 1.0.1')
    assert.equal(textOf({ kind: 'in-changes', itemId: 'update' }, inRange, updateItem), 'In range: 2.1.0')
  })
})

describe('rootNotes', () => {
  const rows = [
    issueRow('child-lib', ['vulnerability'], [locationIn('tools', 'child-lib@1.0.0'), locationIn('apps/x', 'child-lib@1.0.0')]),
    issueRow('old', ['outdated'], [locationIn('tools', 'old@1.0.0')]),
  ]
  const unavailable = new Map([
    ['tools', 'Actions require a pnpm or npm lockfile'],
    ['apps/x', 'The lockfile lists ../y, which pnpm-workspace.yaml does not declare'],
    ['docs', 'Waiting for the scan'],
  ])

  it('lists each unavailable root with rows by its label', () => {
    assert.deepEqual(rootNotes(rows, ALL_KINDS, unavailable, undefined), [
      { rootId: 'apps/x', text: 'apps/x: The lockfile lists ../y, which pnpm-workspace.yaml does not declare' },
      { rootId: 'tools', text: 'tools: Actions require a pnpm or npm lockfile' },
    ])
  })

  it('skips a root whose rows the type filter hides', () => {
    assert.deepEqual(rootNotes(rows, ['vulnerability'], unavailable, undefined).map((note) => note.rootId), ['apps/x', 'tools'])
    assert.deepEqual(rootNotes(rows, ['deprecated'], unavailable, undefined), [])
    assert.deepEqual(
      rootNotes([rows[1]!], ['vulnerability'], unavailable, undefined),
      [],
    )
  })

  it('states the bare reason in a one-root scope', () => {
    assert.deepEqual(rootNotes(rows, ALL_KINDS, unavailable, 'tools'), [{ rootId: 'tools', text: 'Actions require a pnpm or npm lockfile' }])
  })
})

describe('vulnerableRoots', () => {
  const child = issueRow('child-lib', ['vulnerability'], [locationIn('shop-npm', 'child-lib@1.0.0'), locationIn('shop', 'child-lib@1.0.0')])
  const reactDom = issueRow('react-dom', ['vulnerability', 'deprecated'], [
    locationIn('shop', 'react-dom@1.0.0(react@18.2.0)'),
    locationIn('shop', 'react-dom@1.0.0(react@18.3.1)'),
  ])
  const old = issueRow('old', ['outdated'], [locationIn('docs', 'old@1.0.0')])

  it('counts the vulnerable packages of each root once and orders the roots by name', () => {
    assert.deepEqual(vulnerableRoots([child, reactDom, old], undefined), [
      { root: 'shop', count: 2 },
      { root: 'shop-npm', count: 1 },
    ])
  })

  it('keeps only the scope root and skips roots without vulnerable packages', () => {
    assert.deepEqual(vulnerableRoots([child, reactDom, old], 'shop-npm'), [{ root: 'shop-npm', count: 1 }])
    assert.deepEqual(vulnerableRoots([old], undefined), [])
  })
})

describe('issuesEmptyState', () => {
  const status = (state: EnrichmentStatus['state']): EnrichmentStatus => ({
    state,
    revision: 1,
    registry: { total: 10, done: 10, failed: 0 },
    osv: { total: 10, done: 10, skipped: 0, failed: 0 },
    problems: [],
  })

  const ALL_DEP_KINDS: DepKind[] = ['prod', 'dev', 'optional', 'peer']
  const WITHOUT_PROD: DepKind[] = ['dev', 'optional', 'peer']

  it('says the types hide the problems when there are some', () => {
    assert.equal(issuesEmptyState(true, ALL_DEP_KINDS, status('running')), 'filtered')
    assert.equal(issuesEmptyState(true, ALL_DEP_KINDS, status('done')), 'filtered')
  })

  it('says checking while the checks run or before their state is known, offline when started offline, and clean otherwise', () => {
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, status('running')), 'checking')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, undefined), 'checking')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, status('offline')), 'offline')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, status('done')), 'clean')
  })

  it('treats a narrowed kinds filter like the type toggles once the checks are done', () => {
    assert.equal(issuesEmptyState(false, WITHOUT_PROD, status('done')), 'filtered')
    assert.equal(issuesEmptyState(false, ['prod'], status('done')), 'filtered')
    assert.equal(issuesEmptyState(true, WITHOUT_PROD, status('running')), 'filtered')
  })

  it('tells whether the dependency kinds are narrowed', () => {
    assert.equal(narrowsKinds(ALL_DEP_KINDS), false)
    assert.equal(narrowsKinds(WITHOUT_PROD), true)
    assert.equal(narrowsKinds(['prod']), true)
  })

  it('never claims the selected types are clean before the checks are done', () => {
    assert.equal(issuesEmptyState(false, WITHOUT_PROD, status('running')), 'checking')
    assert.equal(issuesEmptyState(false, WITHOUT_PROD, undefined), 'checking')
    assert.equal(issuesEmptyState(false, WITHOUT_PROD, status('offline')), 'offline')
  })

  it('says the checks are incomplete instead of clean when checks failed', () => {
    const failedOsv: EnrichmentStatus = { ...status('done'), osv: { total: 10, done: 10, skipped: 0, failed: 2 } }
    const failedAdvisories: EnrichmentStatus = { ...status('done'), problems: [{ source: 'osv', origin: 'https://api.osv.dev', message: 'timed out', count: 1 }] }
    const failedRegistry: EnrichmentStatus = { ...status('done'), registry: { total: 10, done: 10, failed: 1 } }
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, failedOsv), 'incomplete')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, failedAdvisories), 'incomplete')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, failedRegistry), 'incomplete')
    assert.equal(issuesEmptyState(false, WITHOUT_PROD, failedOsv), 'incomplete')
    assert.equal(issuesEmptyState(true, ALL_DEP_KINDS, failedOsv), 'filtered')
  })

  it('says the checks are incomplete instead of clean when a root in scope failed to scan', () => {
    const done = status('done')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, done, checkGaps(done, { failedRoots: ['legacy'] })), 'incomplete')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, status('running'), checkGaps(status('running'), { failedRoots: ['legacy'] })), 'checking')
    assert.equal(issuesEmptyState(false, ALL_DEP_KINDS, done, checkGaps(done)), 'clean')
  })
})

describe('checkGaps', () => {
  const done: EnrichmentStatus = {
    state: 'done',
    revision: 1,
    registry: { total: 10, done: 10, failed: 1 },
    osv: { total: 10, done: 10, skipped: 0, failed: 2 },
    problems: [
      { source: 'registry', origin: 'https://registry.npmjs.org', message: 'timed out', count: 1 },
      { source: 'osv', origin: 'https://api.osv.dev', message: 'timed out', count: 4 },
    ],
  }

  it('counts the failed checks the problems report, and never fewer than the failed progress counts', () => {
    assert.equal(checkGaps(done).failedChecks, 5)
    assert.equal(checkGaps({ ...done, problems: [] }).failedChecks, 3)
  })

  it('counts no failed checks while the checks run, offline or before the status is known', () => {
    assert.equal(checkGaps({ ...done, state: 'running' }).failedChecks, 0)
    assert.equal(checkGaps({ ...done, state: 'offline' }).failedChecks, 0)
    assert.equal(checkGaps(undefined).failedChecks, 0)
  })

  it('keeps the failed roots and the packages with unlisted paths it is given', () => {
    assert.deepEqual(checkGaps(undefined, { failedRoots: ['legacy'], unlistedPaths: 2 }), { failedChecks: 0, failedRoots: ['legacy'], unlistedPaths: 2 })
    assert.deepEqual(checkGaps(undefined), { failedChecks: 0, failedRoots: [], unlistedPaths: 0 })
  })
})

describe('checksFinishedWithoutFailures', () => {
  const finished: EnrichmentStatus = {
    state: 'done',
    revision: 1,
    registry: { total: 10, done: 10, failed: 0 },
    osv: { total: 10, done: 10, skipped: 0, failed: 0 },
    problems: [],
  }

  it('holds once the checks are done and none of them failed', () => {
    assert.equal(checksFinishedWithoutFailures(finished), true)
  })

  it('does not hold after a failed check, wherever the failure is counted', () => {
    assert.equal(checksFinishedWithoutFailures({ ...finished, problems: [{ source: 'osv', origin: 'https://api.osv.dev', message: 'timed out', count: 3 }] }), false)
    assert.equal(checksFinishedWithoutFailures({ ...finished, registry: { total: 10, done: 10, failed: 1 } }), false)
    assert.equal(checksFinishedWithoutFailures({ ...finished, osv: { total: 10, done: 10, skipped: 0, failed: 2 } }), false)
  })

  it('does not hold while the checks run, offline or before the status is known', () => {
    assert.equal(checksFinishedWithoutFailures({ ...finished, state: 'running' }), false)
    assert.equal(checksFinishedWithoutFailures({ ...finished, state: 'offline' }), false)
    assert.equal(checksFinishedWithoutFailures(undefined), false)
  })
})

describe('knownProblemsState', () => {
  const status = (state: EnrichmentStatus['state']): EnrichmentStatus => ({
    state,
    revision: 1,
    registry: { total: 10, done: 4, failed: 0 },
    osv: { total: 10, done: 4, skipped: 0, failed: 0 },
    problems: [],
  })

  it('waits for the rows and reports a failed request before anything else', () => {
    assert.equal(knownProblemsState('loading', status('done')), 'loading')
    assert.equal(knownProblemsState('failed', status('done')), 'failed')
    assert.equal(knownProblemsState('failed', status('running')), 'failed')
  })

  it('lists the problems it knows, even while the checks still run', () => {
    assert.equal(knownProblemsState(2, status('running')), 'problems')
    assert.equal(knownProblemsState(1, status('done')), 'problems')
  })

  it('claims no known problems only once the checks are done', () => {
    assert.equal(knownProblemsState(0, status('running')), 'checking')
    assert.equal(knownProblemsState(0, undefined), 'checking')
    assert.equal(knownProblemsState(0, status('offline')), 'offline')
    assert.equal(knownProblemsState(0, status('done')), 'clean')
  })

  it('never claims no known problems after failed checks', () => {
    const failed: EnrichmentStatus = { ...status('done'), registry: { total: 10, done: 10, failed: 3 } }
    assert.equal(knownProblemsState(0, failed), 'incomplete')
    assert.equal(knownProblemsState(2, failed), 'problems')
  })

  it('never claims no known problems when some paths to a package with problems were not listed', () => {
    const done = status('done')
    assert.equal(knownProblemsState(0, done, checkGaps(done, { unlistedPaths: 1 })), 'incomplete')
    assert.equal(knownProblemsState(1, done, checkGaps(done, { unlistedPaths: 1 })), 'problems')
    assert.equal(knownProblemsState(0, status('running'), checkGaps(status('running'), { unlistedPaths: 1 })), 'checking')
  })
})

describe('problemCountOf', () => {
  it('is loading while the rows are null, failed after a failed request, and the count otherwise', () => {
    assert.equal(problemCountOf(null, undefined), 'loading')
    assert.equal(problemCountOf(null, 'Server error'), 'failed')
    assert.equal(problemCountOf([], undefined), 0)
    assert.equal(problemCountOf(['child-lib', 'toolkit'], undefined), 2)
  })
})

describe('rootProblemCount', () => {
  const rootWith = (issueCounts: RootSummary['issueCounts']) => ({ issueCounts }) as RootSummary

  it('adds the vulnerable, deprecated and updatable packages, and is loading before the counts exist', () => {
    assert.equal(rootProblemCount(rootWith({ vulnerable: 1, worst: 'high', deprecated: 2, outdatedDirect: 3 })), 6)
    assert.equal(rootProblemCount(rootWith({ vulnerable: 0, deprecated: 0, outdatedDirect: 0 })), 0)
    assert.equal(rootProblemCount(rootWith(undefined)), 'loading')
  })
})

describe('toggledTypes', () => {
  const counts: Record<IssueKind, number> = { vulnerability: 1, deprecated: 0, outdated: 3 }

  it('presses a type with problems and keeps the section order', () => {
    assert.deepEqual(toggledTypes(['outdated'], 'vulnerability', counts), ['vulnerability', 'outdated'])
  })

  it('releases a pressed type while another pressed type has problems', () => {
    assert.deepEqual(toggledTypes(ALL_KINDS, 'outdated', counts), ['vulnerability', 'deprecated'])
  })

  it('keeps the last pressed type that has problems', () => {
    assert.equal(toggledTypes(['vulnerability', 'deprecated'], 'vulnerability', counts), undefined)
    assert.equal(toggledTypes(['outdated'], 'outdated', counts), undefined)
  })

  it('does not press a type without problems', () => {
    assert.equal(toggledTypes(['outdated'], 'deprecated', counts), undefined)
  })
})

describe('toggledKinds', () => {
  it('adds or removes a dependency kind and keeps the canonical order', () => {
    assert.deepEqual(toggledKinds(['prod', 'dev', 'optional', 'peer'], 'dev'), ['prod', 'optional', 'peer'])
    assert.deepEqual(toggledKinds(['peer', 'prod'], 'dev'), ['prod', 'dev', 'peer'])
  })

  it('keeps the last kind', () => {
    assert.equal(toggledKinds(['prod'], 'prod'), undefined)
  })
})

describe('importerLabels', () => {
  it('names two workspace packages and counts the rest, including the ones the server left out', () => {
    assert.deepEqual(importerLabels({ importers: ['importer:web', 'importer:api', 'importer:.'], importersTruncated: 2 }), {
      shown: [workspace('web'), workspace('api')],
      more: 3,
      all: [workspace('web'), workspace('api'), workspace('repository root')],
    })
    assert.deepEqual(importerLabels({ importers: ['importer:web'], importersTruncated: 0 }), { shown: [workspace('web')], more: 0, all: [workspace('web')] })
  })
})

describe('directGroupRows', () => {
  const readerVia = [{ direct: 'read-pkg-up@7.0.1', importers: ['importer:tools/build'] }]
  const semverRow: IssueRow = {
    name: 'semver',
    version: '5.7.2',
    kinds: ['vulnerability'],
    severity: 'high',
    vulnIds: ['GHSA-1'],
    locations: [locationIn('npm-package', 'semver@5.7.2', readerVia)],
  }
  const readerRow: IssueRow = {
    name: 'read-pkg-up',
    version: '7.0.1',
    kinds: ['deprecated', 'outdated'],
    vulnIds: [],
    latest: '11.0.0',
    outdatedLevel: 'major',
    locations: [locationIn('npm-package', 'read-pkg-up@7.0.1', readerVia)],
  }
  const readerGroup: DirectGroup = {
    rootId: 'npm-package',
    direct: 'read-pkg-up@7.0.1',
    name: 'read-pkg-up',
    version: '7.0.1',
    importers: ['importer:tools/build'],
    importersTruncated: 0,
    decoration: { deprecated: true, outdated: { latest: '11.0.0', level: 'major' } },
    worst: 'high',
    issues: [{ nodeId: 'semver@5.7.2', name: 'semver', version: '5.7.2', kinds: ['vulnerability'], severity: 'high', vulnIds: ['GHSA-1'] }],
    issuesTruncated: 0,
  }

  it('joins the direct dependency and the packages below it with their issue rows and locations', () => {
    const [entry] = directGroupRows([readerGroup], [semverRow, readerRow], ALL_KINDS)
    assert.equal(entry?.key, 'npm-package|read-pkg-up@7.0.1')
    assert.equal(entry?.group, readerGroup)
    assert.deepEqual(entry?.own, { key: 'read-pkg-up@7.0.1', kind: 'deprecated', row: readerRow, location: readerRow.locations[0] })
    assert.deepEqual(entry?.issues, [{ key: 'semver@5.7.2', kind: 'vulnerability', row: semverRow, location: semverRow.locations[0] }])
  })

  it('keeps only the problems of the shown types', () => {
    const [outdatedOnly] = directGroupRows([readerGroup], [semverRow, readerRow], ['outdated'])
    assert.equal(outdatedOnly?.own?.kind, 'outdated')
    assert.deepEqual(outdatedOnly?.issues, [])
    const [vulnerableOnly] = directGroupRows([readerGroup], [semverRow, readerRow], ['vulnerability'])
    assert.equal(vulnerableOnly?.own, undefined)
    assert.deepEqual(vulnerableOnly?.issues.map((issue) => issue.key), ['semver@5.7.2'])
  })

  it('drops a group with nothing of the shown types', () => {
    const quiet: DirectGroup = { ...readerGroup, decoration: {}, issues: [], worst: undefined }
    assert.deepEqual(directGroupRows([quiet], [semverRow], ALL_KINDS), [])
    assert.deepEqual(directGroupRows([readerGroup], [semverRow, readerRow], ['deprecated']).map((entry) => entry.issues.length), [0])
  })

  it('builds the rows from the group when the issue rows lack them', () => {
    const [entry] = directGroupRows([readerGroup], [], ALL_KINDS)
    assert.deepEqual(entry?.own, {
      key: 'read-pkg-up@7.0.1',
      kind: 'deprecated',
      row: { name: 'read-pkg-up', version: '7.0.1', kinds: ['deprecated', 'outdated'], vulnIds: [], latest: '11.0.0', outdatedLevel: 'major', locations: [locationIn('npm-package', 'read-pkg-up@7.0.1', readerVia)] },
      location: locationIn('npm-package', 'read-pkg-up@7.0.1', readerVia),
    })
    assert.deepEqual(entry?.issues, [
      {
        key: 'semver@5.7.2',
        kind: 'vulnerability',
        row: { name: 'semver', version: '5.7.2', kinds: ['vulnerability'], severity: 'high', vulnIds: ['GHSA-1'], locations: [locationIn('npm-package', 'semver@5.7.2')] },
        location: locationIn('npm-package', 'semver@5.7.2'),
      },
    ])
  })
})
