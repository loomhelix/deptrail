import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shortcutFor, type KeyInput, type KeyTarget } from '../ui/src/keyboard/shortcuts.ts'

const body: KeyTarget = { tagName: 'BODY', isContentEditable: false, isInMenuOrDialog: false }
const input: KeyTarget = { tagName: 'INPUT', isContentEditable: false, isInMenuOrDialog: false }
const menuItem: KeyTarget = { tagName: 'DIV', isContentEditable: false, isInMenuOrDialog: true }
const dialogButton: KeyTarget = { tagName: 'BUTTON', isContentEditable: false, isInMenuOrDialog: true }

function press(key: string, modifiers: Partial<KeyInput> = {}): KeyInput {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...modifiers }
}

describe('shortcutFor', () => {
  it('maps single keys outside text fields', () => {
    assert.equal(shortcutFor(press('/'), body), 'search')
    assert.equal(shortcutFor(press('['), body), 'toggle-roots')
    assert.equal(shortcutFor(press(']'), body), 'toggle-details')
    assert.equal(shortcutFor(press('1'), body), 'view-issues')
    assert.equal(shortcutFor(press('2'), body), 'view-changes')
    assert.equal(shortcutFor(press('3'), body), 'view-explore')
    assert.equal(shortcutFor(press('4'), body), 'view-compare')
    assert.equal(shortcutFor(press('?', { shiftKey: true }), body), 'help')
    assert.equal(shortcutFor(press('?'), body), 'help')
  })

  it('ignores single keys inside text fields', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      assert.equal(shortcutFor(press('['), { tagName, isContentEditable: false, isInMenuOrDialog: false }), undefined)
      assert.equal(shortcutFor(press('/'), { tagName, isContentEditable: false, isInMenuOrDialog: false }), undefined)
    }
    assert.equal(shortcutFor(press('1'), { tagName: 'DIV', isContentEditable: true, isInMenuOrDialog: false }), undefined)
  })

  it('opens search with Cmd K and Ctrl K anywhere', () => {
    assert.equal(shortcutFor(press('k', { metaKey: true }), input), 'search')
    assert.equal(shortcutFor(press('K', { ctrlKey: true }), input), 'search')
    assert.equal(shortcutFor(press('k', { metaKey: true }), body), 'search')
    assert.equal(shortcutFor(press('k', { metaKey: true, altKey: true }), body), undefined)
    assert.equal(shortcutFor(press('k'), body), undefined)
  })

  it('leaves Shift Cmd K and Shift Ctrl K to the browser', () => {
    assert.equal(shortcutFor(press('K', { metaKey: true, shiftKey: true }), body), undefined)
    assert.equal(shortcutFor(press('K', { ctrlKey: true, shiftKey: true }), input), undefined)
  })

  it('returns escape everywhere', () => {
    assert.equal(shortcutFor(press('Escape'), input), 'escape')
    assert.equal(shortcutFor(press('Escape'), body), 'escape')
  })

  it('cancels single keys under Ctrl, Meta and Alt', () => {
    assert.equal(shortcutFor(press('1', { ctrlKey: true }), body), undefined)
    assert.equal(shortcutFor(press('[', { metaKey: true }), body), undefined)
    assert.equal(shortcutFor(press('/', { altKey: true }), body), undefined)
  })

  it('leaves keys that a menu or a dialog already handled alone', () => {
    for (const key of ['1', '?', '[', ']', '/', 'Escape']) {
      assert.equal(shortcutFor(press(key, { defaultPrevented: true }), body), undefined)
    }
    assert.equal(shortcutFor(press('k', { metaKey: true, defaultPrevented: true }), body), undefined)
  })

  it('ignores keys typed inside an open menu or dialog', () => {
    for (const key of ['2', '?', '[', ']', '/', 'Escape']) {
      assert.equal(shortcutFor(press(key), menuItem), undefined)
      assert.equal(shortcutFor(press(key), dialogButton), undefined)
    }
    assert.equal(shortcutFor(press('k', { ctrlKey: true }), dialogButton), undefined)
  })

  it('returns nothing for unmapped keys', () => {
    assert.equal(shortcutFor(press('x'), body), undefined)
  })
})
