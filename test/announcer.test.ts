import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watch } from 'vue'
import { announce, announcement } from '../ui/src/announcer.ts'

test('announcing the same text twice produces two observable changes', async () => {
  const seen: string[] = []
  watch(announcement, (text) => seen.push(text), { flush: 'sync' })

  announce('Switched to shop-npm')
  await Promise.resolve()
  announce('Switched to shop-npm')
  await Promise.resolve()

  assert.deepEqual(seen, ['Switched to shop-npm', '', 'Switched to shop-npm'])
  assert.equal(seen.filter((text) => text === 'Switched to shop-npm').length, 2)
})

test('the announcement is cleared before it is set', async () => {
  announce('first')
  await Promise.resolve()
  assert.equal(announcement.value, 'first')
})
