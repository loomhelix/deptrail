import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const TOKEN_COOKIE_PREFIX = 'deptrail_token_'
export const TOKEN_HEADER = 'x-deptrail-token'

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`
}

export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
  return originHeader === `http://127.0.0.1:${port}` || originHeader === `http://localhost:${port}`
}

export function tokensMatch(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false
  const expectedBytes = Buffer.from(expected)
  const candidateBytes = Buffer.from(candidate)
  if (expectedBytes.length !== candidateBytes.length) return false
  return timingSafeEqual(expectedBytes, candidateBytes)
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

export function tokenCookieName(port: number): string {
  return `${TOKEN_COOKIE_PREFIX}${port}`
}

export function requestToken(request: IncomingMessage, port: number): string | undefined {
  const header = request.headers[TOKEN_HEADER]
  if (typeof header === 'string') return header
  return cookieValue(request.headers.cookie, tokenCookieName(port))
}

export function sessionCookie(token: string, port: number): string {
  return `${tokenCookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`
}
