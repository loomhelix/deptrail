import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { children } from '../src/query/children.ts'
import type { NodeDecoration } from '../src/query/decorations.ts'
import { dependents } from '../src/query/dependents.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import type { PackageInsight } from '../src/query/package-insight.ts'
import type { SearchHit } from '../src/query/search.ts'
import {
  alsoInRoots,
  variantInRoot,
  checkNotices,
  detailsMoreFacts,
  headerLabels,
  vulnerableBelowRows,
  whyHereOf,
  whyHereRows,
  type WhyHereRow,
} from '../ui/src/why-here.ts'
import { whyHereDetailText } from '../ui/src/vocabulary.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const NOW = Date.parse('2026-10-26T12:00:00.000Z')

function rowText(row: WhyHereRow): string {
  return `${row.parentLabel} ${whyHereDetailText(row.range, row.direct, row.from)}`
}
const FIVE_MINUTES_AGO = '2026-10-26T11:55:00.000Z'

type InsightParts = {
  registry?: Partial<PackageInsight['registry']>
  vulnerabilities?: Partial<PackageInsight['vulnerabilities']>
}

function insight(parts: InsightParts = {}): PackageInsight {
  return {
    revision: 1,
    registry: { state: 'ok', fetchedAt: FIVE_MINUTES_AGO, ...parts.registry },
    requested: [],
    requestedTruncated: 0,
    vulnerabilities: { state: 'ok', fetchedAt: FIVE_MINUTES_AGO, items: [], ...parts.vulnerabilities },
    versionSeverities: {},
  }
}

function asks(parent: string, range: string): PackageInsight['requested'][number] {
  return { parent, range, rangeSource: 'published-manifest' }
}

const SETTLED = { decorationsLoaded: true, checksDone: true }

function labelTexts(decoration: NodeDecoration | undefined, isDirect: boolean, loaded: PackageInsight | null): string[] {
  return headerLabels(decoration, loaded, { isDirect, ...SETTLED }).map((label) => label.text)
}

function hit(name: string, versions: Record<string, [root: string, node: string][]>): SearchHit {
  return {
    name,
    versions: Object.entries(versions).map(([version, roots]) => ({
      version,
      roots: roots.map(([rootId, nodeId]) => ({ rootId, nodeId })),
    })),
  }
}

describe('whyHereRows', () => {
  it('marks a workspace package as asking for a direct dependency', () => {
    const graph = makeGraph({ importers: { api: ['helper@1.0.0'] }, packages: { 'helper@1.0.0': [] } })
    const result = whyHereRows([asks('importer:api', '^1.0.0')], dependents(graph, 'helper@1.0.0', 50, ALL_KINDS))
    assert.deepEqual(result, {
      rows: [{ parent: 'importer:api', parentLabel: 'api', range: '^1.0.0', direct: true, from: [] }],
      more: 0,
    })
    assert.equal(rowText(result.rows[0]), 'api requires ^1.0.0 · direct dependency')
  })

  it('takes the range from the insight and lists every workspace package above each parent of a diamond', () => {
    const graph = makeGraph({
      importers: { web: ['parent-lib@1.0.0'], api: ['helper@1.0.0'], admin: ['helper@1.0.0', 'parent-lib@1.0.0'] },
      packages: { 'helper@1.0.0': ['child-lib@1.0.0'], 'parent-lib@1.0.0': ['child-lib@1.0.0'], 'child-lib@1.0.0': [] },
    })
    const requested = [asks('helper@1.0.0', '^1.0.0'), asks('parent-lib@1.0.0', '1.0.0')]
    const { rows, more } = whyHereRows(requested, dependents(graph, 'child-lib@1.0.0', 50, ALL_KINDS))
    assert.deepEqual(rows, [
      { parent: 'helper@1.0.0', parentLabel: 'helper 1.0.0', range: '^1.0.0', direct: false, from: ['admin', 'api'] },
      { parent: 'parent-lib@1.0.0', parentLabel: 'parent-lib 1.0.0', range: '1.0.0', direct: false, from: ['admin', 'web'] },
    ])
    assert.equal(more, 0)
    assert.deepEqual(rows.map(rowText), [
      'helper 1.0.0 requires ^1.0.0 · from admin, api',
      'parent-lib 1.0.0 requires 1.0.0 · from admin, web',
    ])
  })

  it('follows a chain three levels deep up to the workspace packages, through a workspace package that another one uses', () => {
    const graph = makeGraph({
      importers: { app: ['importer:lib'], lib: ['top@1.0.0'] },
      packages: { 'top@1.0.0': ['mid@1.0.0'], 'mid@1.0.0': ['child@1.0.0'], 'child@1.0.0': [] },
    })
    const { rows } = whyHereRows([asks('mid@1.0.0', '~1.0.0')], dependents(graph, 'child@1.0.0', 50, ALL_KINDS))
    assert.deepEqual(rows, [{ parent: 'mid@1.0.0', parentLabel: 'mid 1.0.0', range: '~1.0.0', direct: false, from: ['app', 'lib'] }])
    assert.equal(rowText(rows[0]), 'mid 1.0.0 requires ~1.0.0 · from app, lib')
  })

  it('shows five rows by default and counts the rest', () => {
    const parents = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}@1.0.0`)
    const graph = makeGraph({
      importers: { app: parents },
      packages: Object.fromEntries([...parents.map((id) => [id, ['child@1.0.0']]), ['child@1.0.0', []]]),
    })
    const requested = parents.map((id) => asks(id, '^1.0.0'))
    const result = whyHereRows(requested, dependents(graph, 'child@1.0.0', 50, ALL_KINDS))
    assert.deepEqual(
      result.rows.map((row) => row.parent),
      parents.slice(0, 5),
    )
    assert.equal(result.more, 2)
    const limited = whyHereRows(requested, dependents(graph, 'child@1.0.0', 50, ALL_KINDS), 2)
    assert.equal(limited.rows.length, 2)
    assert.equal(limited.more, 5)
  })

  it('writes (none) for an empty range and labels a parent outside the fetched graph by its id', () => {
    const graph = makeGraph({
      importers: { app: ['top@1.0.0'] },
      packages: { 'top@1.0.0': ['mid@1.0.0'], 'mid@1.0.0': ['child@1.0.0'], 'child@1.0.0': [] },
    })
    const { rows } = whyHereRows([asks('mid@1.0.0', ''), asks('ghost@2.0.0', '*')], dependents(graph, 'child@1.0.0', 1, ALL_KINDS))
    assert.equal(rows[0].range, '(none)')
    assert.deepEqual(rows[0].from, [])
    assert.equal(rowText(rows[0]), 'mid 1.0.0 requires (none)')
    assert.equal(rows[1].parentLabel, 'ghost 2.0.0')
  })
})

describe('whyHereOf', () => {
  const parents = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}@1.0.0`)
  const graph = makeGraph({
    importers: { app: parents.map((id) => `${id} ^1.0.0`) },
    packages: Object.fromEntries([...parents.map((id) => [id, ['child@1.0.0 ~1.0.0']]), ['child@1.0.0', []]]),
  })
  const childDependents = dependents(graph, 'child@1.0.0', 50, ALL_KINDS)

  it('counts the requests the insight left out in "+N more"', () => {
    const loaded: PackageInsight = { ...insight(), requested: parents.map((id) => asks(id, '^1.0.0')), requestedTruncated: 3 }
    const { rows, more } = whyHereOf(loaded, childDependents)
    assert.equal(rows.length, 5)
    assert.equal(more, 5)
  })

  it('falls back to the parent links of the dependents while the insight loads', () => {
    const { rows, more } = whyHereOf(null, childDependents, 2)
    assert.deepEqual(
      rows.map((row) => [row.parent, row.range, row.from]),
      [
        ['a@1.0.0', '~1.0.0', ['app']],
        ['b@1.0.0', '~1.0.0', ['app']],
      ],
    )
    assert.equal(more, 5)
  })
})

describe('vulnerableBelowRows', () => {
  const graph = makeGraph({
    importers: { app: ['top@1.0.0'] },
    packages: {
      'top@1.0.0': ['mid@1.0.0', 'low-risk@1.0.0'],
      'mid@1.0.0': ['deep@2.0.0', 'low-risk@1.0.0'],
      'low-risk@1.0.0': [],
      'deep@2.0.0': ['top@1.0.0'],
      'clean@1.0.0': [],
    },
  })
  const below = children(graph, 'top@1.0.0', 100, ALL_KINDS)

  it('lists each vulnerable package under the node once, the worst first', () => {
    const decorations: Record<string, NodeDecoration> = {
      'top@1.0.0': { vuln: { severity: 'critical', count: 1 }, below: { count: 2, worst: 'high' } },
      'low-risk@1.0.0': { vuln: { severity: 'low', count: 1 } },
      'deep@2.0.0': { vuln: { severity: 'high', count: 2 } },
      'mid@1.0.0': { deprecated: true, below: { count: 1, worst: 'high' } },
      'clean@1.0.0': { vuln: { severity: 'critical', count: 1 } },
    }
    assert.deepEqual(vulnerableBelowRows(below, decorations), [
      { node: 'deep@2.0.0', label: 'deep 2.0.0', vuln: { severity: 'high', count: 2 } },
      { node: 'low-risk@1.0.0', label: 'low-risk 1.0.0', vuln: { severity: 'low', count: 1 } },
    ])
  })

  it('returns nothing when no package below is vulnerable', () => {
    assert.deepEqual(vulnerableBelowRows(below, { 'top@1.0.0': { vuln: { severity: 'high', count: 1 } } }), [])
  })
})

describe('headerLabels', () => {
  it('names the worst severity, or malicious', () => {
    assert.deepEqual(headerLabels({ vuln: { severity: 'high', count: 2 } }, null, { isDirect: false, ...SETTLED }), [
      { key: 'vuln', text: 'high', tone: 'danger', outlined: false, title: '2 known vulnerabilities; highest severity: high' },
    ])
    assert.deepEqual(headerLabels({ vuln: { severity: 'low', count: 1, malicious: true } }, null, { isDirect: false, ...SETTLED }), [
      { key: 'vuln', text: 'malicious', tone: 'danger', outlined: false, title: '1 known vulnerability; highest severity: low' },
    ])
  })

  it('marks a deprecated version', () => {
    assert.deepEqual(headerLabels({ deprecated: true }, null, { isDirect: false, ...SETTLED }), [
      { key: 'deprecated', text: 'deprecated', tone: 'warn', outlined: false, title: 'This version is deprecated' },
    ])
  })

  it('shows an update with its size only for a direct dependency', () => {
    const decoration: NodeDecoration = { outdated: { level: 'minor', latest: '1.1.0' } }
    assert.deepEqual(headerLabels(decoration, null, { isDirect: true, ...SETTLED }), [
      { key: 'update', text: '↑ 1.1.0 minor', tone: 'info', outlined: false, title: 'Latest: 1.1.0 (minor update)' },
    ])
    assert.deepEqual(headerLabels(decoration, null, { isDirect: false, ...SETTLED }), [])
  })

  it('counts the vulnerable packages below', () => {
    assert.deepEqual(headerLabels({ below: { count: 1, worst: 'high' } }, null, { isDirect: false, ...SETTLED }), [
      { key: 'below', text: '1 vulnerable below · high', tone: 'danger', outlined: true, title: '1 vulnerable package below; highest severity: high' },
    ])
  })

  it('keeps the order severity, deprecated, update, vulnerable below', () => {
    const decoration: NodeDecoration = {
      below: { count: 3, worst: 'moderate' },
      outdated: { level: 'major', latest: '2.0.0' },
      deprecated: true,
      vuln: { severity: 'critical', count: 1 },
    }
    assert.deepEqual(labelTexts(decoration, true, insight()), ['critical', 'deprecated', '↑ 2.0.0 major', '3 vulnerable below · moderate'])
  })

  it('says no known issues in green only when both checks finished clean and the loaded decorations show nothing below', () => {
    assert.deepEqual(headerLabels({}, insight(), { isDirect: true, ...SETTLED }), [
      { key: 'clean', text: 'no known issues', tone: 'ok', outlined: false, title: 'Registry and OSV checks found no issues' },
    ])
    assert.deepEqual(labelTexts(undefined, false, insight()), ['no known issues'], 'a node missing from loaded decorations has nothing below')
    assert.deepEqual(labelTexts({ below: { count: 1, worst: 'low' } }, false, insight()), ['1 vulnerable below · low'])
    assert.deepEqual(labelTexts({ deprecated: true }, false, insight()), ['deprecated'])
    assert.deepEqual(labelTexts({}, false, insight({ registry: { deprecated: 'Use something else' } })), [])
    const advisory: PackageInsight['vulnerabilities']['items'][number] = {
      id: 'GHSA-1',
      aliases: [],
      summary: '',
      severity: 'high',
      malicious: false,
      url: '',
      fixedIn: [],
    }
    assert.deepEqual(labelTexts({}, false, insight({ vulnerabilities: { items: [advisory] } })), [])
    assert.deepEqual(labelTexts({}, false, insight({ registry: { state: 'stale' } })), [])
    assert.deepEqual(labelTexts({}, false, insight({ vulnerabilities: { state: 'pending' } })), [])
    assert.deepEqual(labelTexts({}, false, null), [])
  })

  it('withholds no known issues until the decorations of the root have loaded, since nothing below is known before', () => {
    const settled = (decorationsLoaded: boolean) =>
      headerLabels(undefined, insight(), { isDirect: false, decorationsLoaded, checksDone: true }).map((label) => label.text)
    assert.deepEqual(settled(false), [])
    assert.deepEqual(settled(true), ['no known issues'])
    const notChecked = headerLabels(undefined, insight({ vulnerabilities: { state: 'offline' } }), {
      isDirect: false,
      decorationsLoaded: false,
      checksDone: false,
    })
    assert.deepEqual(
      notChecked.map((label) => label.text),
      ['not checked'],
    )
  })

  it('withholds no known issues until the checks of the whole scan are done, since packages below may still be pending', () => {
    const whileChecks = (state: 'running' | 'offline' | 'done') =>
      headerLabels(undefined, insight(), { isDirect: false, decorationsLoaded: true, checksDone: state === 'done' }).map((label) => label.text)
    assert.deepEqual(whileChecks('running'), [])
    assert.deepEqual(whileChecks('offline'), [])
    assert.deepEqual(whileChecks('done'), ['no known issues'])
    const outdated: NodeDecoration = { outdated: { level: 'minor', latest: '1.1.0' } }
    assert.deepEqual(
      headerLabels(outdated, insight(), { isDirect: true, decorationsLoaded: true, checksDone: false }).map((label) => label.text),
      ['↑ 1.1.0 minor'],
    )
  })

  it('keeps no known issues next to an available update, since an update is not a problem', () => {
    const outdated: NodeDecoration = { outdated: { level: 'major', latest: '3.0.0' } }
    assert.deepEqual(labelTexts(outdated, true, insight()), ['↑ 3.0.0 major', 'no known issues'])
    assert.deepEqual(labelTexts(outdated, false, insight()), ['no known issues'])
  })

  it('says not checked with the reason as the title', () => {
    const notChecked = (parts: InsightParts) => headerLabels({}, insight(parts), { isDirect: false, ...SETTLED })
    assert.deepEqual(notChecked({ vulnerabilities: { state: 'skipped', reason: 'private-scope' } }), [
      {
        key: 'not-checked',
        text: 'not checked',
        tone: 'neutral',
        outlined: true,
        title: 'Private scope with a registry in .npmrc; not sent to OSV',
      },
    ])
    const titleOf = (parts: InsightParts) => notChecked(parts).map((label) => label.title)
    assert.deepEqual(titleOf({ vulnerabilities: { state: 'skipped', reason: 'non-registry' } }), [
      'Not from a registry (git, file, or link)',
    ])
    assert.deepEqual(titleOf({ vulnerabilities: { state: 'skipped', reason: 'unknown-version' } }), [
      'The exact version is unknown (manifest only)',
    ])
    assert.deepEqual(titleOf({ registry: { state: 'offline' }, vulnerabilities: { state: 'offline' } }), [
      'Offline: started with --offline',
    ])
    assert.deepEqual(titleOf({ vulnerabilities: { state: 'failed', message: 'HTTP 503' } }), ['OSV check failed: HTTP 503'])
    assert.deepEqual(titleOf({ registry: { state: 'failed', message: 'timeout' }, vulnerabilities: { state: 'failed' } }), [
      'OSV check failed: unknown reason; Registry check failed: timeout',
    ])
  })
})

describe('alsoInRoots', () => {
  const hits = [
    hit('child-lib-extra', { '1.0.0': [['legacy', 'child-lib-extra@1.0.0']] }),
    hit('child-lib', {
      '2.0.0': [['legacy', 'child-lib@2.0.0'], ['admin', 'child-lib@2.0.0']],
      '1.0.0': [['shop-npm', 'child-lib@1.0.0'], ['shop', 'child-lib@1.0.0'], ['admin', 'child-lib@1.0.0']],
      '0.9.0': [['tools', 'child-lib@0.9.0']],
    }),
  ]

  it('lists the other roots with the package by exact name, the same version first', () => {
    assert.deepEqual(alsoInRoots(hits, 'child-lib', 'shop-npm'), {
      roots: [
        { root: 'admin', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'shop', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'legacy', node: 'child-lib@2.0.0', version: '2.0.0' },
      ],
      more: 1,
    })
  })

  it('stops at the limit and counts the rest', () => {
    assert.deepEqual(alsoInRoots(hits, 'child-lib', 'shop-npm', '1.0.0', 1), {
      roots: [{ root: 'admin', node: 'child-lib@1.0.0', version: '1.0.0' }],
      more: 3,
    })
  })

  it('puts the roots with the selected version first when the root holds several versions', () => {
    assert.deepEqual(alsoInRoots(hits, 'child-lib', 'admin', '1.0.0'), {
      roots: [
        { root: 'shop', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'shop-npm', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'legacy', node: 'child-lib@2.0.0', version: '2.0.0' },
      ],
      more: 1,
    })
    assert.deepEqual(alsoInRoots(hits, 'child-lib', 'admin', '2.0.0').roots[0], { root: 'legacy', node: 'child-lib@2.0.0', version: '2.0.0' })
  })

  it('prefers the versions of the root when no version is selected', () => {
    assert.deepEqual(
      alsoInRoots(hits, 'child-lib', 'admin').roots.map((entry) => entry.root),
      ['legacy', 'shop', 'shop-npm'],
    )
  })

  it('shows the selected version of a root that holds several versions', () => {
    const several = [hit('child-lib', { '2.0.0': [['legacy', 'child-lib@2.0.0']], '1.0.0': [['legacy', 'child-lib@1.0.0'], ['shop', 'child-lib@1.0.0']] })]
    assert.deepEqual(alsoInRoots(several, 'child-lib', 'shop', '1.0.0').roots, [{ root: 'legacy', node: 'child-lib@1.0.0', version: '1.0.0' }])
  })

  it('returns nothing when no other root has the package', () => {
    assert.deepEqual(alsoInRoots(hits, 'child-lib-extra', 'legacy'), { roots: [], more: 0 })
    assert.deepEqual(alsoInRoots(hits, 'missing', 'shop'), { roots: [], more: 0 })
  })
})

describe('checkNotices', () => {
  it('says when registry or OSV data is stale or its check failed', () => {
    assert.deepEqual(checkNotices(insight(), NOW), [])
    assert.deepEqual(checkNotices(insight({ registry: { state: 'stale' }, vulnerabilities: { state: 'stale' } }), NOW), [
      'Registry data is from 5 minutes ago; the last check failed.',
      'OSV data is from 5 minutes ago; the last check failed.',
    ])
    assert.deepEqual(checkNotices(insight({ registry: { state: 'stale', fetchedAt: undefined } }), NOW), [
      'Registry data is from an earlier check; the last check failed.',
    ])
    assert.deepEqual(checkNotices(insight({ registry: { state: 'failed', message: 'timeout' }, vulnerabilities: { state: 'failed' } }), NOW), [
      'Could not check the registry: timeout.',
      'Could not check OSV: unknown reason.',
    ])
  })

  it('adds the credentials hint to a rejected registry check', () => {
    const rejected = insight({ registry: { state: 'failed', message: 'rejected credentials (401)' } })
    assert.deepEqual(checkNotices(rejected, NOW), [
      'Could not check the registry: rejected credentials (401). Check the token for this registry in .npmrc.',
    ])
  })
})

describe('detailsMoreFacts', () => {
  it('gives latest only for a transitive package, the check times and the registry notes', () => {
    const loaded = insight({ registry: { latest: '1.1.0', versionMissing: true } })
    assert.deepEqual(detailsMoreFacts(loaded, false, NOW), {
      latest: 'latest 1.1.0',
      checks: ['Registry checked 5 minutes ago', 'OSV checked 5 minutes ago'],
      notes: ['This version is not in the registry. It may have been unpublished.'],
    })
    assert.deepEqual(detailsMoreFacts(loaded, true, NOW).latest, undefined)
  })

  it('leaves stale and failed checks to the notice and keeps a registry miss', () => {
    const stale = insight({ registry: { state: 'stale', latest: '1.1.0' }, vulnerabilities: { state: 'failed' } })
    assert.deepEqual(detailsMoreFacts(stale, false, NOW), { latest: 'latest 1.1.0', checks: [], notes: [] })
    const notFound = insight({ registry: { state: 'not-found' } })
    assert.deepEqual(detailsMoreFacts(notFound, false, NOW), {
      checks: ['Registry checked 5 minutes ago', 'OSV checked 5 minutes ago'],
      notes: ['Not found in the registry.'],
    })
    assert.deepEqual(detailsMoreFacts(null, false, NOW), { checks: [], notes: [] })
  })
})

describe('variantInRoot', () => {
  const hits: SearchHit[] = [
    {
      name: 'nuxt',
      versions: [
        {
          version: '4.6.1',
          roots: [
            { rootId: 'shop', nodeId: 'nuxt@4.6.1(vite@7.0.0)' },
            { rootId: 'shop', nodeId: 'nuxt@4.6.1(vite@6.0.0)' },
            { rootId: 'docs', nodeId: 'nuxt@4.6.1(vite@5.0.0)' },
          ],
        },
      ],
    },
  ]

  it('numbers the selected node among the variants of its version in its own root', () => {
    assert.deepEqual(variantInRoot(hits, 'nuxt', 'shop', 'nuxt@4.6.1(vite@7.0.0)'), {
      position: 2,
      count: 2,
      peers: [{ name: 'vite', version: '7.0.0' }],
      suffix: '(vite@7.0.0)',
    })
  })

  it('names no variant when the root holds a single node of the version', () => {
    assert.equal(variantInRoot(hits, 'nuxt', 'docs', 'nuxt@4.6.1(vite@5.0.0)'), undefined)
    assert.equal(variantInRoot([], 'nuxt', 'shop', 'nuxt@4.6.1(vite@7.0.0)'), undefined)
  })
})
