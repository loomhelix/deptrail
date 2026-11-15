import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { REQUESTED_CAP, packageInsight } from '../src/query/package-insight.ts'
import { ALL_KINDS, UnknownNodeError } from '../src/query/lookup.ts'
import { IMPORTER_PREFIX } from '../src/model.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

function fixtureRoot() {
  return makeGraph({
    importers: { 'tools/build': ['read-pkg-up@7.0.1'], storefront: ['eslint-plugin-vue@9.32.0'] },
    packages: {
      'read-pkg-up@7.0.1': ['normalize-package-data@2.5.0'],
      'normalize-package-data@2.5.0': ['semver@5.7.2'],
      'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
      'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
      'semver@5.7.2': [],
    },
  })
}

function semverSpec() {
  return {
    meta: {
      'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
      'vue-eslint-parser': makeMeta({ versions: ['9.4.3'], manifests: { '9.4.3': { semver: '5.7.2' } } }),
      semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.7.0'], latest: '7.7.0' }),
    },
    vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
    advisories: {
      semver: [makeAdvisory({ id: 'GHSA-test-0001', severity: 'high' as const, events: [{ introduced: '0' }, { fixed: '5.7.3' }] })],
    },
  }
}

describe('packageInsight', () => {
  it('reports requested ranges with wanted and per-edge fix, the node fix and the vulnerability', () => {
    const insight = packageInsight(makeEnrichmentView(semverSpec()), fixtureRoot(), 'semver@5.7.2', ALL_KINDS, ['5.7.2'])
    assert.equal(insight.requested.length, 2)
    assert.ok(insight.requested.every((row) => row.rangeSource === 'published-manifest'))
    assert.deepEqual(insight.requested.map((row) => row.wanted).sort(), ['5.7.2', '5.7.3'])
    assert.deepEqual(insight.requested.map((row) => [row.fix, row.fixVersion]).sort(), [['bump-parent', undefined], ['within-range', '5.7.3']])
    assert.equal(insight.fix?.kind, 'partial')
    assert.deepEqual(insight.vulnerabilities.items.map((item) => item.id), ['GHSA-test-0001'])
    assert.equal(insight.vulnerabilities.state, 'ok')
    assert.equal(insight.registry.latest, '7.7.0')
    assert.equal(insight.registry.outdatedLevel, 'major')
  })

  it('gives every requested range an unknown fix while the advisories are pending', () => {
    const pending = makeEnrichmentView({ ...semverSpec(), advisories: {} })
    const insight = packageInsight(pending, fixtureRoot(), 'semver@5.7.2', ALL_KINDS, ['5.7.2'])
    assert.deepEqual(insight.requested.map((row) => [row.fix, row.fixVersion]), [['unknown', undefined], ['unknown', undefined]])
    assert.equal(insight.fix?.kind, 'unknown')
    assert.equal(insight.fix?.version, undefined)
    assert.deepEqual(insight.vulnerabilities.items.map((item) => item.id), ['GHSA-test-0001'])
  })

  it('caps requested rows at fifty and counts the rest', () => {
    const importers: Record<string, string[]> = { app: [] }
    const packages: Record<string, string[]> = { 'bad@1.0.0': [] }
    for (let index = 0; index < 60; index++) {
      importers.app.push(`p${index}@1.0.0`)
      packages[`p${index}@1.0.0`] = ['bad@1.0.0']
    }
    const view = makeEnrichmentView({ meta: { bad: makeMeta({ versions: ['1.0.0'] }) } })
    const insight = packageInsight(view, makeGraph({ importers, packages }), 'bad@1.0.0', ALL_KINDS, [])
    assert.equal(insight.requested.length, REQUESTED_CAP)
    assert.equal(insight.requestedTruncated, 10)
    assert.ok(insight.requested.every((row) => row.fix === undefined))
  })

  it('reports a skipped private scope', () => {
    const view = makeEnrichmentView({ skipped: { 'semver@5.7.2': 'private-scope' } })
    const insight = packageInsight(view, fixtureRoot(), 'semver@5.7.2', ALL_KINDS, [])
    assert.deepEqual(insight.vulnerabilities, { state: 'skipped', reason: 'private-scope', items: [] })
  })

  it('flags a version missing from the registry', () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.9'] }, packages: { 'semver@5.7.9': [] } })
    const insight = packageInsight(makeEnrichmentView(semverSpec()), root, 'semver@5.7.9', ALL_KINDS, [])
    assert.equal(insight.registry.versionMissing, true)
  })

  it('reports the failure reason', () => {
    const view = makeEnrichmentView({ failedRegistry: { semver: 'HTTP 500' } })
    const insight = packageInsight(view, fixtureRoot(), 'semver@5.7.2', ALL_KINDS, [])
    assert.deepEqual(insight.registry, { state: 'failed', message: 'HTTP 500' })
  })

  it('reports the reason of a failed vulnerability check', () => {
    const view = makeEnrichmentView({ failedMatches: { 'semver@5.7.2': 'responded with HTTP 500' } })
    const insight = packageInsight(view, fixtureRoot(), 'semver@5.7.2', ALL_KINDS, [])
    assert.deepEqual(insight.vulnerabilities, { state: 'failed', message: 'responded with HTTP 500', items: [] })
  })

  it('is not applicable for importers', () => {
    const insight = packageInsight(makeEnrichmentView(semverSpec()), fixtureRoot(), `${IMPORTER_PREFIX}storefront`, ALL_KINDS, ['1.0.0'])
    assert.deepEqual(insight.registry, { state: 'not-applicable' })
    assert.deepEqual(insight.vulnerabilities, { state: 'not-applicable', items: [] })
    assert.deepEqual(insight.requested, [])
    assert.deepEqual(insight.versionSeverities, {})
  })

  it('throws for unknown ids', () => {
    assert.throws(() => packageInsight(makeEnrichmentView({}), fixtureRoot(), 'nope@1.0.0', ALL_KINDS, []), UnknownNodeError)
  })

  it('reports offline for both sections', () => {
    const insight = packageInsight(makeEnrichmentView({ offline: true }), fixtureRoot(), 'semver@5.7.2', ALL_KINDS, [])
    assert.equal(insight.registry.state, 'offline')
    assert.equal(insight.vulnerabilities.state, 'offline')
  })

  it('reports the severity of other monolith versions with advisories', () => {
    const spec = semverSpec()
    const view = makeEnrichmentView({
      ...spec,
      vulns: { ...spec.vulns, 'semver@6.3.1': ['GHSA-test-0002'] },
      advisories: { semver: [...spec.advisories.semver, makeAdvisory({ id: 'GHSA-test-0002', severity: 'moderate' })] },
    })
    const insight = packageInsight(view, fixtureRoot(), 'semver@5.7.2', ALL_KINDS, ['5.7.2', '7.7.0', '6.3.1'])
    assert.deepEqual(insight.versionSeverities, { '6.3.1': 'moderate' })
  })
})
