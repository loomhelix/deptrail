import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rovingAction, type RovingItem } from '../ui/src/keyboard/roving-list.ts'

const items: RovingItem[] = [
  { id: 'a', expandable: true, expanded: true },
  { id: 'a1', parentId: 'a', expandable: false, expanded: false },
  { id: 'a2', parentId: 'a', expandable: false, expanded: false },
  { id: 'b', expandable: true, expanded: false },
  { id: 'c', expandable: false, expanded: false },
]

describe('rovingAction', () => {
  it('moves with arrows and stops at the ends', () => {
    assert.deepEqual(rovingAction(items, 'a', 'ArrowDown'), { kind: 'move', id: 'a1' })
    assert.deepEqual(rovingAction(items, 'a1', 'ArrowUp'), { kind: 'move', id: 'a' })
    assert.equal(rovingAction(items, 'a', 'ArrowUp'), undefined)
    assert.equal(rovingAction(items, 'c', 'ArrowDown'), undefined)
  })

  it('jumps with Home and End', () => {
    assert.deepEqual(rovingAction(items, 'b', 'Home'), { kind: 'move', id: 'a' })
    assert.deepEqual(rovingAction(items, 'b', 'End'), { kind: 'move', id: 'c' })
    assert.equal(rovingAction(items, 'a', 'Home'), undefined)
    assert.equal(rovingAction(items, 'c', 'End'), undefined)
  })

  it('expands a collapsed item with ArrowRight', () => {
    assert.deepEqual(rovingAction(items, 'b', 'ArrowRight'), { kind: 'expand', id: 'b' })
  })

  it('moves to the first child with ArrowRight on an expanded item', () => {
    assert.deepEqual(rovingAction(items, 'a', 'ArrowRight'), { kind: 'move', id: 'a1' })
  })

  it('does nothing with ArrowRight on a leaf or an expanded item without children', () => {
    assert.equal(rovingAction(items, 'c', 'ArrowRight'), undefined)
    const empty: RovingItem[] = [{ id: 'x', expandable: true, expanded: true }, { id: 'y', expandable: false, expanded: false }]
    assert.equal(rovingAction(empty, 'x', 'ArrowRight'), undefined)
  })

  it('collapses an expanded item with ArrowLeft', () => {
    assert.deepEqual(rovingAction(items, 'a', 'ArrowLeft'), { kind: 'collapse', id: 'a' })
  })

  it('moves to the parent with ArrowLeft on a child or collapsed item', () => {
    assert.deepEqual(rovingAction(items, 'a2', 'ArrowLeft'), { kind: 'move', id: 'a' })
    assert.equal(rovingAction(items, 'b', 'ArrowLeft'), undefined)
  })

  it('activates with Enter and Space', () => {
    assert.deepEqual(rovingAction(items, 'c', 'Enter'), { kind: 'activate', id: 'c' })
    assert.deepEqual(rovingAction(items, 'c', ' '), { kind: 'activate', id: 'c' })
  })

  it('falls back to the first item when nothing is active', () => {
    assert.deepEqual(rovingAction(items, undefined, 'ArrowDown'), { kind: 'move', id: 'a' })
    assert.deepEqual(rovingAction(items, 'missing', 'ArrowDown'), { kind: 'move', id: 'a' })
    assert.equal(rovingAction(items, undefined, 'Enter'), undefined)
  })

  it('ignores other keys and empty lists', () => {
    assert.equal(rovingAction(items, 'a', 'x'), undefined)
    assert.equal(rovingAction([], undefined, 'ArrowDown'), undefined)
  })
})
