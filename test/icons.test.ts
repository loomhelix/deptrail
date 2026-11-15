import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ICON_NAMES, ICON_PATHS } from '../ui/src/icons.ts'

describe('icons', () => {
  it('draws every named icon on the 24 unit grid with at least one path command', () => {
    assert.deepEqual([...ICON_NAMES].sort(), ['check', 'chevron-down', 'chevron-right', 'chevron-up', 'chevrons-left', 'chevrons-right', 'git-branch', 'x'])
    for (const name of ICON_NAMES) {
      const path = ICON_PATHS[name]
      assert.match(path, /^[Mm]/, name)
      const numbers = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
      assert.ok(numbers.length > 0, name)
    }
  })
})
