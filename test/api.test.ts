import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, createApi, setApiSource } from '../ui/src/api.ts'

type RecordedRequest = { url: string; method: string }
type SentRequest = { url: string; method: string; contentType: string | null; body: unknown }

const ALL_KINDS = ['prod', 'dev', 'optional', 'peer'] as const

function fakeFetch(status: number, body: unknown, requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
}

function sendingFetch(status: number, body: unknown, requests: SentRequest[]): typeof fetch {
  return async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('Content-Type'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
}

describe('api client source', () => {
  const COMMIT = 'a'.repeat(40)

  it('prefixes per-source paths with the commit', async () => {
    const requests: RecordedRequest[] = []
    const api = createApi(fakeFetch(200, {}, requests))
    setApiSource(COMMIT)
    try {
      await api.scan()
      await api.search('semver')
      await api.duplicates('shop')
      await api.issueRows(undefined, [...ALL_KINDS])
      await api.children('shop', 'a@1.0.0', 1, [...ALL_KINDS])
      await api.decorations('shop', [...ALL_KINDS])
      await api.changes('shop')
      await api.job('job-1', 0)
      await api.refreshEnrichment()
      await api.rescan()
      await api.git()
      await api.compare('work', COMMIT)
      await api.openSource({ ref: 'refs/heads/main' })
    } finally {
      setApiSource(undefined)
    }
    await api.scan()
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      [
        `GET /api/commits/${COMMIT}/scan`,
        `GET /api/commits/${COMMIT}/search?q=semver`,
        `GET /api/commits/${COMMIT}/duplicates?root=shop`,
        `GET /api/commits/${COMMIT}/issues?groupBy=package`,
        `GET /api/commits/${COMMIT}/roots/shop/nodes/a%401.0.0/children?depth=1`,
        `GET /api/commits/${COMMIT}/roots/shop/decorations`,
        `GET /api/commits/${COMMIT}/roots/shop/changes`,
        'GET /api/jobs/job-1?since=0',
        'POST /api/enrichment/refresh',
        'POST /api/rescan',
        'GET /api/git',
        `GET /api/compare?base=work&target=${COMMIT}`,
        'POST /api/sources',
        'GET /api/scan',
      ],
    )
  })

  it('reports a dropped source to the handler and still rejects', async () => {
    const drops: string[] = []
    const requests: RecordedRequest[] = []
    setApiSource(COMMIT, () => drops.push('dropped'))
    try {
      const dropped = createApi(fakeFetch(404, { error: `Unknown source ${COMMIT}` }, requests))
      await assert.rejects(dropped.scan(), (error: unknown) => error instanceof ApiError && error.status === 404)
      await assert.rejects(dropped.compare('work', COMMIT), ApiError)
      const otherSource = createApi(fakeFetch(404, { error: `Unknown source ${'b'.repeat(40)}` }, requests))
      await assert.rejects(otherSource.compare('b'.repeat(40), COMMIT), ApiError)
      const missingNode = createApi(fakeFetch(404, { error: 'Unknown node a@1.0.0' }, requests))
      await assert.rejects(missingNode.children('shop', 'a@1.0.0', 1, [...ALL_KINDS]), ApiError)
    } finally {
      setApiSource(undefined)
    }
    assert.deepEqual(drops, ['dropped', 'dropped'])
  })
})

describe('api client', () => {
  it('encodes the repository-root root id as a tilde segment and node ids as components', async () => {
    const requests: RecordedRequest[] = []
    const api = createApi(fakeFetch(200, { rows: [] }, requests))
    await api.children('.', '@vue/shared@3.5.13', 1, ['prod', 'dev', 'optional', 'peer'])
    await api.dependents('legacy/admin', 'semver@6.3.1', 50, ['prod', 'peer'])
    assert.deepEqual(requests.map((request) => request.url), [
      '/api/roots/~/nodes/%40vue%2Fshared%403.5.13/children?depth=1',
      '/api/roots/legacy%2Fadmin/nodes/semver%406.3.1/dependents?depth=50&kinds=prod%2Cpeer',
    ])
  })

  it('builds subgraph, search, duplicates and importers requests', async () => {
    const requests: RecordedRequest[] = []
    const api = createApi(fakeFetch(200, [], requests))
    await api.subgraph('npm-package', 'semver@5.7.2', 3, 1, 300, ['prod'])
    await api.search('@vue/')
    await api.duplicates()
    await api.duplicates('.')
    await api.importers('~')
    assert.deepEqual(requests.map((request) => request.url), [
      '/api/roots/npm-package/nodes/semver%405.7.2/subgraph?up=3&down=1&limit=300&kinds=prod',
      '/api/search?q=%40vue%2F',
      '/api/duplicates',
      '/api/duplicates?root=.',
      '/api/roots/%7E/importers',
    ])
  })

  it('posts resolve and rescan and accepts 202', async () => {
    const requests: RecordedRequest[] = []
    const api = createApi(fakeFetch(202, { accepted: true }, requests))
    await api.resolve('scripts/release')
    await api.rescan()
    assert.deepEqual(requests, [
      { url: '/api/roots/scripts%2Frelease/resolve', method: 'POST' },
      { url: '/api/rescan', method: 'POST' },
    ])
  })

  it('builds the enrichment requests', async () => {
    const requests: RecordedRequest[] = []
    const api = createApi(fakeFetch(200, {}, requests))
    await api.decorations('legacy/admin', ['prod', 'dev', 'optional', 'peer'])
    await api.decorations('.', ['prod', 'peer'])
    await api.issueRows(undefined, ['prod', 'dev', 'optional', 'peer'])
    await api.issueGroups('npm-package', ['prod'])
    await api.insight('npm-package', '@vue/shared@3.5.13', ['prod', 'dev', 'optional', 'peer'])
    assert.deepEqual(requests.map((request) => request.url), [
      '/api/roots/legacy%2Fadmin/decorations',
      '/api/roots/~/decorations?kinds=prod%2Cpeer',
      '/api/issues?groupBy=package',
      '/api/issues?root=npm-package&kinds=prod&groupBy=direct',
      '/api/roots/npm-package/nodes/%40vue%2Fshared%403.5.13/insight',
    ])
  })

  it('posts the enrichment refresh', async () => {
    const requests: RecordedRequest[] = []
    const api = createApi(fakeFetch(202, { accepted: true }, requests))
    await api.refreshEnrichment()
    assert.deepEqual(requests, [{ url: '/api/enrichment/refresh', method: 'POST' }])
  })

  it('gets node actions, the change set, a preview diff and a job without a body', async () => {
    const requests: SentRequest[] = []
    const api = createApi(sendingFetch(200, {}, requests))
    await api.nodeActions('legacy/admin', 'semver@6.3.1', ['prod', 'peer'])
    await api.nodeActions('.', '@vue/shared@3.5.13', [...ALL_KINDS])
    await api.changes('shop')
    await api.previewFileDiff('shop', 2)
    await api.job('job-1', 0)
    await api.job('job/2', 12)
    assert.deepEqual(requests, [
      { url: '/api/roots/legacy%2Fadmin/nodes/semver%406.3.1/actions?kinds=prod%2Cpeer', method: 'GET', contentType: null, body: undefined },
      { url: '/api/roots/~/nodes/%40vue%2Fshared%403.5.13/actions', method: 'GET', contentType: null, body: undefined },
      { url: '/api/roots/shop/changes', method: 'GET', contentType: null, body: undefined },
      { url: '/api/roots/shop/preview/files/2/diff', method: 'GET', contentType: null, body: undefined },
      { url: '/api/jobs/job-1?since=0', method: 'GET', contentType: null, body: undefined },
      { url: '/api/jobs/job%2F2?since=12', method: 'GET', contentType: null, body: undefined },
    ])
  })

  it('posts a change as JSON and returns the new item', async () => {
    const requests: SentRequest[] = []
    const item = { id: 'item-1', goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '3.0.0' }, choice: 'latest', steps: [], warnings: [] }
    const api = createApi(sendingFetch(201, item, requests))
    const added = await api.addChange('legacy/admin', { nodeId: 'toolkit@2.0.0', choice: 'latest', importers: ['importer:web'], kinds: ['prod'] })
    assert.deepEqual(added, item)
    assert.deepEqual(requests, [
      {
        url: '/api/roots/legacy%2Fadmin/changes',
        method: 'POST',
        contentType: 'application/json',
        body: { nodeId: 'toolkit@2.0.0', choice: 'latest', importers: ['importer:web'], kinds: ['prod'] },
      },
    ])
  })

  it('replaces a change with PUT and returns the new item', async () => {
    const requests: SentRequest[] = []
    const item = { id: 'item-2', goal: { kind: 'update', name: 'toolkit', importers: ['importer:web'], target: '3.1.0' }, choice: 'version', steps: [], warnings: [] }
    const api = createApi(sendingFetch(200, item, requests))
    const replaced = await api.replaceChange('legacy/admin', 'item/1', { nodeId: 'toolkit@2.0.0', choice: 'version', version: '3.1.0', importers: ['importer:web'] })
    assert.deepEqual(replaced, item)
    assert.deepEqual(requests, [
      {
        url: '/api/roots/legacy%2Fadmin/changes/item%2F1',
        method: 'PUT',
        contentType: 'application/json',
        body: { nodeId: 'toolkit@2.0.0', choice: 'version', version: '3.1.0', importers: ['importer:web'] },
      },
    ])
  })

  it('restores the cleared changes without a body and returns the result', async () => {
    const requests: SentRequest[] = []
    const result = { restored: 2, skipped: [{ name: 'Fix child-lib 1.0.0', reason: 'Fix child-lib 1.0.0 is already in the changes of shop' }] }
    const api = createApi(sendingFetch(200, result, requests))
    assert.deepEqual(await api.restoreCleared('.'), result)
    assert.deepEqual(requests, [{ url: '/api/roots/~/changes/restore-cleared', method: 'POST', contentType: null, body: undefined }])
  })

  it('starts the recommended, preview, apply and revert jobs and returns their ids', async () => {
    const requests: SentRequest[] = []
    const api = createApi(sendingFetch(202, { jobId: 'job-7' }, requests))
    assert.deepEqual(await api.addRecommended('shop', ['prod', 'dev']), { jobId: 'job-7' })
    await api.addRecommended('.', [...ALL_KINDS])
    assert.deepEqual(await api.preview('shop'), { jobId: 'job-7' })
    assert.deepEqual(await api.apply('shop', 'preview-1', true), { jobId: 'job-7' })
    assert.deepEqual(await api.revert('shop'), { jobId: 'job-7' })
    assert.deepEqual(requests, [
      { url: '/api/roots/shop/changes/recommended', method: 'POST', contentType: 'application/json', body: { kinds: ['prod', 'dev'] } },
      { url: '/api/roots/~/changes/recommended', method: 'POST', contentType: 'application/json', body: {} },
      { url: '/api/roots/shop/preview', method: 'POST', contentType: null, body: undefined },
      { url: '/api/roots/shop/apply', method: 'POST', contentType: 'application/json', body: { previewId: 'preview-1', install: true } },
      { url: '/api/roots/shop/revert', method: 'POST', contentType: null, body: undefined },
    ])
  })

  it('cancels a job', async () => {
    const requests: SentRequest[] = []
    const api = createApi(sendingFetch(202, { accepted: true }, requests))
    assert.equal(await api.cancelJob('job/1'), undefined)
    assert.deepEqual(requests, [{ url: '/api/jobs/job%2F1/cancel', method: 'POST', contentType: null, body: undefined }])
  })

  it('deletes one change and the whole change set and accepts 204', async () => {
    const requests: SentRequest[] = []
    const api = createApi(sendingFetch(204, null, requests))
    assert.equal(await api.removeChange('legacy/admin', 'item/1'), undefined)
    assert.equal(await api.clearChanges('shop'), undefined)
    assert.deepEqual(requests, [
      { url: '/api/roots/legacy%2Fadmin/changes/item%2F1', method: 'DELETE', contentType: null, body: undefined },
      { url: '/api/roots/shop/changes', method: 'DELETE', contentType: null, body: undefined },
    ])
  })

  it('rejects a conflicting change with the server error text', async () => {
    const conflict = { error: 'Fix child-lib 1.0.0 is already in the changes of shop', conflictsWith: 'item-1' }
    const api = createApi(sendingFetch(409, conflict, []))
    await assert.rejects(api.addChange('shop', { nodeId: 'child-lib@1.0.0', choice: 'recommended' }), {
      name: 'ApiError',
      status: 409,
      message: 'Fix child-lib 1.0.0 is already in the changes of shop',
    })
  })

  it('throws an ApiError with the status and the server error text', async () => {
    const api = createApi(fakeFetch(409, { error: 'Root services/api is scanning' }, []))
    await assert.rejects(api.dependents('services/api', 'x@1.0.0', 1, ['prod']), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 409)
      assert.equal(error.message, 'Root services/api is scanning')
      return true
    })
  })

  it('falls back to a status message when the error body is not JSON', async () => {
    const api = createApi(async () => new Response('UI is not built', { status: 503, statusText: 'Service Unavailable' }))
    await assert.rejects(api.scan(), { name: 'ApiError', status: 503, message: 'Request failed with status 503' })
  })
})
