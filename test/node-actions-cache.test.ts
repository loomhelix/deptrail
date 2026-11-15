import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { NodeActions } from '../src/actions/types.ts'
import type { DepKind } from '../src/model.ts'
import { createNodeActionsCache, type NodeActionsKey } from '../ui/src/node-actions-cache.ts'

type Call = { root: string; node: string; kinds: DepKind[]; resolve(actions: NodeActions): void; reject(error: Error): void }

function fakeApi() {
  const calls: Call[] = []
  return {
    calls,
    nodeActions(root: string, node: string, kinds: DepKind[]): Promise<NodeActions> {
      return new Promise((resolve, reject) => {
        calls.push({ root, node, kinds, resolve, reject })
      })
    },
  }
}

function keyFor(node: string, overrides: Partial<NodeActionsKey> = {}): NodeActionsKey {
  return { root: 'shop', node, kinds: ['prod'], revision: 'r1', ...overrides }
}

const answer: NodeActions = { unavailable: 'nothing to do' }

describe('createNodeActionsCache', () => {
  it('shares one request between concurrent gets of the same key', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    const first = cache.get(keyFor('a'))
    const second = cache.get(keyFor('a'))
    assert.equal(api.calls.length, 1)
    api.calls[0].resolve(answer)
    assert.deepEqual(await first, answer)
    assert.deepEqual(await second, answer)
  })

  it('serves a settled answer from memory', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    const pending = cache.get(keyFor('a'))
    api.calls[0].resolve(answer)
    await pending
    assert.deepEqual(await cache.get(keyFor('a')), answer)
    assert.equal(api.calls.length, 1)
  })

  it('peeks only settled answers', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    assert.equal(cache.peek(keyFor('a')), undefined)
    const pending = cache.get(keyFor('a'))
    assert.equal(cache.peek(keyFor('a')), undefined)
    api.calls[0].resolve(answer)
    await pending
    assert.deepEqual(cache.peek(keyFor('a')), answer)
  })

  it('does not cache a failed request', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    const failing = cache.get(keyFor('a'))
    api.calls[0].reject(new Error('boom'))
    await assert.rejects(failing, /boom/)
    assert.equal(cache.peek(keyFor('a')), undefined)
    const retry = cache.get(keyFor('a'))
    assert.equal(api.calls.length, 2)
    api.calls[1].resolve(answer)
    assert.deepEqual(await retry, answer)
  })

  it('makes a new request for a new revision', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    void cache.get(keyFor('a'))
    void cache.get(keyFor('a', { revision: 'r2' }))
    assert.equal(api.calls.length, 2)
  })

  it('keeps only the answer of the newest revision of a key', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    const other = cache.get(keyFor('b'))
    const old = cache.get(keyFor('a'))
    api.calls[0].resolve(answer)
    api.calls[1].resolve(answer)
    await Promise.all([other, old])
    const newer = cache.get(keyFor('a', { revision: 'r2' }))
    api.calls[2].resolve(answer)
    await newer
    assert.equal(cache.peek(keyFor('a')), undefined)
    assert.deepEqual(cache.peek(keyFor('a', { revision: 'r2' })), answer)
    assert.deepEqual(cache.peek(keyFor('b')), answer)
  })

  it('treats the same kinds in any order as one key', () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    void cache.get(keyFor('a', { kinds: ['dev', 'prod'] }))
    void cache.get(keyFor('a', { kinds: ['prod', 'dev'] }))
    assert.equal(api.calls.length, 1)
    assert.deepEqual(api.calls[0].kinds, ['prod', 'dev'])
  })

  it('separates keys by root, node and kinds', () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    void cache.get(keyFor('a'))
    void cache.get(keyFor('b'))
    void cache.get(keyFor('a', { root: 'docs' }))
    void cache.get(keyFor('a', { kinds: ['prod', 'dev'] }))
    assert.equal(api.calls.length, 4)
  })

  it('starts at most four requests and the fifth after one settles', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api)
    const answers = ['a', 'b', 'c', 'd', 'e'].map((node) => cache.get(keyFor(node)))
    assert.equal(api.calls.length, 4)
    api.calls[1].resolve(answer)
    await answers[1]
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(api.calls.length, 5)
    assert.equal(api.calls[4].node, 'e')
  })

  it('frees a slot when a request fails', async () => {
    const api = fakeApi()
    const cache = createNodeActionsCache(api, 1)
    const first = cache.get(keyFor('a'))
    void cache.get(keyFor('b'))
    assert.equal(api.calls.length, 1)
    api.calls[0].reject(new Error('boom'))
    await assert.rejects(first)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(api.calls.length, 2)
  })
})
