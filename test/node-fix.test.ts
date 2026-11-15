import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { edgeFixes, nodeFix } from '../src/query/node-fix.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import type { PackageNode } from '../src/model.ts'
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

function fixtureView(vueParserSemverRange = '5.7.2') {
  return makeEnrichmentView({
    meta: {
      'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
      'vue-eslint-parser': makeMeta({ versions: ['9.4.3'], manifests: { '9.4.3': { semver: vueParserSemverRange } } }),
      semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.7.0'] }),
    },
    vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
    advisories: {
      semver: [makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })],
    },
  })
}

function semverNode(root: ReturnType<typeof fixtureRoot>): PackageNode {
  return root.packages.get('semver@5.7.2') as PackageNode
}

describe('nodeFix', () => {
  it('is partial when one parent re-locks and the other must be bumped', () => {
    const root = fixtureRoot()
    const fix = nodeFix(fixtureView(), root, semverNode(root), ALL_KINDS)
    assert.equal(fix?.kind, 'partial')
    assert.deepEqual(fix?.bump, [{ nodeId: 'vue-eslint-parser@9.4.3', isImporter: false }])
  })

  it('re-locks when every published range admits the safe version', () => {
    const root = fixtureRoot()
    const fix = nodeFix(fixtureView('^5.7.0'), root, semverNode(root), ALL_KINDS)
    assert.equal(fix?.kind, 'relock')
    assert.equal(fix?.version, '5.7.3')
  })

  it('asks the importer to bump a direct dependency whose range excludes every safe version', () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.2'] }, packages: { 'semver@5.7.2': [] } })
    const fix = nodeFix(fixtureView(), root, semverNode(root), ALL_KINDS)
    assert.equal(fix?.kind, 'bump')
    assert.deepEqual(fix?.bump, [{ nodeId: 'importer:app', isImporter: true }])
  })

  it('is undefined without advisories', () => {
    const root = fixtureRoot()
    const clean = makeEnrichmentView({})
    assert.equal(nodeFix(clean, root, semverNode(root), ALL_KINDS), undefined)
  })

  it('is unknown while the advisories of the package are pending', () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.2'] }, packages: { 'semver@5.7.2': [] } })
    const view = makeEnrichmentView({
      meta: { semver: makeMeta({ versions: ['5.7.1', '5.7.2', '5.7.3'] }) },
      vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
    })
    assert.deepEqual(nodeFix(view, root, semverNode(root), ALL_KINDS), { kind: 'unknown', bump: [], bumpTruncated: 0 })
    assert.deepEqual(edgeFixes(view, root, semverNode(root), ALL_KINDS).map((entry) => entry.fix), [{ kind: 'unknown' }])
  })

  it('is unknown when loading the advisories of the package failed', () => {
    const root = fixtureRoot()
    const view = makeEnrichmentView({
      meta: { semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.7.0'] }) },
      vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
      failedAdvisories: { semver: 'responded with HTTP 503' },
    })
    assert.equal(nodeFix(view, root, semverNode(root), ALL_KINDS)?.kind, 'unknown')
    assert.ok(edgeFixes(view, root, semverNode(root), ALL_KINDS).every((entry) => entry.fix.kind === 'unknown'))
  })

  it('is unknown when a reported id is missing from the loaded advisories', () => {
    const root = fixtureRoot()
    const view = makeEnrichmentView({
      meta: { semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.7.0'] }) },
      vulns: { 'semver@5.7.2': ['GHSA-test-0001', 'GHSA-test-0002'] },
      advisories: {
        semver: [makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })],
      },
    })
    assert.equal(nodeFix(view, root, semverNode(root), ALL_KINDS)?.kind, 'unknown')
  })

  it('matches a reported id to a loaded advisory by alias', () => {
    const root = fixtureRoot()
    const aliased = { ...makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] }), aliases: ['CVE-2022-25883'] }
    const view = makeEnrichmentView({
      meta: {
        'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
        'vue-eslint-parser': makeMeta({ versions: ['9.4.3'], manifests: { '9.4.3': { semver: '^5.7.0' } } }),
        semver: makeMeta({ versions: ['5.7.2', '5.7.3', '7.7.0'] }),
      },
      vulns: { 'semver@5.7.2': ['CVE-2022-25883'] },
      advisories: { semver: [aliased] },
    })
    const fix = nodeFix(view, root, semverNode(root), ALL_KINDS)
    assert.equal(fix?.kind, 'relock')
    assert.equal(fix?.version, '5.7.3')
  })

  it('never offers the current version as a fix, even when the advisories do not cover it', () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.2'] }, packages: { 'semver@5.7.2': [] } })
    const view = makeEnrichmentView({
      meta: { semver: makeMeta({ versions: ['5.7.2', '5.8.0'] }) },
      vulns: { 'semver@5.7.2': ['GHSA-test-0001'] },
      advisories: { semver: [makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '6.0.0' }, { fixed: '6.3.1' }] })] },
    })
    const fix = nodeFix(view, root, semverNode(root), ALL_KINDS)
    assert.equal(fix?.kind, 'bump')
    assert.notEqual(fix?.version, '5.7.2')
    assert.deepEqual(edgeFixes(view, root, semverNode(root), ALL_KINDS).map((entry) => entry.fix), [{ kind: 'bump-manifest', version: '5.8.0' }])
  })

  it('lists one fix per parent edge', () => {
    const root = fixtureRoot()
    const fixes = edgeFixes(fixtureView(), root, semverNode(root), ALL_KINDS)
    assert.deepEqual(
      fixes.map((entry) => [entry.parent, entry.parentIsImporter, entry.range.source, entry.fix.kind]),
      [
        ['normalize-package-data@2.5.0', false, 'published-manifest', 'within-range'],
        ['vue-eslint-parser@9.4.3', false, 'published-manifest', 'bump-parent'],
      ],
    )
  })
})

describe('fix candidates against every advisory of the package', () => {
  function libView() {
    return makeEnrichmentView({
      meta: {
        parent: makeMeta({ versions: ['1.0.0'], manifests: { '1.0.0': { lib: '~1.0.0' } } }),
        lib: makeMeta({ versions: ['1.0.0', '1.0.1', '2.0.0'] }),
      },
      vulns: { 'lib@1.0.0': ['GHSA-a'] },
      advisories: {
        lib: [
          makeAdvisory({ id: 'GHSA-a', severity: 'high', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }),
          makeAdvisory({ id: 'GHSA-b', severity: 'critical', events: [{ introduced: '1.0.1' }, { fixed: '2.0.0' }] }),
        ],
      },
    })
  }

  it('asks the parent to bump when the only newer version in its range is affected by another advisory', () => {
    const root = makeGraph({
      importers: { app: ['parent@1.0.0'] },
      packages: { 'parent@1.0.0': ['lib@1.0.0'], 'lib@1.0.0': [] },
    })
    const fix = nodeFix(libView(), root, root.packages.get('lib@1.0.0') as PackageNode, ALL_KINDS)
    assert.equal(fix?.kind, 'bump')
    assert.deepEqual(fix?.bump, [{ nodeId: 'parent@1.0.0', isImporter: false }])
  })

  it('asks the importer to bump to a version no advisory of the package affects', () => {
    const root = makeGraph({ importers: { app: ['lib@1.0.0'] }, packages: { 'lib@1.0.0': [] } })
    const view = makeEnrichmentView({
      meta: { lib: makeMeta({ versions: ['1.0.0', '1.0.1', '2.0.0'] }) },
      vulns: { 'lib@1.0.0': ['GHSA-a'] },
      advisories: {
        lib: [
          makeAdvisory({ id: 'GHSA-a', severity: 'high', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }),
          makeAdvisory({ id: 'GHSA-b', severity: 'critical', events: [{ introduced: '1.0.1' }, { fixed: '2.0.0' }] }),
        ],
      },
    })
    const fixes = edgeFixes(view, root, root.packages.get('lib@1.0.0') as PackageNode, ALL_KINDS)
    assert.deepEqual(fixes.map((entry) => entry.fix), [{ kind: 'bump-manifest', version: '2.0.0' }])
  })
})
