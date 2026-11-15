import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import type { DepKind } from '../src/model.ts'
import { ApiError, type DecorationsResponse, type DeptrailApi } from '../ui/src/api.ts'
import { useDecorations } from '../ui/src/decorations.ts'

type Answer = { resolve(response: DecorationsResponse): void; reject(error: Error): void }

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setImmediate(resolve))
}

function setup(initialRoot: string | undefined) {
  const answers: Answer[] = []
  const api = {
    decorations: () =>
      new Promise<DecorationsResponse>((resolve, reject) => {
        answers.push({ resolve, reject })
      }),
  } as unknown as DeptrailApi
  const root = ref<string | undefined>(initialRoot)
  const kinds = ref<DepKind[]>(['prod', 'dev', 'optional', 'peer'])
  const revision = ref('r1')
  const scope = effectScope()
  const decorations = scope.run(() => useDecorations(api, root, kinds, revision))!
  return { answers, root, revision, decorations, scope }
}

describe('useDecorations', () => {
  it('names the root whose decorations are loaded only after they arrive', async () => {
    const { answers, decorations, scope } = setup('shop')
    assert.equal(decorations.loadedRoot.value, undefined)
    answers[0].resolve({ revision: 1, nodes: { 'child-lib@1.0.0': { vuln: { severity: 'high', count: 1 } } } })
    await settle()
    assert.equal(decorations.loadedRoot.value, 'shop')
    scope.stop()
  })

  it('forgets the loaded root as soon as the root changes and keeps it through a reload of the same root', async () => {
    const { answers, root, revision, decorations, scope } = setup('shop')
    answers[0].resolve({ revision: 1, nodes: {} })
    await settle()
    revision.value = 'r2'
    await settle()
    assert.equal(decorations.loadedRoot.value, 'shop')
    root.value = 'shop-npm'
    await settle()
    assert.equal(decorations.loadedRoot.value, undefined)
    answers[2].resolve({ revision: 1, nodes: {} })
    await settle()
    assert.equal(decorations.loadedRoot.value, 'shop-npm')
    scope.stop()
  })

  it('forgets the loaded root when a reload of the same root fails, so old decorations cannot vouch for it', async () => {
    const { answers, revision, decorations, scope } = setup('shop')
    answers[0].resolve({ revision: 1, nodes: {} })
    await settle()
    assert.equal(decorations.loadedRoot.value, 'shop')
    revision.value = 'r2'
    await settle()
    answers[1].reject(new Error('Server error'))
    await settle()
    assert.equal(decorations.loadedRoot.value, undefined)
    revision.value = 'r3'
    await settle()
    answers[2].resolve({ revision: 3, nodes: {} })
    await settle()
    assert.equal(decorations.loadedRoot.value, 'shop')
    scope.stop()
  })

  it('drops the node decorations when a reload of the same root fails', async () => {
    const { answers, revision, decorations, scope } = setup('shop')
    answers[0].resolve({ revision: 1, nodes: { 'child-lib@1.0.0': { vuln: { severity: 'high', count: 1 } } } })
    await settle()
    assert.deepEqual(Object.keys(decorations.nodes.value), ['child-lib@1.0.0'])
    revision.value = 'r2'
    await settle()
    answers[1].reject(new Error('Server error'))
    await settle()
    assert.deepEqual(decorations.nodes.value, {})
    scope.stop()
  })

  it('keeps the node decorations when a reload is refused because the root is busy', async () => {
    const { answers, revision, decorations, scope } = setup('shop')
    answers[0].resolve({ revision: 1, nodes: { 'child-lib@1.0.0': { vuln: { severity: 'high', count: 1 } } } })
    await settle()
    revision.value = 'r2'
    await settle()
    answers[1].reject(new ApiError(409, 'shop is still scanning'))
    await settle()
    assert.deepEqual(Object.keys(decorations.nodes.value), ['child-lib@1.0.0'])
    scope.stop()
  })

  it('keeps the loaded root when a reload is refused because the root is busy', async () => {
    const { answers, revision, decorations, scope } = setup('shop')
    answers[0].resolve({ revision: 1, nodes: {} })
    await settle()
    revision.value = 'r2'
    await settle()
    answers[1].reject(new ApiError(409, 'shop is still scanning'))
    await settle()
    assert.equal(decorations.loadedRoot.value, 'shop')
    assert.equal(decorations.error.value, null)
    scope.stop()
  })

  it('leaves the root unloaded when the request fails or there is no root', async () => {
    const { answers, root, decorations, scope } = setup('shop')
    answers[0].reject(new Error('Server error'))
    await settle()
    assert.equal(decorations.loadedRoot.value, undefined)
    assert.match(decorations.error.value ?? '', /Server error/)
    root.value = undefined
    await settle()
    assert.equal(decorations.loadedRoot.value, undefined)
    scope.stop()
  })
})
