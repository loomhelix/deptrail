import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import semver from 'semver'
import { startFakeServer, type FakeReply, type RecordedRequest } from './fake-http.ts'

export type FakeVersion = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; deprecated?: string }
export type FakePackages = Record<string, Record<string, FakeVersion>>
export type FakeNpmRegistry = { url: string; port: number; requests: RecordedRequest[]; reveal(): void; close(): Promise<void> }

type Tarball = { bytes: Buffer; integrity: string; shasum: string }

const PUBLISHED_AT = '2020-01-01T00:00:00.000Z'
const PUBLISHED_AT_SECONDS = Date.parse(PUBLISHED_AT) / 1000
const TAR_BLOCK_SIZE = 512
const TAR_END_BLOCKS = 2
const TARBALL_MANIFEST_PATH = 'package/package.json'
const TARBALL_SEPARATOR = '/-/'
const TARBALL_EXTENSION = '.tgz'
const FILE_MODE = 0o644
const NOT_FOUND: FakeReply = { status: 404, body: { error: 'Not found' } }

function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function ustarHeader(entryPath: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE)
  header.write(entryPath, 0, 100, 'utf8')
  header.write(octalField(FILE_MODE, 8), 100, 'ascii')
  header.write(octalField(0, 8), 108, 'ascii')
  header.write(octalField(0, 8), 116, 'ascii')
  header.write(octalField(size, 12), 124, 'ascii')
  header.write(octalField(PUBLISHED_AT_SECONDS, 12), 136, 'ascii')
  header.write(' '.repeat(8), 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

function tarballOf(manifest: Record<string, unknown>): Tarball {
  const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const padding = Buffer.alloc((TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE)
  const archive = Buffer.concat([ustarHeader(TARBALL_MANIFEST_PATH, content.length), content, padding, Buffer.alloc(TAR_BLOCK_SIZE * TAR_END_BLOCKS)])
  const bytes = gzipSync(archive)
  return {
    bytes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  }
}

function unscopedName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

function tarballKey(name: string, version: string): string {
  return `${name}@${version}`
}

function buildTarballs(packages: FakePackages): Map<string, Tarball> {
  const tarballs = new Map<string, Tarball>()
  for (const [name, versions] of Object.entries(packages)) {
    for (const [version, { deprecated: _deprecated, ...fields }] of Object.entries(versions)) {
      tarballs.set(tarballKey(name, version), tarballOf({ name, version, ...fields }))
    }
  }
  return tarballs
}

function highestRelease(versions: readonly string[]): string | undefined {
  return versions.filter((version) => semver.prerelease(version) === null).sort(semver.rcompare)[0]
}

export async function startFakeNpmRegistry(
  packages: FakePackages,
  options: { hidden?: readonly string[]; latest?: Record<string, string> } = {},
): Promise<FakeNpmRegistry> {
  const hidden = new Set(options.hidden ?? [])
  const tarballs = buildTarballs(packages)
  let baseUrl = ''

  const visibleVersions = (name: string): string[] => Object.keys(packages[name] ?? {}).filter((version) => !hidden.has(tarballKey(name, version)))

  const tarballUrl = (name: string, version: string): string => `${baseUrl}/${name}${TARBALL_SEPARATOR}${unscopedName(name)}-${version}${TARBALL_EXTENSION}`

  const packument = (name: string): Record<string, unknown> => {
    const versions = visibleVersions(name)
    const latest = options.latest?.[name] ?? highestRelease(versions)
    const entries: Record<string, unknown> = {}
    const time: Record<string, string> = { created: PUBLISHED_AT, modified: PUBLISHED_AT }
    for (const version of versions) {
      const tarball = tarballs.get(tarballKey(name, version)) as Tarball
      entries[version] = {
        name,
        version,
        ...packages[name]?.[version],
        dist: { tarball: tarballUrl(name, version), integrity: tarball.integrity, shasum: tarball.shasum },
      }
      time[version] = PUBLISHED_AT
    }
    return { name, 'dist-tags': latest === undefined ? {} : { latest }, versions: entries, time }
  }

  const tarballReply = (requestPath: string): FakeReply => {
    const separator = requestPath.lastIndexOf(TARBALL_SEPARATOR)
    const name = requestPath.slice(0, separator)
    const file = requestPath.slice(separator + TARBALL_SEPARATOR.length)
    const prefix = `${unscopedName(name)}-`
    if (!file.startsWith(prefix) || !file.endsWith(TARBALL_EXTENSION)) return NOT_FOUND
    const version = file.slice(prefix.length, -TARBALL_EXTENSION.length)
    const tarball = tarballs.get(tarballKey(name, version))
    if (tarball === undefined || hidden.has(tarballKey(name, version))) return NOT_FOUND
    return { headers: { 'content-type': 'application/octet-stream' }, body: tarball.bytes }
  }

  const server = await startFakeServer((request) => {
    if (request.method !== 'GET') return NOT_FOUND
    const requestPath = decodeURIComponent(new URL(request.path, 'http://registry.invalid').pathname).slice(1)
    if (requestPath.includes(TARBALL_SEPARATOR)) return tarballReply(requestPath)
    return Object.hasOwn(packages, requestPath) ? { body: packument(requestPath) } : NOT_FOUND
  })
  baseUrl = server.url
  return {
    url: server.url,
    port: server.port,
    requests: server.requests,
    reveal: () => hidden.clear(),
    close: () => server.close(),
  }
}
