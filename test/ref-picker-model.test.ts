import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitRef } from '../src/git/ref-list.ts'
import type { GitInfo } from '../src/server/branches.ts'
import { PICKER_LIMIT, pickerModel } from '../ui/src/ref-picker-model.ts'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'
const DAY = 86_400_000

function ref(name: string, kind: GitRef['kind'], daysAgo: number): GitRef {
  return { name, short: name.replace(/^refs\/(heads|remotes|tags)\//, ''), kind, commit: HEAD, committedAt: new Date(NOW - daysAgo * DAY).toISOString() }
}

type AvailableInfo = Extract<GitInfo, { available: true }>

const INFO: AvailableInfo = {
  available: true,
  head: { commit: HEAD, branch: 'refs/heads/main' },
  defaultBranch: 'refs/remotes/origin/main',
  refs: [
    ref('refs/heads/main', 'branch', 0),
    ref('refs/heads/maintenance/6.1', 'branch', 3),
    ref('refs/remotes/origin/main', 'remote', 1),
    ref('refs/tags/v1.0.0', 'tag', 20),
  ],
}

describe('ref picker model', () => {
  it('groups the working tree, HEAD, branches, remotes and tags', () => {
    const model = pickerModel(INFO, '', { includeWorking: true, now: NOW })
    assert.deepEqual(
      model.groups.map((group) => [group.label, group.options.map((option) => [option.value, option.label, option.detail])]),
      [
        ['Working tree', [['work', 'Working tree', ''], ['HEAD', 'Last commit (HEAD) · abcdef1', '']]],
        ['Local branches', [['refs/heads/main', 'main', 'checked out'], ['refs/heads/maintenance/6.1', 'maintenance/6.1', '3 days ago']]],
        ['Remote branches', [['refs/remotes/origin/main', 'origin/main', 'yesterday']]],
        ['Tags', [['refs/tags/v1.0.0', 'v1.0.0', '2 weeks ago']]],
      ],
    )
    assert.equal(model.optionCount, 6)
    assert.equal(model.hiddenCount, 0)
    assert.equal(new Set(model.groups.flatMap((group) => group.options.map((option) => option.key))).size, 6)
  })

  it('marks the checked-out branch', () => {
    const options = pickerModel(INFO, '', { includeWorking: true, now: NOW }).groups.flatMap((group) => group.options)
    assert.deepEqual(
      options.filter((option) => option.checkedOut).map((option) => option.value),
      ['refs/heads/main'],
    )
  })

  it('filters case-insensitively', () => {
    const model = pickerModel(INFO, 'MAINT', { includeWorking: true, now: NOW })
    assert.deepEqual(
      model.groups.map((group) => group.label),
      ['Local branches'],
    )
    assert.deepEqual(
      model.groups[0]!.options.map((option) => option.value),
      ['refs/heads/maintenance/6.1'],
    )
  })

  it('caps at 100 options', () => {
    const many: AvailableInfo = { ...INFO, refs: Array.from({ length: 1900 }, (_, index) => ref(`refs/heads/b-${String(index).padStart(4, '0')}`, 'branch', 1)) }
    const model = pickerModel(many, '', { includeWorking: true, now: NOW })
    assert.equal(PICKER_LIMIT, 100)
    assert.equal(model.optionCount, 100)
    assert.equal(model.hiddenCount, 1802)
    assert.deepEqual(
      model.groups[0]!.options.map((option) => option.value),
      ['work', 'HEAD'],
    )
  })

  it('leaves out the working tree when not included', () => {
    const model = pickerModel(INFO, '', { includeWorking: false, now: NOW })
    assert.deepEqual(
      model.groups[0]!.options.map((option) => option.value),
      ['HEAD'],
    )
    const unborn = pickerModel({ available: true, refs: [] }, '', { includeWorking: false, now: NOW })
    assert.deepEqual(unborn.groups, [])
  })
})
