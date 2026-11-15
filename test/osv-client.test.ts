import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpClient } from '../src/enrich/http.ts'
import {
  dedupeAdvisories,
  OSV_BATCH_SIZE,
  OSV_MAX_PAGES,
  queryPackageAdvisories,
  queryVersions,
  severityOf,
  toAdvisory,
  versionKey,
  type VersionQuery,
} from '../src/enrich/osv-client.ts'
import type { Advisory } from '../src/enrich/types.ts'
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

type BatchBody = { queries: { package: { name: string; ecosystem: string }; version: string; page_token?: string }[] }

function queriesFor(count: number): VersionQuery[] {
  return Array.from({ length: count }, (_, index) => ({ name: `pkg-${index}`, version: '1.0.0' }))
}

function advisoryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'GHSA-aaaa-bbbb-cccc',
    modified: '2024-01-01T00:00:00Z',
    summary: 'Bad things',
    aliases: ['CVE-2024-0001'],
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { ecosystem: 'npm', name: 'lodash' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
        versions: ['4.17.20'],
      },
    ],
    ...overrides,
  }
}

function advisory(overrides: Partial<Advisory>): Advisory {
  return {
    id: 'X',
    aliases: [],
    summary: '',
    severity: 'unknown',
    malicious: false,
    url: '',
    fixedIn: [],
    modified: '',
    affected: [],
    ...overrides,
  }
}

describe('versionKey', () => {
  it('joins name and version', () => {
    assert.equal(versionKey('@scope/pkg', '1.2.3'), '@scope/pkg@1.2.3')
  })
})

describe('queryVersions', () => {
  it('splits 2500 queries into batches of 1000, 1000 and 500 and maps results by position', async () => {
    const server = await serve((request) => {
      const body = JSON.parse(request.body) as BatchBody
      return {
        body: {
          results: body.queries.map((query) =>
            query.package.name === 'pkg-1500' ? { vulns: [{ id: 'GHSA-1', modified: 'm1' }] } : {},
          ),
        },
      }
    })
    const outcome = await queryVersions(client, server.url, queriesFor(2500))
    const sizes = server.requests.map((request) => (JSON.parse(request.body) as BatchBody).queries.length).sort((a, b) => a - b)
    assert.deepEqual(sizes, [500, 1000, 1000])
    assert.ok(server.requests.every((request) => request.path === '/v1/querybatch' && request.method === 'POST'))
    assert.equal(OSV_BATCH_SIZE, 1000)
    assert.deepEqual(outcome.matches.get('pkg-1500@1.0.0'), [{ id: 'GHSA-1', modified: 'm1' }])
    assert.deepEqual(outcome.matches.get('pkg-0@1.0.0'), [])
    assert.equal(outcome.matches.size, 2500)
    assert.equal(outcome.failed.size, 0)
  })

  it('sends the npm ecosystem with each query', async () => {
    const server = await serve(() => ({ body: { results: [{}] } }))
    await queryVersions(client, server.url, [{ name: 'lodash', version: '4.17.21' }])
    const body = JSON.parse(server.requests[0].body) as BatchBody
    assert.deepEqual(body.queries, [{ package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' }])
  })

  it('follows next_page_token with only the paged queries and merges vulns', async () => {
    const server = await serve((request) => {
      const body = JSON.parse(request.body) as BatchBody
      if (body.queries[0].page_token === undefined) {
        return {
          body: {
            results: [
              { vulns: [{ id: 'A', modified: 'ma' }], next_page_token: 'tok' },
              { vulns: [{ id: 'B', modified: 'mb' }] },
            ],
          },
        }
      }
      return { body: { results: [{ vulns: [{ id: 'C', modified: 'mc' }] }] } }
    })
    const outcome = await queryVersions(client, server.url, [
      { name: 'one', version: '1.0.0' },
      { name: 'two', version: '2.0.0' },
    ])
    assert.equal(server.requests.length, 2)
    const followUp = JSON.parse(server.requests[1].body) as BatchBody
    assert.deepEqual(followUp.queries, [
      { package: { name: 'one', ecosystem: 'npm' }, version: '1.0.0', page_token: 'tok' },
    ])
    assert.deepEqual(outcome.matches.get('one@1.0.0')?.map((ref) => ref.id), ['A', 'C'])
    assert.deepEqual(outcome.matches.get('two@2.0.0')?.map((ref) => ref.id), ['B'])
  })

  it('puts every key of a chunk answering 500 into failed', async () => {
    const server = await serve(() => ({ status: 500, body: 'boom' }))
    const outcome = await queryVersions(client, server.url, queriesFor(3))
    assert.equal(outcome.matches.size, 0)
    assert.deepEqual([...outcome.failed.keys()].sort(), ['pkg-0@1.0.0', 'pkg-1@1.0.0', 'pkg-2@1.0.0'])
    assert.equal(outcome.failed.get('pkg-0@1.0.0'), 'responded with HTTP 500')
  })

  it('fails only the chunk that failed', async () => {
    let calls = 0
    const server = await serve((request) => {
      calls += 1
      const body = JSON.parse(request.body) as BatchBody
      if (body.queries[0].package.name === 'pkg-0') return { status: 400, body: '{}' }
      return { body: { results: body.queries.map(() => ({})) } }
    })
    const outcome = await queryVersions(client, server.url, queriesFor(1500))
    assert.ok(calls >= 2)
    assert.equal(outcome.failed.size, 1000)
    assert.equal(outcome.matches.size, 500)
  })

  it('reports a malformed response as failed', async () => {
    const server = await serve(() => ({ body: { results: 'nope' } }))
    const outcome = await queryVersions(client, server.url, queriesFor(2))
    assert.equal(outcome.failed.size, 2)
    assert.equal(outcome.failed.get('pkg-0@1.0.0'), 'returned a malformed response')
  })

  it('reports an unreachable server with the transport reason', async () => {
    const server = await serve(() => ({ body: {} }))
    const url = server.url
    await server.close()
    const outcome = await queryVersions(client, url, queriesFor(1))
    assert.equal(outcome.failed.get('pkg-0@1.0.0'), 'is unreachable')
  })

  it('keeps keys such as __proto__ as ordinary entries', async () => {
    const server = await serve(() => ({ body: { results: [{ vulns: [{ id: 'A', modified: 'm' }] }] } }))
    const outcome = await queryVersions(client, server.url, [{ name: '__proto__', version: '1.0.0' }])
    assert.deepEqual(outcome.matches.get('__proto__@1.0.0'), [{ id: 'A', modified: 'm' }])
  })

  it('fails the chunk when the server always returns a fresh page token', async () => {
    let counter = 0
    const server = await serve((request) => {
      const body = JSON.parse(request.body) as BatchBody
      counter += 1
      return { body: { results: body.queries.map(() => ({ vulns: [], next_page_token: `t${counter}` })) } }
    })
    const outcome = await queryVersions(client, server.url, queriesFor(2))
    assert.ok(server.requests.length <= 1 + OSV_MAX_PAGES)
    assert.equal(outcome.matches.size, 0)
    assert.deepEqual([...outcome.failed.values()], ['returned too many pages', 'returned too many pages'])
  })

  it('fails the chunk on a repeated page token', async () => {
    const server = await serve((request) => {
      const body = JSON.parse(request.body) as BatchBody
      return { body: { results: body.queries.map(() => ({ next_page_token: 'same' })) } }
    })
    const outcome = await queryVersions(client, server.url, queriesFor(1))
    assert.equal(server.requests.length, 2)
    assert.equal(outcome.failed.get('pkg-0@1.0.0'), 'returned too many pages')
  })

  it('returns empty maps for no queries without any request', async () => {
    const server = await serve(() => ({ body: {} }))
    const outcome = await queryVersions(client, server.url, [])
    assert.equal(outcome.matches.size, 0)
    assert.equal(server.requests.length, 0)
  })
})

describe('queryPackageAdvisories', () => {
  it('follows next_page_token and returns converted advisories', async () => {
    const server = await serve((request) => {
      const body = JSON.parse(request.body) as { package: { name: string; ecosystem: string }; page_token?: string }
      if (body.page_token === undefined) {
        return { body: { vulns: [advisoryRecord({ id: 'GHSA-1' })], next_page_token: 'next' } }
      }
      return { body: { vulns: [advisoryRecord({ id: 'GHSA-2', aliases: [] })] } }
    })
    const result = await queryPackageAdvisories(client, server.url, 'lodash')
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[0].path, '/v1/query')
    assert.deepEqual(JSON.parse(server.requests[0].body), { package: { name: 'lodash', ecosystem: 'npm' } })
    assert.equal(JSON.parse(server.requests[1].body).page_token, 'next')
    assert.equal(result.state, 'ok')
    if (result.state === 'ok') assert.deepEqual(result.advisories.map((entry) => entry.id), ['GHSA-1', 'GHSA-2'])
  })

  it('returns no advisories when vulns is missing', async () => {
    const server = await serve(() => ({ body: {} }))
    assert.deepEqual(await queryPackageAdvisories(client, server.url, 'lodash'), { state: 'ok', advisories: [] })
  })

  it('fails when the server always returns a fresh page token', async () => {
    let counter = 0
    const server = await serve(() => ({ body: { vulns: [], next_page_token: `t${(counter += 1)}` } }))
    assert.deepEqual(await queryPackageAdvisories(client, server.url, 'lodash'), {
      state: 'failed',
      reason: 'returned too many pages',
    })
    assert.ok(server.requests.length <= 1 + OSV_MAX_PAGES)
  })

  it('fails on a repeated page token', async () => {
    const server = await serve(() => ({ body: { next_page_token: 'same' } }))
    assert.deepEqual(await queryPackageAdvisories(client, server.url, 'lodash'), {
      state: 'failed',
      reason: 'returned too many pages',
    })
    assert.equal(server.requests.length, 2)
  })

  it('reports an HTTP failure', async () => {
    const server = await serve(() => ({ status: 503, body: 'down' }))
    assert.deepEqual(await queryPackageAdvisories(client, server.url, 'lodash'), {
      state: 'failed',
      reason: 'responded with HTTP 503',
    })
  })

  it('reports a malformed body', async () => {
    const server = await serve(() => ({ body: '<html>' }))
    assert.deepEqual(await queryPackageAdvisories(client, server.url, 'lodash'), {
      state: 'failed',
      reason: 'returned a malformed response',
    })
  })
})

describe('toAdvisory', () => {
  it('converts a record', () => {
    assert.deepEqual(toAdvisory(advisoryRecord(), 'lodash'), {
      id: 'GHSA-aaaa-bbbb-cccc',
      aliases: ['CVE-2024-0001'],
      summary: 'Bad things',
      severity: 'high',
      malicious: false,
      url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
      fixedIn: ['4.17.21'],
      modified: '2024-01-01T00:00:00Z',
      affected: [
        { versions: ['4.17.20'], ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] },
      ],
    })
  })

  it('drops withdrawn records and records without id', () => {
    assert.equal(toAdvisory(advisoryRecord({ withdrawn: '2024-02-01T00:00:00Z' }), 'lodash'), null)
    assert.equal(toAdvisory(advisoryRecord({ id: undefined }), 'lodash'), null)
    assert.equal(toAdvisory('text', 'lodash'), null)
    assert.equal(toAdvisory(null, 'lodash'), null)
  })

  it('drops affected entries of other packages and ecosystems', () => {
    const record = advisoryRecord({
      affected: [
        { package: { ecosystem: 'npm', name: 'other' }, versions: ['1.0.0'] },
        { package: { ecosystem: 'PyPI', name: 'lodash' }, versions: ['1.0.0'] },
        { package: { ecosystem: 'npm', name: 'lodash' }, versions: ['2.0.0'] },
      ],
    })
    assert.deepEqual(toAdvisory(record, 'lodash')?.affected, [{ versions: ['2.0.0'], ranges: [] }])
  })

  it('keeps only SEMVER and ECOSYSTEM ranges', () => {
    const record = advisoryRecord({
      affected: [
        {
          package: { ecosystem: 'npm', name: 'lodash' },
          ranges: [
            { type: 'GIT', events: [{ introduced: 'abc' }, { fixed: 'def' }] },
            { type: 'ECOSYSTEM', events: [{ introduced: '1.0.0' }, { last_affected: '1.5.0' }] },
          ],
        },
      ],
    })
    const converted = toAdvisory(record, 'lodash')
    assert.deepEqual(converted?.affected, [
      { versions: [], ranges: [{ events: [{ introduced: '1.0.0' }, { last_affected: '1.5.0' }] }] },
    ])
    assert.deepEqual(converted?.fixedIn, [])
  })

  it('sorts fixedIn by semver, removes duplicates and drops invalid versions', () => {
    const record = advisoryRecord({
      affected: [
        {
          package: { ecosystem: 'npm', name: 'lodash' },
          ranges: [
            { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.10.0' }, { fixed: '4.9.0' }] },
            { type: 'SEMVER', events: [{ introduced: '5.0.0' }, { fixed: '5.1.0' }, { fixed: '4.9.0' }, { fixed: 'bogus' }] },
          ],
        },
      ],
    })
    assert.deepEqual(toAdvisory(record, 'lodash')?.fixedIn, ['4.9.0', '4.10.0', '5.1.0'])
  })

  it('exposes the first CVSS score preferring V4, then V3, then V2', () => {
    const only3 = advisoryRecord({
      database_specific: undefined,
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L' }],
    })
    const converted = toAdvisory(only3, 'lodash')
    assert.equal(converted?.severity, 'unknown')
    assert.equal(converted?.cvss, 'CVSS:3.1/AV:N/AC:L')
    const all = advisoryRecord({
      severity: [
        { type: 'CVSS_V2', score: 'v2' },
        { type: 'CVSS_V3', score: 'v3' },
        { type: 'CVSS_V4', score: 'v4' },
      ],
    })
    assert.equal(toAdvisory(all, 'lodash')?.cvss, 'v4')
    assert.equal(toAdvisory(advisoryRecord(), 'lodash')?.cvss, undefined)
  })

  it('tolerates missing optional fields', () => {
    const converted = toAdvisory({ id: 'GHSA-x' }, 'lodash')
    assert.deepEqual(converted, {
      id: 'GHSA-x',
      aliases: [],
      summary: '',
      severity: 'unknown',
      malicious: false,
      url: 'https://osv.dev/vulnerability/GHSA-x',
      fixedIn: [],
      modified: '',
      affected: [],
    })
  })
})

describe('severityOf', () => {
  it('maps the five database labels', () => {
    const severities = ['LOW', 'MODERATE', 'MEDIUM', 'HIGH', 'CRITICAL'].map(
      (label) => severityOf({ id: 'GHSA-1', database_specific: { severity: label } }).severity,
    )
    assert.deepEqual(severities, ['low', 'moderate', 'moderate', 'high', 'critical'])
  })

  it('treats MAL ids as critical and malicious', () => {
    assert.deepEqual(severityOf({ id: 'MAL-2024-1' }), { severity: 'critical', malicious: true })
  })

  it('falls back to unknown', () => {
    assert.deepEqual(severityOf({ id: 'GHSA-1' }), { severity: 'unknown', malicious: false })
    assert.deepEqual(severityOf({ id: 'GHSA-1', database_specific: { severity: 'WEIRD' } }), {
      severity: 'unknown',
      malicious: false,
    })
    assert.deepEqual(severityOf({ id: 'GHSA-1', database_specific: 'x' }), { severity: 'unknown', malicious: false })
  })
})

describe('dedupeAdvisories', () => {
  it('keeps the GHSA advisory when a MAL record aliases it', () => {
    const mal = advisory({ id: 'MAL-2024-1', aliases: ['GHSA-aaaa'] })
    const ghsa = advisory({ id: 'GHSA-aaaa', aliases: [] })
    assert.deepEqual(dedupeAdvisories([mal, ghsa]).map((entry) => entry.id), ['GHSA-aaaa'])
    assert.deepEqual(dedupeAdvisories([ghsa, mal]).map((entry) => entry.id), ['GHSA-aaaa'])
  })

  it('keeps the first when neither is GHSA', () => {
    const first = advisory({ id: 'CVE-1', aliases: ['OSV-2'] })
    const second = advisory({ id: 'OSV-2', aliases: [] })
    assert.deepEqual(dedupeAdvisories([first, second]).map((entry) => entry.id), ['CVE-1'])
  })

  it('keeps unrelated advisories in order', () => {
    const entries = [advisory({ id: 'A' }), advisory({ id: 'B' }), advisory({ id: 'C' })]
    assert.deepEqual(dedupeAdvisories(entries).map((entry) => entry.id), ['A', 'B', 'C'])
  })
})
