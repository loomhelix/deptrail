import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptedClause, fieldOf, goalText, importerLabel } from '../src/actions/labels.ts'
import { setRangeStep } from '../src/actions/set-range.ts'
import type { RootGraph } from '../src/model.ts'
import { makeGraph } from './helpers/graph-factory.ts'

function withCatalogs(root: RootGraph, catalogs: Record<string, Record<string, string>>): RootGraph {
  root.config = { registry: 'https://registry.npmjs.org/', scopedRegistries: {}, hasAuth: false, catalogs, overrides: {}, workspacePatterns: [], warnings: [] }
  return root
}

function catalogRoot(): RootGraph {
  return withCatalogs(
    makeGraph({
      importers: {
        storefront: ['vue@3.4.21 catalog:'],
        admin: ['vue@3.4.21 catalog:default'],
        legacy: ['vue@3.4.21 catalog:legacy'],
        docs: ['vue@3.4.21 ^3.4.0'],
      },
      packages: { 'vue@3.4.21': [] },
    }),
    { default: { vue: '^3.4.0' }, legacy: { vue: '~3.4.0' } },
  )
}

describe('action labels', () => {
  it('names the root importer and keeps the path of the others', () => {
    assert.equal(importerLabel('importer:.'), 'the root package')
    assert.equal(importerLabel('importer:packages/storefront'), 'packages/storefront')
  })

  it('writes the goal of a fix and of an update', () => {
    assert.equal(goalText({ kind: 'fix', name: 'semver', version: '5.7.2', advisoryIds: ['GHSA-test-0001'], severity: 'high' }), 'Fix semver 5.7.2')
    assert.equal(goalText({ kind: 'update', name: 'vue', importers: ['importer:storefront'], target: '3.5.0' }), 'Update vue to 3.5.0')
  })

  it('lists up to three accepting parents and counts the rest', () => {
    assert.equal(acceptedClause(['storefront']), 'storefront accepts it')
    assert.equal(acceptedClause(['a ^1.0.0', 'b ~1.0.0']), 'a ^1.0.0 and b ~1.0.0 accept it')
    assert.equal(acceptedClause(['a', 'b', 'c']), 'a, b, and c accept it')
    assert.equal(acceptedClause(['a', 'b', 'c', 'd', 'e']), 'a, b, c, and 2 more accept it')
  })

  it('maps edge kinds to manifest fields and leaves peers out', () => {
    assert.equal(fieldOf('prod'), 'dependencies')
    assert.equal(fieldOf('dev'), 'devDependencies')
    assert.equal(fieldOf('optional'), 'optionalDependencies')
    assert.equal(fieldOf('peer'), undefined)
  })
})

describe('setRangeStep', () => {
  it('keeps the caret of a manifest range', () => {
    const root = makeGraph({ importers: { storefront: ['dev:eslint-plugin-vue@9.32.0 ^9.32.0'] }, packages: { 'eslint-plugin-vue@9.32.0': [] } })
    const result = setRangeStep(root, {
      importer: 'importer:storefront',
      field: 'devDependencies',
      dependency: 'eslint-plugin-vue',
      specifier: '^9.32.0',
      target: '9.33.0',
      reason: '9.33.0 requires vue-eslint-parser ^9.4.4',
    })
    assert.deepEqual(result, {
      step: {
        kind: 'set-range',
        importer: 'importer:storefront',
        dependency: 'eslint-plugin-vue',
        field: 'devDependencies',
        place: 'manifest',
        from: '^9.32.0',
        to: '^9.33.0',
        reason: '9.33.0 requires vue-eslint-parser ^9.4.4',
      },
    })
  })

  it('rewrites the default catalog entry and names every importer that uses it', () => {
    const result = setRangeStep(catalogRoot(), {
      importer: 'importer:storefront',
      field: 'dependencies',
      dependency: 'vue',
      specifier: 'catalog:',
      target: '3.5.0',
      reason: '3.5.0 is the lowest safe vue above 3.4.21',
    })
    assert.deepEqual(result, {
      step: {
        kind: 'set-range',
        importer: 'importer:storefront',
        dependency: 'vue',
        field: 'dependencies',
        place: 'catalog',
        from: '^3.4.0',
        to: '^3.5.0',
        reason: '3.5.0 is the lowest safe vue above 3.4.21 (catalog entry used by admin, storefront)',
      },
    })
  })

  it('names a named catalog', () => {
    const result = setRangeStep(catalogRoot(), {
      importer: 'importer:legacy',
      field: 'dependencies',
      dependency: 'vue',
      specifier: 'catalog:legacy',
      target: '3.4.38',
      reason: 'r',
    })
    assert.deepEqual(result, {
      step: {
        kind: 'set-range',
        importer: 'importer:legacy',
        dependency: 'vue',
        field: 'dependencies',
        place: 'catalog',
        catalog: 'legacy',
        from: '~3.4.0',
        to: '~3.4.38',
        reason: 'r (catalog entry used by legacy)',
      },
    })
  })

  it('notes a changed range form', () => {
    const root = makeGraph({ importers: { app: ['lib@1.4.0 >=1 <2'] }, packages: { 'lib@1.4.0': [] } })
    const result = setRangeStep(root, { importer: 'importer:app', field: 'dependencies', dependency: 'lib', specifier: '>=1 <2', target: '2.1.0', reason: 'r' })
    assert.ok('step' in result)
    assert.equal(result.step.to, '^2.1.0')
    assert.equal(result.step.reason, 'r (the range form changes from >=1 <2)')
  })

  it('is unavailable for a workspace specifier', () => {
    const root = makeGraph({ importers: { app: ['importer:lib'], lib: [] }, packages: {} })
    const result = setRangeStep(root, { importer: 'importer:app', field: 'dependencies', dependency: 'lib', specifier: 'workspace:*', target: '2.0.0', reason: 'r' })
    assert.deepEqual(result, { unavailable: 'app: workspace: specifiers are not edited' })
  })
})
