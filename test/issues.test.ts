import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GROUP_ISSUES_CAP, IMPORTERS_CAP, VIA_CAP, issuesByDirect, issuesByPackage } from '../src/query/issues.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import type { DepKind, RootGraph } from '../src/model.ts'
import type { Advisory, PackageMeta, Severity } from '../src/enrich/types.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

const PROD_ONLY = new Set<DepKind>(['prod'])

function fixtureRoot(id: string): RootGraph {
  const root = makeGraph({
    importers: { 'tools/build': ['read-pkg-up@7.0.1'], storefront: ['eslint-plugin-vue@9.32.0'] },
    packages: {
      'read-pkg-up@7.0.1': ['normalize-package-data@2.5.0'],
      'normalize-package-data@2.5.0': ['semver@5.7.2'],
      'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
      'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
      'semver@5.7.2': [],
    },
  })
  return { ...root, id, path: id }
}

function semverFixtureSpec() {
  return {
    meta: {
      'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
      'vue-eslint-parser': makeMeta({ versions: ['9.4.3'], manifests: { '9.4.3': { semver: '5.7.2' } } }),
      semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.7.0'] }),
    },
    vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
    advisories: {
      semver: [makeAdvisory({ id: 'GHSA-test-0001', severity: 'high' as Severity, events: [{ introduced: '0' }, { fixed: '5.7.3' }] })],
    },
  }
}

type Flag = { vuln?: Severity; deprecated?: boolean; outdated?: string }

function flaggedView(flags: Record<string, Flag>) {
  const meta: Record<string, PackageMeta> = {}
  const vulns: Record<string, string[]> = {}
  const advisories: Record<string, Advisory[]> = {}
  for (const [id, flag] of Object.entries(flags)) {
    const separator = id.lastIndexOf('@')
    const name = id.slice(0, separator)
    const version = id.slice(separator + 1)
    meta[name] = makeMeta({
      versions: [version, ...(flag.outdated ? [flag.outdated] : [])],
      latest: flag.outdated ?? version,
      deprecated: flag.deprecated ? { [version]: 'old' } : {},
    })
    if (flag.vuln) {
      vulns[id] = [`GHSA-${name}`]
      advisories[name] = [makeAdvisory({ id: `GHSA-${name}`, severity: flag.vuln })]
    }
  }
  return makeEnrichmentView({ meta, vulns, advisories })
}

describe('issuesByPackage', () => {
  it('merges the same name and version across roots into one row with two locations', () => {
    const roots = [fixtureRoot('one'), fixtureRoot('two')]
    const rows = issuesByPackage(makeEnrichmentView(semverFixtureSpec()), roots, ALL_KINDS)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'semver')
    assert.deepEqual(rows[0].kinds, ['vulnerability'])
    assert.equal(rows[0].severity, 'high')
    assert.deepEqual(rows[0].vulnIds, ['GHSA-test-0001'])
    assert.deepEqual(rows[0].locations.map((location) => location.rootId), ['one', 'two'])
    assert.equal(rows[0].locations[0].fix?.kind, 'partial')
    assert.deepEqual(rows[0].locations[0].via.map((entry) => entry.direct), ['eslint-plugin-vue@9.32.0', 'read-pkg-up@7.0.1'])
  })

  it('caps via at twenty and reports the rest', () => {
    const importers: Record<string, string[]> = { app: [] }
    const packages: Record<string, string[]> = { 'bad@1.0.0': [] }
    for (let index = 0; index < 25; index++) {
      importers.app.push(`d${index}@1.0.0`)
      packages[`d${index}@1.0.0`] = ['bad@1.0.0']
    }
    const root = makeGraph({ importers, packages })
    const rows = issuesByPackage(flaggedView({ 'bad@1.0.0': { vuln: 'high' } }), [root], ALL_KINDS)
    const location = rows[0].locations[0]
    assert.equal(VIA_CAP, 20)
    assert.equal(location.via.length, 20)
    assert.equal(location.viaTruncated, 5)
  })

  it('lists outdated direct dependencies but not outdated transitive ones', () => {
    const root = makeGraph({
      importers: { app: ['direct@1.0.0'] },
      packages: { 'direct@1.0.0': ['deep@1.0.0'], 'deep@1.0.0': [] },
    })
    const rows = issuesByPackage(
      flaggedView({ 'direct@1.0.0': { outdated: '2.0.0' }, 'deep@1.0.0': { outdated: '3.0.0' } }),
      [root],
      ALL_KINDS,
    )
    assert.deepEqual(rows.map((row) => row.name), ['direct'])
    assert.deepEqual(rows[0].kinds, ['outdated'])
    assert.equal(rows[0].latest, '2.0.0')
    assert.equal(rows[0].outdatedLevel, 'major')
    assert.equal(rows[0].wanted, '1.0.0')
  })

  it('orders by severity, then deprecated, then outdated level, then name', () => {
    const root = makeGraph({
      importers: { app: ['a-high@1.0.0', 'b-crit@1.0.0', 'c-dep@1.0.0', 'd-minor@1.0.0', 'e-major@1.0.0'] },
      packages: {
        'a-high@1.0.0': [],
        'b-crit@1.0.0': [],
        'c-dep@1.0.0': [],
        'd-minor@1.0.0': [],
        'e-major@1.0.0': [],
      },
    })
    const view = flaggedView({
      'a-high@1.0.0': { vuln: 'high' },
      'b-crit@1.0.0': { vuln: 'critical' },
      'c-dep@1.0.0': { deprecated: true, outdated: '1.0.1' },
      'd-minor@1.0.0': { outdated: '1.1.0' },
      'e-major@1.0.0': { outdated: '2.0.0' },
    })
    const rows = issuesByPackage(view, [root], ALL_KINDS)
    assert.deepEqual(rows.map((row) => row.name), ['b-crit', 'a-high', 'c-dep', 'e-major', 'd-minor'])
    assert.equal(rows[2].deprecatedMessage, 'old')
  })

  it('omits a node reachable only through dev edges when kinds is prod', () => {
    const root = makeGraph({
      importers: { app: ['dev:holder@1.0.0'] },
      packages: { 'holder@1.0.0': ['bad@1.0.0'], 'bad@1.0.0': [] },
    })
    const view = flaggedView({ 'bad@1.0.0': { vuln: 'high' } })
    assert.equal(issuesByPackage(view, [root], PROD_ONLY).length, 0)
    assert.equal(issuesByPackage(view, [root], ALL_KINDS).length, 1)
  })
})

describe('issuesByDirect', () => {
  it('groups the vulnerable node under each direct dependency that leads to it', () => {
    const groups = issuesByDirect(makeEnrichmentView(semverFixtureSpec()), [fixtureRoot('one')], ALL_KINDS)
    const byDirect = new Map(groups.map((group) => [group.direct, group]))
    assert.deepEqual([...byDirect.keys()].sort(), ['eslint-plugin-vue@9.32.0', 'read-pkg-up@7.0.1'])
    for (const direct of ['read-pkg-up@7.0.1', 'eslint-plugin-vue@9.32.0']) {
      const group = byDirect.get(direct)
      assert.deepEqual(group?.issues.map((issue) => issue.nodeId), ['semver@5.7.2'])
      assert.equal(group?.worst, 'high')
      assert.equal(group?.issues[0].fix?.kind, 'partial')
    }
  })

  it('keeps an outdated direct dependency with nothing below as a group without issues', () => {
    const root = makeGraph({ importers: { app: ['lone@1.0.0'] }, packages: { 'lone@1.0.0': [] } })
    const groups = issuesByDirect(flaggedView({ 'lone@1.0.0': { outdated: '2.0.0' } }), [root], ALL_KINDS)
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].issues, [])
    assert.equal(groups[0].worst, undefined)
    assert.equal(groups[0].decoration.outdated?.level, 'major')
    assert.deepEqual(groups[0].importers, ['importer:app'])
  })

  it('caps issues at fifty and reports the rest', () => {
    const packages: Record<string, string[]> = { 'top@1.0.0': [] }
    const flags: Record<string, Flag> = {}
    for (let index = 0; index < 60; index++) {
      packages['top@1.0.0'].push(`bad${index}@1.0.0`)
      packages[`bad${index}@1.0.0`] = []
      flags[`bad${index}@1.0.0`] = { vuln: 'low' }
    }
    const root = makeGraph({ importers: { app: ['top@1.0.0'] }, packages })
    const groups = issuesByDirect(flaggedView(flags), [root], ALL_KINDS)
    const top = groups.find((group) => group.direct === 'top@1.0.0')
    assert.equal(GROUP_ISSUES_CAP, 50)
    assert.equal(IMPORTERS_CAP, 20)
    assert.equal(top?.issues.length, 50)
    assert.equal(top?.issuesTruncated, 10)
  })
})
