import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { unifiedDiff, truncateUtf8, MAX_EDIT_DISTANCE } from '../src/actions/text-diff.ts'

function numberedLines(count: number, change?: (index: number) => string | null): string {
  const lines: string[] = []
  for (let index = 1; index <= count; index++) lines.push(change?.(index) ?? `line ${index}`)
  return lines.join('\n') + '\n'
}

describe('unifiedDiff', () => {
  it('renders a single change with three lines of context', () => {
    const result = unifiedDiff('x.json', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nD\ne\nf\ng\nh\n')
    assert.equal(
      result.diff,
      ['--- a/x.json', '+++ b/x.json', '@@ -1,7 +1,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ''].join('\n')
    )
    assert.equal(result.added, 1)
    assert.equal(result.removed, 1)
  })

  it('splits hunks when the gap exceeds twice the context', () => {
    const before = numberedLines(20)
    const apart = unifiedDiff('p', before, numberedLines(20, (i) => (i === 2 || i === 12 ? 'X' : null)))
    const close = unifiedDiff('p', before, numberedLines(20, (i) => (i === 2 || i === 8 ? 'X' : null)))
    assert.equal(apart.diff.split('\n').filter((line) => line.startsWith('@@')).length, 2)
    assert.equal(close.diff.split('\n').filter((line) => line.startsWith('@@')).length, 1)
  })

  it('merges hunks whose contexts touch', () => {
    const before = numberedLines(20)
    const touching = unifiedDiff('p', before, numberedLines(20, (i) => (i === 2 || i === 9 ? 'X' : null)))
    assert.equal(touching.diff.split('\n').filter((line) => line.startsWith('@@')).length, 1)
  })

  it('treats a missing before as a new file', () => {
    const result = unifiedDiff('p', null, 'x\ny\n')
    assert.equal(result.diff, ['--- /dev/null', '+++ b/p', '@@ -0,0 +1,2 @@', '+x', '+y', ''].join('\n'))
    assert.equal(result.added, 2)
    assert.equal(result.removed, 0)
  })

  it('treats a missing after as a deleted file', () => {
    const result = unifiedDiff('p', 'x\ny\n', null)
    assert.equal(result.diff, ['--- a/p', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y', ''].join('\n'))
    assert.equal(result.removed, 2)
  })

  it('marks a last line without a newline', () => {
    const result = unifiedDiff('p', 'a\nb\n', 'a\nb')
    assert.equal(
      result.diff,
      ['--- a/p', '+++ b/p', '@@ -1,2 +1,2 @@', ' a', '-b', '+b', '\\ No newline at end of file', ''].join('\n')
    )
  })

  it('marks an unchanged last line without a newline once', () => {
    const result = unifiedDiff('p', 'a\nb', 'A\nb')
    assert.equal(
      result.diff,
      ['--- a/p', '+++ b/p', '@@ -1,2 +1,2 @@', '-a', '+A', ' b', '\\ No newline at end of file', ''].join('\n')
    )
  })

  it('keeps carriage returns in lines', () => {
    const result = unifiedDiff('p', 'a\r\nb\r\n', 'a\r\nB\r\n')
    assert.equal(result.diff, ['--- a/p', '+++ b/p', '@@ -1,2 +1,2 @@', ' a\r', '-b\r', '+B\r', ''].join('\n'))
  })

  it('returns an empty diff for equal texts', () => {
    assert.deepEqual(unifiedDiff('p', 'a\n', 'a\n'), { diff: '', added: 0, removed: 0 })
  })

  it('writes a pure insertion header like diff -u', () => {
    const result = unifiedDiff('p', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nd\nNEW\ne\nf\ng\n')
    assert.ok(result.diff.includes('@@ -2,6 +2,7 @@'))
  })

  it('counts changed lines on a large text', () => {
    const before = numberedLines(20000)
    const after = numberedLines(20000, (i) => (i % 20 === 0 ? `changed ${i}` : null))
    const result = unifiedDiff('lock', before, after)
    assert.equal(result.added, 1000)
    assert.equal(result.removed, 1000)
  })

  it('falls back to one removal block and one addition block beyond the edit distance cap', () => {
    const total = MAX_EDIT_DISTANCE + 500
    const before = numberedLines(total)
    const after = numberedLines(total, (i) => `other ${i}`)
    const result = unifiedDiff('p', before, after)
    assert.equal(result.removed, total)
    assert.equal(result.added, total)
    const body = result.diff.split('\n').filter((line) => /^[-+ ]/.test(line) && !/^(---|\+\+\+)/.test(line))
    const firstAddition = body.findIndex((line) => line.startsWith('+'))
    assert.equal(body.slice(0, firstAddition).every((line) => line.startsWith('-')), true)
    assert.equal(body.slice(firstAddition).every((line) => line.startsWith('+')), true)
  })
})

describe('truncateUtf8', () => {
  it('cuts at the last line break within the byte limit', () => {
    assert.deepEqual(truncateUtf8('ä\nb\n', 3), { text: 'ä\n', truncated: true })
  })

  it('returns short text unchanged', () => {
    assert.deepEqual(truncateUtf8('ab\n', 10), { text: 'ab\n', truncated: false })
  })

  it('returns empty text when no line break fits', () => {
    assert.deepEqual(truncateUtf8('abcdef\n', 3), { text: '', truncated: true })
  })
})
