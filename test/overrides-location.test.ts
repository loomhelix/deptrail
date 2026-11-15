import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseManagerVersion, declaredOverridesFiles, overridesLocation } from '../src/actions/overrides-location.ts'

describe('parseManagerVersion', () => {
  it('reads a version', () => {
    assert.equal(parseManagerVersion('10.34.3\n'), '10.34.3')
    assert.equal(parseManagerVersion('garbage'), undefined)
  })
})

describe('declaredOverridesFiles', () => {
  it('lists each declaration in order', () => {
    const files = {
      workspaceYaml: 'overrides:\n  a: 1.0.0\n',
      rootManifest: JSON.stringify({ pnpm: { overrides: { b: '1' } }, overrides: { c: '1' } })
    }
    assert.deepEqual(declaredOverridesFiles(files), ['pnpm-workspace.yaml', 'package.json#pnpm.overrides', 'package.json#overrides'])
  })

  it('ignores empty or malformed declarations', () => {
    assert.deepEqual(declaredOverridesFiles({ workspaceYaml: 'overrides: {}\n', rootManifest: null }), [])
    assert.deepEqual(declaredOverridesFiles({ workspaceYaml: ': : [', rootManifest: '{nope' }), [])
    assert.deepEqual(declaredOverridesFiles({ workspaceYaml: null, rootManifest: null }), [])
  })
})

describe('overridesLocation', () => {
  it('pnpm 9', () => {
    assert.deepEqual(overridesLocation({ name: 'pnpm', version: '9.15.0' }, []), { file: 'package.json#pnpm.overrides' })
    assert.deepEqual(overridesLocation({ name: 'pnpm', version: '9.15.0' }, ['pnpm-workspace.yaml']), { file: 'pnpm-workspace.yaml' })
  })

  it('pnpm 10', () => {
    assert.deepEqual(overridesLocation({ name: 'pnpm', version: '10.34.3' }, []), { file: 'pnpm-workspace.yaml' })
    assert.deepEqual(overridesLocation({ name: 'pnpm', version: '10.34.3' }, ['package.json#pnpm.overrides']), { file: 'package.json#pnpm.overrides' })
  })

  it('pnpm 11', () => {
    assert.deepEqual(overridesLocation({ name: 'pnpm', version: '11.0.0' }, ['package.json#pnpm.overrides']), {
      file: 'pnpm-workspace.yaml',
      warning: 'pnpm 11 ignores the pnpm field of package.json, so the override goes to pnpm-workspace.yaml'
    })
  })

  it('npm', () => {
    assert.deepEqual(overridesLocation({ name: 'npm', version: '11.19.0' }, []), { file: 'package.json#overrides' })
    assert.deepEqual(overridesLocation({ name: 'npm', version: '11.19.0' }, ['pnpm-workspace.yaml']), { file: 'package.json#overrides' })
  })
})
