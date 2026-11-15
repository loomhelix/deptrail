import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import type { ChangeItem, ChangesResponse } from '../src/actions/types.ts'
import type { RootSummary } from '../ui/src/api.ts'
import { changeState, itemFor, itemsTouching, useChangesIndex, type ChangesByRoot } from '../ui/src/changes-index.ts'

const fixItem: ChangeItem = {
  id: 'one',
  goal: { kind: 'fix', name: 'lodash', version: '4.17.20', advisoryIds: [], severity: 'high' },
  choice: 'chain',
  steps: [],
  warnings: [],
}
const updateItem: ChangeItem = {
  id: 'two',
  goal: { kind: 'update', name: 'react', importers: [], target: '19.0.0' },
  choice: 'version',
  steps: [],
  warnings: [],
}
const index: ChangesByRoot = new Map([['shop', [fixItem, updateItem]]])

function rootWith(id: string, changeCount: number): RootSummary {
  return { id, actions: { changeCount } } as unknown as RootSummary
}

function response(items: ChangeItem[]): ChangesResponse {
  return { items, revertable: false, installByDefault: false }
}

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setImmediate(resolve))
}

describe('itemFor', () => {
  it('matches a fix goal by name and version', () => {
    assert.equal(itemFor(index, 'shop', { kind: 'fix', name: 'lodash', version: '4.17.20' }), fixItem)
    assert.equal(itemFor(index, 'shop', { kind: 'fix', name: 'lodash', version: '4.17.21' }), undefined)
  })

  it('matches an update goal by name only', () => {
    assert.equal(itemFor(index, 'shop', { kind: 'update', name: 'react' }), updateItem)
    assert.equal(itemFor(index, 'shop', { kind: 'update', name: 'lodash' }), undefined)
  })

  it('finds nothing in another root', () => {
    assert.equal(itemFor(index, 'docs', { kind: 'update', name: 'react' }), undefined)
  })
})

describe('itemsTouching', () => {
  const raiseParent: ChangeItem = {
    id: 'raise',
    goal: { kind: 'fix', name: 'child-lib', version: '1.0.0', advisoryIds: [], severity: 'high' },
    choice: 'chain',
    steps: [
      { kind: 'relock', name: 'child-lib', from: '1.0.0', to: '1.0.1', reason: '' },
      { kind: 'set-range', importer: 'importer:web', dependency: 'parent-lib', field: 'dependencies', place: 'manifest', from: '1.0.0', to: '1.1.0', reason: '' },
    ],
    warnings: [],
  }
  const updateApi: ChangeItem = {
    id: 'update',
    goal: { kind: 'update', name: 'toolkit', importers: ['importer:api'], target: '2.1.0' },
    choice: 'wanted',
    steps: [{ kind: 'relock', name: 'toolkit', from: '2.0.0', to: '2.1.0', reason: '' }],
    warnings: [],
  }

  it('keeps the changes that edit or update the workspace package', () => {
    assert.deepEqual(itemsTouching([raiseParent, updateApi, fixItem], 'importer:web'), [raiseParent])
    assert.deepEqual(itemsTouching([raiseParent, updateApi, fixItem], 'importer:api'), [updateApi])
    assert.deepEqual(itemsTouching([], 'importer:api'), [])
  })
})

describe('changeState', () => {
  it('is absent without an item', () => {
    assert.deepEqual(changeState(undefined, 'chain'), { kind: 'absent' })
  })

  it('is same for an equal choice', () => {
    assert.deepEqual(changeState(fixItem, 'chain'), { kind: 'same', item: fixItem })
  })

  it('is different for another choice', () => {
    assert.deepEqual(changeState(fixItem, 'override'), { kind: 'different', item: fixItem })
  })

  it('compares the update target for a version choice', () => {
    assert.deepEqual(changeState(updateItem, 'version', '19.0.0'), { kind: 'same', item: updateItem })
    assert.deepEqual(changeState(updateItem, 'version', '18.3.1'), { kind: 'different', item: updateItem })
  })
})

describe('useChangesIndex', () => {
  function setup(initialRoots: RootSummary[]) {
    const requested: string[] = []
    const answers = new Map<string, ChangeItem[]>([['shop', [fixItem]], ['docs', [updateItem]]])
    const api = {
      async changes(root: string): Promise<ChangesResponse> {
        requested.push(root)
        return response(answers.get(root) ?? [])
      },
    }
    const roots = ref<readonly RootSummary[]>(initialRoots)
    const revision = ref('r1')
    const scope = effectScope()
    const changes = scope.run(() => useChangesIndex(api, roots, revision))!
    return { requested, answers, roots, revision, changes, scope }
  }

  it('loads only roots with changes', async () => {
    const { requested, changes, scope } = setup([rootWith('shop', 1), rootWith('docs', 0)])
    await settle()
    assert.deepEqual(requested, ['shop'])
    assert.deepEqual([...changes.index.value.keys()], ['shop'])
    scope.stop()
  })

  it('reloads when a change count changes and clears a root that dropped to zero', async () => {
    const { requested, roots, changes, scope } = setup([rootWith('shop', 1), rootWith('docs', 0)])
    await settle()
    roots.value = [rootWith('shop', 0), rootWith('docs', 1)]
    await settle()
    assert.deepEqual(requested, ['shop', 'docs'])
    assert.deepEqual([...changes.index.value.keys()], ['docs'])
    scope.stop()
  })

  it('reloads when the revision changes', async () => {
    const { requested, revision, scope } = setup([rootWith('shop', 1)])
    await settle()
    revision.value = 'r2'
    await settle()
    assert.deepEqual(requested, ['shop', 'shop'])
    scope.stop()
  })

  it('does not reload for unrelated root updates', async () => {
    const { requested, roots, scope } = setup([rootWith('shop', 1)])
    await settle()
    roots.value = [rootWith('shop', 1)]
    await settle()
    assert.deepEqual(requested, ['shop'])
    scope.stop()
  })

  it('lets a caller await a reload', async () => {
    const { answers, changes, scope } = setup([rootWith('shop', 1)])
    await settle()
    answers.set('shop', [fixItem, updateItem])
    await changes.reload()
    assert.equal(changes.index.value.get('shop')?.length, 2)
    scope.stop()
  })

  it('loads a root the caller names before the summary counts its changes', async () => {
    const { requested, changes, scope } = setup([rootWith('shop', 0), rootWith('docs', 0)])
    await settle()
    await changes.reload('docs')
    assert.deepEqual(requested, ['docs'])
    assert.deepEqual([...changes.index.value.keys()], ['docs'])
    scope.stop()
  })

  it('loads every root the caller names', async () => {
    const { requested, changes, scope } = setup([rootWith('shop', 0), rootWith('docs', 0)])
    await settle()
    await changes.reload('shop', 'docs')
    assert.deepEqual(requested, ['shop', 'docs'])
    assert.deepEqual([...changes.index.value.keys()], ['shop', 'docs'])
    scope.stop()
  })

  it('keeps the previous items of a root whose request fails', async () => {
    let failing = false
    const api = {
      async changes(): Promise<ChangesResponse> {
        if (failing) throw new Error('offline')
        return response([fixItem])
      },
    }
    const scope = effectScope()
    const changes = scope.run(() => useChangesIndex(api, ref([rootWith('shop', 1)]), ref('r1')))!
    await settle()
    failing = true
    await changes.reload()
    assert.equal(changes.index.value.get('shop')?.length, 1)
    scope.stop()
  })
})
