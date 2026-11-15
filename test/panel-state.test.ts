import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_STATE_KEY, readPanelState, writePanelState } from '../ui/src/panel-state.ts'

function storedValue(value: string | null) {
  const keys: string[] = []
  return {
    keys,
    getItem(key: string): string | null {
      keys.push(key)
      return value
    },
  }
}

const throwingStorage = {
  getItem(): string | null {
    throw new Error('storage is disabled')
  },
  setItem(): void {
    throw new Error('quota exceeded')
  },
}

describe('readPanelState', () => {
  it('opens both panels on a wide viewport without a stored value', () => {
    assert.deepEqual(readPanelState(undefined, 1280), { rootsCollapsed: false, detailsCollapsed: false })
    assert.deepEqual(readPanelState(storedValue(null), 1100), { rootsCollapsed: false, detailsCollapsed: false })
  })

  it('collapses the details panel below 1100 px and the roots panel below 820 px', () => {
    assert.deepEqual(readPanelState(undefined, 1099), { rootsCollapsed: false, detailsCollapsed: true })
    assert.deepEqual(readPanelState(undefined, 820), { rootsCollapsed: false, detailsCollapsed: true })
    assert.deepEqual(readPanelState(undefined, 819), { rootsCollapsed: true, detailsCollapsed: true })
  })

  it('reads the stored value under deptrail.panels and prefers it to the defaults', () => {
    const storage = storedValue(JSON.stringify({ rootsCollapsed: true, detailsCollapsed: false }))
    assert.deepEqual(readPanelState(storage, 800), { rootsCollapsed: true, detailsCollapsed: false })
    assert.deepEqual(storage.keys, ['deptrail.panels'])
    assert.equal(PANEL_STATE_KEY, 'deptrail.panels')
  })

  it('falls back to the default for each missing or malformed field', () => {
    assert.deepEqual(readPanelState(storedValue(JSON.stringify({ rootsCollapsed: true })), 1000), {
      rootsCollapsed: true,
      detailsCollapsed: true,
    })
    assert.deepEqual(readPanelState(storedValue(JSON.stringify({ rootsCollapsed: 'yes', detailsCollapsed: 1 })), 1280), {
      rootsCollapsed: false,
      detailsCollapsed: false,
    })
    for (const malformed of ['{', 'null', '[]', '"collapsed"', '42']) {
      assert.deepEqual(readPanelState(storedValue(malformed), 1280), { rootsCollapsed: false, detailsCollapsed: false }, malformed)
    }
  })

  it('ignores a storage that throws', () => {
    assert.deepEqual(readPanelState(throwingStorage, 1000), { rootsCollapsed: false, detailsCollapsed: true })
  })
})

describe('writePanelState', () => {
  it('stores the state as JSON under deptrail.panels', () => {
    const written: [string, string][] = []
    writePanelState({ setItem: (key, value) => written.push([key, value]) }, { rootsCollapsed: true, detailsCollapsed: false })
    assert.deepEqual(written, [['deptrail.panels', JSON.stringify({ rootsCollapsed: true, detailsCollapsed: false })]])
  })

  it('round-trips through readPanelState', () => {
    let saved: string | null = null
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value
      },
    }
    writePanelState(storage, { rootsCollapsed: false, detailsCollapsed: true })
    assert.deepEqual(readPanelState(storage, 1600), { rootsCollapsed: false, detailsCollapsed: true })
  })

  it('ignores a missing or throwing storage', () => {
    assert.doesNotThrow(() => writePanelState(undefined, { rootsCollapsed: true, detailsCollapsed: true }))
    assert.doesNotThrow(() => writePanelState(throwingStorage, { rootsCollapsed: true, detailsCollapsed: true }))
  })
})
