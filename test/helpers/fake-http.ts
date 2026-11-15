import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export type RecordedRequest = {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}
export type FakeReply = { status?: number; headers?: Record<string, string>; body?: unknown; delayMs?: number }
export type FakeServer = { url: string; port: number; requests: RecordedRequest[]; close(): Promise<void> }

const REQUESTS_PATH = '/__requests'

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function startFakeServer(
  handler: (request: RecordedRequest) => FakeReply | Promise<FakeReply>,
): Promise<FakeServer> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === REQUESTS_PATH) {
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify(requests))
      return
    }
    const recorded: RecordedRequest = {
      method: incoming.method ?? 'GET',
      path: incoming.url ?? '/',
      headers: incoming.headers,
      body: await readBody(incoming),
    }
    requests.push(recorded)
    const reply = await handler(recorded)
    if (reply.delayMs !== undefined) await delay(reply.delayMs)
    const rawBody = typeof reply.body === 'string' || Buffer.isBuffer(reply.body)
    const payload = reply.body === undefined ? '' : rawBody ? (reply.body as string | Buffer) : JSON.stringify(reply.body)
    const contentType = reply.body === undefined || rawBody ? {} : { 'content-type': 'application/json' }
    outgoing.writeHead(reply.status ?? 200, { ...contentType, ...reply.headers })
    outgoing.end(payload)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}
