import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RootGraph, SourceKind } from '../src/model.ts'
import { sharedRootWarnings, sharesWorkspacePackage, sharingRoots } from '../src/actions/shared-packages.ts'
import type { SharingRoot } from '../src/actions/types.ts'

function rootOf(id: string, importerPaths: Record<string, string>, source: SourceKind = 'lockfile', manager: RootGraph['manager'] = 'pnpm'): RootGraph {
  return {
    id,
    path: id,
    manager,
    source,
    status: 'ready',
    importers: Object.entries(importerPaths).map(([importerId, importerPath]) => ({ id: `importer:${importerId}`, path: importerPath, name: importerId, deps: [], dependents: [] })),
    packages: new Map(),
    warnings: [],
  }
}

const storefront = rootOf('frontend/storefront-nuxt', {
  '.': 'frontend/storefront-nuxt',
  '../../npm-package/commerce-ui': 'npm-package/commerce-ui',
  '../../npm-package/stylelint-config': 'npm-package/stylelint-config',
})
const npmPackage = rootOf('npm-package', { 'commerce-ui': 'npm-package/commerce-ui', 'stylelint-config': 'npm-package/stylelint-config' })
const repositoryRoot = rootOf('.', { 'npm-package/stylelint-config': 'npm-package/stylelint-config' })
const manifestOnly = rootOf('tools', { 'npm-package/commerce-ui': 'npm-package/commerce-ui' }, 'manifest-only')
const roots = [storefront, npmPackage, repositoryRoot, manifestOnly]

describe('sharingRoots', () => {
  it('maps each manifest to the other lockfile roots that list the same directory', () => {
    assert.deepEqual(
      sharingRoots(storefront, roots),
      new Map([
        ['../../npm-package/commerce-ui/package.json', [{ id: 'npm-package', manager: 'pnpm' }]],
        ['../../npm-package/stylelint-config/package.json', [{ id: '.', manager: 'pnpm' }, { id: 'npm-package', manager: 'pnpm' }]],
      ]),
    )
    assert.deepEqual(sharingRoots(npmPackage, roots).get('commerce-ui/package.json'), [{ id: 'frontend/storefront-nuxt', manager: 'pnpm' }])
  })

  it("shares the root's own package.json with a root that lists it", () => {
    const shop = rootOf('apps/shop', { '.': 'apps/shop' })
    const parent = rootOf('.', { 'apps/shop': 'apps/shop' })
    assert.deepEqual(sharingRoots(shop, [shop, parent]), new Map([['package.json', [{ id: '.', manager: 'pnpm' }]]]))
  })
})

describe('sharesWorkspacePackage', () => {
  it('tells whether two roots share a workspace package', () => {
    assert.equal(sharesWorkspacePackage(storefront, npmPackage), true)
    assert.equal(sharesWorkspacePackage(storefront, rootOf('other', { '.': 'other' })), false)
    assert.equal(sharesWorkspacePackage(storefront, storefront), false)
  })
})

describe('sharedRootWarnings', () => {
  const pnpmRoot: SharingRoot = { id: 'npm-package', manager: 'pnpm' }
  const sharedByAll = (paths: string[], sharing: SharingRoot[]): Map<string, SharingRoot[]> => new Map(paths.map((path) => [path, sharing]))
  const named = (count: number): string[] => Array.from({ length: count }, (_, index) => `../../npm-package/${String.fromCharCode(97 + index)}/package.json`)

  it('warns once per sharing root and names up to three files', () => {
    const two = named(2)
    assert.deepEqual(sharedRootWarnings(two, sharedByAll(two, [pnpmRoot])), [
      'npm-package also uses ../../npm-package/a/package.json, ../../npm-package/b/package.json: its lockfile is not updated; run pnpm install in npm-package',
    ])
    const ten = named(10)
    assert.deepEqual(sharedRootWarnings(ten, sharedByAll(ten, [pnpmRoot])), [
      'npm-package also uses ../../npm-package/a/package.json, ../../npm-package/b/package.json, ../../npm-package/c/package.json, and 7 more files: its lockfile is not updated; run pnpm install in npm-package',
    ])
    const four = named(4)
    assert.match(sharedRootWarnings(four, sharedByAll(four, [pnpmRoot]))[0], /c\/package\.json, and 1 more file: /)
  })

  it('names the repository root and the manager of the sharing root', () => {
    const path = '../../npm-package/stylelint-config/package.json'
    assert.deepEqual(sharedRootWarnings([path], sharedByAll([path], [{ id: '.', manager: 'pnpm' }])), [
      `The repository root also uses ${path}: its lockfile is not updated; run pnpm install in the repository root`,
    ])
    assert.match(sharedRootWarnings([path], sharedByAll([path], [{ id: 'legacy', manager: 'npm' }]))[0], /run npm install in legacy$/)
  })

  it('orders the warnings by sharing root id and skips paths nobody shares', () => {
    const shared = new Map<string, SharingRoot[]>([['a/package.json', [{ id: 'z', manager: 'pnpm' }, { id: 'b', manager: 'pnpm' }]]])
    const warnings = sharedRootWarnings(['a/package.json', 'c/package.json'], shared)
    assert.deepEqual(warnings.map((warning) => warning.split(' ')[0]), ['b', 'z'])
    assert.equal(warnings[0].includes('c/package.json'), false)
  })
})
