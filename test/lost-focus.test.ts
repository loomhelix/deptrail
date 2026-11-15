import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hasLostFocus, restoreFocusIfLost, type FocusOwner } from '../ui/src/keyboard/lost-focus.ts'

const BODY = { tag: 'body' }
const BUTTON = { tag: 'button' }

function owner(activeElement: unknown): FocusOwner {
  return { activeElement, body: BODY }
}

describe('hasLostFocus', () => {
  it('says focus is lost when nothing or the body has it', () => {
    assert.equal(hasLostFocus(owner(null)), true)
    assert.equal(hasLostFocus(owner(BODY)), true)
  })

  it('says focus is kept when an element has it', () => {
    assert.equal(hasLostFocus(owner(BUTTON)), false)
  })
})

describe('restoreFocusIfLost', () => {
  it('restores focus after the next render when it was lost', async () => {
    const focusOwner = owner(BUTTON)
    let restored = 0
    const pending = restoreFocusIfLost(focusOwner, () => (restored += 1))
    focusOwner.activeElement = BODY
    assert.equal(restored, 0)
    await pending
    assert.equal(restored, 1)
  })

  it('leaves focus alone when an element still has it after the render', async () => {
    let restored = 0
    await restoreFocusIfLost(owner(BUTTON), () => (restored += 1))
    assert.equal(restored, 0)
  })
})
