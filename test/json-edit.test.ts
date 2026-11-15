import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setJsonString, JsonEditError } from '../src/actions/json-edit.ts'
import { unifiedDiff } from '../src/actions/text-diff.ts'

function manifest(indent: string, lineBreak = '\n'): string {
  return [
    '{',
    `${indent}"name": "demo",`,
    `${indent}"dependencies": {`,
    `${indent}${indent}"semver": "^7.0.0",`,
    `${indent}${indent}"left-pad": "^1.0.0"`,
    `${indent}}`,
    '}',
    ''
  ].join(lineBreak)
}

function changedLines(before: string, after: string): { added: number; removed: number } {
  const { added, removed } = unifiedDiff('package.json', before, after)
  return { added, removed }
}

describe('setJsonString', () => {
  for (const [label, indent, lineBreak] of [
    ['two spaces', '  ', '\n'],
    ['four spaces', '    ', '\n'],
    ['tabs', '\t', '\n'],
    ['CRLF', '  ', '\r\n']
  ] as const) {
    it(`replaces one value and nothing else with ${label}`, () => {
      const before = manifest(indent, lineBreak)
      const after = setJsonString(before, ['dependencies', 'semver'], '^7.6.3')
      assert.deepEqual(changedLines(before, after), { added: 1, removed: 1 })
      assert.equal(JSON.parse(after).dependencies.semver, '^7.6.3')
      assert.equal(after, before.replace('^7.0.0', '^7.6.3'))
    })

    it(`appends a missing key with sibling indentation with ${label}`, () => {
      const before = manifest(indent, lineBreak)
      const after = setJsonString(before, ['dependencies', 'x'], '^2')
      assert.equal(
        after,
        before.replace(
          `"left-pad": "^1.0.0"${lineBreak}`,
          `"left-pad": "^1.0.0",${lineBreak}${indent}${indent}"x": "^2"${lineBreak}`
        )
      )
      assert.deepEqual(JSON.parse(after).dependencies, { semver: '^7.0.0', 'left-pad': '^1.0.0', x: '^2' })
    })
  }

  it('finds a key written with escapes', () => {
    const before = '{\n  "dependencies": {\n    "sem\\u0076er": "^7.0.0"\n  }\n}\n'
    const after = setJsonString(before, ['dependencies', 'semver'], '^7.6.3')
    assert.equal(JSON.parse(after).dependencies.semver, '^7.6.3')
    assert.deepEqual(changedLines(before, after), { added: 1, removed: 1 })
  })

  it('edits the last of repeated keys', () => {
    const before = '{"a": "1", "a": "2"}'
    assert.equal(setJsonString(before, ['a'], '3'), '{"a": "1", "a": "3"}')
  })

  it('turns an empty object into three lines', () => {
    const before = '{\n  "name": "demo",\n  "dependencies": {}\n}\n'
    const after = setJsonString(before, ['dependencies', 'x'], '^1')
    assert.equal(after, '{\n  "name": "demo",\n  "dependencies": {\n    "x": "^1"\n  }\n}\n')
  })

  it('creates a nested override inside an existing pnpm object', () => {
    const before = '{\n  "name": "demo",\n  "pnpm": {\n    "onlyBuiltDependencies": "x"\n  }\n}\n'
    const after = setJsonString(before, ['pnpm', 'overrides', 'semver@<5.7.3'], '5.7.3')
    assert.deepEqual(JSON.parse(after).pnpm, { onlyBuiltDependencies: 'x', overrides: { 'semver@<5.7.3': '5.7.3' } })
    assert.equal(
      after,
      '{\n  "name": "demo",\n  "pnpm": {\n    "onlyBuiltDependencies": "x",\n    "overrides": {\n      "semver@<5.7.3": "5.7.3"\n    }\n  }\n}\n'
    )
  })

  it('creates pnpm and overrides when pnpm is missing', () => {
    const before = '{\n  "name": "demo"\n}\n'
    const after = setJsonString(before, ['pnpm', 'overrides', 'semver@<5.7.3'], '5.7.3')
    assert.deepEqual(JSON.parse(after), { name: 'demo', pnpm: { overrides: { 'semver@<5.7.3': '5.7.3' } } })
    assert.equal(
      after,
      '{\n  "name": "demo",\n  "pnpm": {\n    "overrides": {\n      "semver@<5.7.3": "5.7.3"\n    }\n  }\n}\n'
    )
  })

  it('creates a top-level overrides object with CRLF line breaks', () => {
    const before = '{\r\n  "name": "demo"\r\n}\r\n'
    const after = setJsonString(before, ['overrides', 'a'], '1')
    assert.equal(after, '{\r\n  "name": "demo",\r\n  "overrides": {\r\n    "a": "1"\r\n  }\r\n}\r\n')
  })

  it('keeps "//" members and a missing trailing newline', () => {
    const before = '{\n  "//": "note",\n  "dependencies": {\n    "a": "^1"\n  }\n}'
    const after = setJsonString(before, ['dependencies', 'a'], '^2')
    assert.equal(after, before.replace('^1', '^2'))
    const appended = setJsonString(before, ['dependencies', 'b'], '^2')
    assert.ok(appended.endsWith('}') && !appended.endsWith('\n'))
    assert.equal(JSON.parse(appended)['//'], 'note')
  })

  it('appends to an inline object on the same line', () => {
    const before = '{ "dependencies": { "a": "^1" } }'
    const after = setJsonString(before, ['dependencies', 'b'], '^2')
    assert.equal(after, '{ "dependencies": { "a": "^1", "b": "^2" } }')
  })

  it('throws for a number at the path', () => {
    assert.throws(() => setJsonString('{"a": 1}', ['a'], 'x'), JsonEditError)
  })

  it('throws for an array on the way', () => {
    assert.throws(() => setJsonString('{"a": []}', ['a', 'b'], 'x'), JsonEditError)
  })

  it('throws when the document is not an object', () => {
    assert.throws(() => setJsonString('[1]', ['a'], 'x'), JsonEditError)
  })

  it('throws for malformed JSON', () => {
    assert.throws(() => setJsonString('{"a": ', ['a'], 'x'), JsonEditError)
    assert.throws(() => setJsonString('{"a": "x"} x', ['a'], 'y'), JsonEditError)
    assert.throws(() => setJsonString('{"a": tru}', ['a'], 'y'), JsonEditError)
  })

  it('handles nested arrays and escaped quotes in values', () => {
    const before = '{"list": [1, [2, {"a": "}"}]], "s": "q\\"x", "t": "old"}'
    const after = setJsonString(before, ['t'], 'new')
    assert.equal(after, before.replace('"old"', '"new"'))
  })
})
