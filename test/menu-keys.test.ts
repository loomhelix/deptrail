import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { menuButtonResponse, menuKeyAction } from '../ui/src/keyboard/menu-keys.ts'

const labels = ['All roots', 'legacy/admin', 'shop', 'shop-npm']

describe('menuKeyAction', () => {
  it('moves with the arrows and wraps around the ends', () => {
    assert.deepEqual(menuKeyAction(labels, 0, 'ArrowDown'), { kind: 'move', index: 1 })
    assert.deepEqual(menuKeyAction(labels, 2, 'ArrowUp'), { kind: 'move', index: 1 })
    assert.deepEqual(menuKeyAction(labels, 3, 'ArrowDown'), { kind: 'move', index: 0 })
    assert.deepEqual(menuKeyAction(labels, 0, 'ArrowUp'), { kind: 'move', index: 3 })
  })

  it('jumps to the first and the last item with Home and End', () => {
    assert.deepEqual(menuKeyAction(labels, 2, 'Home'), { kind: 'move', index: 0 })
    assert.deepEqual(menuKeyAction(labels, 1, 'End'), { kind: 'move', index: 3 })
  })

  it('chooses the active item with Enter and Space', () => {
    assert.deepEqual(menuKeyAction(labels, 2, 'Enter'), { kind: 'choose', index: 2 })
    assert.deepEqual(menuKeyAction(labels, 1, ' '), { kind: 'choose', index: 1 })
  })

  it('closes with Escape and leaves with Tab', () => {
    assert.deepEqual(menuKeyAction(labels, 1, 'Escape'), { kind: 'close' })
    assert.deepEqual(menuKeyAction(labels, 1, 'Tab'), { kind: 'leave' })
  })

  it('jumps to the next item that starts with a typed letter, ignoring case and wrapping', () => {
    assert.deepEqual(menuKeyAction(labels, 0, 's'), { kind: 'move', index: 2 })
    assert.deepEqual(menuKeyAction(labels, 2, 'S'), { kind: 'move', index: 3 })
    assert.deepEqual(menuKeyAction(labels, 3, 's'), { kind: 'move', index: 2 })
    assert.deepEqual(menuKeyAction(labels, 2, 'l'), { kind: 'move', index: 1 })
  })

  it('ignores a letter no item starts with and keys that are not letters', () => {
    assert.equal(menuKeyAction(labels, 0, 'z'), undefined)
    assert.equal(menuKeyAction(labels, 0, 'Shift'), undefined)
    assert.equal(menuKeyAction(labels, 0, 'ArrowRight'), undefined)
  })

  it('stays on the only item that starts with the letter', () => {
    assert.equal(menuKeyAction(labels, 1, 'l'), undefined)
  })

  it('does nothing but close in an empty menu', () => {
    assert.equal(menuKeyAction([], 0, 'ArrowDown'), undefined)
    assert.equal(menuKeyAction([], 0, 'Enter'), undefined)
    assert.deepEqual(menuKeyAction([], 0, 'Escape'), { kind: 'close' })
  })
})

describe('menuButtonResponse', () => {
  const open = { isOpen: true, choseWithSpace: false }
  const closed = { isOpen: false, choseWithSpace: false }

  it('keeps focus in an open menu while its button is pressed, so focus leaving cannot close it before the click', () => {
    assert.deepEqual(menuButtonResponse({ type: 'mousedown' }, open), { preventDefault: true })
    assert.deepEqual(menuButtonResponse({ type: 'mousedown' }, closed), { preventDefault: false })
  })

  it('closes an open menu and opens a closed one on click', () => {
    assert.deepEqual(menuButtonResponse({ type: 'click' }, open), { preventDefault: false, menu: 'close' })
    assert.deepEqual(menuButtonResponse({ type: 'click' }, closed), { preventDefault: false, menu: 'open' })
  })

  it('swallows the Space keyup that follows a choice made with Space, so no click reopens the menu', () => {
    assert.deepEqual(menuButtonResponse({ type: 'keyup', key: ' ' }, { isOpen: false, choseWithSpace: true }), { preventDefault: true })
  })

  it('lets other keyups and a Space keyup of the button itself through', () => {
    assert.deepEqual(menuButtonResponse({ type: 'keyup', key: ' ' }, closed), { preventDefault: false })
    assert.deepEqual(menuButtonResponse({ type: 'keyup', key: 'Enter' }, { isOpen: false, choseWithSpace: true }), { preventDefault: false })
  })
})
