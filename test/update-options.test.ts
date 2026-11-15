import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { updateActions, updateSteps, type ImporterManifests } from '../src/actions/update-options.ts'
import type { UpdateActions } from '../src/actions/types.ts'
import type { PackageMeta } from '../src/enrich/types.ts'
import type { PackageNode, RootGraph } from '../src/model.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

const VITE_VERSIONS = ['5.4.2', '5.4.6', '5.4.11', '6.0.6', '6.0.7', '6.1.0-beta.1']
const VITE = makeMeta({ versions: VITE_VERSIONS, latest: '6.0.7', deprecated: { '6.0.6': 'use 6.0.7' } })
const VITE_ADVISORY = makeAdvisory({ id: 'GHSA-test-vite', severity: 'moderate', events: [{ introduced: '5.4.6' }, { fixed: '5.4.7' }] })

const BOTH = ['importer:commerce-ui', 'importer:storefront']

const MANIFESTS: ImporterManifests = new Map<string, Record<string, unknown>>([
  ['importer:commerce-ui', { name: 'commerce-ui', devDependencies: { vite: '^5.4.2' } }],
  ['importer:storefront', { name: 'storefront', devDependencies: { vite: '^5.4.0' }, peerDependencies: { vite: '^5' } }],
])

function viteRoot(importers: Record<string, string[]> = {}): RootGraph {
  return makeGraph({
    importers: { 'commerce-ui': ['dev:vite@5.4.2 ^5.4.2'], storefront: ['dev:vite@5.4.2 ^5.4.0'], ...importers },
    packages: { 'vite@5.4.2': [] },
  })
}

function viteUpdate(root: RootGraph, manifests: ImporterManifests = MANIFESTS, meta: PackageMeta = VITE): UpdateActions | undefined {
  const view = makeEnrichmentView({ meta: { vite: meta }, advisories: { vite: [VITE_ADVISORY] } })
  return updateActions({ view, root }, root.packages.get('vite@5.4.2') as PackageNode, manifests)
}

function requireUpdate(update: UpdateActions | undefined): UpdateActions {
  assert.ok(update)
  return update
}

function withCatalogs(root: RootGraph, catalogs: Record<string, Record<string, string>>): RootGraph {
  root.config = { registry: 'https://registry.npmjs.org/', scopedRegistries: {}, hasAuth: false, catalogs, overrides: {}, workspacePatterns: [], warnings: [] }
  return root
}

const ROLLDOWN_VITE = makeMeta({ versions: ['7.0.0', '7.1.0'], latest: '7.1.0' })

const ALIAS_MANIFESTS: ImporterManifests = new Map<string, Record<string, unknown>>([
  ['importer:web', { devDependencies: { vite: '^5.4.2' } }],
  ['importer:app', { devDependencies: { vite: 'npm:rolldown-vite@^7.0.0' } }],
])

function aliasRoot(appRange = 'npm:rolldown-vite@^7.0.0'): RootGraph {
  return makeGraph({
    importers: { web: ['dev:vite@5.4.2 ^5.4.2'], app: [`dev:rolldown-vite@7.0.0 ${appRange}`] },
    packages: { 'vite@5.4.2': [], 'rolldown-vite@7.0.0': [] },
  })
}

function aliasUpdate(root: RootGraph, id: string, manifests: ImporterManifests = ALIAS_MANIFESTS): UpdateActions {
  const view = makeEnrichmentView({ meta: { vite: VITE, 'rolldown-vite': ROLLDOWN_VITE } })
  return requireUpdate(updateActions({ view, root }, root.packages.get(id) as PackageNode, manifests))
}

const APP_ALIAS_IMPORTER = {
  id: 'importer:app',
  field: 'devDependencies',
  alias: 'vite',
  specifier: 'npm:rolldown-vite@^7.0.0',
  editable: true,
  template: 'npm:rolldown-vite@^<version>',
}

describe('npm aliases', () => {
  it('does not count an alias of another package as a declaration of the package', () => {
    const root = aliasRoot()
    assert.deepEqual(aliasUpdate(root, 'vite@5.4.2').importers, [
      { id: 'importer:web', field: 'devDependencies', specifier: '^5.4.2', editable: true, template: '^<version>' },
    ])
    assert.deepEqual(updateSteps(aliasUpdate(root, 'vite@5.4.2'), root, 'latest', undefined, ['importer:app']), {
      error: 'importer:app does not declare vite',
    })
  })

  it('lists the importer that aliases the package under another key, keeping the alias prefix', () => {
    const root = aliasRoot()
    const update = aliasUpdate(root, 'rolldown-vite@7.0.0')
    assert.equal(update.wanted, '7.1.0')
    assert.deepEqual(update.importers, [APP_ALIAS_IMPORTER])
  })

  it('edits the alias key of the manifest', () => {
    const root = aliasRoot()
    assert.deepEqual(updateSteps(aliasUpdate(root, 'rolldown-vite@7.0.0'), root, 'latest', undefined, ['importer:app']), {
      goal: { kind: 'update', name: 'rolldown-vite', importers: ['importer:app'], target: '7.1.0' },
      steps: [
        {
          kind: 'set-range',
          importer: 'importer:app',
          dependency: 'vite',
          field: 'devDependencies',
          place: 'manifest',
          from: 'npm:rolldown-vite@^7.0.0',
          to: 'npm:rolldown-vite@^7.1.0',
          reason: '7.1.0 is the latest version of rolldown-vite',
        },
      ],
      warnings: [],
    })
    const wanted = updateSteps(aliasUpdate(root, 'rolldown-vite@7.0.0'), root, 'wanted', undefined, [])
    assert.ok('goal' in wanted)
    assert.deepEqual(wanted.goal.importers, ['importer:app'])
  })

  it('counts an alias of the package under its own name as a plain declaration', () => {
    const root = makeGraph({ importers: { web: ['dev:vite@5.4.2 npm:vite@^5.4.0'] }, packages: { 'vite@5.4.2': [] } })
    const manifests = new Map([['importer:web', { devDependencies: { vite: 'npm:vite@^5.4.0' } }]])
    assert.deepEqual(aliasUpdate(root, 'vite@5.4.2', manifests).importers, [
      { id: 'importer:web', field: 'devDependencies', specifier: 'npm:vite@^5.4.0', editable: true, template: 'npm:vite@^<version>' },
    ])
  })

  it('reads an alias through the catalog entry of its key', () => {
    const root = withCatalogs(aliasRoot('catalog:'), { default: { vite: 'npm:rolldown-vite@^7.0.0' } })
    const manifests = new Map([...ALIAS_MANIFESTS, ['importer:app', { devDependencies: { vite: 'catalog:' } }]])
    assert.deepEqual(aliasUpdate(root, 'vite@5.4.2', manifests).importers.map((importer) => importer.id), ['importer:web'])
    assert.deepEqual(aliasUpdate(root, 'rolldown-vite@7.0.0', manifests).importers, [{ ...APP_ALIAS_IMPORTER, specifier: 'catalog:' }])
  })
})

describe('updateActions', () => {
  it('lists the wanted, latest and published versions with the importers that declare the package', () => {
    assert.deepEqual(viteUpdate(viteRoot()), {
      name: 'vite',
      current: '5.4.2',
      wanted: '5.4.11',
      latest: '6.0.7',
      versions: [
        { version: '6.1.0-beta.1', prerelease: true },
        { version: '6.0.7' },
        { version: '6.0.6', deprecated: true },
        { version: '5.4.11' },
        { version: '5.4.6', severity: 'moderate' },
        { version: '5.4.2' },
      ],
      importers: [
        { id: 'importer:commerce-ui', field: 'devDependencies', specifier: '^5.4.2', editable: true, template: '^<version>' },
        { id: 'importer:storefront', field: 'devDependencies', specifier: '^5.4.0', editable: true, template: '^<version>', peerRange: '^5' },
      ],
    })
  })

  it('is undefined when no importer depends on the package directly', () => {
    const root = makeGraph({ importers: { app: ['lib@1.0.0 ^1.0.0'] }, packages: { 'lib@1.0.0': ['vite@5.4.2 ^5.4.0'], 'vite@5.4.2': [] } })
    assert.equal(viteUpdate(root, new Map([['importer:app', { dependencies: { lib: '^1.0.0' } }]])), undefined)
  })

  it('takes the first manifest field that declares the package', () => {
    const manifests = new Map<string, Record<string, unknown>>([
      ['importer:commerce-ui', { dependencies: { vite: '~5.4.2' }, devDependencies: { vite: '^5.4.2' } }],
    ])
    assert.deepEqual(requireUpdate(viteUpdate(viteRoot(), manifests)).importers, [
      { id: 'importer:commerce-ui', field: 'dependencies', specifier: '~5.4.2', editable: true, template: '~<version>' },
    ])
  })

  it('marks a workspace: specifier as not editable', () => {
    const root = viteRoot({ docs: ['dev:vite@5.4.2 workspace:*'] })
    const manifests = new Map([...MANIFESTS, ['importer:docs', { devDependencies: { vite: 'workspace:*' } }]])
    const update = requireUpdate(viteUpdate(root, manifests))
    assert.deepEqual(update.importers.at(-1), {
      id: 'importer:docs',
      field: 'devDependencies',
      specifier: 'workspace:*',
      editable: false,
      reason: 'workspace: specifiers are not edited',
    })
  })

  it('takes the template of a catalog importer from the catalog entry', () => {
    const root = withCatalogs(
      makeGraph({ importers: { admin: ['dev:vite@5.4.2 catalog:'], docs: ['dev:vite@5.4.2 catalog:'] }, packages: { 'vite@5.4.2': [] } }),
      { default: { vite: '~5.4.0' } },
    )
    const manifests = new Map<string, Record<string, unknown>>([
      ['importer:admin', { devDependencies: { vite: 'catalog:' } }],
      ['importer:docs', { devDependencies: { vite: 'catalog:' } }],
    ])
    assert.deepEqual(requireUpdate(viteUpdate(root, manifests)).importers, [
      { id: 'importer:admin', field: 'devDependencies', specifier: 'catalog:', editable: true, template: '~<version>' },
      { id: 'importer:docs', field: 'devDependencies', specifier: 'catalog:', editable: true, template: '~<version>' },
    ])
  })

  it('leaves out a latest that is the current version and a wanted that is not newer', () => {
    const root = makeGraph({ importers: { 'commerce-ui': ['dev:vite@5.4.2 5.4.2'] }, packages: { 'vite@5.4.2': [] } })
    const manifests = new Map([['importer:commerce-ui', { devDependencies: { vite: '5.4.2' } }]])
    const update = requireUpdate(viteUpdate(root, manifests, makeMeta({ versions: VITE_VERSIONS, latest: '5.4.2' })))
    assert.equal('wanted' in update, false)
    assert.equal('latest' in update, false)
  })
})

describe('updateSteps', () => {
  it('raises every selected importer to the latest version with the major and peer warnings', () => {
    const root = viteRoot()
    assert.deepEqual(updateSteps(requireUpdate(viteUpdate(root)), root, 'latest', undefined, BOTH), {
      goal: { kind: 'update', name: 'vite', importers: BOTH, target: '6.0.7' },
      steps: [
        {
          kind: 'set-range',
          importer: 'importer:commerce-ui',
          dependency: 'vite',
          field: 'devDependencies',
          place: 'manifest',
          from: '^5.4.2',
          to: '^6.0.7',
          reason: '6.0.7 is the latest version of vite',
        },
        {
          kind: 'set-range',
          importer: 'importer:storefront',
          dependency: 'vite',
          field: 'devDependencies',
          place: 'manifest',
          from: '^5.4.0',
          to: '^6.0.7',
          reason: '6.0.7 is the latest version of vite',
        },
      ],
      warnings: ['major update', 'storefront: peerDependencies ^5 unchanged'],
    })
  })

  it('raises only the selected importers to a chosen version', () => {
    const root = viteRoot()
    assert.deepEqual(updateSteps(requireUpdate(viteUpdate(root)), root, 'version', '5.4.11', ['importer:storefront']), {
      goal: { kind: 'update', name: 'vite', importers: ['importer:storefront'], target: '5.4.11' },
      steps: [
        {
          kind: 'set-range',
          importer: 'importer:storefront',
          dependency: 'vite',
          field: 'devDependencies',
          place: 'manifest',
          from: '^5.4.0',
          to: '^5.4.11',
          reason: '5.4.11 is the selected version of vite',
        },
      ],
      warnings: ['storefront: peerDependencies ^5 unchanged'],
    })
  })

  it('relocks to the wanted version for every importer with an edge to the package', () => {
    const root = viteRoot()
    assert.deepEqual(updateSteps(requireUpdate(viteUpdate(root)), root, 'wanted', undefined, []), {
      goal: { kind: 'update', name: 'vite', importers: BOTH, target: '5.4.11' },
      steps: [{ kind: 'relock', name: 'vite', from: '5.4.2', to: '5.4.11', reason: 'every requesting range accepts 5.4.11' }],
      warnings: [],
    })
  })

  it('edits a shared catalog entry once', () => {
    const root = withCatalogs(
      makeGraph({ importers: { admin: ['dev:vite@5.4.2 catalog:'], docs: ['dev:vite@5.4.2 catalog:'] }, packages: { 'vite@5.4.2': [] } }),
      { default: { vite: '^5.4.0' } },
    )
    const manifests = new Map<string, Record<string, unknown>>([
      ['importer:admin', { devDependencies: { vite: 'catalog:' } }],
      ['importer:docs', { devDependencies: { vite: 'catalog:' } }],
    ])
    const selected = ['importer:admin', 'importer:docs']
    assert.deepEqual(updateSteps(requireUpdate(viteUpdate(root, manifests)), root, 'latest', undefined, selected), {
      goal: { kind: 'update', name: 'vite', importers: selected, target: '6.0.7' },
      steps: [
        {
          kind: 'set-range',
          importer: 'importer:admin',
          dependency: 'vite',
          field: 'devDependencies',
          place: 'catalog',
          from: '^5.4.0',
          to: '^6.0.7',
          reason: '6.0.7 is the latest version of vite (catalog entry used by admin, docs)',
        },
      ],
      warnings: ['major update'],
    })
  })

  it('refuses a version that is not published or is the current one', () => {
    const root = viteRoot()
    const update = requireUpdate(viteUpdate(root))
    assert.deepEqual(updateSteps(update, root, 'version', '9.9.9', BOTH), { error: '9.9.9 is not a published version of vite' })
    assert.deepEqual(updateSteps(update, root, 'version', '5.4.2', BOTH), { error: '5.4.2 is the current version' })
  })

  it('refuses an importer that does not declare the package or cannot be edited', () => {
    const root = viteRoot({ docs: ['dev:vite@5.4.2 workspace:*'] })
    const manifests = new Map([...MANIFESTS, ['importer:docs', { devDependencies: { vite: 'workspace:*' } }]])
    const update = requireUpdate(viteUpdate(root, manifests))
    assert.deepEqual(updateSteps(update, root, 'version', '6.0.6', ['importer:admin']), { error: 'importer:admin does not declare vite' })
    assert.deepEqual(updateSteps(update, root, 'latest', undefined, ['importer:commerce-ui', 'importer:docs']), {
      error: 'importer:docs: workspace: specifiers are not edited',
    })
  })

  it('refuses an empty selection', () => {
    const root = viteRoot()
    assert.deepEqual(updateSteps(requireUpdate(viteUpdate(root)), root, 'latest', undefined, []), { error: 'Select at least one workspace package' })
  })

  it('refuses wanted and latest when there is no such version', () => {
    const root = makeGraph({ importers: { 'commerce-ui': ['dev:vite@5.4.2 5.4.2'] }, packages: { 'vite@5.4.2': [] } })
    const manifests = new Map([['importer:commerce-ui', { devDependencies: { vite: '5.4.2' } }]])
    const update = requireUpdate(viteUpdate(root, manifests, makeMeta({ versions: VITE_VERSIONS, latest: '5.4.2' })))
    assert.deepEqual(updateSteps(update, root, 'wanted', undefined, []), { error: 'vite has no newer version within its ranges' })
    assert.deepEqual(updateSteps(update, root, 'latest', undefined, ['importer:commerce-ui']), { error: 'vite has no latest version to update to' })
    assert.deepEqual(updateSteps(update, root, 'version', undefined, ['importer:commerce-ui']), { error: 'Select a version of vite' })
  })
})
