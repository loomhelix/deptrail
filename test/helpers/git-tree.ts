import { createHash } from 'node:crypto'
import { readdir, readFile, readlink } from 'node:fs/promises'
import path, { posix } from 'node:path'
import { parseTree, type TreeIndex } from '../../src/git/tree-index.ts'

export type MemoryFile = string | { symlink: string }
export type MemoryTree = { index: TreeIndex; readBlob(blobId: string): Promise<Buffer | null> }

const TREE_ENTRY_LIMIT = 2_000_000
const DIRECTORY_ID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SKIPPED_DIRECTORY = '.git'

export function treeBuffer(entries: [mode: string, type: string, id: string, path: string][]): Buffer {
  const records = entries.map(([mode, type, id, entryPath]) => `${mode} ${type} ${id}\t${entryPath}`)
  return Buffer.from(records.length === 0 ? '' : records.join('\0') + '\0', 'utf8')
}

function blobIdOf(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

function parentDirectories(filePath: string): string[] {
  const parents: string[] = []
  for (let parent = posix.dirname(filePath); parent !== '.'; parent = posix.dirname(parent)) parents.unshift(parent)
  return parents
}

export function memoryTree(files: Record<string, MemoryFile>, prefix = ''): MemoryTree {
  const contents = new Map<string, Buffer>()
  const directories = new Set<string>()
  const entries: [string, string, string, string][] = []
  for (const filePath of Object.keys(files).sort()) {
    for (const directory of parentDirectories(filePath)) {
      if (directories.has(directory)) continue
      directories.add(directory)
      entries.push(['040000', 'tree', DIRECTORY_ID, directory])
    }
    const file = files[filePath]
    const text = typeof file === 'string' ? file : file.symlink
    const id = blobIdOf(text)
    contents.set(id, Buffer.from(text, 'utf8'))
    entries.push([typeof file === 'string' ? '100644' : '120000', 'blob', id, filePath])
  }
  return {
    index: parseTree(treeBuffer(entries), prefix, TREE_ENTRY_LIMIT),
    readBlob: async (blobId) => contents.get(blobId) ?? null,
  }
}

async function collectFiles(dir: string, relative: string, files: Record<string, MemoryFile>): Promise<void> {
  for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
    if (entry.name === SKIPPED_DIRECTORY) continue
    const entryPath = relative === '' ? entry.name : posix.join(relative, entry.name)
    const absolute = path.join(dir, entryPath)
    if (entry.isSymbolicLink()) files[entryPath] = { symlink: await readlink(absolute) }
    else if (entry.isDirectory()) await collectFiles(dir, entryPath, files)
    else if (entry.isFile()) files[entryPath] = await readFile(absolute, 'utf8')
  }
}

export async function directoryTree(dir: string): Promise<MemoryTree> {
  const files: Record<string, MemoryFile> = {}
  await collectFiles(dir, '', files)
  return memoryTree(files)
}
