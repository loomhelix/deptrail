import semver from 'semver'
import type { Advisory, EnrichmentView } from '../enrich/types.ts'
import { IMPORTER_PREFIX, PLACEHOLDER_PREFIX, type NodeId, type PackageNode, type RootGraph } from '../model.ts'
import { compareVersions, packageVersions } from '../query/graph-diff.ts'
import { isAffected } from '../query/versions.ts'
import { importerLabel } from './labels.ts'
import type { ChangeItem, FixGoal, PreviewGoal, UpdateGoal } from './types.ts'

type GoalCheck = Omit<PreviewGoal, 'itemId'>

function parentText(graph: RootGraph, id: NodeId): string {
  if (id.startsWith(IMPORTER_PREFIX)) return importerLabel(id)
  const parent = graph.packages.get(id)
  return parent === undefined ? id : `${parent.name} ${parent.version}`
}

function remainingPathText(graph: RootGraph, nodes: readonly PackageNode[], version: string): string {
  const parent = nodes.find((node) => node.dependents.length > 0)?.dependents[0]
  return parent === undefined ? `${version} is still in the lockfile` : `${version} is still required by ${parentText(graph, parent)}`
}

function loadedAdvisories(view: EnrichmentView, name: string): Advisory[] {
  const loaded = view.advisoriesOf(name)
  return loaded.state === 'ok' || loaded.state === 'stale' ? loaded.advisories : []
}

function packagesNamed(graph: RootGraph, name: string): PackageNode[] {
  return [...graph.packages.values()].filter((node) => node.name === name && !node.id.startsWith(PLACEHOLDER_PREFIX))
}

function checkFix(goal: FixGoal, before: RootGraph, after: RootGraph, view: EnrichmentView): GoalCheck {
  const remaining = packagesNamed(after, goal.name)
  const targeted = remaining.filter((node) => node.version === goal.version)
  if (targeted.length > 0) return { met: false, detail: remainingPathText(after, targeted, goal.version) }
  const versions = [...new Set(remaining.map((node) => node.version))].sort(compareVersions)
  const previous = packageVersions(before).get(goal.name)
  const advisories = loadedAdvisories(view, goal.name)
  for (const version of versions.filter((candidate) => !previous?.has(candidate))) {
    const advisory = advisories.find((candidate) => isAffected(version, candidate))
    if (advisory !== undefined) return { met: false, detail: `${version} is affected by ${advisory.id}` }
  }
  if (versions.length === 0) return { met: true, detail: `${goal.name} is no longer in the lockfile` }
  return { met: true, detail: `no affected version left (${versions.join(', ')})` }
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('')
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

function reachesTarget(version: string, target: string): boolean {
  return semver.valid(version) !== null && semver.valid(target) !== null && semver.gte(version, target)
}

function outsideWrittenRange(version: string, range: string): boolean {
  return semver.validRange(range) !== null && semver.valid(version) !== null && !semver.satisfies(version, range)
}

function checkUpdate(goal: UpdateGoal, after: RootGraph): GoalCheck {
  const resolved = new Set<string>()
  for (const importerId of goal.importers) {
    const label = importerLabel(importerId)
    const importer = after.importers.find((candidate) => candidate.id === importerId)
    const resolutions = (importer?.deps ?? []).flatMap((edge) => {
      const node = edge.kind === 'peer' ? undefined : after.packages.get(edge.to)
      return node?.name === goal.name ? [{ range: edge.range, version: node.version }] : []
    })
    if (resolutions.length === 0) return { met: false, detail: `${label} no longer depends on ${goal.name}` }
    for (const { range, version } of resolutions) {
      if (!reachesTarget(version, goal.target)) return { met: false, detail: `${label} resolves ${goal.name} ${version}, below ${goal.target}` }
      if (outsideWrittenRange(version, range)) return { met: false, detail: `${label} resolves ${goal.name} ${version}, outside ${range}` }
      resolved.add(version)
    }
  }
  const versions = [...resolved].sort(compareVersions).join(', ')
  return { met: true, detail: `${goal.name} ${versions} in ${joinLabels(goal.importers.map(importerLabel))}` }
}

export function checkGoals(items: readonly ChangeItem[], before: RootGraph, after: RootGraph, view: EnrichmentView): PreviewGoal[] {
  return items.map((item) => ({
    itemId: item.id,
    ...(item.goal.kind === 'fix' ? checkFix(item.goal, before, after, view) : checkUpdate(item.goal, after)),
  }))
}
