import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export type StaticResponse = { status: number; contentType: string; body: Buffer | string }

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const UI_NOT_BUILT: StaticResponse = {
  status: 503,
  contentType: 'text/plain; charset=utf-8',
  body: 'UI is not built. Run pnpm build.',
}

async function readFileIfPresent(file: string): Promise<Buffer | null> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    return await readFile(file)
  } catch {
    return null
  }
}

function insideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function respondWith(file: string, body: Buffer): StaticResponse {
  const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  return { status: 200, contentType, body }
}

export async function serveStatic(staticDir: string, pathname: string): Promise<StaticResponse> {
  const root = path.resolve(staticDir)
  const indexFile = path.join(root, 'index.html')
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    decoded = '/'
  }
  const requested = path.resolve(root, `.${decoded}`)
  if (insideDirectory(root, requested)) {
    const body = await readFileIfPresent(requested)
    if (body) return respondWith(requested, body)
  }
  const index = await readFileIfPresent(indexFile)
  return index ? respondWith(indexFile, index) : UI_NOT_BUILT
}
