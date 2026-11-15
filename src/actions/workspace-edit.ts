import { isMap, isScalar, parseDocument, YAMLMap, type Document } from 'yaml'

export class WorkspaceEditError extends Error {}

const UNINDENTED_SEQUENCE = /^( *)[^\s#-][^\n]*:[ \t]*(?:#[^\n]*)?\r?\n\1- /m
const INDENTED_MAPPING_LINE = /^( +)[^\s#-][^\n]*:/m
const DEFAULT_INDENT = 2

function indentOf(source: string): number {
  return INDENTED_MAPPING_LINE.exec(source)?.[1].length ?? DEFAULT_INDENT
}

function prepareIntermediateMaps(document: Document, path: readonly string[]): void {
  if (document.contents !== null && !isMap(document.contents)) {
    throw new WorkspaceEditError('The workspace file is not a map')
  }
  for (let length = 1; length < path.length; length++) {
    const prefix = path.slice(0, length)
    const node = document.getIn(prefix, true)
    if (node === undefined) return
    if (isScalar(node) && node.value === null) document.setIn(prefix, new YAMLMap())
    else if (!isMap(node)) throw new WorkspaceEditError(`${prefix.join('.')} is not a map`)
  }
}

export function setWorkspaceString(text: string | null, path: readonly string[], value: string): string {
  const source = text ?? ''
  const document = parseDocument(source)
  if (document.errors.length > 0) throw new WorkspaceEditError(document.errors[0].message)
  prepareIntermediateMaps(document, path)
  document.setIn(path, value)
  return document.toString({ lineWidth: 0, indent: indentOf(source), indentSeq: !UNINDENTED_SEQUENCE.test(source) })
}
