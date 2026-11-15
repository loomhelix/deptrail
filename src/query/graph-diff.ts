import semver from 'semver'
import { PLACEHOLDER_PREFIX, type RootGraph } from '../model.ts'

export type PackageChange = { name: string; removed: string[]; added: string[] }

export function packageVersions(graph: RootGraph): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>()
  for (const node of graph.packages.values()) {
    if (node.id.startsWith(PLACEHOLDER_PREFIX)) continue
    const known = versions.get(node.name)
    if (known) known.add(node.version)
    else versions.set(node.name, new Set([node.version]))
  }
  return versions
}

export function compareVersions(left: string, right: string): number {
  const leftValid = semver.valid(left) !== null
  const rightValid = semver.valid(right) !== null
  if (leftValid && rightValid) return semver.compare(left, right)
  if (leftValid) return -1
  if (rightValid) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function onlyIn(source: Set<string> | undefined, other: Set<string> | undefined): string[] {
  return [...(source ?? [])].filter((version) => !other?.has(version)).sort(compareVersions)
}

export function graphDiff(before: RootGraph, after: RootGraph): PackageChange[] {
  const beforeVersions = packageVersions(before)
  const afterVersions = packageVersions(after)
  const names = [...new Set([...beforeVersions.keys(), ...afterVersions.keys()])].sort()
  const changes: PackageChange[] = []
  for (const name of names) {
    const removed = onlyIn(beforeVersions.get(name), afterVersions.get(name))
    const added = onlyIn(afterVersions.get(name), beforeVersions.get(name))
    if (removed.length > 0 || added.length > 0) changes.push({ name, removed, added })
  }
  return changes
}
