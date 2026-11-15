import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { firstNodesByLayer, type MergedRoot } from '../ui/src/graph/whole-root.ts'
import type { SearchHit } from '../src/query/search.ts'
import { loadRootVariants, variantNodeRefs } from '../ui/src/graph/root-variants.ts'

const ROOT = 'shop'
const FIRST = 'react-dom@18.3.1(react@18.3.1)'
const SECOND = 'react-dom@18.3.1(react@18.3.2)'
const THIRD = 'react-dom@18.3.1(react@18.3.3)'

function hitsFor(nodeIds: string[]): SearchHit[] {
  return [{ name: 'react-dom', versions: [{ version: '18.3.1', roots: nodeIds.map((nodeId) => ({ rootId: ROOT, nodeId })) }] }]
}

function refs(ids: string[]): { id: string; name: string }[] {
  return ids.map((id) => ({ id, name: id.slice(0, id.indexOf('@', 1)) }))
}

describe('loadRootVariants', () => {
  it('numbers the drawn variants over every variant of the root and searches once per name', async () => {
    const searched: string[] = []
    const search = async (name: string): Promise<SearchHit[]> => {
      searched.push(name)
      return hitsFor([FIRST, SECOND, THIRD])
    }
    const variants = await loadRootVariants(ROOT, refs([FIRST, THIRD, 'semver@7.0.0']), search)
    assert.equal(variants.get(FIRST)?.position, 1)
    assert.equal(variants.get(FIRST)?.count, 3)
    assert.equal(variants.get(THIRD)?.position, 3)
    assert.equal(variants.get(THIRD)?.count, 3)
    assert.equal(variants.has('semver@7.0.0'), false)
    assert.deepEqual(searched, ['react-dom'])
  })

  it('does not search when no drawn node has a peer suffix', async () => {
    let calls = 0
    const variants = await loadRootVariants(ROOT, refs(['semver@7.0.0']), async () => {
      calls++
      return []
    })
    assert.equal(calls, 0)
    assert.equal(variants.size, 0)
  })

  it('numbers over the drawn nodes when the search is rejected', async () => {
    const variants = await loadRootVariants(ROOT, refs([FIRST, THIRD]), async () => {
      throw new Error('offline')
    })
    assert.deepEqual(
      [variants.get(FIRST)?.position, variants.get(FIRST)?.count, variants.get(THIRD)?.position, variants.get(THIRD)?.count],
      [1, 2, 2, 2],
    )
  })

  it('searches by the server name, not by the name inside the id', async () => {
    const searched: string[] = []
    const id = 'https://host/lib.git@abc(x@1.0.0)'
    await loadRootVariants(ROOT, [{ id, name: 'lib' }], async (name) => {
      searched.push(name)
      return []
    })
    assert.deepEqual(searched, ['lib'])
  })

  it('does not search for a name whose only peer-suffixed node is outside the drawn nodes', async () => {
    const node = (id: string, name: string, layer: number) => ({ node: { id, name, version: '1', isImporter: false }, layer })
    const merged = {
      nodes: [node('semver@7.0.0', 'semver', 0), node(FIRST, 'react-dom', 5)],
      edges: [],
      reachedBy: new Map(),
      truncated: false,
    } as unknown as MergedRoot
    const searched: string[] = []
    await loadRootVariants(ROOT, variantNodeRefs(firstNodesByLayer(merged, 1).nodes), async (name) => {
      searched.push(name)
      return []
    })
    assert.deepEqual(searched, [])
  })
})
