import { RootGraphBuilder } from '../../src/graph/root-graph-builder.ts'
import { IMPORTER_PREFIX, type DepKind, type Edge, type RootGraph } from '../../src/model.ts'

export type GraphSpec = { importers: Record<string, string[]>; packages: Record<string, string[]> }

const KIND_PREFIXES: DepKind[] = ['dev', 'optional', 'peer']

function splitPackageId(id: string): { name: string; version: string } {
  const separator = id.lastIndexOf('@')
  if (separator <= 0) return { name: id, version: '' }
  return { name: id.slice(0, separator), version: id.slice(separator + 1) }
}

function defaultRange(to: string): string {
  return to.startsWith(IMPORTER_PREFIX) ? '' : splitPackageId(to).version
}

function parseTarget(target: string): Edge {
  const kind = KIND_PREFIXES.find((candidate) => target.startsWith(`${candidate}:`)) ?? 'prod'
  const unprefixed = kind === 'prod' ? target : target.slice(kind.length + 1)
  const rangeSeparator = unprefixed.indexOf(' ')
  if (rangeSeparator === -1) return { to: unprefixed, kind, range: defaultRange(unprefixed) }
  return { to: unprefixed.slice(0, rangeSeparator), kind, range: unprefixed.slice(rangeSeparator + 1) }
}

export function makeGraph(spec: GraphSpec): RootGraph {
  const builder = new RootGraphBuilder({ id: 'test-root', path: '.', manager: 'pnpm', source: 'lockfile' })
  for (const path of Object.keys(spec.importers)) builder.addImporter(path, path)
  for (const id of Object.keys(spec.packages)) {
    const { name, version } = splitPackageId(id)
    builder.addPackage(id, name, version)
  }
  for (const [path, targets] of Object.entries(spec.importers)) {
    for (const target of targets) builder.addEdge(IMPORTER_PREFIX + path, parseTarget(target))
  }
  for (const [id, targets] of Object.entries(spec.packages)) {
    for (const target of targets) builder.addEdge(id, parseTarget(target))
  }
  return builder.build()
}

export function makeFanIn(count: number): RootGraph {
  const importerCount = 10
  const importers: Record<string, string[]> = {}
  for (let index = 0; index < importerCount; index++) importers[`app${index}`] = []
  const packages: Record<string, string[]> = { 'tslib@2.6.0': [] }
  for (let index = 0; index < count; index++) {
    const id = `p${index}@1.0.0`
    packages[id] = ['tslib@2.6.0']
    importers[`app${index % importerCount}`].push(id)
  }
  return makeGraph({ importers, packages })
}
