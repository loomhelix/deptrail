import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { edgeMoveWarnings } from '../src/actions/edge-moves.ts'
import type { OverrideStep, RelockStep, SetRangeStep } from '../src/actions/types.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import type { RootGraph } from '../src/model.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const RELOCK: RelockStep = { kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: 'helper accepts it' }
const OVERRIDE: OverrideStep = { kind: 'override', selector: 'child-lib@<1.0.1', value: '1.0.1', file: 'pnpm-workspace.yaml', reason: 'forces 1.0.1' }

function probeGraph(versions: { helper: string; wide: string; other: string }): RootGraph {
  return makeGraph({
    importers: { '.': ['helper@1.0.0', 'wide-lib@1.0.0', 'other-lib@1.0.0'] },
    packages: {
      'helper@1.0.0': [`child-lib@${versions.helper}`],
      'wide-lib@1.0.0': [`child-lib@${versions.wide}`],
      'other-lib@1.0.0': [`child-lib@${versions.other}`],
      [`child-lib@${versions.helper}`]: [],
      [`child-lib@${versions.wide}`]: [],
      [`child-lib@${versions.other}`]: [],
    },
  })
}

function peerVariantGraph(peerSuffixes: readonly string[], childVersion: string): RootGraph {
  const builder = new RootGraphBuilder({ id: 'test-root', path: '.', manager: 'pnpm', source: 'lockfile' })
  builder.addImporter('.', 'app')
  builder.addPackage(`child-lib@${childVersion}`, 'child-lib', childVersion)
  for (const peerSuffix of peerSuffixes) {
    const parentId = `wide-lib@1.0.0${peerSuffix}`
    builder.addPackage(parentId, 'wide-lib', '1.0.0', peerSuffix)
    builder.addEdge('importer:.', { to: parentId, kind: 'prod', range: '^1.0.0' })
    builder.addEdge(parentId, { to: `child-lib@${childVersion}`, kind: 'prod', range: '>=1.0.0' })
  }
  return builder.build()
}

describe('edgeMoveWarnings', () => {
  const before = probeGraph({ helper: '1.0.0', wide: '2.0.0', other: '2.0.0' })
  const after = probeGraph({ helper: '1.0.1', wide: '1.0.1', other: '2.0.0' })

  it('warns about a parent whose version of a re-locked package moves down besides the re-lock', () => {
    assert.deepEqual(edgeMoveWarnings([RELOCK], before, after), ['wide-lib 1.0.0 moves child-lib 2.0.0 → 1.0.1 (downgrade)'])
  })

  it('warns about a parent moved by an override from a version the selector does not match', () => {
    assert.deepEqual(edgeMoveWarnings([OVERRIDE], before, after), ['wide-lib 1.0.0 moves child-lib 2.0.0 → 1.0.1 (downgrade)'])
  })

  it('accepts a move into the override value from a version the selector matches', () => {
    const wideBefore = probeGraph({ helper: '1.0.0', wide: '1.0.0', other: '2.0.0' })
    assert.deepEqual(edgeMoveWarnings([OVERRIDE], wideBefore, after), [])
  })

  it('names an importer and leaves out the downgrade note for a move up', () => {
    const importerBefore = makeGraph({ importers: { '.': ['child-lib@2.0.0 ^2.0.0'], web: ['child-lib@1.0.0 ^1.0.0'] }, packages: { 'child-lib@2.0.0': [], 'child-lib@1.0.0': [] } })
    const importerAfter = makeGraph({ importers: { '.': ['child-lib@2.1.0 ^2.0.0'], web: ['child-lib@1.0.1 ^1.0.0'] }, packages: { 'child-lib@2.1.0': [], 'child-lib@1.0.1': [] } })
    assert.deepEqual(edgeMoveWarnings([RELOCK], importerBefore, importerAfter), ['the root package moves child-lib 2.0.0 → 2.1.0'])
  })

  it('ignores names no re-lock or override targets and importer edges an update sets', () => {
    const setRange: SetRangeStep = { kind: 'set-range', importer: 'importer:.', dependency: 'child-lib', field: 'dependencies', place: 'manifest', from: '^2.0.0', to: '^3.0.0', reason: 'update' }
    const rangeBefore = makeGraph({ importers: { '.': ['child-lib@2.0.0 ^2.0.0'] }, packages: { 'child-lib@2.0.0': [] } })
    const rangeAfter = makeGraph({ importers: { '.': ['child-lib@3.0.0 ^3.0.0'] }, packages: { 'child-lib@3.0.0': [] } })
    assert.deepEqual(edgeMoveWarnings([setRange], before, after), [])
    assert.deepEqual(edgeMoveWarnings([RELOCK, setRange], rangeBefore, rangeAfter), [])
    assert.deepEqual(edgeMoveWarnings([{ ...RELOCK, name: 'other-name' }], before, after), [])
  })

  it('ignores importer edges of a catalog entry an update sets', () => {
    const catalogStep: SetRangeStep = { kind: 'set-range', importer: 'importer:.', dependency: 'child-lib', field: 'dependencies', place: 'catalog', from: '^2.0.0', to: '^3.0.0', reason: 'update' }
    const catalogBefore = makeGraph({ importers: { '.': ['child-lib@2.0.0 catalog:'], web: ['child-lib@2.0.0 catalog:'] }, packages: { 'child-lib@2.0.0': [] } })
    const catalogAfter = makeGraph({ importers: { '.': ['child-lib@3.0.0 catalog:'], web: ['child-lib@3.0.0 catalog:'] }, packages: { 'child-lib@3.0.0': [] } })
    assert.deepEqual(edgeMoveWarnings([RELOCK, catalogStep], catalogBefore, catalogAfter), [])
    assert.deepEqual(edgeMoveWarnings([RELOCK, { ...catalogStep, catalog: 'tools' }], catalogBefore, catalogAfter), [
      'the root package moves child-lib 2.0.0 → 3.0.0',
      'web moves child-lib 2.0.0 → 3.0.0',
    ])
  })

  it('compares a parent across peer variants and reports each move once', () => {
    const variantsBefore = peerVariantGraph(['(react@18.0.0)', '(react@19.0.0)'], '2.0.0')
    const variantsAfter = peerVariantGraph(['(react@19.0.0)', '(react@20.0.0)'], '1.0.1')
    assert.deepEqual(edgeMoveWarnings([RELOCK, OVERRIDE], variantsBefore, variantsAfter), ['wide-lib 1.0.0 moves child-lib 2.0.0 → 1.0.1 (downgrade)'])
  })
})
