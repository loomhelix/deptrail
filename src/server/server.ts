import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { disabledActions, type ActionService } from '../actions/action-service.ts'
import { offlineEnrichment, type EnrichmentService } from '../enrich/enrichment-service.ts'
import type { ScanSession } from '../scan/scan-session.ts'
import type { Branches } from './branches.ts'
import { generateToken, isAllowedHost, isAllowedOrigin, sessionCookie, tokensMatch, requestToken } from './auth.ts'
import { createErrorLog, type LogStream } from './error-log.ts'
import { handleApi } from './router.ts'
import { serveStatic } from './static.ts'

export type ServerOptions = {
  session: ScanSession
  enrichment?: EnrichmentService
  actions?: ActionService
  branches?: Branches
  port?: number
  staticDir: string
  token?: string
  errorStream?: LogStream
}
export type RunningServer = { url: string; port: number; token: string; close(): Promise<void> }

export const MAX_BODY_BYTES = 65_536

const LOOPBACK = '127.0.0.1'
const JSON_MEDIA_TYPE = 'application/json'
const SAFE_METHODS = new Set(['GET', 'HEAD'])

class RequestRejection extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
  response.end(text)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    response.writeHead(status, { 'Cache-Control': 'no-store' })
    response.end()
    return
  }
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(text)
}

function redirectWithSessionCookie(response: ServerResponse, url: URL, token: string, port: number): void {
  const target = new URL(url)
  target.searchParams.delete('token')
  response.writeHead(302, {
    'Set-Cookie': sessionCookie(token, port),
    Location: `${target.pathname}${target.search}`,
    'Cache-Control': 'no-store',
  })
  response.end()
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function pathnameOf(request: IncomingMessage): string {
  return (request.url ?? '/').split('?')[0]!
}

function hasBody(request: IncomingMessage): boolean {
  return Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined
}

function mediaTypeOf(request: IncomingMessage): string {
  return (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
}

function readBodyText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let oversized = false
    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) oversized = true
      if (!oversized) chunks.push(chunk)
    })
    request.on('end', () =>
      oversized ? reject(new RequestRejection(413, 'Request body is larger than 64 KB')) : resolve(Buffer.concat(chunks).toString('utf8')),
    )
    request.on('error', reject)
  })
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!hasBody(request)) return undefined
  if (mediaTypeOf(request) !== JSON_MEDIA_TYPE) throw new RequestRejection(415, 'Content-Type must be application/json')
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new RequestRejection(413, 'Request body is larger than 64 KB')
  const text = await readBodyText(request)
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestRejection(400, 'Malformed JSON body')
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { session, staticDir } = options
  const enrichment = options.enrichment ?? offlineEnrichment()
  const actions = options.actions ?? disabledActions('Actions are not enabled')
  const token = options.token ?? generateToken()
  const logError = createErrorLog(options.errorStream ?? process.stderr)
  let port = 0

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    const url = new URL(request.url ?? '/', `http://${LOOPBACK}:${port}`)
    const reject = (status: number, message: string): void =>
      isApiPath(url.pathname) ? sendJson(response, status, { error: message }) : sendText(response, status, message)
    if (!isAllowedHost(request.headers.host, port)) return reject(403, 'Forbidden')
    const method = request.method ?? 'GET'
    const urlToken = url.searchParams.get('token')
    if (method === 'GET' && url.pathname === '/' && urlToken !== null) {
      if (!tokensMatch(token, urlToken)) return reject(401, 'Unauthorized')
      return redirectWithSessionCookie(response, url, token, port)
    }
    if (!tokensMatch(token, requestToken(request, port))) return reject(401, 'Unauthorized')
    const safeMethod = SAFE_METHODS.has(method)
    if (!safeMethod && !isAllowedOrigin(request.headers.origin, port)) return reject(403, 'Forbidden origin')
    if (isApiPath(url.pathname)) {
      let body: unknown
      if (!safeMethod) {
        try {
          body = await readJsonBody(request)
        } catch (failure) {
          if (!(failure instanceof RequestRejection)) throw failure
          request.resume()
          return reject(failure.status, failure.message)
        }
      }
      const result = await handleApi({ session, enrichment, actions, branches: options.branches }, { method, pathname: url.pathname, searchParams: url.searchParams, body }, logError)
      return sendJson(response, result.status, result.body)
    }
    if (!safeMethod) return sendText(response, 405, 'Method not allowed')
    const file = await serveStatic(staticDir, url.pathname)
    response.writeHead(file.status, { 'Content-Type': file.contentType, 'X-Content-Type-Options': 'nosniff' })
    response.end(method === 'HEAD' ? undefined : file.body)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((failure: unknown) => {
      logError(`${request.method ?? 'GET'} ${pathnameOf(request)}`, failure)
      if (!response.headersSent) sendText(response, 500, 'Internal error')
      else response.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  return {
    url: `http://${LOOPBACK}:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
