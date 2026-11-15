import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rootLabel as serverRootLabel } from '../src/actions/labels.ts'
import { nameSegments, nodeIdLabel, nodeLabel, npmPackageUrl, pathFromRoot, pathWords, rootLabel, slashSegments } from '../ui/src/labels.ts'

describe('ui labels', () => {
  it('links scoped and unscoped names to npm without encoding the scope', () => {
    assert.equal(npmPackageUrl('semver'), 'https://www.npmjs.com/package/semver')
    assert.equal(npmPackageUrl('@vue/compiler-sfc'), 'https://www.npmjs.com/package/@vue/compiler-sfc')
  })

  it('names the repository-root root and keeps other root ids', () => {
    assert.equal(rootLabel('.'), 'repository root')
    assert.equal(rootLabel('legacy/admin'), 'legacy/admin')
  })

  it('names roots with the same words as the server', () => {
    assert.equal(rootLabel, serverRootLabel)
    assert.equal(serverRootLabel('.'), 'repository root')
  })

  it('labels importers by name and packages by name and version', () => {
    assert.equal(nodeLabel({ name: '@fixture/build', version: '', isImporter: true }), '@fixture/build')
    assert.equal(nodeLabel({ name: 'semver', version: '5.7.2', isImporter: false }), 'semver 5.7.2')
    assert.equal(nodeLabel({ name: 'missing', version: '', isImporter: false }), 'missing')
  })

  it('labels a node id: importers by path and packages by name and version without the peer suffix', () => {
    assert.equal(nodeIdLabel('importer:storefront'), 'storefront')
    assert.equal(nodeIdLabel('importer:.'), 'repository root')
    assert.equal(nodeIdLabel('@vue/compiler-sfc@3.5.13(vue@3.5.13)'), '@vue/compiler-sfc 3.5.13')
    assert.equal(nodeIdLabel('helper@1.0.0'), 'helper 1.0.0')
    assert.equal(nodeIdLabel('plain-name'), 'plain-name')
  })

  it('labels a node id with a pnpm v6 slash, a placeholder prefix or an alias', () => {
    assert.equal(nodeIdLabel('/@types/node@20.17.9'), '@types/node 20.17.9')
    assert.equal(nodeIdLabel('/@scope/x@1.0.0(peer@1.0.0)'), '@scope/x 1.0.0')
    assert.equal(nodeIdLabel('/@typescript-eslint/utils@8.18.0(eslint@9.17.0)'), '@typescript-eslint/utils 8.18.0')
    assert.equal(nodeIdLabel('/lodash@4.17.21'), 'lodash 4.17.21')
    assert.equal(nodeIdLabel('?:@scope/x@^1.0.0'), '?:@scope/x ^1.0.0')
    assert.equal(nodeIdLabel('foo@npm:bar@1.0.0'), 'foo npm:bar@1.0.0')
    assert.equal(nodeIdLabel('@scope/x@1.0.0(b@2.0.0)'), '@scope/x 1.0.0')
    assert.equal(nodeIdLabel('importer:apps/web'), 'apps/web')
  })
})

describe('slashSegments', () => {
  it('splits after every slash so a long path can wrap there', () => {
    assert.deepEqual(slashSegments('application/commerce-web-ee/dev'), ['application/', 'commerce-web-ee/', 'dev'])
    assert.deepEqual(slashSegments('shop, variant 1 of 2 (@types/node 25.9.9)'), ['shop, variant 1 of 2 (@types/', 'node 25.9.9)'])
    assert.deepEqual(slashSegments('shop'), ['shop'])
  })
})

describe('nameSegments', () => {
  it('splits a package name after its scope slash and after every dot', () => {
    assert.deepEqual(nameSegments('@sample/jquery.nicescroll'), ['@sample/', 'jquery.', 'nicescroll'])
    assert.deepEqual(nameSegments('@babel/plugin-proposal-logical-assignment-operators'), ['@babel/', 'plugin-proposal-logical-assignment-operators'])
    assert.deepEqual(nameSegments('semver'), ['semver'])
  })
})

describe('pathFromRoot', () => {
  it('gives the path of a workspace package relative to its root, with .. for one outside it', () => {
    assert.equal(pathFromRoot('.', 'apps/web'), 'apps/web')
    assert.equal(pathFromRoot('npm-package', 'npm-package/tools/build'), 'tools/build')
    assert.equal(pathFromRoot('npm-package', 'npm-package'), '')
    assert.equal(pathFromRoot('frontend/storefront-nuxt', 'npm-package/commerce-ui-nuxt'), '../../npm-package/commerce-ui-nuxt')
    assert.equal(pathFromRoot('a/b', 'a/c'), '../c')
  })
})

describe('pathWords', () => {
  it('splits a label into words and each word after its slashes, keeping hyphenated parts whole', () => {
    assert.deepEqual(pathWords('shop-npm'), [['shop-npm']])
    assert.deepEqual(pathWords('frontend/storefront-nuxt, variant 1 of 2'), [['frontend/', 'storefront-nuxt,'], ['variant'], ['1'], ['of'], ['2']])
  })
})
