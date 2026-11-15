import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { codeSegments, diffLines, fileStats, packageChangeText, previewMetaText } from '../ui/src/actions-text.ts'

describe('packageChangeText', () => {
  it('shows a single replaced version with an arrow', () => {
    assert.equal(packageChangeText({ name: 'semver', removed: ['5.7.2'], added: ['5.7.3'] }), 'semver 5.7.2 → 5.7.3')
  })

  it('marks added and removed packages', () => {
    assert.equal(packageChangeText({ name: 'esbuild', removed: [], added: ['0.24.0'] }), '+ esbuild 0.24.0')
    assert.equal(packageChangeText({ name: 'esbuild', removed: [], added: ['0.24.0', '0.25.0'] }), '+ esbuild 0.24.0, 0.25.0')
    assert.equal(packageChangeText({ name: 'rollup', removed: ['3.29.4'], added: [] }), '− rollup 3.29.4')
    assert.equal(packageChangeText({ name: 'rollup', removed: ['3.29.4', '4.0.0'], added: [] }), '− rollup 3.29.4, 4.0.0')
  })

  it('joins several versions on each side', () => {
    assert.equal(packageChangeText({ name: 'child-lib', removed: ['1.0.0', '2.0.0'], added: ['1.0.1'] }), 'child-lib 1.0.0, 2.0.0 → 1.0.1')
    assert.equal(packageChangeText({ name: 'child-lib', removed: ['1.0.0'], added: ['1.0.1', '2.0.1'] }), 'child-lib 1.0.0 → 1.0.1, 2.0.1')
  })
})

describe('fileStats', () => {
  it('counts added and removed lines', () => {
    assert.equal(fileStats({ path: 'web/package.json', change: 'modified', added: 1, removed: 1 }), '+1 −1')
    assert.equal(fileStats({ path: 'pnpm-lock.yaml', change: 'modified', added: 214, removed: 0 }), '+214 −0')
  })
})

describe('previewMetaText', () => {
  it('names the package manager and how long ago the preview ran', () => {
    const preview = { manager: { name: 'pnpm' as const, version: '10.34.3' }, createdAt: '2026-10-25T10:00:00.000Z' }
    assert.equal(previewMetaText(preview, Date.parse('2026-10-25T10:00:40.000Z')), 'pnpm 10.34.3 · just now')
    assert.equal(previewMetaText(preview, Date.parse('2026-10-25T10:05:00.000Z')), 'pnpm 10.34.3 · 5 minutes ago')
  })
})

describe('diffLines', () => {
  it('marks the headers, hunks, added, removed and context lines of a unified diff', () => {
    const diff = [
      '--- a/web/package.json',
      '+++ b/web/package.json',
      '@@ -3,4 +3,4 @@',
      '   "private": true,',
      '-    "parent-lib": "1.0.0",',
      '+    "parent-lib": "1.1.0",',
      '---',
      '+++',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    assert.deepEqual(diffLines(diff), [
      { text: '--- a/web/package.json', tone: 'meta' },
      { text: '+++ b/web/package.json', tone: 'meta' },
      { text: '@@ -3,4 +3,4 @@', tone: 'meta' },
      { text: '   "private": true,', tone: 'context' },
      { text: '-    "parent-lib": "1.0.0",', tone: 'removed' },
      { text: '+    "parent-lib": "1.1.0",', tone: 'added' },
      { text: '---', tone: 'removed' },
      { text: '+++', tone: 'added' },
      { text: '\\ No newline at end of file', tone: 'meta' },
    ])
  })

  it('has no lines for an empty diff', () => {
    assert.deepEqual(diffLines(''), [])
  })
})

describe('codeSegments', () => {
  it('splits a text at its backtick-quoted commands', () => {
    assert.deepEqual(codeSegments('node_modules was not updated. Run `npm ci` in shop-npm when ready.'), [
      { text: 'node_modules was not updated. Run ', code: false },
      { text: 'npm ci', code: true },
      { text: ' in shop-npm when ready.', code: false },
    ])
    assert.deepEqual(codeSegments('Run `pnpm install --frozen-lockfile`'), [
      { text: 'Run ', code: false },
      { text: 'pnpm install --frozen-lockfile', code: true },
    ])
  })

  it('keeps a text without commands in one plain segment', () => {
    assert.deepEqual(codeSegments('Files restored in shop.'), [{ text: 'Files restored in shop.', code: false }])
    assert.deepEqual(codeSegments(''), [])
  })
})
