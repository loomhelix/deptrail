import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parentChain, type ChainResult, type VersionsLoader } from '../src/actions/parent-chain.ts'
import type { DepKind, PackageNode, RootGraph } from '../src/model.ts'
import type { PackageMeta } from '../src/enrich/types.ts'
import { ALL_KINDS, type KindFilter } from '../src/query/lookup.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

const SAFE_SEMVER = ['5.7.3', '7.6.3', '7.7.0']

const NORMALIZE_PACKAGE_DATA = makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: '2 || 3 || 4 || 5' } } })

const VUE_ESLINT_PARSER = makeMeta({
  versions: ['9.4.3', '9.4.4', '10.0.0'],
  manifests: { '9.4.3': { semver: '5.7.2' }, '9.4.4': { semver: '^7.3.6' }, '10.0.0': { semver: '^7.6.0' } },
})

const ESLINT_PLUGIN_VUE_ACCEPTING = makeMeta({ versions: ['9.32.0'], manifests: { '9.32.0': { 'vue-eslint-parser': '^9.4.3' } } })

const ESLINT_PLUGIN_VUE_PINNED = makeMeta({
  versions: ['9.32.0', '9.33.0'],
  manifests: { '9.32.0': { 'vue-eslint-parser': '9.4.3' }, '9.33.0': { 'vue-eslint-parser': '^9.4.4' } },
})

const SEMVER_RELOCK = { kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'normalize-package-data accepts it' }

function chainRoot(storefrontRange = '^9.32.0'): RootGraph {
  return makeGraph({
    importers: { 'tools/build': ['read-pkg-up@7.0.1'], storefront: [`dev:eslint-plugin-vue@9.32.0 ${storefrontRange}`] },
    packages: {
      'read-pkg-up@7.0.1': ['normalize-package-data@2.5.0'],
      'normalize-package-data@2.5.0': ['semver@5.7.2'],
      'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
      'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
      'semver@5.7.2': [],
    },
  })
}

type Registry = { published: Record<string, PackageMeta>; failures?: Record<string, string> }

async function searchChain(
  root: RootGraph,
  registry: Registry,
  options: { kinds?: KindFilter; safe?: string[]; vulnerable?: string } = {},
): Promise<{ result: ChainResult; loads: string[] }> {
  const loads: string[] = []
  const loadVersions: VersionsLoader = async (name) => {
    loads.push(name)
    const failure = registry.failures?.[name]
    if (failure !== undefined) return { state: 'failed', reason: failure }
    const meta = registry.published[name]
    return meta ? { state: 'ok', meta } : { state: 'failed', reason: 'is not published' }
  }
  const result = await parentChain({
    view: makeEnrichmentView({ meta: registry.published }),
    root,
    node: root.packages.get(options.vulnerable ?? 'semver@5.7.2') as PackageNode,
    safe: options.safe ?? SAFE_SEMVER,
    kinds: options.kinds ?? ALL_KINDS,
    loadVersions,
  })
  return { result, loads }
}

function chainRegistry(eslintPluginVue: PackageMeta, parser: PackageMeta = VUE_ESLINT_PARSER): Registry {
  return {
    published: {
      'normalize-package-data': NORMALIZE_PACKAGE_DATA,
      'vue-eslint-parser': parser,
      'eslint-plugin-vue': eslintPluginVue,
    },
  }
}

function exactLevels(count: number, importerRange: string): { root: RootGraph; registry: Registry } {
  const packages: Record<string, string[]> = { 'semver@5.7.2': [] }
  const published: Record<string, PackageMeta> = {}
  for (let level = 1; level <= count; level++) {
    const child = level === 1 ? 'semver' : `level${level - 1}`
    const childVersion = level === 1 ? '5.7.2' : '1.0.0'
    const raisedChildRange = level === 1 ? '^5.7.3' : '1.0.1'
    packages[`level${level}@1.0.0`] = [`${child}@${childVersion}`]
    published[`level${level}`] = makeMeta({
      versions: ['1.0.0', '1.0.1'],
      manifests: { '1.0.0': { [child]: childVersion }, '1.0.1': { [child]: raisedChildRange } },
    })
  }
  const root = makeGraph({ importers: { app: [`level${count}@1.0.0 ${importerRange}`] }, packages })
  return { root, registry: { published } }
}

function fanIn(count: number): { root: RootGraph; registry: Registry } {
  const packages: Record<string, string[]> = { 'semver@5.7.2': [] }
  const published: Record<string, PackageMeta> = {}
  const targets: string[] = []
  for (let index = 1; index <= count; index++) {
    packages[`parent${index}@1.0.0`] = ['semver@5.7.2']
    targets.push(`parent${index}@1.0.0 ^1.0.0`)
    published[`parent${index}`] = makeMeta({ versions: ['1.0.0', '1.0.1'], manifests: { '1.0.0': { semver: '5.7.2' }, '1.0.1': { semver: '^5.7.3' } } })
  }
  return { root: makeGraph({ importers: { app: targets }, packages }), registry: { published } }
}

function twoParentRoot(): RootGraph {
  return makeGraph({
    importers: { storefront: ['dev:eslint-plugin-vue@9.32.0 ^9.32.0', 'dev:eslint-config-acme@1.0.0 ^1.0.0'] },
    packages: {
      'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
      'eslint-config-acme@1.0.0': ['vue-eslint-parser@9.4.3'],
      'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
      'semver@5.7.2': [],
    },
  })
}

function twoParentRegistry(pluginRange: string): Registry {
  return {
    published: {
      'eslint-plugin-vue': makeMeta({ versions: ['9.32.0'], manifests: { '9.32.0': { 'vue-eslint-parser': pluginRange } } }),
      'eslint-config-acme': makeMeta({ versions: ['1.0.0'], manifests: { '1.0.0': { 'vue-eslint-parser': '~9.4.3' } } }),
      'vue-eslint-parser': makeMeta({
        versions: ['9.4.3', '9.4.4', '9.5.0'],
        manifests: { '9.4.3': { semver: '5.7.2' }, '9.4.4': { semver: '^7.3.6' }, '9.5.0': { semver: '^7.6.0' } },
      }),
    },
  }
}

describe('parentChain', () => {
  it('relocks the vulnerable package for the accepting parent and the first parent that accepts a fixed child', async () => {
    const { result, loads } = await searchChain(chainRoot(), chainRegistry(ESLINT_PLUGIN_VUE_ACCEPTING))
    assert.deepEqual(result, {
      steps: [
        SEMVER_RELOCK,
        { kind: 'relock', name: 'vue-eslint-parser', from: '9.4.3', to: '9.4.4', reason: '9.4.4 requires semver ^7.3.6; eslint-plugin-vue ^9.4.3 accepts it' },
      ],
    })
    assert.deepEqual(loads, ['vue-eslint-parser'])
  })

  it('climbs to a grandparent whose importer range accepts a fixed version', async () => {
    const { result, loads } = await searchChain(chainRoot('^9.32.0'), chainRegistry(ESLINT_PLUGIN_VUE_PINNED))
    assert.deepEqual(result, {
      steps: [
        SEMVER_RELOCK,
        { kind: 'relock', name: 'eslint-plugin-vue', from: '9.32.0', to: '9.33.0', reason: '9.33.0 requires vue-eslint-parser ^9.4.4; storefront ^9.32.0 accepts it' },
      ],
    })
    assert.deepEqual(loads, ['vue-eslint-parser', 'eslint-plugin-vue'])
  })

  it('raises the importer range when it excludes every fixed version, keeping its operator', async () => {
    const { result } = await searchChain(chainRoot('~9.32.0'), chainRegistry(ESLINT_PLUGIN_VUE_PINNED))
    assert.deepEqual(result, {
      steps: [
        SEMVER_RELOCK,
        {
          kind: 'set-range',
          importer: 'importer:storefront',
          dependency: 'eslint-plugin-vue',
          field: 'devDependencies',
          place: 'manifest',
          from: '~9.32.0',
          to: '~9.33.0',
          reason: '9.33.0 requires vue-eslint-parser ^9.4.4',
        },
      ],
    })
  })

  it('leaves the dev path out when only prod edges are followed', async () => {
    const { result } = await searchChain(chainRoot('~9.32.0'), chainRegistry(ESLINT_PLUGIN_VUE_PINNED), { kinds: new Set<DepKind>(['prod']) })
    assert.deepEqual(result, { steps: [SEMVER_RELOCK] })
  })

  it('merges two requesting parents into one relock that both ranges accept', async () => {
    const { result } = await searchChain(twoParentRoot(), twoParentRegistry('^9.4.3'))
    assert.deepEqual(result, {
      steps: [
        {
          kind: 'relock',
          name: 'vue-eslint-parser',
          from: '9.4.3',
          to: '9.4.4',
          reason: '9.4.4 requires semver ^7.3.6; eslint-plugin-vue ^9.4.3 and eslint-config-acme ~9.4.3 accept it',
        },
      ],
    })
  })

  it('is unavailable when the requesting parents share no fixed version', async () => {
    const { result } = await searchChain(twoParentRoot(), twoParentRegistry('>=9.5.0 <10'))
    assert.deepEqual(result, { unavailable: 'vue-eslint-parser 9.4.3 has no fixed version that all its parents accept' })
  })

  it('raises an importer that pins the vulnerable package directly to the lowest safe version', async () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.2 5.7.2'] }, packages: { 'semver@5.7.2': [] } })
    const { result } = await searchChain(root, { published: {} })
    assert.deepEqual(result, {
      steps: [
        {
          kind: 'set-range',
          importer: 'importer:app',
          dependency: 'semver',
          field: 'dependencies',
          place: 'manifest',
          from: '5.7.2',
          to: '5.7.3',
          reason: '5.7.3 is the lowest safe semver above 5.7.2',
        },
      ],
    })
  })

  it('is unavailable when no safe version is above the pinned one', async () => {
    const root = makeGraph({ importers: { app: ['semver@7.7.0 7.7.0'] }, packages: { 'semver@7.7.0': [] } })
    const { result } = await searchChain(root, { published: {} }, { safe: ['5.7.3'], vulnerable: 'semver@7.7.0' })
    assert.deepEqual(result, { unavailable: 'no safe version of semver above 7.7.0' })
  })

  it('stops above five levels', async () => {
    const five = exactLevels(5, '^1.0.0')
    const allowed = await searchChain(five.root, five.registry)
    assert.deepEqual(allowed.result, {
      steps: [{ kind: 'relock', name: 'level5', from: '1.0.0', to: '1.0.1', reason: '1.0.1 requires level4 1.0.1; app ^1.0.0 accepts it' }],
    })
    const seven = exactLevels(7, '1.0.0')
    const { result, loads } = await searchChain(seven.root, seven.registry)
    assert.deepEqual(result, { unavailable: 'the chain is deeper than 5 levels' })
    assert.deepEqual(loads, ['level1', 'level2', 'level3', 'level4', 'level5'])
  })

  it('stops after twenty packument loads', async () => {
    const twenty = fanIn(20)
    const allowed = await searchChain(twenty.root, twenty.registry)
    assert.ok('steps' in allowed.result)
    assert.equal(allowed.result.steps.length, 20)
    assert.equal(allowed.loads.length, 20)
    const twentyOne = fanIn(21)
    const { result, loads } = await searchChain(twentyOne.root, twentyOne.registry)
    assert.deepEqual(result, { unavailable: 'the search needs more than 20 packument loads' })
    assert.equal(loads.length, 20)
  })

  it('does not follow a peer edge', async () => {
    const root = makeGraph({
      importers: { app: ['semver@5.7.2 ^5.7.0', 'peer-host@1.0.0 ^1.0.0'] },
      packages: { 'peer-host@1.0.0': ['peer:semver@5.7.2 5.7.2'], 'semver@5.7.2': [] },
    })
    const { result, loads } = await searchChain(root, { published: {} })
    assert.deepEqual(result, { steps: [{ kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'app accepts it' }] })
    assert.deepEqual(loads, [])
  })

  it('is unavailable when no parent path reaches a workspace package', async () => {
    const peerOnly = makeGraph({
      importers: { app: ['peer-host@1.0.0 ^1.0.0'] },
      packages: { 'peer-host@1.0.0': ['peer:semver@5.7.2 5.7.2'], 'semver@5.7.2': [] },
    })
    assert.deepEqual((await searchChain(peerOnly, { published: {} })).result, { unavailable: 'no parent path reaches a workspace package' })
    const devOnly = makeGraph({ importers: { app: ['dev:lib@1.0.0 ^1.0.0'] }, packages: { 'lib@1.0.0': ['semver@5.7.2'], 'semver@5.7.2': [] } })
    const registry = { published: { lib: makeMeta({ versions: ['1.0.0', '1.0.1'], manifests: { '1.0.0': { semver: '5.7.2' }, '1.0.1': { semver: '^5.7.3' } } }) } }
    const { result, loads } = await searchChain(devOnly, registry, { kinds: new Set<DepKind>(['prod']) })
    assert.deepEqual(result, { unavailable: 'no parent path reaches a workspace package' })
    assert.deepEqual(loads, ['lib'])
  })

  it('raises a shared catalog entry once, for the first importer by path', async () => {
    const root = makeGraph({
      importers: { storefront: ['dev:eslint-plugin-vue@9.32.0 catalog:'], admin: ['dev:eslint-plugin-vue@9.32.0 catalog:'] },
      packages: {
        'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
        'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
        'semver@5.7.2': [],
      },
    })
    root.config = {
      registry: 'https://registry.npmjs.org/',
      scopedRegistries: {},
      hasAuth: false,
      catalogs: { default: { 'eslint-plugin-vue': '~9.32.0' } },
      overrides: {},
      workspacePatterns: [],
      warnings: [],
    }
    const { result } = await searchChain(root, chainRegistry(ESLINT_PLUGIN_VUE_PINNED))
    assert.deepEqual(result, {
      steps: [
        {
          kind: 'set-range',
          importer: 'importer:admin',
          dependency: 'eslint-plugin-vue',
          field: 'devDependencies',
          place: 'catalog',
          from: '~9.32.0',
          to: '~9.33.0',
          reason: '9.33.0 requires vue-eslint-parser ^9.4.4 (catalog entry used by admin, storefront)',
        },
      ],
    })
  })

  it('is unavailable when no newer parent version accepts a safe child', async () => {
    const onlyCurrent = makeMeta({ versions: ['9.4.3'], manifests: { '9.4.3': { semver: '5.7.2' } } })
    const { result } = await searchChain(chainRoot(), chainRegistry(ESLINT_PLUGIN_VUE_ACCEPTING, onlyCurrent))
    assert.deepEqual(result, { unavailable: 'vue-eslint-parser has no version that accepts a safe semver' })
  })

  it('is unavailable when the versions of a parent fail to load', async () => {
    const registry = { ...chainRegistry(ESLINT_PLUGIN_VUE_ACCEPTING), failures: { 'vue-eslint-parser': 'is unreachable' } }
    const { result } = await searchChain(chainRoot(), registry)
    assert.deepEqual(result, { unavailable: 'could not load the versions of vue-eslint-parser: is unreachable' })
  })

  it('accepts a parent version that no longer depends on the vulnerable package', async () => {
    const dropsSemver = makeMeta({ versions: ['9.4.3', '9.5.0'], manifests: { '9.4.3': { semver: '5.7.2' }, '9.5.0': {} } })
    const { result } = await searchChain(chainRoot(), chainRegistry(ESLINT_PLUGIN_VUE_ACCEPTING, dropsSemver))
    assert.deepEqual(result, {
      steps: [
        SEMVER_RELOCK,
        { kind: 'relock', name: 'vue-eslint-parser', from: '9.4.3', to: '9.5.0', reason: '9.5.0 no longer depends on semver; eslint-plugin-vue ^9.4.3 accepts it' },
      ],
    })
  })
})
