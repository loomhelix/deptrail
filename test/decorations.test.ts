import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decorations, isDirectDependency, issueCounts } from '../src/query/decorations.ts'
import { nodeAdvisories, requestedRange } from '../src/query/enrichment-lookup.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import type { DepKind, PackageNode } from '../src/model.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

const PROD_ONLY = new Set<DepKind>(['prod'])

function highVulnView(...names: string[]) {
  const vulns: Record<string, string[]> = {}
  const advisories: Record<string, ReturnType<typeof makeAdvisory>[]> = {}
  for (const id of names) {
    const name = id.slice(0, id.lastIndexOf('@'))
    vulns[id] = [`GHSA-${name}`]
    advisories[name] = [makeAdvisory({ id: `GHSA-${name}`, severity: 'high' })]
  }
  return makeEnrichmentView({ vulns, advisories })
}

test('a node with one high advisory gets vuln', () => {
  const root = makeGraph({ importers: { app: ['a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  const result = decorations(highVulnView('a@1.0.0'), root, ALL_KINDS)
  assert.deepEqual(result['a@1.0.0'].vuln, { severity: 'high', count: 1 })
})

test('a MAL advisory marks the vulnerability malicious', () => {
  const root = makeGraph({ importers: { app: ['a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  const view = makeEnrichmentView({
    vulns: { 'a@1.0.0': ['MAL-1'] },
    advisories: { a: [makeAdvisory({ id: 'MAL-1', severity: 'critical' })] },
  })
  assert.deepEqual(decorations(view, root, ALL_KINDS)['a@1.0.0'].vuln, { severity: 'critical', count: 1, malicious: true })
})

test('a diamond rolls up to every ancestor once and never to the vulnerable node', () => {
  const root = makeGraph({
    importers: { app: ['a@1.0.0', 'b@1.0.0'] },
    packages: { 'a@1.0.0': ['c@1.0.0'], 'b@1.0.0': ['c@1.0.0'], 'c@1.0.0': [] },
  })
  const result = decorations(highVulnView('c@1.0.0'), root, ALL_KINDS)
  for (const id of ['a@1.0.0', 'b@1.0.0', 'importer:app']) assert.deepEqual(result[id].below, { count: 1, worst: 'high' })
  assert.equal(result['c@1.0.0'].below, undefined)
})

test('two vulnerable nodes under one parent aggregate count and worst', () => {
  const root = makeGraph({
    importers: { app: ['a@1.0.0'] },
    packages: { 'a@1.0.0': ['x@1.0.0', 'y@1.0.0'], 'x@1.0.0': [], 'y@1.0.0': [] },
  })
  const view = makeEnrichmentView({
    vulns: { 'x@1.0.0': ['X'], 'y@1.0.0': ['Y'] },
    advisories: { x: [makeAdvisory({ id: 'X', severity: 'high' })], y: [makeAdvisory({ id: 'Y', severity: 'low' })] },
  })
  assert.deepEqual(decorations(view, root, ALL_KINDS)['a@1.0.0'].below, { count: 2, worst: 'high' })
})

test('a cycle terminates', () => {
  const root = makeGraph({
    importers: { app: ['x@1.0.0'] },
    packages: { 'x@1.0.0': ['y@1.0.0'], 'y@1.0.0': ['x@1.0.0'] },
  })
  const result = decorations(highVulnView('y@1.0.0'), root, ALL_KINDS)
  assert.equal(result['x@1.0.0'].below?.count, 1)
  assert.equal(result['y@1.0.0'].below, undefined)
})

test('kinds that exclude dev block the roll-up through a dev edge', () => {
  const root = makeGraph({ importers: { app: ['dev:a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  const view = highVulnView('a@1.0.0')
  assert.equal(decorations(view, root, PROD_ONLY)['importer:app']?.below, undefined)
  assert.equal(decorations(view, root, ALL_KINDS)['importer:app'].below?.count, 1)
})

test('outdated, no outdated for non-semver, and deprecated', () => {
  const root = makeGraph({
    importers: { app: ['semver@5.7.2', 'odd@^1.0.0', 'old@1.0.0'] },
    packages: { 'semver@5.7.2': [], 'odd@^1.0.0': [], 'old@1.0.0': [] },
  })
  const view = makeEnrichmentView({
    meta: {
      semver: makeMeta({ versions: ['5.7.2', '7.7.0'], latest: '7.7.0' }),
      odd: makeMeta({ versions: [], latest: '9.0.0' }),
      old: makeMeta({ versions: ['1.0.0'], latest: '1.0.0', deprecated: { '1.0.0': 'gone' } }),
    },
  })
  const result = decorations(view, root, ALL_KINDS)
  assert.deepEqual(result['semver@5.7.2'].outdated, { level: 'major', latest: '7.7.0' })
  assert.equal(result['odd@^1.0.0']?.outdated, undefined)
  assert.equal(result['old@1.0.0'].deprecated, true)
})

test('decorations memoize per revision and kinds', () => {
  const root = makeGraph({ importers: { app: ['a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  const first = makeEnrichmentView({ revision: 1 })
  const second = makeEnrichmentView({ revision: 2 })
  assert.equal(decorations(first, root, ALL_KINDS), decorations(first, root, ALL_KINDS))
  assert.notEqual(decorations(first, root, ALL_KINDS), decorations(second, root, ALL_KINDS))
  assert.notEqual(decorations(second, root, ALL_KINDS), decorations(second, root, PROD_ONLY))
})

test('issueCounts distinct nodes and direct outdated', () => {
  const root = makeGraph({
    importers: { app: ['a@1.0.0', 'dep@1.0.0'] },
    packages: {
      'a@1.0.0': ['v@1.0.0', 't@1.0.0'],
      'v@1.0.0': [],
      't@1.0.0': [],
      'dep@1.0.0': [],
    },
  })
  const view = makeEnrichmentView({
    vulns: { 'v@1.0.0': ['V'] },
    advisories: { v: [makeAdvisory({ id: 'V', severity: 'high' })] },
    meta: {
      a: makeMeta({ versions: ['1.0.0'], latest: '1.0.0', deprecated: { '1.0.0': 'old' } }),
      dep: makeMeta({ versions: ['1.0.0', '2.0.0'], latest: '2.0.0' }),
      t: makeMeta({ versions: ['1.0.0', '1.1.0'], latest: '1.1.0' }),
    },
  })
  assert.deepEqual(issueCounts(view, root), { vulnerable: 1, worst: 'high', deprecated: 1, outdatedDirect: 1 })
})

test('issueCounts at an unchanged revision keeps filtered decorations memoized', () => {
  const root = makeGraph({ importers: { app: ['a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  const view = highVulnView('a@1.0.0')
  issueCounts(view, root)
  const filtered = decorations(view, root, PROD_ONLY)
  assert.equal(issueCounts(view, root).vulnerable, 1)
  assert.equal(decorations(view, root, PROD_ONLY), filtered)
})

test('issueCounts recompute at a new revision', () => {
  const root = makeGraph({ importers: { app: ['a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  assert.equal(issueCounts(makeEnrichmentView({ revision: 1 }), root).vulnerable, 0)
  const vulnerable = makeEnrichmentView({
    revision: 2,
    vulns: { 'a@1.0.0': ['A'] },
    advisories: { a: [makeAdvisory({ id: 'A', severity: 'low' })] },
  })
  assert.deepEqual(issueCounts(vulnerable, root), { vulnerable: 1, worst: 'low', deprecated: 0, outdatedDirect: 0 })
})

test('isDirectDependency follows the kind filter', () => {
  const root = makeGraph({ importers: { app: ['dev:a@1.0.0'] }, packages: { 'a@1.0.0': ['b@1.0.0'], 'b@1.0.0': [] } })
  const a = root.packages.get('a@1.0.0') as PackageNode
  const b = root.packages.get('b@1.0.0') as PackageNode
  assert.equal(isDirectDependency(root, a, ALL_KINDS), true)
  assert.equal(isDirectDependency(root, a, PROD_ONLY), false)
  assert.equal(isDirectDependency(root, b, ALL_KINDS), false)
})

test('requestedRange prefers the published manifest of a package parent', () => {
  const root = makeGraph({
    importers: { app: ['normalize-package-data@2.5.0'] },
    packages: { 'normalize-package-data@2.5.0': ['semver@5.7.2'], 'semver@5.7.2': [] },
  })
  const view = makeEnrichmentView({
    meta: {
      'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } }),
    },
  })
  const parent = root.packages.get('normalize-package-data@2.5.0') as PackageNode
  const child = root.packages.get('semver@5.7.2') as PackageNode
  assert.deepEqual(requestedRange(view, root, parent, '5.7.2', child), { range: '2 || 3 || 4 || 5', source: 'published-manifest' })
  const importer = root.importers[0]
  assert.deepEqual(requestedRange(view, root, importer, '5.7.2', child), { range: '5.7.2', source: 'lockfile' })
})

test('advisory ids without loaded advisories become unknown stand-ins', () => {
  const root = makeGraph({ importers: { app: ['a@1.0.0'] }, packages: { 'a@1.0.0': [] } })
  const view = makeEnrichmentView({ vulns: { 'a@1.0.0': ['GHSA-zzz'] } })
  const [advisory] = nodeAdvisories(view, root, root.packages.get('a@1.0.0') as PackageNode)
  assert.equal(advisory.id, 'GHSA-zzz')
  assert.equal(advisory.severity, 'unknown')
  assert.equal(advisory.url, 'https://osv.dev/vulnerability/GHSA-zzz')
})
