import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import type { DepKind } from '../src/model.ts'
import type { IssueRow } from '../src/query/issues.ts'
import type { DeptrailApi, IssueRowsResponse } from '../ui/src/api.ts'
import { useIssueRows } from '../ui/src/issue-rows.ts'

type Answer = { resolve(response: IssueRowsResponse): void; reject(error: Error): void }

const CHILD: IssueRow = { name: 'child-lib', version: '1.0.0', kinds: ['vulnerability'], vulnIds: [], locations: [] }

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setImmediate(resolve))
}

function setup() {
  const answers: Answer[] = []
  const api = {
    issueRows: () =>
      new Promise<IssueRowsResponse>((resolve, reject) => {
        answers.push({ resolve, reject })
      }),
  } as unknown as DeptrailApi
  const root = ref<string | undefined>('shop')
  const kinds = ref<DepKind[]>(['prod', 'dev', 'optional', 'peer'])
  const revision = ref<string | undefined>('r1')
  const scope = effectScope()
  const issues = scope.run(() => useIssueRows(api, root, kinds, revision))!
  return { answers, root, revision, issues, scope }
}

describe('useIssueRows', () => {
  it('sends no request until the revision is known, then one', async () => {
    const { answers, revision, issues, scope } = setup()
    answers.length = 0
    revision.value = undefined
    await settle()
    assert.equal(answers.length, 0)
    assert.equal(issues.rows.value, null)
    revision.value = 'r2'
    await settle()
    assert.equal(answers.length, 1)
    scope.stop()
  })

  it('has no rows and no count while the first request is open, then both', async () => {
    const { answers, issues, scope } = setup()
    assert.equal(issues.rows.value, null)
    assert.equal(issues.count.value, null)
    answers[0].resolve({ revision: 1, rows: [CHILD] })
    await settle()
    assert.deepEqual(issues.rows.value, [CHILD])
    assert.equal(issues.count.value, 1)
    assert.equal(issues.error.value, null)
    scope.stop()
  })

  it('reports a failed request, and clears the failure on the next success or when the scope changes', async () => {
    const { answers, root, revision, issues, scope } = setup()
    answers[0].reject(new Error('Server error'))
    await settle()
    assert.equal(issues.rows.value, null)
    assert.equal(issues.error.value, 'Server error')
    revision.value = 'r2'
    await settle()
    answers[1].resolve({ revision: 2, rows: [] })
    await settle()
    assert.equal(issues.error.value, null)
    answers.length = 0
    revision.value = 'r3'
    await settle()
    answers[0].reject(new Error('Server error'))
    await settle()
    root.value = 'shop-npm'
    await settle()
    assert.equal(issues.error.value, null)
    assert.equal(issues.rows.value, null)
    scope.stop()
  })
})
