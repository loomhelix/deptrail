import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePnpmLock } from '../src/adapters/pnpm-lock.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import type { Edge, Importer, PackageNode, RootGraph } from '../src/model.ts'

type ParsedLock = { graph: RootGraph; supported: boolean }

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/pnpm/${name}`, import.meta.url), 'utf8')
}

function parseText(text: string): ParsedLock {
  const builder = new RootGraphBuilder({ id: '.', path: '.', manager: 'pnpm', source: 'lockfile' })
  const { supported } = parsePnpmLock(text, builder)
  return { graph: builder.build(), supported }
}

function allNodes(graph: RootGraph): Array<Importer | PackageNode> {
  return [...graph.importers, ...graph.packages.values()]
}

function withoutLeadingSlash(id: string): string {
  return id.startsWith('/') ? id.slice(1) : id
}

function collectTriples(graph: RootGraph): string[] {
  const triples = allNodes(graph).flatMap((node) =>
    node.deps.map((edge) => `${withoutLeadingSlash(node.id)} ${edge.kind} ${withoutLeadingSlash(edge.to)}`),
  )
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

const workspaceLayouts = [
  { label: 'v9', fixture: 'v9-workspace.yaml', packageId: (key: string) => key },
  { label: 'v6', fixture: 'v6-workspace.yaml', packageId: (key: string) => `/${key}` },
]

describe('parsePnpmLock', () => {
  for (const { label, fixture, packageId } of workspaceLayouts) {
    describe(`${label} workspace lockfile`, () => {
      const { graph, supported } = parseText(readFixture(fixture))

      it('is supported and resolves every dependency without placeholders or warnings', () => {
        assert.equal(supported, true)
        assert.deepEqual(graph.warnings, [])
        assert.deepEqual(
          allNodes(graph).filter((node) => node.id.startsWith('?:')),
          [],
        )
      })

      it('adds one importer per lockfile importer named after its path', () => {
        assert.deepEqual(
          graph.importers.map((importer) => [importer.id, importer.path, importer.name]),
          [
            ['importer:.', '.', '.'],
            ['importer:packages/a', 'packages/a', 'packages/a'],
            ['importer:packages/b', 'packages/b', 'packages/b'],
          ],
        )
      })

      it('turns a link: version into a prod edge to the linked importer keeping the specifier as range', () => {
        assert.deepEqual(requireEdge(graph, 'importer:packages/a', 'importer:packages/b'), {
          to: 'importer:packages/b',
          kind: 'prod',
          range: 'workspace:*',
        })
        assert.deepEqual(requireNode(graph, 'importer:packages/b').dependents, ['importer:packages/a'])
      })

      it('maps importer dependency blocks to prod, dev and optional edges with specifier ranges', () => {
        assert.deepEqual(requireEdge(graph, 'importer:packages/a', packageId('lodash@4.17.21')), {
          to: packageId('lodash@4.17.21'),
          kind: 'prod',
          range: '^4.17.21',
        })
        assert.deepEqual(
          requireEdge(graph, 'importer:packages/a', packageId('vue-eslint-parser@9.4.3(eslint@9.17.0)')),
          {
            to: packageId('vue-eslint-parser@9.4.3(eslint@9.17.0)'),
            kind: 'dev',
            range: '^9.4.3',
          },
        )
        assert.deepEqual(requireEdge(graph, 'importer:packages/a', packageId('fsevents@2.3.3')), {
          to: packageId('fsevents@2.3.3'),
          kind: 'optional',
          range: '^2.3.3',
        })
      })

      it('splits a peer-suffixed key into name, version and peerSuffix', () => {
        const node = requirePackage(graph, packageId('vue-eslint-parser@9.4.3(eslint@9.17.0)'))

        assert.equal(node.name, 'vue-eslint-parser')
        assert.equal(node.version, '9.4.3')
        assert.equal(node.peerSuffix, '(eslint@9.17.0)')
      })

      it('keeps the leading @ of a scoped name and every peer group of the suffix', () => {
        const node = requirePackage(
          graph,
          packageId('@typescript-eslint/utils@8.18.0(eslint@9.17.0)(typescript@5.7.2)'),
        )

        assert.equal(node.name, '@typescript-eslint/utils')
        assert.equal(node.version, '8.18.0')
        assert.equal(node.peerSuffix, '(eslint@9.17.0)(typescript@5.7.2)')
      })

      it('leaves peerSuffix unset for a package without peers', () => {
        assert.equal(requirePackage(graph, packageId('lodash@4.17.21')).peerSuffix, undefined)
      })

      it('turns a resolved declared peer into a peer edge carrying the declared range', () => {
        const parser = packageId('vue-eslint-parser@9.4.3(eslint@9.17.0)')

        assert.deepEqual(requireEdge(graph, parser, packageId('eslint@9.17.0')), {
          to: packageId('eslint@9.17.0'),
          kind: 'peer',
          range: '>=6.0.0',
        })
        assert.deepEqual(
          requireNode(graph, parser).deps.filter((edge) => edge.to === packageId('eslint@9.17.0')),
          [{ to: packageId('eslint@9.17.0'), kind: 'peer', range: '>=6.0.0' }],
        )
      })

      it('keeps non-peer dependencies as prod edges whose range is the resolved version', () => {
        const parser = packageId('vue-eslint-parser@9.4.3(eslint@9.17.0)')

        assert.deepEqual(requireEdge(graph, parser, packageId('debug@4.4.0')), {
          to: packageId('debug@4.4.0'),
          kind: 'prod',
          range: '4.4.0',
        })
      })

      it('skips a declared peer that is not resolved in the same entry', () => {
        assert.deepEqual(
          requireNode(graph, packageId('debug@4.4.0')).deps.map((edge) => edge.to),
          [packageId('ms@2.1.3')],
        )
        assert.deepEqual(
          requireNode(graph, packageId('eslint@9.17.0')).deps.map((edge) => edge.to),
          [packageId('debug@4.4.0')],
        )
      })

      it('maps package optionalDependencies to optional edges', () => {
        assert.deepEqual(requireEdge(graph, packageId('x@1.0.0'), packageId('fsevents@2.3.3')), {
          to: packageId('fsevents@2.3.3'),
          kind: 'optional',
          range: '2.3.3',
        })
      })

      it('points an aliased dependency at the aliased package key and node name', () => {
        const aliasTarget = packageId('string-width@4.2.3')

        assert.deepEqual(requireEdge(graph, 'importer:packages/a', aliasTarget), {
          to: aliasTarget,
          kind: 'prod',
          range: 'npm:string-width@^4.2.0',
        })
        assert.equal(requirePackage(graph, aliasTarget).name, 'string-width')
        assert.equal(graph.packages.has(packageId('string-width-cjs@4.2.3')), false)
      })

      it('keeps both edges of a dependency cycle', () => {
        const x = packageId('x@1.0.0')
        const y = packageId('y@1.0.0')

        assert.equal(requireEdge(graph, x, y).kind, 'prod')
        assert.equal(requireEdge(graph, y, x).kind, 'prod')
        assert.deepEqual(requireNode(graph, y).dependents, [x])
        assert.deepEqual(requireNode(graph, x).dependents, ['importer:packages/b', y])
      })
    })
  }

  describe('v6 and v9 equivalence', () => {
    it('yields identical (from, to, kind) triples once the v6 / prefix is stripped', () => {
      const v9Triples = collectTriples(parseText(readFixture('v9-workspace.yaml')).graph)
      const v6Triples = collectTriples(parseText(readFixture('v6-workspace.yaml')).graph)

      assert.ok(v9Triples.length > 20)
      assert.deepEqual(v6Triples, v9Triples)
    })

    it('treats lockfile version 6.1 like 6.0', () => {
      const v61Text = readFixture('v6-workspace.yaml').replace("lockfileVersion: '6.0'", "lockfileVersion: '6.1'")

      assert.deepEqual(
        collectTriples(parseText(v61Text).graph),
        collectTriples(parseText(readFixture('v6-workspace.yaml')).graph),
      )
    })
  })

  describe('v6 reference forms', () => {
    const packageBody = '    resolution: {integrity: sha512-AAAA}'

    it('accepts an alias written without the leading slash', () => {
      const text = [
        "lockfileVersion: '6.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      string-width-cjs:',
        '        specifier: npm:string-width@^4.2.0',
        '        version: string-width@4.2.3',
        'packages:',
        '  /string-width@4.2.3:',
        packageBody,
      ].join('\n')

      const { graph } = parseText(text)

      assert.equal(requireEdge(graph, 'importer:.', '/string-width@4.2.3').kind, 'prod')
      assert.deepEqual(graph.warnings, [])
    })

    it('treats a lockfile without importers as the single root importer', () => {
      const text = [
        "lockfileVersion: '6.0'",
        'dependencies:',
        '  lodash:',
        '    specifier: ^4.17.21',
        '    version: 4.17.21',
        'devDependencies:',
        '  semver:',
        '    specifier: ^7.6.3',
        '    version: 7.6.3',
        'packages:',
        '  /lodash@4.17.21:',
        packageBody,
        '  /semver@7.6.3:',
        packageBody,
      ].join('\n')

      const { graph, supported } = parseText(text)

      assert.equal(supported, true)
      assert.deepEqual(graph.importers.map((importer) => importer.id), ['importer:.'])
      assert.deepEqual(requireNode(graph, 'importer:.').deps, [
        { to: '/lodash@4.17.21', kind: 'prod', range: '^4.17.21' },
        { to: '/semver@7.6.3', kind: 'dev', range: '^7.6.3' },
      ])
      assert.deepEqual(graph.warnings, [])
    })
  })

  describe('v6 non-registry packages', () => {
    const commit = '1d7e288222b53a0cab90a331f1865220ec29560c'
    const gitId = `github.com/u/gitdep/${commit}`
    const { graph, supported } = parseText(readFixture('v6-non-registry.yaml'))

    it('resolves git and file: dependencies to their own keys without placeholders or warnings', () => {
      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, [])
      assert.deepEqual(
        [...graph.packages.keys()].sort(),
        ['/lodash@4.17.21', '/wrapper@1.0.0', 'file:../localdep', gitId],
      )
    })

    it('takes name and version of a git dependency from the entry fields', () => {
      const node = requirePackage(graph, gitId)

      assert.equal(node.name, 'gitdep')
      assert.equal(node.version, '2.0.1')
      assert.equal(node.peerSuffix, undefined)
    })

    it('takes name and version of a file: dependency from the entry fields', () => {
      const node = requirePackage(graph, 'file:../localdep')

      assert.equal(node.name, 'localdep')
      assert.equal(node.version, '1.0.0')
    })

    it('links importer and package edges to the non-registry nodes', () => {
      assert.deepEqual(requireEdge(graph, 'importer:.', gitId), {
        to: gitId,
        kind: 'prod',
        range: `github:u/gitdep#${commit}`,
      })
      assert.deepEqual(requireEdge(graph, 'importer:.', 'file:../localdep'), {
        to: 'file:../localdep',
        kind: 'prod',
        range: 'file:../localdep',
      })
      assert.deepEqual(requireEdge(graph, '/wrapper@1.0.0', gitId), { to: gitId, kind: 'prod', range: '2.0.1' })
      assert.deepEqual(requireEdge(graph, gitId, '/lodash@4.17.21'), {
        to: '/lodash@4.17.21',
        kind: 'prod',
        range: '4.17.21',
      })
    })
  })

  describe('v9 non-registry packages', () => {
    const commit = '1d7e288222b53a0cab90a331f1865220ec29560c'
    const tarballId = `gitdep@https://codeload.github.com/u/gitdep/tar.gz/${commit}`
    const tarballUrl = `https://codeload.github.com/u/gitdep/tar.gz/${commit}`
    const { graph, supported } = parseText(readFixture('v9-non-registry.yaml'))

    it('resolves a tarball dependency to its snapshot key without placeholders or warnings', () => {
      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, [])
      assert.deepEqual([...graph.packages.keys()].sort(), [tarballId, 'lodash@4.17.21', 'wrapper@1.0.0'])
    })

    it('takes the version of a tarball dependency from the package metadata', () => {
      const node = requirePackage(graph, tarballId)

      assert.equal(node.name, 'gitdep')
      assert.equal(node.version, '2.0.1')
    })

    it('links importer and package edges to the tarball node', () => {
      assert.deepEqual(requireEdge(graph, 'importer:.', tarballId), { to: tarballId, kind: 'prod', range: tarballUrl })
      assert.deepEqual(requireEdge(graph, 'wrapper@1.0.0', tarballId), { to: tarballId, kind: 'prod', range: '2.0.1' })
    })
  })

  describe('pnpm 11 env lockfile document', () => {
    const envText = readFixture('v9-env-document.yaml')

    it('parses the main document that follows the env document', () => {
      const { graph, supported } = parseText(envText)

      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, [])
      assert.deepEqual(graph.importers.map((importer) => importer.id), ['importer:.'])
      assert.deepEqual([...graph.packages.keys()], ['lodash@4.17.21'])
      assert.deepEqual(requireEdge(graph, 'importer:.', 'lodash@4.17.21'), {
        to: 'lodash@4.17.21',
        kind: 'prod',
        range: '^4.17.21',
      })
    })

    it('parses the same graph from text with CRLF line endings', () => {
      const crlfGraph = parseText(envText.replace(/\n/g, '\r\n')).graph

      assert.deepEqual(collectTriples(crlfGraph), collectTriples(parseText(envText).graph))
      assert.deepEqual([...crlfGraph.packages.keys()], ['lodash@4.17.21'])
    })

    it('parses a single document that starts with a document marker', () => {
      const markedText = `---\n${readFixture('v9-workspace.yaml')}`

      assert.deepEqual(
        collectTriples(parseText(markedText).graph),
        collectTriples(parseText(readFixture('v9-workspace.yaml')).graph),
      )
    })
  })

  describe('link: inside packages', () => {
    it('resolves the link against the repository root', () => {
      const text = [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .: {}',
        '  tools/cli: {}',
        'packages:',
        '  host@1.0.0:',
        '    resolution: {integrity: sha512-AAAA}',
        'snapshots:',
        '  host@1.0.0:',
        '    dependencies:',
        '      local-lib: link:tools/cli',
      ].join('\n')

      const { graph } = parseText(text)

      assert.deepEqual(requireEdge(graph, 'host@1.0.0', 'importer:tools/cli'), {
        to: 'importer:tools/cli',
        kind: 'prod',
        range: 'link:tools/cli',
      })
      assert.deepEqual(graph.warnings, [])
    })
  })

  describe('unsupported lockfiles', () => {
    it('rejects lockfileVersion 5.4 with a warning and adds no nodes', () => {
      const { graph, supported } = parseText(readFixture('v5.yaml'))

      assert.equal(supported, false)
      assert.deepEqual(graph.warnings, ['pnpm lockfile version 5.4 is not supported'])
      assert.deepEqual(graph.importers, [])
      assert.equal(graph.packages.size, 0)
    })

    it('rejects a document without a lockfileVersion', () => {
      const { graph, supported } = parseText('importers: {}\n')

      assert.equal(supported, false)
      assert.deepEqual(graph.warnings, ['pnpm lockfile version undefined is not supported'])
    })
  })

  describe('lockfiles newer than supported', () => {
    it('parses a lockfile version above 9 like 9 and warns that results may be incomplete', () => {
      const v10Text = readFixture('v9-workspace.yaml').replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'")
      const { graph, supported } = parseText(v10Text)

      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, ['pnpm lockfile version 10.0 is newer than supported; results may be incomplete'])
      assert.deepEqual(collectTriples(graph), collectTriples(parseText(readFixture('v9-workspace.yaml')).graph))
    })

    it('does not warn for a minor version of 9', () => {
      const v91Text = readFixture('v9-workspace.yaml').replace("lockfileVersion: '9.0'", "lockfileVersion: '9.1'")

      assert.deepEqual(parseText(v91Text).graph.warnings, [])
    })
  })

  describe("this repository's own lockfile", () => {
    const { graph, supported } = parseText(readFixture('own-repo.yaml'))

    it('parses with zero placeholders and zero warnings', () => {
      assert.equal(supported, true)
      assert.deepEqual(graph.warnings, [])
      assert.deepEqual(
        allNodes(graph).filter((node) => node.id.startsWith('?:')),
        [],
      )
    })

    it('links the root importer to its direct dependencies with their kinds', () => {
      assert.deepEqual(graph.importers.map((importer) => importer.id), ['importer:.'])
      assert.deepEqual(requireEdge(graph, 'importer:.', 'yaml@2.9.1'), {
        to: 'yaml@2.9.1',
        kind: 'prod',
        range: '^2.9.1',
      })
      assert.equal(requireEdge(graph, 'importer:.', 'tsx@4.23.15').kind, 'dev')
    })

    it('keeps the optional edges of esbuild to its platform binaries', () => {
      const optionalEdges = requirePackage(graph, 'esbuild@0.28.2').deps.filter((edge) => edge.kind === 'optional')

      assert.equal(optionalEdges.length, 26)
      assert.ok(optionalEdges.every((edge) => edge.to.startsWith('@esbuild/')))
    })
  })

  describe('non-registry packages', () => {
    it('marks a v9 package whose key version is a URL and nothing else', () => {
      const { graph } = parseText(readFixture('v9-non-registry.yaml'))
      const marked = [...graph.packages.values()].filter((node) => node.nonRegistry).map((node) => node.id)

      assert.deepEqual(marked, ['gitdep@https://codeload.github.com/u/gitdep/tar.gz/1d7e288222b53a0cab90a331f1865220ec29560c'])
    })

    it('marks v6 git and directory packages and nothing else', () => {
      const { graph } = parseText(readFixture('v6-non-registry.yaml'))
      const marked = [...graph.packages.values()].filter((node) => node.nonRegistry).map((node) => node.id).sort()

      assert.deepEqual(marked, ['file:../localdep', 'github.com/u/gitdep/1d7e288222b53a0cab90a331f1865220ec29560c'].sort())
    })
  })
})
