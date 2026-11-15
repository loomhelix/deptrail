import semver from 'semver'
import type { GlobalIndex } from '../graph/global-index.ts'

export type DuplicateEntry = { name: string; versions: { version: string; roots: string[] }[] }

export function duplicates(index: GlobalIndex, rootId?: string): DuplicateEntry[] {
  const found: DuplicateEntry[] = []
  for (const [name, entries] of index) {
    const rootsByVersion = new Map<string, Set<string>>()
    for (const entry of entries) {
      if (rootId !== undefined && entry.rootId !== rootId) continue
      if (semver.valid(entry.version) === null) continue
      const roots = rootsByVersion.get(entry.version) ?? new Set<string>()
      roots.add(entry.rootId)
      rootsByVersion.set(entry.version, roots)
    }
    if (rootsByVersion.size < 2) continue
    const versions = [...rootsByVersion]
      .sort(([left], [right]) => semver.rcompare(left, right))
      .map(([version, roots]) => ({ version, roots: [...roots].sort() }))
    found.push({ name, versions })
  }
  return found.sort((left, right) => right.versions.length - left.versions.length || (left.name < right.name ? -1 : 1))
}
