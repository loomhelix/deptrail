import { posix } from 'node:path'
import type { DirEntry } from '../sources/file-reader.ts'

export type TreeIndex = {
  directories: ReadonlyMap<string, readonly DirEntry[]>
  blobs: ReadonlyMap<string, string>
  kinds: ReadonlyMap<string, DirEntry['kind']>
  submodules: readonly string[]
}

export class TreeTooLargeError extends Error {
  constructor(maxEntries: number) {
    super(`the tree has more than ${maxEntries} entries`)
    this.name = 'TreeTooLargeError'
  }
}

const KIND_BY_MODE: Record<string, DirEntry['kind']> = {
  '040000': 'dir',
  '100644': 'file',
  '100755': 'file',
  '120000': 'symlink',
}

const TOP = '.'
const SUBMODULE_MODE = '160000'
const PARENT_PREFIX = '..'

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '')
}

function parentOf(fullPath: string): string {
  const slash = fullPath.lastIndexOf('/')
  return slash === -1 ? '' : fullPath.slice(0, slash)
}

function nameOf(fullPath: string): string {
  return fullPath.slice(fullPath.lastIndexOf('/') + 1)
}

function keyOf(fullPath: string, root: string): string {
  if (fullPath === root) return TOP
  if (root === '') return fullPath
  if (fullPath.startsWith(`${root}/`)) return fullPath.slice(root.length + 1)
  return posix.relative(root, fullPath)
}

export function parseTree(output: Buffer, prefix: string, maxEntries: number): TreeIndex {
  const root = normalizePrefix(prefix)
  const listings = new Map<string, DirEntry[]>([['', []]])
  const blobs = new Map<string, string>()
  const kinds = new Map<string, DirEntry['kind']>()
  const submodules: string[] = []
  let count = 0
  let start = 0
  while (start < output.length) {
    let end = output.indexOf(0, start)
    if (end === -1) end = output.length
    const record = output.subarray(start, end).toString('utf8')
    start = end + 1
    if (record === '') continue
    count += 1
    if (count > maxEntries) throw new TreeTooLargeError(maxEntries)
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode = '', , id = ''] = record.slice(0, tab).split(' ')
    const fullPath = record.slice(tab + 1)
    if (mode === SUBMODULE_MODE) {
      const key = keyOf(fullPath, root)
      if (!key.startsWith(PARENT_PREFIX)) submodules.push(key)
      continue
    }
    const kind = KIND_BY_MODE[mode]
    if (!kind || fullPath === '') continue
    const parent = parentOf(fullPath)
    let siblings = listings.get(parent)
    if (!siblings) {
      siblings = []
      listings.set(parent, siblings)
    }
    siblings.push({ name: nameOf(fullPath), kind })
    const key = keyOf(fullPath, root)
    kinds.set(key, kind)
    if (kind === 'dir' && !listings.has(fullPath)) listings.set(fullPath, [])
    if (kind === 'file') blobs.set(key, id)
  }
  const directories = new Map<string, readonly DirEntry[]>([...listings].map(([fullPath, entries]) => [keyOf(fullPath, root), entries]))
  if (!directories.has(TOP)) directories.set(TOP, [])
  return { directories, blobs, kinds, submodules }
}
