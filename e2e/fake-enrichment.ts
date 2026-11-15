import { startFakeServer, type FakeReply, type RecordedRequest } from '../test/helpers/fake-http.ts'

export const FIXTURE_TOKEN = 'fixture-secret-token'
export const SEMVER_ADVISORY_ID = 'GHSA-e2e0-semv-0001'
export const PRIVATE_REGISTRY_PATH = '/acme/'

export type FakeEnrichment = { registryUrl: string; osvUrl: string; registryPort: number; close(): Promise<void> }

type FakeVersion = { dependencies?: Record<string, string>; deprecated?: string }
type FakePackument = { latest?: string; versions: Record<string, FakeVersion> }
type BatchQuery = { package?: { name?: unknown }; version?: unknown }

const REQUIRED_AUTHORIZATION = `Bearer ${FIXTURE_TOKEN}`
const VULNERABLE_NAME = 'semver'
const VULNERABLE_VERSION = '5.7.2'
const ADVISORY_MODIFIED = '2026-01-01T00:00:00Z'

const PUBLIC_PACKUMENTS = new Map<string, FakePackument>(
  Object.entries<FakePackument>({
    semver: { latest: '7.7.0', versions: { '5.7.2': {}, '5.7.3': {}, '6.3.1': {}, '7.6.3': {}, '7.7.0': {} } },
    'normalize-package-data': { versions: { '2.5.0': { dependencies: { semver: '2 || 3 || 4 || 5' } } } },
    'vue-eslint-parser': {
      latest: '10.0.0',
      versions: { '9.4.3': { dependencies: { eslint: '>=6.0.0', semver: '5.7.2' } }, '10.0.0': {} },
    },
    'read-pkg-up': {
      latest: '11.0.0',
      versions: {
        '7.0.1': { deprecated: 'Renamed to read-package-up', dependencies: { 'normalize-package-data': '^2.5.0' } },
        '11.0.0': {},
      },
    },
    'eslint-plugin-vue': { latest: '9.33.0', versions: { '9.32.0': { dependencies: { 'vue-eslint-parser': '^9.4.3' } }, '9.33.0': {} } },
  }),
)

const PRIVATE_PACKUMENTS = new Map<string, FakePackument>(Object.entries<FakePackument>({ '@acme/internal': { versions: { '1.0.0': {} } } }))

const SEMVER_ADVISORY = {
  id: SEMVER_ADVISORY_ID,
  modified: ADVISORY_MODIFIED,
  summary: 'Fixture advisory for semver',
  aliases: [],
  database_specific: { severity: 'HIGH' },
  affected: [
    {
      package: { ecosystem: 'npm', name: VULNERABLE_NAME },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '5.7.3' }] }],
      versions: [],
    },
  ],
}

function decodedPath(request: RecordedRequest): string | undefined {
  try {
    return decodeURIComponent(request.path)
  } catch {
    return undefined
  }
}

function parsedBody(request: RecordedRequest): unknown {
  try {
    return JSON.parse(request.body)
  } catch {
    return undefined
  }
}

function packumentReply(name: string, packument: FakePackument | undefined): FakeReply {
  if (packument === undefined) return { status: 404 }
  const versions = Object.fromEntries(Object.entries(packument.versions).map(([version, entry]) => [version, { name, version, ...entry }]))
  return { body: { name, 'dist-tags': packument.latest === undefined ? {} : { latest: packument.latest }, versions } }
}

function registryReply(request: RecordedRequest): FakeReply {
  const path = decodedPath(request)
  if (request.method !== 'GET' || path === undefined) return { status: 404 }
  if (path.startsWith(PRIVATE_REGISTRY_PATH)) {
    const name = path.slice(PRIVATE_REGISTRY_PATH.length)
    return packumentReply(name, PRIVATE_PACKUMENTS.get(name))
  }
  if (request.headers.authorization !== REQUIRED_AUTHORIZATION) return { status: 401 }
  const name = path.slice(1)
  return packumentReply(name, PUBLIC_PACKUMENTS.get(name))
}

function isVulnerableQuery(query: BatchQuery): boolean {
  return query.package?.name === VULNERABLE_NAME && query.version === VULNERABLE_VERSION
}

function osvReply(request: RecordedRequest): FakeReply {
  if (request.method !== 'POST') return { status: 404 }
  const body = parsedBody(request) as { queries?: unknown; package?: { name?: unknown } } | undefined
  if (request.path === '/v1/querybatch') {
    if (!Array.isArray(body?.queries)) return { status: 400 }
    const results = (body.queries as BatchQuery[]).map((query) =>
      isVulnerableQuery(query) ? { vulns: [{ id: SEMVER_ADVISORY_ID, modified: ADVISORY_MODIFIED }] } : {},
    )
    return { body: { results } }
  }
  if (request.path === '/v1/query') {
    if (body === undefined) return { status: 400 }
    return { body: body.package?.name === VULNERABLE_NAME ? { vulns: [SEMVER_ADVISORY] } : {} }
  }
  return { status: 404 }
}

export async function startFakeEnrichment(): Promise<FakeEnrichment> {
  const [registry, osv] = await Promise.all([startFakeServer(registryReply), startFakeServer(osvReply)])
  return {
    registryUrl: registry.url,
    osvUrl: osv.url,
    registryPort: registry.port,
    close: async () => {
      await Promise.all([registry.close(), osv.close()])
    },
  }
}
