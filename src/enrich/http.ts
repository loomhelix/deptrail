import type { AuthorizationLookup } from './credentials.ts'

export type HttpRequest = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  authorizationFor?: AuthorizationLookup
}
export type HttpResponse = { status: number; headers: Headers; text: string }
export type HttpErrorKind = 'network' | 'timeout' | 'too-large' | 'redirects' | 'aborted'

export class HttpError extends Error {
  readonly kind: HttpErrorKind

  constructor(kind: HttpErrorKind) {
    super(`http request failed: ${kind}`)
    this.name = 'HttpError'
    this.kind = kind
  }
}

export const HTTP_DEFAULTS = {
  timeoutMs: 30_000,
  retryDelaysMs: [1000, 4000],
  maxRetryAfterMs: 30_000,
  maxBytes: 52_428_800,
  concurrencyPerOrigin: 16,
  maxRedirects: 5,
} as const

export type HttpClientOptions = {
  userAgent: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  maxBytes?: number
  concurrencyPerOrigin?: number
}
export type HttpClient = { request(request: HttpRequest): Promise<HttpResponse> }

type Method = 'GET' | 'POST'
type Hop = { url: string; method: Method; body: string | undefined }
type OriginGate = { active: number; waiting: Array<() => void> }
type Release = () => void

const REDIRECT_STATUSES = [301, 302, 303, 307, 308]
const RETRYABLE_STATUS = (status: number) => status === 429 || status >= 500
const AUTHORIZATION_HEADER = /^authorization$/i

function retryDelayMs(headers: Headers, attempt: number): number {
  const retryAfterSeconds = Number(headers.get('retry-after'))
  const headerValid = headers.get('retry-after') !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
  return headerValid
    ? Math.min(retryAfterSeconds * 1000, HTTP_DEFAULTS.maxRetryAfterMs)
    : HTTP_DEFAULTS.retryDelaysMs[attempt]
}

function nextHop(current: Hop, response: Response): Hop | undefined {
  const location = response.headers.get('location')
  if (!REDIRECT_STATUSES.includes(response.status) || location === null) return undefined
  const url = new URL(location, current.url).href
  if (response.status === 303) return { url, method: 'GET', body: undefined }
  return { ...current, url }
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? sleepUnlessAborted
  const timeoutMs = options.timeoutMs ?? HTTP_DEFAULTS.timeoutMs
  const maxBytes = options.maxBytes ?? HTTP_DEFAULTS.maxBytes
  const concurrencyPerOrigin = options.concurrencyPerOrigin ?? HTTP_DEFAULTS.concurrencyPerOrigin
  const gates = new Map<string, OriginGate>()

  function throwIfAborted(): void {
    if (options.signal?.aborted) throw new HttpError('aborted')
  }

  function sleepUnlessAborted(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      options.signal?.addEventListener('abort', finish)
      if (options.signal?.aborted) finish()
    })
  }

  async function acquire(origin: string): Promise<Release> {
    throwIfAborted()
    const gate = gates.get(origin) ?? { active: 0, waiting: [] }
    gates.set(origin, gate)
    if (gate.active >= concurrencyPerOrigin) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          options.signal?.removeEventListener('abort', giveUp)
          resolve()
        }
        const giveUp = () => {
          gate.waiting.splice(gate.waiting.indexOf(grant), 1)
          reject(new HttpError('aborted'))
        }
        gate.waiting.push(grant)
        options.signal?.addEventListener('abort', giveUp)
      })
    } else gate.active++
    return () => {
      const next = gate.waiting.shift()
      if (next) next()
      else gate.active--
    }
  }

  async function readBodyWithin(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new HttpError('too-large')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function headersFor(request: HttpRequest, hop: Hop, withholdAuthorization: boolean): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!AUTHORIZATION_HEADER.test(name)) headers[name] = value
    }
    headers['User-Agent'] = options.userAgent
    const authorization = withholdAuthorization ? undefined : request.authorizationFor?.(hop.url)
    if (authorization !== undefined) headers['Authorization'] = authorization
    return headers
  }

  async function attempt(
    request: HttpRequest,
    hop: Hop,
    withholdAuthorization: boolean,
    lastAttempt: boolean,
  ): Promise<{ response: Response; text: string }> {
    const release = await acquire(new URL(hop.url).origin)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortFromOutside = () => controller.abort()
    options.signal?.addEventListener('abort', abortFromOutside)
    try {
      throwIfAborted()
      const response = await fetchImpl(hop.url, {
        method: hop.method,
        headers: headersFor(request, hop, withholdAuthorization),
        body: hop.body,
        redirect: 'manual',
        signal: controller.signal,
      })
      const bodyIsIrrelevant = nextHop(hop, response) !== undefined || (RETRYABLE_STATUS(response.status) && !lastAttempt)
      if (bodyIsIrrelevant) {
        await response.body?.cancel()
        return { response, text: '' }
      }
      return { response, text: await readBodyWithin(response) }
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (options.signal?.aborted) throw new HttpError('aborted')
      throw new HttpError(timedOut ? 'timeout' : 'network')
    } finally {
      release()
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromOutside)
    }
  }

  async function fetchHop(request: HttpRequest, hop: Hop, withholdAuthorization: boolean): Promise<{ redirectTo: Hop } | { response: HttpResponse }> {
    const retries = HTTP_DEFAULTS.retryDelaysMs.length
    for (let attemptIndex = 0; ; attemptIndex++) {
      const lastAttempt = attemptIndex === retries
      let outcome: { response: Response; text: string }
      try {
        outcome = await attempt(request, hop, withholdAuthorization, lastAttempt)
      } catch (error) {
        if (!(error instanceof HttpError) || error.kind !== 'network' || lastAttempt) throw error
        await sleep(HTTP_DEFAULTS.retryDelaysMs[attemptIndex])
        throwIfAborted()
        continue
      }
      const { response, text } = outcome
      if (RETRYABLE_STATUS(response.status) && !lastAttempt) {
        await sleep(retryDelayMs(response.headers, attemptIndex))
        throwIfAborted()
        continue
      }
      const redirectTo = nextHop(hop, response)
      if (redirectTo !== undefined) return { redirectTo }
      return { response: { status: response.status, headers: response.headers, text } }
    }
  }

  async function request(httpRequest: HttpRequest): Promise<HttpResponse> {
    throwIfAborted()
    let hop: Hop = { url: httpRequest.url, method: httpRequest.method ?? 'GET', body: httpRequest.body }
    let httpsSeen = false
    for (let redirects = 0; ; redirects++) {
      const hopProtocol = new URL(hop.url).protocol
      const result = await fetchHop(httpRequest, hop, httpsSeen && hopProtocol === 'http:')
      httpsSeen = httpsSeen || hopProtocol === 'https:'
      if ('response' in result) return result.response
      if (redirects === HTTP_DEFAULTS.maxRedirects) throw new HttpError('redirects')
      hop = result.redirectTo
    }
  }

  return { request }
}
