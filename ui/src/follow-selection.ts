import type { JobKind } from '../../src/actions/types.ts'
import { IMPORTER_PREFIX, type NodeId } from '../../src/model.ts'
import type { RootSummary, SearchHit } from './api.ts'
import type { Selection } from './context.ts'
import { nodeIdLabel, rootLabel } from './labels.ts'
import { packageNameOf, peerVariantsOf, peerVariantsPerGroup, versionOf, type PeerVariant } from './node-id.ts'
import { noLongerInRootText, notInAnyRootText, notInRootSentence, openInRootText, openVariantInRootText, packageVariantText } from './vocabulary.ts'

export type FollowOption = { node: NodeId; version: string }
export type FollowLocation = { root: string; node: NodeId; version: string }
export type FollowOutcome =
  | { kind: 'moved'; node: NodeId; version: string }
  | { kind: 'choose'; options: FollowOption[] }
  | { kind: 'elsewhere'; roots: FollowLocation[] }
  | { kind: 'gone' }
export type MissingOutcome = Exclude<FollowOutcome, { kind: 'moved' }>
export type FollowLink = { label: string; selection: Selection; opensRoot: boolean }
export type FollowLinkAction = 'open-in-root' | 'choose' | 'select'
export type SelectionHistory = { wasShownInRoot: boolean }

function variantsPerRoot(locations: readonly FollowLocation[]): Map<string, Map<NodeId, PeerVariant>> {
  return peerVariantsPerGroup(
    locations,
    (location) => location.root,
    (location) => location.node,
  )
}

function variantLabel(location: FollowLocation, variants: ReadonlyMap<string, ReadonlyMap<NodeId, PeerVariant>>): string {
  return packageVariantText(packageNameOf(location.node), location.version, variants.get(location.root)?.get(location.node))
}

function locationsOf(name: string, hits: readonly SearchHit[]): FollowLocation[] {
  return hits
    .filter((hit) => hit.name === name)
    .flatMap((hit) => hit.versions.flatMap((entry) => entry.roots.map((location) => ({ root: location.rootId, node: location.nodeId, version: entry.version }))))
}

function nearestFirst(locations: readonly FollowLocation[], selection: Selection): FollowLocation[] {
  const version = versionOf(selection.node)
  const inRoot = locations.filter((location) => location.root === selection.root)
  const elsewhere = locations.filter((location) => location.root !== selection.root)
  const sameVersion = elsewhere.filter((location) => location.version === version)
  const otherVersions = elsewhere.filter((location) => location.version !== version)
  return [...inRoot, ...sameVersion, ...otherVersions]
}

function neverShownOutcome(selection: Selection, candidates: readonly FollowLocation[]): MissingOutcome {
  if (selection.node.startsWith(IMPORTER_PREFIX)) return { kind: 'elsewhere', roots: [] }
  if (candidates.length === 0) return { kind: 'gone' }
  return { kind: 'elsewhere', roots: nearestFirst(candidates, selection) }
}

export function followOutcome(selection: Selection, hits: readonly SearchHit[], history: SelectionHistory): FollowOutcome {
  const candidates = locationsOf(packageNameOf(selection.node), hits).filter(
    (location) => location.root !== selection.root || location.node !== selection.node,
  )
  if (!history.wasShownInRoot) return neverShownOutcome(selection, candidates)
  if (selection.node.startsWith(IMPORTER_PREFIX)) return { kind: 'choose', options: [] }
  const inRoot = candidates.filter((location) => location.root === selection.root)
  const [onlyOne] = inRoot
  if (inRoot.length === 1 && onlyOne !== undefined) return { kind: 'moved', node: onlyOne.node, version: onlyOne.version }
  if (inRoot.length > 1) return { kind: 'choose', options: inRoot.map(({ node, version }) => ({ node, version })) }
  if (candidates.length === 0) return { kind: 'gone' }
  return { kind: 'elsewhere', roots: nearestFirst(candidates, selection) }
}

export function movedVariants(
  hits: readonly SearchHit[],
  name: string,
  root: string,
  fromNode: NodeId,
  toNode: NodeId,
): { from: PeerVariant; to: PeerVariant } | undefined {
  const nodesInRoot = locationsOf(name, hits)
    .filter((location) => location.root === root)
    .map((location) => location.node)
  const variants = peerVariantsOf([...nodesInRoot, fromNode, toNode])
  const from = variants.get(fromNode)
  const to = variants.get(toNode)
  return from === undefined || to === undefined ? undefined : { from, to }
}

export function shouldFollow(root: RootSummary | undefined): boolean {
  return root !== undefined && root.status === 'ready' && root.actions.job?.state !== 'running'
}

export function finishedJobOf(root: RootSummary | undefined): string | null {
  const job = root?.actions.job
  return job !== undefined && job.state !== 'running' ? job.id : null
}

export function jobBehindChange(root: RootSummary, finishedJobAtLastLoad: string | null | undefined): JobKind | undefined {
  const job = root.actions.job
  if (finishedJobAtLastLoad === undefined || job === undefined || job.state === 'running') return undefined
  if (job.state !== 'done') return undefined
  return job.id === finishedJobAtLastLoad ? undefined : job.kind
}

export function missingSelectionText(selection: Selection, outcome: MissingOutcome): string {
  switch (outcome.kind) {
    case 'choose':
      return noLongerInRootText(nodeIdLabel(selection.node), selection.root)
    case 'elsewhere':
      return notInRootSentence(nodeIdLabel(selection.node), selection.root)
    case 'gone':
      return notInAnyRootText(packageNameOf(selection.node))
  }
}

function openInRootLabel(selection: Selection, location: FollowLocation, variants: ReadonlyMap<string, ReadonlyMap<NodeId, PeerVariant>>): string {
  const where = rootLabel(location.root)
  return location.node === selection.node ? openInRootText(where) : openVariantInRootText(variantLabel(location, variants), where)
}

function elsewhereLink(selection: Selection, location: FollowLocation, variants: ReadonlyMap<string, ReadonlyMap<NodeId, PeerVariant>>): FollowLink {
  const target = { root: location.root, node: location.node }
  if (location.root === selection.root) return { label: variantLabel(location, variants), selection: target, opensRoot: false }
  return { label: openInRootLabel(selection, location, variants), selection: target, opensRoot: true }
}

export function followLinks(selection: Selection, outcome: MissingOutcome): FollowLink[] {
  switch (outcome.kind) {
    case 'choose': {
      const options = outcome.options.map((option) => ({ root: selection.root, node: option.node, version: option.version }))
      const variants = variantsPerRoot(options)
      return options.map((option) => ({
        label: variantLabel(option, variants),
        selection: { root: selection.root, node: option.node },
        opensRoot: false,
      }))
    }
    case 'elsewhere': {
      const variants = variantsPerRoot(outcome.roots)
      return outcome.roots.map((location) => elsewhereLink(selection, location, variants))
    }
    case 'gone':
      return []
  }
}

export function followLinkAction(outcome: MissingOutcome | null | undefined, link: FollowLink): FollowLinkAction {
  if (link.opensRoot) return 'open-in-root'
  return outcome?.kind === 'choose' ? 'choose' : 'select'
}
