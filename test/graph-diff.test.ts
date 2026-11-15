import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { graphDiff, packageVersions } from '../src/query/graph-diff.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import { makeGraph } from './helpers/graph-factory.ts'

function graphOf(...ids: string[]) {
  return makeGraph({ importers: { app: ids }, packages: Object.fromEntries(ids.map((id) => [id, []])) })
}

function peerSuffixedGraph(peerSuffix: string) {
  const builder = new RootGraphBuilder({ id: 'test-root', path: '.', manager: 'pnpm', source: 'lockfile' })
  builder.addPackage(`vue-eslint-parser@9.4.3${peerSuffix}`, 'vue-eslint-parser', '9.4.3', peerSuffix)
  return builder.build()
}

describe('graphDiff', () => {
  it('reports a changed version', () => {
    assert.deepEqual(graphDiff(graphOf('semver@5.7.2'), graphOf('semver@5.7.3')), [
      { name: 'semver', removed: ['5.7.2'], added: ['5.7.3'] },
    ])
  })

  it('ignores peer suffix changes', () => {
    const before = peerSuffixedGraph('(eslint@9.17.0)')
    const after = peerSuffixedGraph('(eslint@9.18.0)')
    assert.deepEqual(graphDiff(before, after), [])
  })

  it('reports an added package', () => {
    assert.deepEqual(graphDiff(graphOf('semver@5.7.2'), graphOf('semver@5.7.2', 'esbuild@0.24.0')), [
      { name: 'esbuild', removed: [], added: ['0.24.0'] },
    ])
  })

  it('ignores placeholder nodes', () => {
    const withPlaceholder = makeGraph({ importers: { app: [] }, packages: { '?:ghost@1.0.0': [] } })
    assert.deepEqual(graphDiff(graphOf('semver@5.7.2'), graphOf('semver@5.7.2')), [])
    assert.equal(packageVersions(withPlaceholder).size, 0)
  })

  it('sorts names and versions', () => {
    const before = graphOf('zlib@1.0.0', 'a@1.10.0', 'a@1.2.0')
    const after = graphOf('zlib@1.0.0')
    assert.deepEqual(graphDiff(before, after), [{ name: 'a', removed: ['1.2.0', '1.10.0'], added: [] }])
    const sorted = graphDiff(graphOf(), graphOf('z@1.0.0', 'b@1.0.0'))
    assert.deepEqual(sorted.map((change) => change.name), ['b', 'z'])
  })

  it('puts invalid versions last', () => {
    const changes = graphDiff(graphOf(), graphOf('a@weird', 'a@1.0.0'))
    assert.deepEqual(changes[0].added, ['1.0.0', 'weird'])
  })
})
