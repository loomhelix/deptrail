import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { packageNameOf, peerSuffixOf, peerVariantsOf, versionOf } from '../ui/src/node-id.ts'

describe('packageNameOf', () => {
  it('reads the package name from a node id', () => {
    assert.equal(packageNameOf('child-lib@1.0.0'), 'child-lib')
    assert.equal(packageNameOf('@vue/shared@3.5.13'), '@vue/shared')
    assert.equal(packageNameOf('vue-router@4.4.5(vue@3.5.13)'), 'vue-router')
    assert.equal(packageNameOf('@acme/ui@file:../ui'), '@acme/ui')
    assert.equal(packageNameOf('plain-name'), 'plain-name')
  })
})

describe('versionOf', () => {
  it('reads the version from a node id without its peer suffix', () => {
    assert.equal(versionOf('helper@1.0.0'), '1.0.0')
    assert.equal(versionOf('@vue/shared@3.5.13'), '3.5.13')
    assert.equal(versionOf('vue-router@4.4.5(vue@3.5.13)'), '4.4.5')
    assert.equal(versionOf('@acme/ui@file:../ui'), 'file:../ui')
    assert.equal(versionOf('plain-name'), '')
  })
})

describe('ids with a prefix, a scope, a peer suffix or an alias', () => {
  const CASES: { id: string; name: string; version: string; peerSuffix: string }[] = [
    { id: '/@types/node@20.17.9', name: '@types/node', version: '20.17.9', peerSuffix: '' },
    { id: '/@scope/x@1.0.0(peer@1.0.0)', name: '@scope/x', version: '1.0.0', peerSuffix: '(peer@1.0.0)' },
    { id: '/lodash@4.17.21', name: 'lodash', version: '4.17.21', peerSuffix: '' },
    { id: '?:@scope/x@^1.0.0', name: '?:@scope/x', version: '^1.0.0', peerSuffix: '' },
    { id: '?:/@scope/x@1.0.0', name: '?:@scope/x', version: '1.0.0', peerSuffix: '' },
    { id: 'foo@npm:bar@1.0.0', name: 'foo', version: 'npm:bar@1.0.0', peerSuffix: '' },
    { id: '@scope/x@1.0.0(b@2.0.0)', name: '@scope/x', version: '1.0.0', peerSuffix: '(b@2.0.0)' },
    { id: 'importer:apps/web', name: 'importer:apps/web', version: '', peerSuffix: '' },
  ]

  for (const { id, name, version, peerSuffix } of CASES) {
    it(`reads ${id}`, () => {
      assert.deepEqual({ name: packageNameOf(id), version: versionOf(id), peerSuffix: peerSuffixOf(id) }, { name, version, peerSuffix })
    })
  }
})

describe('peerSuffixOf', () => {
  it('keeps the peer suffix of a node id and nothing without one', () => {
    assert.equal(peerSuffixOf('react-dom@18.2.0(react@18.2.0)'), '(react@18.2.0)')
    assert.equal(peerSuffixOf('@vue/compiler-sfc@3.5.13(vue@3.5.13)(typescript@5.6.0)'), '(vue@3.5.13)(typescript@5.6.0)')
    assert.equal(peerSuffixOf('helper@1.0.0'), '')
    assert.equal(peerSuffixOf('importer:web'), '')
  })
})

describe('peerVariantsOf', () => {
  it('numbers the variants of one version and names only the peers that differ', () => {
    const first = 'nuxt@4.6.1(confbox@0.2.2)(srvx@0.9.1)(vite@7.3.7(sass@1.0.0))'
    const second = 'nuxt@4.6.1(confbox@0.2.4)(vite@7.3.7(sass@1.0.0))'
    const variants = peerVariantsOf([second, 'helper@1.0.0', first])
    assert.deepEqual([...variants.keys()].sort(), [first, second])
    assert.deepEqual(variants.get(first), {
      position: 1,
      count: 2,
      peers: [
        { name: 'confbox', version: '0.2.2' },
        { name: 'srvx', version: '0.9.1' },
      ],
      suffix: '(confbox@0.2.2)(srvx@0.9.1)(vite@7.3.7(sass@1.0.0))',
    })
    assert.deepEqual(variants.get(second)?.peers, [
      { name: 'confbox', version: '0.2.4' },
      { name: 'srvx', version: undefined },
    ])
    assert.equal(variants.get(second)?.position, 2)
  })

  it('reads scoped peers and ignores the peers nested inside a peer', () => {
    const variants = peerVariantsOf([
      'x@1.0.0(@types/node@25.9.9)(vite@7.0.0(@types/node@25.9.9))',
      'x@1.0.0(@types/node@24.0.0)(vite@7.0.0(@types/node@24.0.0))',
    ])
    assert.deepEqual(
      [...variants.values()].map((variant) => variant.peers),
      [[{ name: '@types/node', version: '24.0.0' }], [{ name: '@types/node', version: '25.9.9' }]],
    )
  })

  it('names no peers when pnpm shortened the suffix to a hash', () => {
    const variants = peerVariantsOf(['@nuxt/nitro-server@4.6.1(154c60b31fb8837c845aae682568aac0)', '@nuxt/nitro-server@4.6.1(0b3c96a5f311dc6b591f670b3b7dbfa4)'])
    assert.deepEqual(
      [...variants.values()].map((variant) => [variant.position, variant.count, variant.peers]),
      [
        [1, 2, []],
        [2, 2, []],
      ],
    )
  })

  it('leaves a package with a single node unnumbered, even when the same id repeats', () => {
    assert.equal(peerVariantsOf(['a@1.0.0(b@1.0.0)', 'a@1.0.0(b@1.0.0)', 'a@2.0.0(b@1.0.0)']).size, 0)
  })
})
