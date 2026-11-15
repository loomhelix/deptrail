import { rootLabel } from '../../src/actions/labels.ts'
import { IMPORTER_PREFIX, type NodeId, type SourceKind } from '../../src/model.ts'
import { packageNameOf, versionOf } from './node-id.ts'

export { rootLabel }

export const APPROXIMATE_SOURCES: ReadonlySet<SourceKind> = new Set<SourceKind>(['resolved-today', 'manifest-only'])

const COUNT_FORMAT = new Intl.NumberFormat('en-US')
const PATH_SEPARATOR = '/'
const NAME_WRAP_POINT = /(?<=[/.])/
const REPOSITORY_ROOT_PATH = '.'
const PARENT_DIRECTORY = '..'

export function countLabel(count: number, singular: string, plural: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? singular : plural}`
}

export function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`
}

export function nodeLabel(node: { name: string; version: string; isImporter: boolean }): string {
  return node.isImporter ? node.name : `${node.name} ${node.version}`.trim()
}

export function nodeIdLabel(id: NodeId): string {
  if (id.startsWith(IMPORTER_PREFIX)) return rootLabel(id.slice(IMPORTER_PREFIX.length))
  const version = versionOf(id)
  return version === '' ? packageNameOf(id) : `${packageNameOf(id)} ${version}`
}

export function slashSegments(text: string): string[] {
  const segments = text.split(PATH_SEPARATOR)
  return segments.map((segment, index) => (index < segments.length - 1 ? `${segment}${PATH_SEPARATOR}` : segment))
}

const WORD_SEPARATOR = ' '

export function pathWords(text: string): string[][] {
  return text.split(WORD_SEPARATOR).map(slashSegments)
}

export function nameSegments(name: string): string[] {
  return name.split(NAME_WRAP_POINT)
}

function pathSegmentsOf(path: string): string[] {
  return path === REPOSITORY_ROOT_PATH ? [] : path.split(PATH_SEPARATOR)
}

export function pathFromRoot(rootPath: string, packagePath: string): string {
  const rootSegments = pathSegmentsOf(rootPath)
  const packageSegments = pathSegmentsOf(packagePath)
  let shared = 0
  while (shared < rootSegments.length && rootSegments[shared] === packageSegments[shared]) shared++
  return [...rootSegments.slice(shared).map(() => PARENT_DIRECTORY), ...packageSegments.slice(shared)].join(PATH_SEPARATOR)
}
