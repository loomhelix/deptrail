import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createHttpClient, HttpError, type HttpClientOptions } from '../src/enrich/http.ts'
import { startFakeServer, type FakeServer } from './helpers/fake-http.ts'

const servers: FakeServer[] = []
const STILL_QUEUED = 'still queued'
const PERMIT_PROBE_PATH = '/sent-once-the-throttled-request-sleeps'

async function serve(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler)
  servers.push(server)
  return server
}

function clientWithRecordedSleeps(options: Partial<HttpClientOptions> = {}) {
  const sleeps: number[] = []
  const client = createHttpClient({
    userAgent: 'deptrail-test/1.0',
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...options,
  })
  return { client, sleeps }
}

async function closedPortUrl(): Promise<string> {
  const server = await startFakeServer(() => ({}))
  await server.close()
  return server.url
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
})

describe('http client', () => {
  it('sends the user agent and the authorization for the url', async () => {
    const server = await serve(() => ({ body: 'ok' }))
    const { client } = clientWithRecordedSleeps()
    const response = await client.request({
      url: `${server.url}/pkg`,
      authorizationFor: () => 'Bearer secret-token',
    })
    assert.equal(response.status, 200)
    assert.equal(response.text, 'ok')
    assert.equal(server.requests[0].headers['user-agent'], 'deptrail-test/1.0')
    assert.equal(server.requests[0].headers['authorization'], 'Bearer secret-token')
  })

  it('posts a body with the method and headers given', async () => {
    const server = await serve(() => ({ body: { ok: true } }))
    const { client } = clientWithRecordedSleeps()
    const response = await client.request({
      url: `${server.url}/query`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    assert.equal(server.requests[0].method, 'POST')
    assert.equal(server.requests[0].body, '{"a":1}')
    assert.equal(server.requests[0].headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(response.text), { ok: true })
  })

  it('retries a 503 twice with the default delays and then returns it', async () => {
    const server = await serve(() => ({ status: 503 }))
    const { client, sleeps } = clientWithRecordedSleeps()
    const response = await client.request({ url: server.url })
    assert.equal(response.status, 503)
    assert.equal(server.requests.length, 3)
    assert.deepEqual(sleeps, [1000, 4000])
  })

  it('retries a 429 and succeeds when the server recovers', async () => {
    let calls = 0
    const server = await serve(() => (++calls === 1 ? { status: 429 } : { body: 'fine' }))
    const { client, sleeps } = clientWithRecordedSleeps()
    const response = await client.request({ url: server.url })
    assert.equal(response.text, 'fine')
    assert.deepEqual(sleeps, [1000])
  })

  it('honors Retry-After in seconds and caps it', async () => {
    const short = await serve(() => ({ status: 429, headers: { 'retry-after': '2' } }))
    const long = await serve(() => ({ status: 429, headers: { 'retry-after': '120' } }))
    const shortRun = clientWithRecordedSleeps()
    const longRun = clientWithRecordedSleeps()
    await shortRun.client.request({ url: short.url })
    await longRun.client.request({ url: long.url })
    assert.deepEqual(shortRun.sleeps, [2000, 2000])
    assert.deepEqual(longRun.sleeps, [30_000, 30_000])
  })

  it('requests 401 and 404 only once', async () => {
    const unauthorized = await serve(() => ({ status: 401 }))
    const missing = await serve(() => ({ status: 404 }))
    const { client, sleeps } = clientWithRecordedSleeps()
    assert.equal((await client.request({ url: unauthorized.url })).status, 401)
    assert.equal((await client.request({ url: missing.url })).status, 404)
    assert.equal(unauthorized.requests.length, 1)
    assert.equal(missing.requests.length, 1)
    assert.deepEqual(sleeps, [])
  })

  it('throws a network error after three attempts on a closed port', async () => {
    const url = await closedPortUrl()
    const { client, sleeps } = clientWithRecordedSleeps()
    const error = await rejectionOf(client.request({ url }))
    assert.ok(error instanceof HttpError)
    assert.equal(error.kind, 'network')
    assert.deepEqual(sleeps, [1000, 4000])
    assert.ok(!error.message.includes('127.0.0.1'))
  })

  it('throws timeout when a reply takes longer than timeoutMs', async () => {
    const server = await serve(() => ({ delayMs: 200 }))
    const { client } = clientWithRecordedSleeps({ timeoutMs: 50 })
    const error = await rejectionOf(client.request({ url: server.url }))
    assert.ok(error instanceof HttpError)
    assert.equal(error.kind, 'timeout')
  })

  it('sends authorization to the origin it belongs to and not to a redirect target', async () => {
    const target = await serve(() => ({ body: 'arrived' }))
    const origin = await serve(() => ({ status: 302, headers: { location: `${target.url}/final` } }))
    const { client } = clientWithRecordedSleeps()
    const response = await client.request({
      url: `${origin.url}/start`,
      authorizationFor: (url) => (url.startsWith(origin.url) ? 'Bearer origin-only' : undefined),
    })
    assert.equal(response.text, 'arrived')
    assert.equal(origin.requests[0].headers['authorization'], 'Bearer origin-only')
    assert.equal(target.requests[0].path, '/final')
    assert.equal(target.requests[0].headers['authorization'], undefined)
    assert.equal(target.requests[0].headers['user-agent'], 'deptrail-test/1.0')
  })

  it('keeps authorization on a same-origin redirect with a relative location', async () => {
    const server = await serve((request) =>
      request.path === '/start' ? { status: 301, headers: { location: '/final' } } : { body: 'done' },
    )
    const { client } = clientWithRecordedSleeps()
    const response = await client.request({ url: `${server.url}/start`, authorizationFor: () => 'Bearer same' })
    assert.equal(response.text, 'done')
    assert.equal(server.requests[1].headers['authorization'], 'Bearer same')
  })

  it('switches to GET without a body on 303 and keeps the method on 307', async () => {
    const server = await serve((request) => {
      if (request.path === '/see-other') return { status: 303, headers: { location: '/landing' } }
      if (request.path === '/temporary') return { status: 307, headers: { location: '/landing' } }
      return { body: 'landed' }
    })
    const { client } = clientWithRecordedSleeps()
    await client.request({ url: `${server.url}/see-other`, method: 'POST', body: 'payload' })
    await client.request({ url: `${server.url}/temporary`, method: 'POST', body: 'payload' })
    const landings = server.requests.filter((request) => request.path === '/landing')
    assert.equal(landings[0].method, 'GET')
    assert.equal(landings[0].body, '')
    assert.equal(landings[1].method, 'POST')
    assert.equal(landings[1].body, 'payload')
  })

  it('throws redirects after more than five hops', async () => {
    const server = await serve((request) => {
      const hop = Number(request.path.slice(1)) || 0
      return { status: 302, headers: { location: `/${hop + 1}` } }
    })
    const { client } = clientWithRecordedSleeps()
    const error = await rejectionOf(client.request({ url: server.url }))
    assert.ok(error instanceof HttpError)
    assert.equal(error.kind, 'redirects')
    assert.equal(server.requests.length, 6)
  })

  it('never sends authorization on a hop from https to http', async () => {
    const seenAuthorizations: Array<string | undefined> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      seenAuthorizations.push(headers.get('authorization') ?? undefined)
      if (url.startsWith('https://')) {
        return new Response(null, { status: 302, headers: { location: 'http://registry.example/final' } })
      }
      return new Response('plain', { status: 200 })
    }
    const { client } = clientWithRecordedSleeps({ fetchImpl })
    const response = await client.request({
      url: 'https://registry.example/start',
      authorizationFor: () => 'Bearer must-stay-private',
    })
    assert.equal(response.text, 'plain')
    assert.deepEqual(seenAuthorizations, ['Bearer must-stay-private', undefined])
  })

  it('never sends authorization over http after the chain has used https', async () => {
    const seenAuthorizations: Array<string | undefined> = []
    const redirects: Record<string, string> = {
      'https://registry.example/a': 'http://registry.example/b',
      'http://registry.example/b': '/c',
    }
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      seenAuthorizations.push(new Headers(init?.headers).get('authorization') ?? undefined)
      const location = redirects[url]
      return location ? new Response(null, { status: 302, headers: { location } }) : new Response('end')
    }
    const { client } = clientWithRecordedSleeps({ fetchImpl })
    await client.request({ url: 'https://registry.example/a', authorizationFor: () => 'Bearer secret' })
    assert.deepEqual(seenAuthorizations, ['Bearer secret', undefined, undefined])
  })

  it('does not count time spent queued for a permit against the timeout', async () => {
    const queuedRequests = 10
    const server = await serve(() => ({ delayMs: 60 }))
    const { client } = clientWithRecordedSleeps({ concurrencyPerOrigin: 1, timeoutMs: 300 })
    const responses = await Promise.all(Array.from({ length: queuedRequests }, () => client.request({ url: server.url })))
    assert.deepEqual(responses.map((response) => response.status), Array.from({ length: queuedRequests }, () => 200))
    assert.equal(server.requests.length, queuedRequests)
  })

  it('aborts a request queued for a permit without sending it', async () => {
    const sentUrls: string[] = []
    const firstSent = deferred()
    const firstAnswer = deferred()
    const fetchIgnoringAbort: typeof fetch = async (input) => {
      sentUrls.push(String(input))
      firstSent.resolve()
      await firstAnswer.promise
      return new Response('late')
    }
    const controller = new AbortController()
    const { client } = clientWithRecordedSleeps({ concurrencyPerOrigin: 1, signal: controller.signal, fetchImpl: fetchIgnoringAbort })
    const first = rejectionOf(client.request({ url: 'https://registry.example/first' }))
    const queued = rejectionOf(client.request({ url: 'https://registry.example/queued' }))
    await firstSent.promise
    controller.abort()
    const queuedOutcome = await Promise.race([queued, delay(1000, STILL_QUEUED, { ref: false })])
    firstAnswer.resolve()
    await first
    assert.ok(queuedOutcome instanceof HttpError && queuedOutcome.kind === 'aborted', String(queuedOutcome))
    assert.deepEqual(sentUrls, ['https://registry.example/first'])
  })

  it('ends a retry backoff at once when the signal aborts', async () => {
    const server = await serve((request) => (request.path === PERMIT_PROBE_PATH ? {} : { status: 429, headers: { 'retry-after': '30' } }))
    const controller = new AbortController()
    const client = createHttpClient({ userAgent: 'deptrail-test/1.0', signal: controller.signal, concurrencyPerOrigin: 1 })
    const startedAt = Date.now()
    const pending = rejectionOf(client.request({ url: server.url }))
    await client.request({ url: `${server.url}${PERMIT_PROBE_PATH}` })
    controller.abort()
    const error = await pending
    assert.ok(error instanceof HttpError)
    assert.equal(error.kind, 'aborted')
    assert.ok(Date.now() - startedAt < 2000)
    assert.deepEqual(server.requests.map((request) => request.path), ['/', PERMIT_PROBE_PATH])
  })

  it('throws too-large when the body passes maxBytes', async () => {
    const server = await serve(() => ({ body: 'x'.repeat(2048) }))
    const { client } = clientWithRecordedSleeps({ maxBytes: 1024 })
    const error = await rejectionOf(client.request({ url: server.url }))
    assert.ok(error instanceof HttpError)
    assert.equal(error.kind, 'too-large')
    assert.equal(server.requests.length, 1)
  })

  it('limits concurrent requests per origin', async () => {
    let inFlight = 0
    let peak = 0
    const server = await serve(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await delay(50)
      inFlight--
      return { body: 'ok' }
    })
    const { client } = clientWithRecordedSleeps({ concurrencyPerOrigin: 2 })
    const responses = await Promise.all(Array.from({ length: 6 }, () => client.request({ url: server.url })))
    assert.equal(responses.length, 6)
    assert.equal(server.requests.length, 6)
    assert.equal(peak, 2)
  })

  it('throws aborted without retrying when the signal aborts mid-request', async () => {
    const arrived = deferred()
    const server = await serve(() => {
      arrived.resolve()
      return { delayMs: 500 }
    })
    const controller = new AbortController()
    const { client, sleeps } = clientWithRecordedSleeps({ signal: controller.signal })
    const pending = rejectionOf(client.request({ url: server.url }))
    await arrived.promise
    controller.abort()
    const error = await pending
    assert.ok(error instanceof HttpError)
    assert.equal(error.kind, 'aborted')
    assert.equal(server.requests.length, 1)
    assert.deepEqual(sleeps, [])
  })
})
