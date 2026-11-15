import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePnpmLock } from '../src/adapters/pnpm-lock.ts'
import { parseNpmLock } from '../src/adapters/npm-lock.ts'
import { RootGraphBuilder } from '../src/graph/root-graph-builder.ts'
import { PLACEHOLDER_PREFIX } from '../src/model.ts'
import type { Manager, RootGraph } from '../src/model.ts'

function readMonolithFile(relativePath: string): string {
  return readFileSync(new URL(`./fixtures/monolith/${relativePath}`, import.meta.url), 'utf8')
}

function newBuilder(manager: Manager): RootGraphBuilder {
  return new RootGraphBuilder({ id: '.', path: '.', manager, source: 'lockfile' })
}

function placeholderIds(graph: RootGraph): string[] {
  return [...graph.packages.keys()].filter((id) => id.startsWith(PLACEHOLDER_PREFIX))
}

describe('fixture monolith lockfiles', () => {
  it('parses the npm-package pnpm lockfile without placeholders or warnings', () => {
    const builder = newBuilder('pnpm')
    const { supported } = parsePnpmLock(readMonolithFile('npm-package/pnpm-lock.yaml'), builder)
    const graph = builder.build()
    assert.equal(supported, true)
    assert.deepEqual(placeholderIds(graph), [])
    assert.deepEqual(graph.warnings, [])
    const semver = graph.packages.get('semver@5.7.2')
    assert.ok(semver)
    assert.deepEqual([...semver.dependents].sort(), [
      'normalize-package-data@2.5.0',
      'vue-eslint-parser@9.4.3(eslint@9.17.0)',
    ])
  })

  it('parses the legacy/admin npm lockfile without placeholders', () => {
    const builder = newBuilder('npm')
    const { supported } = parseNpmLock(readMonolithFile('legacy/admin/package-lock.json'), builder)
    const graph = builder.build()
    assert.equal(supported, true)
    assert.deepEqual(placeholderIds(graph), [])
    assert.ok(graph.packages.has('semver@6.3.1'))
  })
})
