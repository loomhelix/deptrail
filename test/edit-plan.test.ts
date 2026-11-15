import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EditError,
  applySteps,
  findConflict,
  manifestPathOf,
  overridesFilePath,
  relockPins,
  sameGoal,
  stepPaths,
} from '../src/actions/edit-plan.ts'
import type { ChangeItem, FixGoal, OverrideStep, RelockStep, SetRangeStep, Step, UpdateGoal } from '../src/actions/types.ts'
import { makeGraph } from './helpers/graph-factory.ts'

const fixGoal: FixGoal = { kind: 'fix', name: 'semver', version: '5.7.2', advisoryIds: [], severity: 'high' }
const updateGoal: UpdateGoal = { kind: 'update', name: 'vue', importers: ['importer:storefront'], target: '3.5.0' }

function setRange(overrides: Partial<SetRangeStep> = {}): SetRangeStep {
  return { kind: 'set-range', importer: 'importer:storefront', dependency: 'vue', field: 'dependencies', place: 'manifest', from: '^3.4.0', to: '^3.5.0', reason: 'r', ...overrides }
}

function override(overrides: Partial<OverrideStep> = {}): OverrideStep {
  return { kind: 'override', selector: 'semver@<5.7.3', value: '5.7.3', file: 'pnpm-workspace.yaml', reason: 'r', ...overrides }
}

function relock(overrides: Partial<RelockStep> = {}): RelockStep {
  return { kind: 'relock', name: 'semver', from: '5.7.2', to: '5.7.3', reason: 'r', ...overrides }
}

function item(id: string, steps: Step[], goal: FixGoal | UpdateGoal = fixGoal): ChangeItem {
  return { id, goal, choice: 'relock', steps, warnings: [] }
}

describe('paths', () => {
  it('maps importers to manifests', () => {
    assert.equal(manifestPathOf('importer:.'), 'package.json')
    assert.equal(manifestPathOf('importer:a/b'), 'a/b/package.json')
  })

  it('maps override files and lists step paths', () => {
    assert.equal(overridesFilePath('pnpm-workspace.yaml'), 'pnpm-workspace.yaml')
    assert.equal(overridesFilePath('package.json#pnpm.overrides'), 'package.json')
    assert.equal(overridesFilePath('package.json#overrides'), 'package.json')
    assert.deepEqual(
      stepPaths([relock(), setRange(), setRange({ place: 'catalog' }), override(), override({ file: 'package.json#overrides' })]),
      ['storefront/package.json', 'pnpm-workspace.yaml', 'package.json'],
    )
  })
})

describe('applySteps', () => {
  it('edits a nested manifest', () => {
    const texts = new Map<string, string | null>([['storefront/package.json', '{\n  "dependencies": {\n    "vue": "^3.4.0"\n  }\n}\n']])
    const result = applySteps(texts, [setRange(), setRange()])
    assert.deepEqual([...result.keys()], ['storefront/package.json'])
    assert.match(result.get('storefront/package.json') ?? '', /"vue": "\^3\.5\.0"/)
  })

  it('creates the workspace file for an override', () => {
    const result = applySteps(new Map([['pnpm-workspace.yaml', null]]), [override()])
    assert.match(result.get('pnpm-workspace.yaml') ?? '', /overrides:\n {2}semver@<5\.7\.3: 5\.7\.3/)
  })

  it('updates a default catalog entry', () => {
    const yaml = 'catalogs:\n  default:\n    vue: ^3.4.0\n'
    const result = applySteps(new Map([['pnpm-workspace.yaml', yaml]]), [setRange({ place: 'catalog' })])
    assert.match(result.get('pnpm-workspace.yaml') ?? '', /vue: \^3\.5\.0/)
  })

  it('updates the unnamed catalog and a named one', () => {
    const yaml = 'catalog:\n  vue: ^3.4.0\ncatalogs:\n  legacy:\n    vue: ~3.4.0\n'
    const result = applySteps(new Map([['pnpm-workspace.yaml', yaml]]), [setRange({ place: 'catalog' }), setRange({ place: 'catalog', catalog: 'legacy', to: '~3.5.0' })])
    const text = result.get('pnpm-workspace.yaml') ?? ''
    assert.match(text, /catalog:\n {2}vue: \^3\.5\.0/)
    assert.match(text, /legacy:\n {4}vue: ~3\.5\.0/)
  })

  it('writes overrides into package.json', () => {
    const manifest = '{\n  "name": "x"\n}\n'
    const pnpm = applySteps(new Map([['package.json', manifest]]), [override({ file: 'package.json#pnpm.overrides' })])
    assert.match(pnpm.get('package.json') ?? '', /"pnpm": \{\s+"overrides": \{\s+"semver@<5\.7\.3": "5\.7\.3"/)
    const plain = applySteps(new Map([['package.json', manifest]]), [override({ file: 'package.json#overrides' })])
    assert.match(plain.get('package.json') ?? '', /"overrides": \{\s+"semver@<5\.7\.3": "5\.7\.3"/)
  })

  it('ignores relock steps and throws for a missing manifest', () => {
    assert.equal(applySteps(new Map(), [relock()]).size, 0)
    assert.throws(() => applySteps(new Map([['storefront/package.json', null]]), [setRange()]), (error: unknown) => error instanceof EditError && error.message === 'storefront/package.json is missing')
  })
})

describe('relockPins', () => {
  const root = () =>
    makeGraph({
      importers: { '.': ['semver@5.7.2 ^5.7.0', 'dev:other@1.0.0 npm:other@^1.0.0'], web: ['semver@5.7.2 catalog:'] },
      packages: { 'semver@5.7.2': [], 'other@1.0.0': [] },
    })

  it('pins only the override for pnpm', () => {
    const steps = relockPins(root(), 'pnpm', [relock()], 'pnpm-workspace.yaml')
    assert.deepEqual(steps.map((step) => step.kind), ['override'])
    assert.equal((steps[0] as OverrideStep).selector, 'semver@5.7.2')
    assert.equal((steps[0] as OverrideStep).value, '5.7.3')
  })

  it('adds manifest pins for npm', () => {
    const steps = relockPins(root(), 'npm', [relock()], 'package.json#overrides')
    assert.deepEqual(steps.map((step) => step.kind), ['override', 'set-range'])
    const pin = steps[1] as SetRangeStep
    assert.equal(pin.importer, 'importer:.')
    assert.equal(pin.dependency, 'semver')
    assert.equal(pin.field, 'dependencies')
    assert.equal(pin.place, 'manifest')
    assert.equal(pin.from, '^5.7.0')
    assert.equal(pin.to, '5.7.3')
  })
})

describe('sameGoal', () => {
  it('compares fixes by name and version and updates by name', () => {
    assert.equal(sameGoal(fixGoal, { ...fixGoal, advisoryIds: ['x'] }), true)
    assert.equal(sameGoal(fixGoal, { ...fixGoal, version: '5.7.1' }), false)
    assert.equal(sameGoal(updateGoal, { ...updateGoal, target: '3.6.0' }), true)
    assert.equal(sameGoal(updateGoal, { ...updateGoal, name: 'react' }), false)
    assert.equal(sameGoal(fixGoal, updateGoal), false)
  })
})

describe('findConflict', () => {
  function both(first: ChangeItem, second: ChangeItem, reason: string): void {
    assert.equal(findConflict([first], second)?.reason, reason)
    assert.equal(findConflict([second], first)?.reason, reason)
  }

  it('flags different targets for one range', () => {
    both(item('a', [setRange()]), item('b', [setRange({ to: '^3.6.0' })], updateGoal), 'both set vue in storefront')
    both(item('a', [setRange({ importer: 'importer:.' })]), item('b', [setRange({ importer: 'importer:.', to: '^3.6.0' })], updateGoal), 'both set vue in the root package')
    both(item('a', [setRange({ place: 'catalog', catalog: 'legacy' })]), item('b', [setRange({ place: 'catalog', catalog: 'legacy', importer: 'importer:admin', to: '^3.6.0' })], updateGoal), 'both set vue in the legacy catalog')
  })

  it('flags different override values and relock targets', () => {
    both(item('a', [override()]), item('b', [override({ value: '5.8.0' })]), 'both override semver@<5.7.3')
    both(item('a', [relock()]), item('b', [relock({ to: '5.7.4' })]), 'both re-lock semver 5.7.2')
  })

  it('flags an override that matches another relock', () => {
    both(item('a', [override({ selector: 'semver@<5.7.3' })]), item('b', [relock()]), 'the override semver@<5.7.3 also matches the re-lock of semver 5.7.2')
  })

  it('accepts identical steps and unrelated ones', () => {
    assert.equal(findConflict([item('a', [setRange(), override()])], item('b', [setRange(), override()])), undefined)
    assert.equal(findConflict([item('a', [override({ selector: 'semver@<5.7.1' })])], item('b', [relock()])), undefined)
    assert.equal(findConflict([item('a', [setRange()])], item('b', [setRange({ dependency: 'react', to: '^19.0.0' })])), undefined)
  })

  it('returns the conflicting item', () => {
    const first = item('a', [relock()])
    assert.equal(findConflict([first], item('b', [relock({ to: '5.7.4' })]))?.item, first)
  })
})
