import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { setWorkspaceString, WorkspaceEditError } from '../src/actions/workspace-edit.ts'
import { unifiedDiff } from '../src/actions/text-diff.ts'

const WORKSPACE = [
  '# workspace settings',
  'packages:',
  "  - 'packages/*'",
  "  - 'apps/*' # applications",
  '',
  'overrides:',
  '  lodash: 4.17.21',
  '',
  'catalog:',
  '  vue: ^3.4.0',
  '',
  'catalogs:',
  '  legacy:',
  '    vue: ^2.7.0',
  ''
].join('\n')

describe('setWorkspaceString', () => {
  it('adds one override line and keeps comments and quoting', () => {
    const after = setWorkspaceString(WORKSPACE, ['overrides', 'semver@<5.7.3'], '5.7.3')
    const { added, removed } = unifiedDiff('pnpm-workspace.yaml', WORKSPACE, after)
    assert.deepEqual({ added, removed }, { added: 1, removed: 0 })
    assert.ok(after.includes('# workspace settings'))
    assert.ok(after.includes("- 'apps/*' # applications"))
    assert.deepEqual(parse(after).overrides, { lodash: '4.17.21', 'semver@<5.7.3': '5.7.3' })
  })

  it('updates catalog and named catalog entries in place', () => {
    const catalog = setWorkspaceString(WORKSPACE, ['catalog', 'vue'], '^3.5.0')
    assert.equal(catalog, WORKSPACE.replace('^3.4.0', '^3.5.0'))
    const named = setWorkspaceString(WORKSPACE, ['catalogs', 'legacy', 'vue'], '^2.7.16')
    assert.equal(named, WORKSPACE.replace('^2.7.0', '^2.7.16'))
  })

  it('keeps a four-space indent and adds only the new line', () => {
    const before = [
      'packages:',
      "    - 'packages/*'",
      '',
      'overrides:',
      '    lodash: 4.17.21',
      '',
      'catalogs:',
      '    legacy:',
      '        vue: ^2.7.0',
      '',
    ].join('\n')
    const after = setWorkspaceString(before, ['overrides', 'semver@<5.7.3'], '5.7.3')
    assert.equal(after, before.replace('    lodash: 4.17.21\n', '    lodash: 4.17.21\n    semver@<5.7.3: 5.7.3\n'))
    assert.deepEqual(unifiedDiff('pnpm-workspace.yaml', before, after).added, 1)
    const nested = setWorkspaceString(before, ['catalogs', 'legacy', 'react'], '^18.0.0')
    assert.equal(nested, before.replace('        vue: ^2.7.0\n', '        vue: ^2.7.0\n        react: ^18.0.0\n'))
  })

  it('keeps sequences unindented when they were', () => {
    const before = 'packages:\n- a\n- b\noverrides:\n  x: 1.0.0\n'
    const after = setWorkspaceString(before, ['overrides', 'y'], '2.0.0')
    assert.equal(after, 'packages:\n- a\n- b\noverrides:\n  x: 1.0.0\n  y: 2.0.0\n')
  })

  it('keeps sequences indented when they were', () => {
    const before = 'packages:\n  - a\n  - b\n'
    const after = setWorkspaceString(before, ['overrides', 'y'], '2.0.0')
    assert.ok(after.startsWith('packages:\n  - a\n  - b\n'))
  })

  it('reads keys and versions back as strings', () => {
    const after = setWorkspaceString('packages:\n  - a\n', ['overrides', '@babel/traverse@<7.23.2'], '1.10.0')
    assert.deepEqual(parse(after).overrides, { '@babel/traverse@<7.23.2': '1.10.0' })
  })

  it('creates a document from null text', () => {
    const after = setWorkspaceString(null, ['overrides', 'semver@<5.7.3'], '5.7.3')
    assert.deepEqual(parse(after), { overrides: { 'semver@<5.7.3': '5.7.3' } })
  })

  it('throws for malformed YAML', () => {
    assert.throws(() => setWorkspaceString('a: [1\nb: }', ['a'], 'x'), WorkspaceEditError)
  })

  it('treats an intermediate key with no value as a missing map', () => {
    const before = 'packages:\n  - a\noverrides:\ncatalog:\n  vue: ^3.4.0\n'
    const after = setWorkspaceString(before, ['overrides', 'x'], '1.0.0')
    assert.deepEqual(parse(after), { packages: ['a'], overrides: { x: '1.0.0' }, catalog: { vue: '^3.4.0' } })
    assert.ok(after.includes('catalog:\n  vue: ^3.4.0\n'))
  })

  it('throws WorkspaceEditError for a scalar on the way', () => {
    assert.throws(() => setWorkspaceString('overrides: foo\n', ['overrides', 'x'], '1'), (error) => {
      return error instanceof WorkspaceEditError && error.message.includes('overrides')
    })
  })

  it('throws WorkspaceEditError for a sequence on the way', () => {
    assert.throws(() => setWorkspaceString('overrides:\n  - a\n', ['overrides', 'x'], '1'), WorkspaceEditError)
  })

  it('throws WorkspaceEditError for a top-level sequence or scalar', () => {
    assert.throws(() => setWorkspaceString('- a\n- b\n', ['overrides', 'x'], '1'), WorkspaceEditError)
    assert.throws(() => setWorkspaceString('hello\n', ['overrides', 'x'], '1'), WorkspaceEditError)
  })
})
