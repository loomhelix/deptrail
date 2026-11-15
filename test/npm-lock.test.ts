import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNpmLock } from '../src/adapters/npm-lock.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import type { Edge, Importer, PackageNode, RootGraph } from '../src/model.ts'

type ParsedLock = { graph: RootGraph; supported: boolean }
type LockEntries = Record<string, Record<string, unknown>>

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/npm/${name}`, import.meta.url), 'utf8')
}

function parseText(text: string): ParsedLock {
  const builder = new RootGraphBuilder({ id: '.', path: '.', manager: 'npm', source: 'lockfile' })
  const { supported } = parseNpmLock(text, builder)
  return { graph: builder.build(), supported }
}

function parseEntries(entries: LockEntries, lockfileVersion = 3): ParsedLock {
  return parseText(JSON.stringify({ lockfileVersion, packages: entries }))
}

function allNodes(graph: RootGraph): Array<Importer | PackageNode> {
  return [...graph.importers, ...graph.packages.values()]
}

function collectTriples(graph: RootGraph): string[] {
  const triples = allNodes(graph).flatMap((node) => node.deps.map((edge) => `${node.id} ${edge.kind} ${edge.to}`))
  return triples.sort()
}

function requireNode(graph: RootGraph, id: string): Importer | PackageNode {
  const node = allNodes(graph).find((candidate) => candidate.id === id)
  assert.ok(node, `expected node ${id} to exist`)
  return node
}

function requireEdge(graph: RootGraph, from: string, to: string): Edge {
  const edge = requireNode(graph, from).deps.find((candidate) => candidate.to === to)
  assert.ok(edge, `expected an edge ${from} -> ${to}`)
  return edge
}

function requirePackage(graph: RootGraph, id: string): PackageNode {
  const node = graph.packages.get(id)
  assert.ok(node, `expected package ${id} to exist`)
  return node
}

function packageEntry(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version, ...extra }
}

const rootEntry = (dependencies: Record<string, string>) => ({ '': { name: 'root', dependencies } })

describe('parseNpmLock', () => {
  describe('v3 workspace lockfile', () => {
    const { graph, supported } = parseText(readFixture('v3-workspaces.json'))

    it('is supported and resolves every reference without placeholders or warnings', () => {
      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, [])
      assert.deepEqual(
        allNodes(graph).filter((node) => node.id.startsWith('?:')),
        [],
      )
    })

    it('adds the root and each workspace as importers named after their package name', () => {
      assert.deepEqual(
        graph.importers.map((importer) => [importer.id, importer.path, importer.name]),
        [
          ['importer:.', '.', 'monorepo'],
          ['importer:packages/a', 'packages/a', '@fixture/a'],
          ['importer:packages/b', 'packages/b', '@fixture/b'],
        ],
      )
    })

    it('adds one package node per name@version and never one for a link entry', () => {
      assert.deepEqual(
        [...graph.packages.keys()].sort(),
        [
          'chokidar@3.6.0',
          'debug@4.3.7',
          'emoji-regex@8.0.0',
          'eslint@9.17.0',
          'fsevents@2.3.3',
          'ms@2.1.3',
          'semver@5.7.2',
          'semver@7.6.3',
          'string-width@4.2.3',
          'vue-eslint-parser@9.4.3',
        ].sort(),
      )
    })

    it('links a workspace dependency to the importer it points at', () => {
      const edge = requireEdge(graph, 'importer:packages/a', 'importer:packages/b')
      assert.deepEqual(edge, { to: 'importer:packages/b', kind: 'prod', range: '^1.0.0' })
      assert.deepEqual(requireNode(graph, 'importer:packages/b').dependents, ['importer:packages/a'])
    })

    it('resolves a nested install before a hoisted one', () => {
      assert.deepEqual(requireEdge(graph, 'vue-eslint-parser@9.4.3', 'semver@5.7.2'), {
        to: 'semver@5.7.2',
        kind: 'prod',
        range: '^5.7.2',
      })
      assert.deepEqual(requireEdge(graph, 'importer:.', 'semver@7.6.3'), {
        to: 'semver@7.6.3',
        kind: 'prod',
        range: '^7.6.3',
      })
    })

    it('falls back to the hoisted install for workspace dependencies', () => {
      assert.deepEqual(requireEdge(graph, 'importer:packages/b', 'semver@7.6.3').kind, 'prod')
      assert.deepEqual(requirePackage(graph, 'semver@7.6.3').dependents, ['importer:.', 'importer:packages/b'])
      assert.deepEqual(requirePackage(graph, 'semver@5.7.2').dependents, ['vue-eslint-parser@9.4.3'])
    })

    it('maps importer dependency blocks to prod and dev edges with declared ranges', () => {
      assert.deepEqual(requireNode(graph, 'importer:.').deps, [
        { to: 'semver@7.6.3', kind: 'prod', range: '^7.6.3' },
        { to: 'string-width@4.2.3', kind: 'prod', range: 'npm:string-width@^4.2.0' },
        { to: 'eslint@9.17.0', kind: 'dev', range: '^9.17.0' },
        { to: 'vue-eslint-parser@9.4.3', kind: 'dev', range: '^9.4.3' },
      ])
      assert.deepEqual(requireEdge(graph, 'importer:packages/a', 'eslint@9.17.0').kind, 'dev')
    })

    it('keeps the real package identity of an aliased install', () => {
      const aliased = requirePackage(graph, 'string-width@4.2.3')
      assert.equal(aliased.name, 'string-width')
      assert.equal(aliased.version, '4.2.3')
      assert.deepEqual(aliased.deps, [{ to: 'emoji-regex@8.0.0', kind: 'prod', range: '^8.0.0' }])
    })

    it('adds a peer edge with the declared peer range', () => {
      assert.deepEqual(requireEdge(graph, 'vue-eslint-parser@9.4.3', 'eslint@9.17.0'), {
        to: 'eslint@9.17.0',
        kind: 'peer',
        range: '>=6.0.0',
      })
    })

    it('adds an optional edge when the optional dependency is installed', () => {
      assert.deepEqual(requireEdge(graph, 'chokidar@3.6.0', 'fsevents@2.3.3'), {
        to: 'fsevents@2.3.3',
        kind: 'optional',
        range: '~2.3.2',
      })
    })

    it('skips a missing optional dependency and a missing optional peer silently', () => {
      assert.deepEqual(
        requireNode(graph, 'importer:packages/b').deps.map((edge) => edge.kind),
        ['prod', 'prod'],
      )
      assert.deepEqual(requirePackage(graph, 'debug@4.3.7').deps, [{ to: 'ms@2.1.3', kind: 'prod', range: '^2.1.3' }])
    })
  })

  describe('v2 lockfile with the legacy dependencies block', () => {
    it('produces the same graph as the v3 lockfile', () => {
      const v2 = parseText(readFixture('v2-nested.json'))
      const v3 = parseText(readFixture('v3-workspaces.json'))

      assert.equal(v2.supported, true)
      assert.deepEqual(v2.graph, v3.graph)
      assert.ok(collectTriples(v2.graph).length > 10)
    })

    it('ignores the legacy dependencies block entirely', () => {
      const document = JSON.parse(readFixture('v2-nested.json'))
      document.dependencies = { 'only-in-legacy': { version: '9.9.9' } }

      const { graph } = parseText(JSON.stringify(document))

      assert.equal(graph.packages.has('only-in-legacy@9.9.9'), false)
    })
  })

  describe('unsupported and malformed lockfiles', () => {
    it('rejects lockfileVersion 1 with a warning and no nodes', () => {
      const { graph, supported } = parseText(readFixture('v1.json'))

      assert.equal(supported, false)
      assert.deepEqual(graph.warnings, ['npm lockfile version 1 is not supported'])
      assert.deepEqual(allNodes(graph), [])
    })

    it('rejects a document without lockfileVersion', () => {
      const { graph, supported } = parseText('{"packages":{}}')

      assert.equal(supported, false)
      assert.deepEqual(graph.warnings, ['npm lockfile version undefined is not supported'])
    })

    it('throws on text that is not JSON', () => {
      assert.throws(() => parseText('lockfileVersion: 3'), SyntaxError)
    })

    it('parses a lockfile version above 3 like 3 and warns that results may be incomplete', () => {
      const v3Text = readFixture('v3-workspaces.json')
      const v4Text = JSON.stringify({ ...JSON.parse(v3Text), lockfileVersion: 4 })
      const { graph, supported } = parseText(v4Text)

      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, ['npm lockfile version 4 is newer than supported; results may be incomplete'])
      assert.deepEqual(collectTriples(graph), collectTriples(parseText(v3Text).graph))
    })

    it('accepts a supported lockfile without packages as an empty graph', () => {
      const { graph, supported } = parseText('{"lockfileVersion":3}')

      assert.equal(supported, true)
      assert.deepEqual(allNodes(graph), [])
      assert.deepEqual(graph.warnings, [])
    })
  })

  describe('importers', () => {
    it('names an importer after its path when the entry has no name', () => {
      const { graph } = parseEntries({ '': {}, 'packages/anonymous': {} })

      assert.deepEqual(
        graph.importers.map((importer) => [importer.id, importer.name]),
        [
          ['importer:.', '.'],
          ['importer:packages/anonymous', 'packages/anonymous'],
        ],
      )
    })

    it('treats a key outside node_modules as an importer even when its folder name contains node_modules', () => {
      const { graph } = parseEntries({ '': {}, 'tools/my_node_modules/pkg': { name: 'tool' } })

      assert.deepEqual(
        graph.importers.map((importer) => importer.id),
        ['importer:.', 'importer:tools/my_node_modules/pkg'],
      )
      assert.equal(graph.packages.size, 0)
    })

    it('resolves a workspace dependency from the workspace node_modules before the root node_modules', () => {
      const { graph } = parseEntries({
        ...rootEntry({ x: '*' }),
        'node_modules/x': packageEntry('1.0.0'),
        'packages/a': { name: 'a', dependencies: { x: '^2.0.0' } },
        'packages/a/node_modules/x': packageEntry('2.0.0'),
      })

      assert.equal(requireEdge(graph, 'importer:packages/a', 'x@2.0.0').range, '^2.0.0')
      assert.equal(requireEdge(graph, 'importer:.', 'x@1.0.0').range, '*')
    })

    it('resolves a package nested in a workspace through the workspace and then the root', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'node_modules/z': packageEntry('3.0.0'),
        'packages/a': { name: 'a' },
        'packages/a/node_modules/y': packageEntry('1.0.0', { dependencies: { z: '^3.0.0', w: '^1.0.0' } }),
        'packages/a/node_modules/w': packageEntry('1.5.0'),
      })

      assert.deepEqual(requirePackage(graph, 'y@1.0.0').deps, [
        { to: 'z@3.0.0', kind: 'prod', range: '^3.0.0' },
        { to: 'w@1.5.0', kind: 'prod', range: '^1.0.0' },
      ])
    })

    it('resolves a nested importer through the node_modules of its enclosing importer before the root', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'node_modules/x': packageEntry('1.0.0'),
        'packages/a': { name: 'a' },
        'packages/a/node_modules/x': packageEntry('2.0.0'),
        'packages/a/sub': { name: 'sub', dependencies: { x: '^2.0.0' } },
      })

      assert.deepEqual(requireNode(graph, 'importer:packages/a/sub').deps, [
        { to: 'x@2.0.0', kind: 'prod', range: '^2.0.0' },
      ])
      assert.deepEqual(graph.warnings, [])
    })

    it('falls back from a nested importer to the root when no enclosing importer installs the dependency', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'node_modules/y': packageEntry('3.0.0'),
        'packages/a': { name: 'a' },
        'packages/a/sub': { name: 'sub', dependencies: { y: '^3.0.0' } },
      })

      assert.deepEqual(requireNode(graph, 'importer:packages/a/sub').deps, [
        { to: 'y@3.0.0', kind: 'prod', range: '^3.0.0' },
      ])
    })

    it('prefers the nested importer own node_modules over the enclosing importer node_modules', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'packages/a': { name: 'a' },
        'packages/a/node_modules/x': packageEntry('2.0.0'),
        'packages/a/sub': { name: 'sub', dependencies: { x: '*' } },
        'packages/a/sub/node_modules/x': packageEntry('3.0.0'),
      })

      assert.equal(requireEdge(graph, 'importer:packages/a/sub', 'x@3.0.0').range, '*')
    })

    it('skips path segments that are not importers while walking up from a nested importer', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'packages/a': { name: 'a' },
        'packages/a/node_modules/x': packageEntry('2.0.0'),
        'packages/a/group/leaf': { name: 'leaf', dependencies: { x: '^2.0.0' } },
      })

      assert.equal(requireEdge(graph, 'importer:packages/a/group/leaf', 'x@2.0.0').range, '^2.0.0')
    })

    it('resolves a package installed under a nested importer through that importer, its enclosing importer and the root', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'node_modules/x': packageEntry('1.0.0'),
        'node_modules/y': packageEntry('3.0.0'),
        'packages/a': { name: 'a' },
        'packages/a/node_modules/x': packageEntry('2.0.0'),
        'packages/a/sub': { name: 'sub' },
        'packages/a/sub/node_modules/lib': packageEntry('1.0.0', { dependencies: { x: '^2.0.0', y: '^3.0.0' } }),
      })

      assert.deepEqual(requirePackage(graph, 'lib@1.0.0').deps, [
        { to: 'x@2.0.0', kind: 'prod', range: '^2.0.0' },
        { to: 'y@3.0.0', kind: 'prod', range: '^3.0.0' },
      ])
      assert.deepEqual(graph.warnings, [])
    })

    it('resolves a package nested deeper under a nested importer through every enclosing node_modules', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'packages/a': { name: 'a' },
        'packages/a/node_modules/x': packageEntry('2.0.0'),
        'packages/a/sub': { name: 'sub' },
        'packages/a/sub/node_modules/lib': packageEntry('1.0.0'),
        'packages/a/sub/node_modules/lib/node_modules/inner': packageEntry('1.0.0', { dependencies: { x: '^2.0.0' } }),
      })

      assert.deepEqual(requirePackage(graph, 'inner@1.0.0').deps, [{ to: 'x@2.0.0', kind: 'prod', range: '^2.0.0' }])
    })

    it('adds peer edges for importer peer dependencies and skips them when they are not installed', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'node_modules/react': packageEntry('18.3.1'),
        'packages/ui': { name: 'ui', peerDependencies: { react: '>=18', vue: '^3.0.0' } },
      })

      assert.deepEqual(requireNode(graph, 'importer:packages/ui').deps, [
        { to: 'react@18.3.1', kind: 'peer', range: '>=18' },
      ])
      assert.deepEqual(graph.warnings, [])
    })
  })

  describe('package identity', () => {
    it('reads the name from the last node_modules segment, including scoped names', () => {
      const { graph } = parseEntries({
        '': { name: 'root' },
        'node_modules/plain': packageEntry('1.0.0'),
        'node_modules/@scope/pkg': packageEntry('2.0.0'),
        'node_modules/plain/node_modules/@scope/inner': packageEntry('3.0.0'),
      })

      assert.deepEqual(
        [...graph.packages.values()].map((node) => [node.id, node.name, node.version]),
        [
          ['plain@1.0.0', 'plain', '1.0.0'],
          ['@scope/pkg@2.0.0', '@scope/pkg', '2.0.0'],
          ['@scope/inner@3.0.0', '@scope/inner', '3.0.0'],
        ],
      )
    })

    it('keeps name@version with the real version for git, tarball and file installs', () => {
      const { graph } = parseEntries({
        ...rootEntry({ 'git-lib': 'github:acme/git-lib', 'tar-lib': 'https://example.test/tar-lib-1.2.0.tgz' }),
        'node_modules/git-lib': packageEntry('1.4.0', { resolved: 'git+ssh://git@github.com/acme/git-lib.git#abc123' }),
        'node_modules/tar-lib': packageEntry('1.2.0', { resolved: 'https://example.test/tar-lib-1.2.0.tgz' }),
      })

      assert.deepEqual(requireNode(graph, 'importer:.').deps, [
        { to: 'git-lib@1.4.0', kind: 'prod', range: 'github:acme/git-lib' },
        { to: 'tar-lib@1.2.0', kind: 'prod', range: 'https://example.test/tar-lib-1.2.0.tgz' },
      ])
      assert.deepEqual(graph.warnings, [])
    })

    it('merges the same name@version installed at several paths into one node with the union of its edges', () => {
      const { graph } = parseEntries({
        ...rootEntry({ x: '^1.0.0', p: '^1.0.0' }),
        'node_modules/x': packageEntry('1.0.0', { dependencies: { y: '*' } }),
        'node_modules/y': packageEntry('1.0.0'),
        'node_modules/p': packageEntry('1.0.0', { dependencies: { x: '^1.0.0' } }),
        'node_modules/p/node_modules/x': packageEntry('1.0.0', { dependencies: { y: '*' } }),
        'node_modules/p/node_modules/y': packageEntry('2.0.0'),
      })

      assert.deepEqual(
        [...graph.packages.keys()].sort(),
        ['p@1.0.0', 'x@1.0.0', 'y@1.0.0', 'y@2.0.0'],
      )
      assert.deepEqual(requirePackage(graph, 'x@1.0.0').deps, [
        { to: 'y@1.0.0', kind: 'prod', range: '*' },
        { to: 'y@2.0.0', kind: 'prod', range: '*' },
      ])
      assert.deepEqual(requirePackage(graph, 'x@1.0.0').dependents, ['importer:.', 'p@1.0.0'])
    })

    it('ignores devDependencies on packages that are not importers', () => {
      const { graph } = parseEntries({
        ...rootEntry({ lib: '^1.0.0' }),
        'node_modules/lib': packageEntry('1.0.0', { devDependencies: { tester: '^1.0.0' } }),
        'node_modules/tester': packageEntry('1.0.0'),
      })

      assert.deepEqual(requirePackage(graph, 'lib@1.0.0').deps, [])
    })

    it('resolves a scoped package nested under a scoped parent through the parent and then the root', () => {
      const { graph } = parseEntries({
        ...rootEntry({ '@s/p': '^1.0.0' }),
        'node_modules/@s/p': packageEntry('1.0.0', { dependencies: { q: '^1.0.0', r: '^1.0.0' } }),
        'node_modules/@s/p/node_modules/q': packageEntry('1.1.0'),
        'node_modules/r': packageEntry('1.2.0'),
      })

      assert.deepEqual(requirePackage(graph, '@s/p@1.0.0').deps, [
        { to: 'q@1.1.0', kind: 'prod', range: '^1.0.0' },
        { to: 'r@1.2.0', kind: 'prod', range: '^1.0.0' },
      ])
    })
  })

  describe('missing targets', () => {
    it('turns a missing prod dependency into a placeholder with a warning', () => {
      const { graph } = parseEntries({
        ...rootEntry({ lib: '^1.0.0' }),
        'node_modules/lib': packageEntry('1.0.0', { dependencies: { 'left-pad': '^1.3.0' } }),
      })

      assert.deepEqual(requireEdge(graph, 'lib@1.0.0', '?:left-pad@^1.3.0'), {
        to: '?:left-pad@^1.3.0',
        kind: 'prod',
        range: '^1.3.0',
      })
      assert.deepEqual(graph.warnings, ['Unresolved dependency left-pad@^1.3.0'])
    })

    it('turns a missing importer dev dependency into a placeholder with a warning', () => {
      const { graph } = parseEntries({ '': { name: 'root', devDependencies: { tester: '^2.0.0' } } })

      assert.deepEqual(requireNode(graph, 'importer:.').deps, [
        { to: '?:tester@^2.0.0', kind: 'dev', range: '^2.0.0' },
      ])
      assert.deepEqual(graph.warnings, ['Unresolved dependency tester@^2.0.0'])
    })

    it('does not see an install that is only reachable from a sibling subtree', () => {
      const { graph } = parseEntries({
        ...rootEntry({ a: '*' }),
        'node_modules/a': packageEntry('1.0.0', { dependencies: { hidden: '*' } }),
        'node_modules/b': packageEntry('1.0.0'),
        'node_modules/b/node_modules/hidden': packageEntry('1.0.0'),
      })

      assert.deepEqual(requirePackage(graph, 'a@1.0.0').deps, [{ to: '?:hidden@*', kind: 'prod', range: '*' }])
    })

    it('ignores non-string dependency ranges', () => {
      const { graph } = parseEntries({
        '': { name: 'root', dependencies: { odd: 42, fine: '^1.0.0' } },
        'node_modules/fine': packageEntry('1.0.0'),
      })

      assert.deepEqual(requireNode(graph, 'importer:.').deps, [{ to: 'fine@1.0.0', kind: 'prod', range: '^1.0.0' }])
    })
  })

  describe('link entries', () => {
    it('never turns a link entry into a package and resolves it to the importer at resolved', () => {
      const { graph } = parseEntries({
        '': { name: 'root', dependencies: { shared: '*' } },
        'node_modules/shared': { resolved: 'libs/shared', link: true },
        'libs/shared': { name: 'shared', version: '1.0.0' },
      })

      assert.equal(graph.packages.size, 0)
      assert.deepEqual(requireNode(graph, 'importer:.').deps, [
        { to: 'importer:libs/shared', kind: 'prod', range: '*' },
      ])
      assert.deepEqual(graph.warnings, [])
    })

    it('ignores a link entry that has no resolved target and reports the dependency as unresolved', () => {
      const { graph } = parseEntries({
        '': { name: 'root', dependencies: { shared: '*' } },
        'node_modules/shared': { link: true },
      })

      assert.equal(graph.packages.has('shared@'), false)
      assert.deepEqual(graph.warnings, ['Unresolved dependency shared@*'])
    })
  })

  describe('non-registry packages', () => {
    it('marks an entry resolved from git and not one resolved from a registry', () => {
      const { graph } = parseEntries({
        '': { name: 'app', dependencies: { gitdep: 'github:u/r', lodash: '^4.0.0' } },
        'node_modules/gitdep': { version: '1.0.0', resolved: 'git+ssh://git@github.com/u/r.git#abc' },
        'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      })

      assert.equal(graph.packages.get('gitdep@1.0.0')?.nonRegistry, true)
      assert.equal(graph.packages.get('lodash@4.17.21')?.nonRegistry, undefined)
    })
  })
})
