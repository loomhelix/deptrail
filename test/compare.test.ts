import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RootGraph } from '../src/model.ts'
import { compareSources, hasChanges, type RootComparison } from '../src/query/compare.ts'
import { makeGraph, type GraphSpec } from './helpers/graph-factory.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

const CLEAN_VIEW = makeEnrichmentView({ vulns: {} })

function rootOf(spec: GraphSpec, overrides: Partial<RootGraph> = {}): RootGraph {
  return Object.assign(makeGraph(spec), { id: 'shop', path: 'shop' }, overrides)
}

function packagesOf(ids: string[]): Record<string, string[]> {
  return Object.fromEntries(ids.map((id) => [id, []]))
}

function only(response: ReturnType<typeof compareSources>): RootComparison {
  assert.equal(response.roots.length, 1)
  return response.roots[0]!
}

function cleanView(ids: string[]) {
  return makeEnrichmentView({ vulns: Object.fromEntries(ids.map((id) => [id, []])) })
}

describe('compareSources', () => {
  it('classifies version changes', () => {
    const base = rootOf({ importers: {}, packages: packagesOf(['a@1.0.0', 'b@1.0.0', 'c@2.0.0', 'd@1.0.0', 'd@2.0.0']) })
    const target = rootOf({ importers: {}, packages: packagesOf(['a@1.1.0', 'c@1.0.0', 'd@1.0.0', 'e@1.0.0']) })
    const root = only(compareSources(CLEAN_VIEW, { roots: [base] }, { roots: [target] }))
    assert.equal(root.presence, 'both')
    assert.equal(root.state, 'ready')
    assert.equal(root.exact, true)
    assert.deepEqual(root.versions, [
      { name: 'a', change: 'upgraded', base: ['1.0.0'], target: ['1.1.0'], targetNode: 'a@1.1.0' },
      { name: 'b', change: 'removed', base: ['1.0.0'], target: [] },
      { name: 'c', change: 'downgraded', base: ['2.0.0'], target: ['1.0.0'], targetNode: 'c@1.0.0' },
      { name: 'd', change: 'changed', base: ['1.0.0', '2.0.0'], target: ['1.0.0'], targetNode: 'd@1.0.0' },
      { name: 'e', change: 'added', base: [], target: ['1.0.0'], targetNode: 'e@1.0.0' },
    ])
  })

  it('lists direct dependency changes', () => {
    const base = rootOf({ importers: { web: ['x@1.0.0 ^1.0.0', 'dev:y@1.0.0 1.0.0'] }, packages: packagesOf(['x@1.0.0', 'y@1.0.0']) })
    const target = rootOf({ importers: { web: ['x@2.0.0 ^2.0.0', 'z@1.0.0 1.0.0'] }, packages: packagesOf(['x@2.0.0', 'z@1.0.0']) })
    const root = only(compareSources(CLEAN_VIEW, { roots: [base] }, { roots: [target] }))
    assert.deepEqual(root.directs, [
      { importer: 'web', importerName: 'web', name: 'x', kind: 'prod', change: 'changed', base: '^1.0.0', target: '^2.0.0', targetNode: 'x@2.0.0' },
      { importer: 'web', importerName: 'web', name: 'y', kind: 'dev', change: 'removed', base: '1.0.0' },
      { importer: 'web', importerName: 'web', name: 'z', kind: 'prod', change: 'added', target: '1.0.0', targetNode: 'z@1.0.0' },
    ])
  })

  it('lists workspace packages added and removed without their edges', () => {
    const base = rootOf({ importers: { web: [], old: ['x@1.0.0'] }, packages: packagesOf(['x@1.0.0']) })
    const target = rootOf({ importers: { web: [], api: ['x@1.0.0'] }, packages: packagesOf(['x@1.0.0']) })
    const root = only(compareSources(CLEAN_VIEW, { roots: [base] }, { roots: [target] }))
    assert.deepEqual(root.importers, [
      { path: 'api', name: 'api', change: 'added' },
      { path: 'old', name: 'old', change: 'removed' },
    ])
    assert.deepEqual(root.directs, [])
  })

  it('reports introduced and resolved risk', () => {
    const view = makeEnrichmentView({
      vulns: { 'v@1.0.0': ['GHSA-1'], 'v@1.1.0': [], 'w@1.0.0': [], 'w@2.0.0': [] },
      advisories: { v: [makeAdvisory({ id: 'GHSA-1', severity: 'high' })] },
      meta: { w: makeMeta({ versions: ['1.0.0', '2.0.0'], deprecated: { '2.0.0': 'use x' } }), v: makeMeta({ versions: ['1.0.0', '1.1.0'] }) },
    })
    const older = rootOf({ importers: {}, packages: packagesOf(['v@1.0.0', 'w@1.0.0']) })
    const newer = rootOf({ importers: {}, packages: packagesOf(['v@1.1.0', 'w@2.0.0']) })
    const forward = only(compareSources(view, { roots: [older] }, { roots: [newer] }))
    assert.deepEqual(forward.risk, [
      { name: 'w', version: '2.0.0', issue: 'deprecated', change: 'introduced', targetNode: 'w@2.0.0' },
      { name: 'v', version: '1.0.0', issue: 'vulnerability', change: 'resolved', severity: 'high' },
    ])
    const backward = only(compareSources(view, { roots: [newer] }, { roots: [older] }))
    assert.deepEqual(backward.risk, [
      { name: 'v', version: '1.0.0', issue: 'vulnerability', change: 'introduced', severity: 'high', targetNode: 'v@1.0.0' },
      { name: 'w', version: '2.0.0', issue: 'deprecated', change: 'resolved' },
    ])
    assert.equal(forward.riskPending, 0)
  })

  it('orders introduced risk by severity, then name', () => {
    const view = makeEnrichmentView({
      vulns: { 'a@1.0.0': ['GHSA-a'], 'b@1.0.0': ['GHSA-b'], 'c@1.0.0': ['GHSA-c'] },
      advisories: {
        a: [makeAdvisory({ id: 'GHSA-a', severity: 'low' })],
        b: [makeAdvisory({ id: 'GHSA-b', severity: 'critical' })],
        c: [makeAdvisory({ id: 'GHSA-c', severity: 'critical' })],
      },
    })
    const base = rootOf({ importers: {}, packages: {} })
    const target = rootOf({ importers: {}, packages: packagesOf(['a@1.0.0', 'c@1.0.0', 'b@1.0.0']) })
    const root = only(compareSources(view, { roots: [base] }, { roots: [target] }))
    assert.deepEqual(
      root.risk.map((risk) => risk.name),
      ['b', 'c', 'a'],
    )
  })

  it('counts pending risk', () => {
    const base = rootOf({ importers: {}, packages: packagesOf(['a@1.0.0']) })
    const target = rootOf({ importers: {}, packages: packagesOf(['a@1.1.0']) })
    const view = makeEnrichmentView({ vulns: { 'a@1.0.0': [] }, meta: { a: makeMeta({ versions: ['1.0.0', '1.1.0'] }) } })
    const root = only(compareSources(view, { roots: [base] }, { roots: [target] }))
    assert.equal(root.riskPending, 1)
  })

  it('counts a vulnerable version whose advisories are still loading as pending', () => {
    const base = rootOf({ importers: {}, packages: packagesOf(['a@1.0.0']) })
    const target = rootOf({ importers: {}, packages: packagesOf(['a@1.1.0']) })
    const meta = { a: makeMeta({ versions: ['1.0.0', '1.1.0'] }) }
    const view = makeEnrichmentView({ vulns: { 'a@1.0.0': [], 'a@1.1.0': ['GHSA-1'] }, meta })
    const root = only(compareSources(view, { roots: [base] }, { roots: [target] }))
    assert.equal(root.riskPending, 1)
  })

  it('does not compare versions of an inexact root', () => {
    const base = rootOf({ importers: { web: ['x@1.0.0 ^1.0.0'] }, packages: packagesOf(['x@1.0.0']) })
    const target = rootOf({ importers: { web: ['x@^2.0.0 ^2.0.0'] }, packages: packagesOf(['x@^2.0.0']) }, { source: 'manifest-only' })
    const root = only(compareSources(CLEAN_VIEW, { roots: [base] }, { roots: [target] }))
    assert.equal(root.exact, false)
    assert.deepEqual(root.versions, [])
    assert.deepEqual(root.risk, [])
    assert.deepEqual(root.notes, [{ side: 'target', kind: 'inexact', source: 'manifest-only' }])
    assert.equal(root.directs.length, 1)
    assert.equal(root.directs[0]?.change, 'changed')
  })

  it('marks scanning and failed roots', () => {
    const ready = rootOf({ importers: {}, packages: packagesOf(['a@1.0.0']) })
    const scanning = rootOf({ importers: {}, packages: {} }, { status: 'scanning' })
    const pending = compareSources(CLEAN_VIEW, { roots: [ready] }, { roots: [scanning] })
    assert.equal(pending.complete, false)
    assert.equal(only(pending).state, 'scanning')
    assert.deepEqual(only(pending).versions, [])
    const failed = rootOf({ importers: {}, packages: {} }, { status: 'failed', error: 'boom' })
    const broken = compareSources(CLEAN_VIEW, { roots: [failed] }, { roots: [ready] })
    assert.equal(broken.complete, true)
    assert.equal(only(broken).state, 'failed')
    assert.deepEqual(only(broken).notes, [{ side: 'base', kind: 'failed', error: 'boom' }])
    assert.deepEqual(only(broken).versions, [])
  })

  it('handles roots on one side', () => {
    const view = makeEnrichmentView({ vulns: { 'v@1.0.0': ['GHSA-1'] }, advisories: { v: [makeAdvisory({ id: 'GHSA-1', severity: 'moderate' })] } })
    const added = rootOf({ importers: { '.': ['v@1.0.0'] }, packages: packagesOf(['v@1.0.0']) }, { id: 'tools', path: 'tools' })
    const response = compareSources(view, { roots: [] }, { roots: [added] })
    const root = only(response)
    assert.equal(root.rootId, 'tools')
    assert.equal(root.presence, 'target-only')
    assert.deepEqual(root.versions, [])
    assert.deepEqual(root.directs, [])
    assert.deepEqual(root.risk, [{ name: 'v', version: '1.0.0', issue: 'vulnerability', change: 'introduced', severity: 'moderate', targetNode: 'v@1.0.0' }])
    assert.equal(only(compareSources(view, { roots: [added] }, { roots: [] })).presence, 'base-only')
  })

  it('does not compare a root that the other side skipped as a submodule', () => {
    const view = makeEnrichmentView({ vulns: { 'v@1.0.0': ['GHSA-1'] }, advisories: { v: [makeAdvisory({ id: 'GHSA-1', severity: 'high' })] } })
    const vendored = rootOf({ importers: { '.': ['v@1.0.0'] }, packages: packagesOf(['v@1.0.0']) }, { id: 'vendor/sub', path: 'vendor/sub' })
    const skipped = { roots: [], skippedSubmodules: ['vendor'] }
    const target = only(compareSources(view, skipped, { roots: [vendored] }))
    assert.equal(target.presence, 'target-only')
    assert.equal(target.exact, false)
    assert.deepEqual(target.notes, [{ side: 'base', kind: 'submodule' }])
    assert.deepEqual(target.risk, [])
    const base = only(compareSources(view, { roots: [vendored] }, { roots: [], skippedSubmodules: ['vendor/sub'] }))
    assert.deepEqual(base.notes, [{ side: 'target', kind: 'submodule' }])
    assert.deepEqual(base.risk, [])
    const unrelated = only(compareSources(view, { roots: [], skippedSubmodules: ['vend'] }, { roots: [vendored] }))
    assert.deepEqual(unrelated.notes, [])
    assert.equal(unrelated.risk.length, 1)
  })

  it('orders roots by id and carries the enrichment revision', () => {
    const view = makeEnrichmentView({ revision: 7, vulns: {} })
    const zeta = rootOf({ importers: {}, packages: {} }, { id: 'zeta', path: 'zeta' })
    const alpha = rootOf({ importers: {}, packages: {} }, { id: 'alpha', path: 'alpha' })
    const response = compareSources(view, { roots: [zeta] }, { roots: [alpha, zeta] })
    assert.equal(response.revision, 7)
    assert.deepEqual(
      response.roots.map((root) => root.rootId),
      ['alpha', 'zeta'],
    )
  })

  it('does not count a root that is approximate on both sides and unchanged', () => {
    const approximate = rootOf({ importers: { web: ['x@^1.0.0 ^1.0.0'] }, packages: packagesOf(['x@^1.0.0']) }, { source: 'manifest-only' })
    const same = only(compareSources(CLEAN_VIEW, { roots: [approximate] }, { roots: [approximate] }))
    assert.equal(same.notes.length, 2)
    assert.equal(hasChanges(same), false)
    const resolvedToday = rootOf({ importers: { web: ['x@1.0.0 ^1.0.0'] }, packages: packagesOf(['x@1.0.0']) }, { source: 'resolved-today' })
    assert.equal(hasChanges(only(compareSources(CLEAN_VIEW, { roots: [approximate] }, { roots: [resolvedToday] }))), true)
    const exact = rootOf({ importers: { web: ['x@1.0.0 ^1.0.0'] }, packages: packagesOf(['x@1.0.0']) })
    assert.equal(hasChanges(only(compareSources(CLEAN_VIEW, { roots: [exact] }, { roots: [approximate] }))), true)
  })

  it('tells roots with changes apart', () => {
    const same = rootOf({ importers: { web: ['a@1.0.0'] }, packages: packagesOf(['a@1.0.0']) })
    const view = cleanView(['a@1.0.0', 'a@1.1.0'])
    assert.equal(hasChanges(only(compareSources(view, { roots: [same] }, { roots: [same] }))), false)
    const moved = rootOf({ importers: { web: ['a@1.1.0'] }, packages: packagesOf(['a@1.1.0']) })
    assert.equal(hasChanges(only(compareSources(view, { roots: [same] }, { roots: [moved] }))), true)
    assert.equal(hasChanges(only(compareSources(view, { roots: [] }, { roots: [same] }))), true)
  })
})
