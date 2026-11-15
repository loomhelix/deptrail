import type { NodeId } from '../../../src/model.ts'
import type { SearchHit } from '../../../src/query/search.ts'
import { peerSuffixOf, peerVariantsOf, type PeerVariant } from '../node-id.ts'
import { variantInRoot } from '../why-here.ts'

type Search = (name: string) => Promise<readonly SearchHit[]>
export type VariantNodeRef = { id: NodeId; name: string }

export function variantNodeRefs(entries: readonly { node: VariantNodeRef }[]): VariantNodeRef[] {
  return entries.map((entry) => ({ id: entry.node.id, name: entry.node.name }))
}

function namesWithPeerSuffix(nodes: readonly VariantNodeRef[]): Set<string> {
  return new Set(nodes.filter((node) => peerSuffixOf(node.id) !== '').map((node) => node.name))
}

async function variantsOfName(root: string, name: string, nodes: readonly VariantNodeRef[], search: Search): Promise<[NodeId, PeerVariant | undefined][]> {
  try {
    const hits = await search(name)
    return nodes.map((node) => [node.id, variantInRoot(hits, name, root, node.id)])
  } catch {
    const drawn = peerVariantsOf(nodes.map((node) => node.id))
    return nodes.map((node) => [node.id, drawn.get(node.id)])
  }
}

export async function loadRootVariants(root: string, nodes: readonly VariantNodeRef[], search: Search): Promise<Map<NodeId, PeerVariant>> {
  const perName = await Promise.all(
    [...namesWithPeerSuffix(nodes)].map((name) =>
      variantsOfName(
        root,
        name,
        nodes.filter((node) => node.name === name),
        search,
      ),
    ),
  )
  const variants = new Map<NodeId, PeerVariant>()
  for (const [id, variant] of perName.flat()) if (variant !== undefined) variants.set(id, variant)
  return variants
}
