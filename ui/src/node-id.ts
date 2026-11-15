import { PLACEHOLDER_PREFIX, type NodeId } from '../../src/model.ts'

type NameAndVersion = { name: string; version: string }
export type VariantPeer = { name: string; version: string | undefined }
export type PeerVariant = { position: number; count: number; peers: readonly VariantPeer[]; suffix: string }

const PEER_SUFFIX_START = '('
const PEER_SUFFIX_END = ')'
const VERSION_SEPARATOR = '@'
const PNPM_V6_PREFIX = '/'
const SCOPE_LENGTH = 1

function peerSuffixStart(id: NodeId): number {
  const start = id.indexOf(PEER_SUFFIX_START)
  return start === -1 ? id.length : start
}

function withoutPeerSuffix(id: NodeId): string {
  return id.slice(0, peerSuffixStart(id))
}

function withoutPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

function nameAndVersionOf(id: NodeId): NameAndVersion {
  const bare = withoutPeerSuffix(id)
  const placeholder = bare.startsWith(PLACEHOLDER_PREFIX) ? PLACEHOLDER_PREFIX : ''
  const nameAndVersion = withoutPrefix(bare.slice(placeholder.length), PNPM_V6_PREFIX)
  const separator = nameAndVersion.indexOf(VERSION_SEPARATOR, SCOPE_LENGTH)
  if (separator === -1) return { name: `${placeholder}${nameAndVersion}`, version: '' }
  return { name: `${placeholder}${nameAndVersion.slice(0, separator)}`, version: nameAndVersion.slice(separator + VERSION_SEPARATOR.length) }
}

export function peerSuffixOf(id: NodeId): string {
  return id.slice(peerSuffixStart(id))
}

export function packageNameOf(id: NodeId): string {
  return nameAndVersionOf(id).name
}

export function versionOf(id: NodeId): string {
  return nameAndVersionOf(id).version
}

function topLevelPeersOf(id: NodeId): Map<string, string> {
  const peers = new Map<string, string>()
  let depth = 0
  let current = ''
  for (const character of peerSuffixOf(id)) {
    if (character === PEER_SUFFIX_START) depth++
    if (depth === 1 && character !== PEER_SUFFIX_START && character !== PEER_SUFFIX_END) current += character
    if (character === PEER_SUFFIX_END) depth--
    if (character === PEER_SUFFIX_END && depth === 0) {
      const separator = current.indexOf(VERSION_SEPARATOR, SCOPE_LENGTH)
      if (separator !== -1) peers.set(current.slice(0, separator), current.slice(separator + VERSION_SEPARATOR.length))
      current = ''
    }
  }
  return peers
}

function differingPeerNames(peerSets: readonly Map<string, string>[]): string[] {
  const names = new Set(peerSets.flatMap((peers) => [...peers.keys()]))
  return [...names].filter((name) => new Set(peerSets.map((peers) => peers.get(name))).size > 1).sort((left, right) => left.localeCompare(right, 'en'))
}

export function peerVariantsOf(ids: Iterable<NodeId>): Map<NodeId, PeerVariant> {
  const idsByVersion = new Map<string, Set<NodeId>>()
  for (const id of ids) {
    const key = withoutPeerSuffix(id)
    idsByVersion.set(key, (idsByVersion.get(key) ?? new Set()).add(id))
  }
  const variants = new Map<NodeId, PeerVariant>()
  for (const group of idsByVersion.values()) {
    if (group.size < 2) continue
    const ordered = [...group].sort((left, right) => left.localeCompare(right, 'en'))
    const peerSets = ordered.map(topLevelPeersOf)
    const names = differingPeerNames(peerSets)
    ordered.forEach((id, index) => {
      const peers = names.map((name) => ({ name, version: peerSets[index]?.get(name) }))
      variants.set(id, { position: index + 1, count: ordered.length, peers, suffix: peerSuffixOf(id) })
    })
  }
  return variants
}

export function peerVariantsPerGroup<T>(entries: readonly T[], groupOf: (entry: T) => string, nodeOf: (entry: T) => NodeId): Map<string, Map<NodeId, PeerVariant>> {
  const nodesPerGroup = new Map<string, NodeId[]>()
  for (const entry of entries) nodesPerGroup.set(groupOf(entry), [...(nodesPerGroup.get(groupOf(entry)) ?? []), nodeOf(entry)])
  return new Map([...nodesPerGroup].map(([group, nodes]) => [group, peerVariantsOf(nodes)]))
}
