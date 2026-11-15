import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpClient, HttpError } from '../src/enrich/http.ts'
import {
  CORGI_ACCEPT,
  failureReason,
  fetchPackageMeta,
  isPackageMeta,
  metaCovers,
  packumentUrl,
  type RegistryFetchRequest,
} from '../src/enrich/registry-client.ts'
import type { PackageMeta } from '../src/enrich/types.ts'
import { startFakeServer, type FakeServer } from './helpers/fake-http.ts'

const servers: FakeServer[] = []

async function serve(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler)
  servers.push(server)
  return server
}

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
})

const client = createHttpClient({ userAgent: 'deptrail-test/1.0', sleep: async () => {} })

function requestFor(server: FakeServer, overrides: Partial<RegistryFetchRequest> = {}): RegistryFetchRequest {
  return {
    registry: server.url,
    name: 'lodash',
    versionsInUse: [],
    authorizationFor: () => undefined,
    ...overrides,
  }
}

describe('packumentUrl', () => {
  it('appends a slash and encodes the scope separator', () => {
    assert.equal(packumentUrl('https://registry.npmjs.org', '@acme/ui'), 'https://registry.npmjs.org/@acme%2fui')
    assert.equal(packumentUrl('https://r.example/npm/all/', 'lodash'), 'https://r.example/npm/all/lodash')
  })

  it('keeps a name from a lockfile inside one path segment below the registry', () => {
    const base = 'https://r.example/npm/all/'
    for (const name of ['@a/b/../../x', 'x/../../admin', '..', '.', '@../..', 'a?b#c', 'a b']) {
      const url = new URL(packumentUrl(base, name))
      assert.equal(url.origin, 'https://r.example', name)
      assert.ok(url.pathname.startsWith('/npm/all/'), `${name} gave ${url.pathname}`)
      assert.equal(url.pathname.slice('/npm/all/'.length).includes('/'), false, `${name} gave ${url.pathname}`)
      assert.equal(url.search, '', name)
      assert.equal(url.hash, '', name)
    }
  })
})

describe('fetchPackageMeta requests', () => {
  it('requests the encoded scoped path with the corgi accept header', async () => {
    const server = await serve(() => ({ body: { versions: {} } }))
    await fetchPackageMeta(client, requestFor(server, { name: '@acme/ui' }))
    assert.equal(server.requests[0].path, '/@acme%2fui')
    assert.equal(server.requests[0].headers.accept, CORGI_ACCEPT)
  })

  it('sends the etag as If-None-Match', async () => {
    const server = await serve(() => ({ status: 304 }))
    const result = await fetchPackageMeta(client, requestFor(server, { etag: '"abc"' }))
    assert.equal(server.requests[0].headers['if-none-match'], '"abc"')
    assert.deepEqual(result, { state: 'not-modified' })
  })

  it('keeps the registry path prefix', async () => {
    const server = await serve(() => ({ body: { versions: {} } }))
    await fetchPackageMeta(client, requestFor(server, { registry: `${server.url}/npm/all/` }))
    assert.equal(server.requests[0].path, '/npm/all/lodash')
  })

  it('sends Authorization only when the lookup returns a value', async () => {
    const server = await serve(() => ({ body: { versions: {} } }))
    await fetchPackageMeta(client, requestFor(server))
    await fetchPackageMeta(client, requestFor(server, { authorizationFor: () => 'Bearer t' }))
    assert.equal(server.requests[0].headers.authorization, undefined)
    assert.equal(server.requests[1].headers.authorization, 'Bearer t')
  })
})

describe('fetchPackageMeta results', () => {
  it('keeps manifests only for in-use versions', async () => {
    const versions = Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`1.${index}.0`, {}]))
    versions['2.0.0'] = {}
    const server = await serve(() => ({ body: { 'dist-tags': { latest: '2.0.0' }, versions } }))
    const result = await fetchPackageMeta(client, requestFor(server, { versionsInUse: ['2.0.0'] }))
    assert.equal(result.state, 'ok')
    if (result.state !== 'ok') return
    assert.deepEqual(Object.keys(result.meta.manifests), ['2.0.0'])
    assert.equal(result.meta.versions.length, 3001)
    assert.deepEqual(result.meta.distTags, { latest: '2.0.0' })
  })

  it('keeps a manifest for every version when all manifests are requested', async () => {
    const server = await serve(() => ({
      body: {
        versions: {
          '1.0.0': { dependencies: { a: '^1' } },
          '1.1.0': { dependencies: { a: '^1.1' } },
          '2.0.0': { peerDependencies: { b: '^2' } },
        },
      },
    }))
    const result = await fetchPackageMeta(client, requestFor(server, { versionsInUse: ['1.0.0'], allManifests: true }))
    assert.equal(result.state, 'ok')
    if (result.state !== 'ok') return
    assert.deepEqual(result.meta.manifests, { '1.0.0': { a: '^1' }, '1.1.0': { a: '^1.1' }, '2.0.0': { b: '^2' } })
  })

  it('merges dependency fields so dependencies win', async () => {
    const server = await serve(() => ({
      body: {
        versions: {
          '1.0.0': {
            dependencies: { a: '^1' },
            optionalDependencies: { a: '^2', b: '^3' },
            peerDependencies: { c: '^4' },
          },
        },
      },
    }))
    const result = await fetchPackageMeta(client, requestFor(server, { versionsInUse: ['1.0.0'] }))
    assert.equal(result.state, 'ok')
    if (result.state !== 'ok') return
    assert.deepEqual(result.meta.manifests['1.0.0'], { a: '^1', b: '^3', c: '^4' })
  })

  it('records only deprecated versions and the etag', async () => {
    const server = await serve(() => ({
      headers: { etag: '"v1"' },
      body: { versions: { '1.0.0': { deprecated: 'use 2' }, '2.0.0': {}, '3.0.0': { deprecated: true } } },
    }))
    const result = await fetchPackageMeta(client, requestFor(server))
    assert.equal(result.state, 'ok')
    if (result.state !== 'ok') return
    assert.deepEqual(result.meta.deprecated, { '1.0.0': 'use 2' })
    assert.equal(result.etag, '"v1"')
  })

  it('maps 404 to not-found', async () => {
    const server = await serve(() => ({ status: 404 }))
    assert.deepEqual(await fetchPackageMeta(client, requestFor(server)), { state: 'not-found' })
  })

  it('maps 401 to rejected credentials', async () => {
    const server = await serve(() => ({ status: 401 }))
    assert.deepEqual(await fetchPackageMeta(client, requestFor(server)), {
      state: 'failed',
      reason: 'rejected credentials (401)',
      authRejected: true,
    })
  })

  it('maps 500 to an HTTP status reason', async () => {
    const server = await serve(() => ({ status: 500 }))
    assert.deepEqual(await fetchPackageMeta(client, requestFor(server)), {
      state: 'failed',
      reason: 'responded with HTTP 500',
      authRejected: false,
    })
  })

  it('reports invalid JSON and missing versions as malformed', async () => {
    const invalid = await serve(() => ({ body: 'not json' }))
    const missing = await serve(() => ({ body: { name: 'x' } }))
    for (const server of [invalid, missing]) {
      assert.deepEqual(await fetchPackageMeta(client, requestFor(server)), {
        state: 'failed',
        reason: 'returned a malformed packument',
        authRejected: false,
      })
    }
  })

  it('reports an unreachable registry', async () => {
    const server = await startFakeServer(() => ({}))
    await server.close()
    assert.deepEqual(await fetchPackageMeta(client, requestFor(server)), {
      state: 'failed',
      reason: 'is unreachable',
      authRejected: false,
    })
  })
})

describe('metaCovers and isPackageMeta', () => {
  const meta: PackageMeta = {
    distTags: {},
    versions: ['1.0.0', '2.0.0'],
    deprecated: {},
    manifests: { '1.0.0': {} },
  }

  it('ignores in-use versions missing from versions', () => {
    assert.equal(metaCovers(meta, ['1.0.0', '9.9.9']), true)
    assert.equal(metaCovers(meta, ['2.0.0']), false)
  })

  it('rejects an object without manifests', () => {
    assert.equal(isPackageMeta(meta), true)
    assert.equal(isPackageMeta({ distTags: {}, versions: [], deprecated: {} }), false)
    assert.equal(isPackageMeta(null), false)
  })
})

describe('failureReason', () => {
  it('maps every http error kind', () => {
    assert.equal(failureReason(new HttpError('timeout')), 'did not respond within 30 s')
    assert.equal(failureReason(new HttpError('network')), 'is unreachable')
    assert.equal(failureReason(new HttpError('too-large')), 'returned more than 50 MB')
    assert.equal(failureReason(new HttpError('redirects')), 'redirected too many times')
    assert.equal(failureReason(new HttpError('aborted')), 'request was canceled')
  })
})
