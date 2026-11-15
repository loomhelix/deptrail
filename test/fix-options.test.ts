import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fixActions, relockTarget, type OptionsContext } from '../src/actions/fix-options.ts'
import { overridesLocation } from '../src/actions/overrides-location.ts'
import type { VersionsLoader } from '../src/actions/parent-chain.ts'
import type { FixGoal, ManagerInfo, OverridesFile, OverrideStep } from '../src/actions/types.ts'
import type { Advisory, PackageMeta } from '../src/enrich/types.ts'
import type { PackageNode, RootGraph } from '../src/model.ts'
import { ALL_KINDS } from '../src/query/lookup.ts'
import { makeGraph } from './helpers/graph-factory.ts'
import { makeAdvisory, makeEnrichmentView, makeMeta } from './helpers/enrichment-view.ts'

const PNPM_10: ManagerInfo = { name: 'pnpm', version: '10.34.3' }
const PNPM_11: ManagerInfo = { name: 'pnpm', version: '11.0.0' }
const NPM: ManagerInfo = { name: 'npm', version: '11.2.0' }
const NPM_10: ManagerInfo = { name: 'npm', version: '10.9.9' }
const NPM_10_OVERRIDES = 'npm 10.9.9 does not apply overrides to an existing lockfile, npm 11.2.0 and later do'

const FIXED_IN_5_7_3 = makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })
const FIXED_IN_7_7_0 = makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }, { fixed: '7.7.0' }] })
const NEVER_FIXED = makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '0' }] })

const GOAL: FixGoal = { kind: 'fix', name: 'semver', version: '5.7.2', advisoryIds: ['GHSA-test-0001'], severity: 'high' }

const SEMVER_RELOCK = { kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'normalize-package-data accepts it' }
const PARSER_RELOCK = { kind: 'relock', name: 'vue-eslint-parser', from: '9.4.3', to: '9.4.4', reason: '9.4.4 requires semver ^7.3.6; eslint-plugin-vue ^9.4.3 accepts it' }
const OVERRIDE_5_7_3: OverrideStep = {
  kind: 'override',
  selector: 'semver@<5.7.3',
  value: '5.7.3',
  file: 'pnpm-workspace.yaml',
  reason: 'forces 5.7.3 although vue-eslint-parser declares 5.7.2',
}
const PNPM_FIELD_WARNING = 'pnpm 11 ignores the pnpm field of package.json, so the override goes to pnpm-workspace.yaml'

type Scenario = {
  root?: RootGraph
  normalizeRange?: string
  parserRange?: string
  semverVersions?: string[]
  advisories?: Advisory[]
  vulns?: string[]
  manager?: ManagerInfo
  declared?: OverridesFile[]
  failures?: Record<string, string>
}

function chainRoot(extraImporters: Record<string, string[]> = {}): RootGraph {
  return makeGraph({
    importers: { ...extraImporters, 'tools/build': ['read-pkg-up@7.0.1'], storefront: ['dev:eslint-plugin-vue@9.32.0 ^9.32.0'] },
    packages: {
      'read-pkg-up@7.0.1': ['normalize-package-data@2.5.0'],
      'normalize-package-data@2.5.0': ['semver@5.7.2'],
      'eslint-plugin-vue@9.32.0': ['vue-eslint-parser@9.4.3'],
      'vue-eslint-parser@9.4.3': ['semver@5.7.2'],
      'semver@5.7.2': [],
    },
  })
}

function published(scenario: Scenario): Record<string, PackageMeta> {
  return {
    semver: makeMeta({ versions: scenario.semverVersions ?? ['5.7.2', '5.7.3', '7.7.0'] }),
    'normalize-package-data': makeMeta({ versions: ['2.5.0'], manifests: { '2.5.0': { semver: scenario.normalizeRange ?? '2 || 3 || 4 || 5' } } }),
    'vue-eslint-parser': makeMeta({
      versions: ['9.4.3', '9.4.4', '10.0.0'],
      manifests: { '9.4.3': { semver: scenario.parserRange ?? '5.7.2' }, '9.4.4': { semver: '^7.3.6' }, '10.0.0': { semver: '^7.6.0' } },
    }),
    'eslint-plugin-vue': makeMeta({ versions: ['9.32.0'], manifests: { '9.32.0': { 'vue-eslint-parser': '^9.4.3' } } }),
  }
}

function contextOf(scenario: Scenario): { context: OptionsContext; node: PackageNode } {
  const root = scenario.root ?? chainRoot()
  const meta = published(scenario)
  const manager = scenario.manager ?? PNPM_10
  const loadVersions: VersionsLoader = async (name) => {
    const failure = scenario.failures?.[name]
    if (failure !== undefined) return { state: 'failed', reason: failure }
    const known = meta[name]
    return known ? { state: 'ok', meta: known } : { state: 'failed', reason: 'is not published' }
  }
  const view = makeEnrichmentView({
    meta,
    vulns: { 'semver@5.7.2': scenario.vulns ?? ['GHSA-test-0001'] },
    advisories: scenario.advisories === undefined ? { semver: [FIXED_IN_5_7_3] } : { semver: scenario.advisories },
  })
  return {
    context: { view, root, kinds: ALL_KINDS, manager, overrides: overridesLocation(manager, scenario.declared ?? []), loadVersions },
    node: root.packages.get('semver@5.7.2') as PackageNode,
  }
}

async function actionsFor(scenario: Scenario) {
  const { context, node } = contextOf(scenario)
  return fixActions(context, node)
}

describe('relockTarget', () => {
  it('is the highest candidate every range accepts', () => {
    assert.equal(relockTarget(['^5.7.0', '2 || 3 || 4 || 5'], ['7.7.0', '5.7.3', '5.7.4']), '5.7.4')
  })

  it('is undefined when a range is unknown or the ranges share no candidate', () => {
    assert.equal(relockTarget(['^5.7.0', undefined], ['5.7.3']), undefined)
    assert.equal(relockTarget(['~5.7.0', '^7.0.0'], ['5.7.3', '7.7.0']), undefined)
  })
})

describe('fixActions', () => {
  it('is undefined without advisories', async () => {
    assert.equal(await actionsFor({ vulns: [] }), undefined)
  })

  it('offers one relock to the highest safe version every requesting range accepts', async () => {
    assert.deepEqual(await actionsFor({ parserRange: '^5.7.0' }), {
      goal: GOAL,
      options: [
        {
          choice: 'relock',
          recommended: true,
          steps: [{ kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'normalize-package-data and vue-eslint-parser accept it' }],
          warnings: [],
        },
      ],
      unavailable: [],
    })
  })

  it('recommends the override when the requesting ranges share no safe version', async () => {
    assert.deepEqual(await actionsFor({ normalizeRange: '~5.7.0', parserRange: '^7.0.0' }), {
      goal: GOAL,
      options: [
        {
          choice: 'override',
          recommended: true,
          steps: [{ ...OVERRIDE_5_7_3, reason: 'forces 5.7.3 although vue-eslint-parser declares ^7.0.0' }],
          warnings: [],
        },
      ],
      unavailable: [{ choice: 'relock', reason: 'the requesting ranges have no safe version in common' }],
    })
  })

  it('offers the whole chain, then the override, for a partial fix', async () => {
    assert.deepEqual(await actionsFor({}), {
      goal: GOAL,
      options: [
        { choice: 'chain', recommended: true, steps: [SEMVER_RELOCK, PARSER_RELOCK], warnings: [] },
        { choice: 'override', recommended: false, steps: [OVERRIDE_5_7_3], warnings: [] },
      ],
      unavailable: [],
    })
  })

  it('keeps only the override when the chain fails, with the chain reason', async () => {
    assert.deepEqual(await actionsFor({ failures: { 'vue-eslint-parser': 'is unreachable' } }), {
      goal: GOAL,
      options: [{ choice: 'override', recommended: true, steps: [OVERRIDE_5_7_3], warnings: [] }],
      unavailable: [{ choice: 'chain', reason: 'could not load the versions of vue-eslint-parser: is unreachable' }],
    })
  })

  it('jumps to the lowest safe version of a higher major when the current major has none', async () => {
    assert.deepEqual(await actionsFor({ advisories: [FIXED_IN_7_7_0] }), {
      goal: GOAL,
      options: [
        {
          choice: 'override',
          recommended: true,
          steps: [
            {
              kind: 'override',
              selector: 'semver@<7.7.0',
              value: '7.7.0',
              file: 'pnpm-workspace.yaml',
              reason: 'forces 7.7.0 although normalize-package-data declares 2 || 3 || 4 || 5',
            },
          ],
          warnings: ['major jump'],
        },
      ],
      unavailable: [{ choice: 'chain', reason: 'normalize-package-data has no version that accepts a safe semver' }],
    })
  })

  it('picks the highest safe version of the current major', async () => {
    const actions = await actionsFor({ semverVersions: ['5.7.2', '5.7.3', '5.8.0', '7.7.0'] })
    const override = actions?.options.find((option) => option.choice === 'override')
    assert.deepEqual(override?.steps, [{ ...OVERRIDE_5_7_3, selector: 'semver@<5.8.0', value: '5.8.0', reason: 'forces 5.8.0 although vue-eslint-parser declares 5.7.2' }])
    assert.deepEqual(override?.warnings, [])
  })

  it('says only what it forces when no requesting range is known to exclude it', async () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.2 next'] }, packages: { 'semver@5.7.2': [] } })
    const actions = await actionsFor({ root })
    const override = actions?.options.find((option) => option.choice === 'override')
    assert.deepEqual(override?.steps, [{ ...OVERRIDE_5_7_3, reason: 'forces 5.7.3' }])
  })

  it('adds the overrides location warning for pnpm 11 with the pnpm field declared', async () => {
    const actions = await actionsFor({ manager: PNPM_11, declared: ['package.json#pnpm.overrides'] })
    const override = actions?.options.find((option) => option.choice === 'override')
    assert.deepEqual(override, { choice: 'override', recommended: false, steps: [OVERRIDE_5_7_3], warnings: [PNPM_FIELD_WARNING] })
  })

  it('writes the npm override to package.json#overrides', async () => {
    const actions = await actionsFor({ manager: NPM })
    const override = actions?.options.find((option) => option.choice === 'override')
    assert.deepEqual(override?.steps, [{ ...OVERRIDE_5_7_3, file: 'package.json#overrides' }])
  })

  it('does not offer an npm override with an npm older than 11.2.0', async () => {
    const actions = await actionsFor({ manager: NPM_10 })
    assert.deepEqual(actions?.options.map((option) => option.choice), ['chain'])
    assert.deepEqual(actions?.unavailable, [{ choice: 'override', reason: NPM_10_OVERRIDES }])
  })

  it('does not offer an npm re-lock of a package that another package requests with an npm older than 11.2.0', async () => {
    const actions = await actionsFor({ manager: NPM_10, parserRange: '^5.7.0' })
    assert.deepEqual(actions?.options, [])
    assert.deepEqual(actions?.unavailable, [
      { choice: 'relock', reason: NPM_10_OVERRIDES },
      { choice: 'override', reason: NPM_10_OVERRIDES },
    ])
  })

  it('offers an npm re-lock of a package that only workspace packages request with an npm older than 11.2.0', async () => {
    const root = makeGraph({ importers: { app: ['semver@5.7.2 ^5.7.0'], web: ['semver@5.7.2 ^5.7.1'] }, packages: { 'semver@5.7.2': [] } })
    const actions = await actionsFor({ manager: NPM_10, root })
    assert.deepEqual(actions?.options.map((option) => [option.choice, option.steps]), [['relock', [{ ...SEMVER_RELOCK, reason: 'app and web accept it' }]]])
  })

  it('does not offer an npm override of a direct dependency of the root package', async () => {
    const actions = await actionsFor({ manager: NPM, root: chainRoot({ '.': ['semver@5.7.2 ^5.7.0'] }) })
    assert.deepEqual(actions?.options.map((option) => option.choice), ['chain'])
    assert.deepEqual(actions?.unavailable, [
      { choice: 'override', reason: 'npm does not allow an override of a direct dependency of the root package; update it instead' },
    ])
  })

  it('does not offer an override without a safe version above the current one', async () => {
    const advisory = makeAdvisory({ id: 'GHSA-test-0001', severity: 'high', events: [{ introduced: '5.7.2' }] })
    assert.deepEqual(await actionsFor({ semverVersions: ['5.7.1', '5.7.2'], advisories: [advisory] }), {
      goal: GOAL,
      options: [],
      unavailable: [
        { choice: 'chain', reason: 'vue-eslint-parser has no version that accepts a safe semver' },
        { choice: 'override', reason: 'no safe version of semver above 5.7.2' },
      ],
    })
  })

  it('gives the reason without options when no published version is free of the advisories', async () => {
    assert.deepEqual(await actionsFor({ advisories: [NEVER_FIXED] }), {
      goal: GOAL,
      options: [],
      unavailable: [],
      reason: 'No published version of semver is free of these advisories',
    })
  })

  it('gives the reason without options when the advisory data is incomplete', async () => {
    assert.deepEqual(await actionsFor({ advisories: [], vulns: ['GHSA-test-0002'] }), {
      goal: { ...GOAL, advisoryIds: ['GHSA-test-0002'], severity: 'unknown' },
      options: [],
      unavailable: [],
      reason: 'Registry or advisory data for semver is incomplete',
    })
  })

  it('takes every advisory id and the worst severity into the goal', async () => {
    const moderate = makeAdvisory({ id: 'GHSA-test-0002', severity: 'moderate', events: [{ introduced: '0' }, { fixed: '5.7.3' }] })
    const actions = await actionsFor({ parserRange: '^5.7.0', vulns: ['GHSA-test-0002', 'GHSA-test-0001'], advisories: [moderate, FIXED_IN_5_7_3] })
    assert.deepEqual(actions?.goal, { ...GOAL, advisoryIds: ['GHSA-test-0001', 'GHSA-test-0002'] })
  })
})
