import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  npmConfigEnv,
  parseNpmrc,
  parseNpmrcEntries,
  redactCredentials,
  stripRegistryCredentials,
  userNpmrcPath,
} from '../src/config/npmrc.ts'

describe('parseNpmrc', () => {
  it('reads the registry and ignores comments and blank lines', () => {
    const values = parseNpmrc('; comment\n# other\n\nregistry=https://r.example/\n', {})
    assert.equal(values.registry, 'https://r.example/')
    assert.equal(values.hasAuth, false)
  })

  it('expands ${VAR} from env and uses an empty string when unset', () => {
    const values = parseNpmrc('registry=https://${HOST}/${MISSING}x\n', { HOST: 'r.example' })
    assert.equal(values.registry, 'https://r.example/x')
  })

  it('collects scoped registries', () => {
    const values = parseNpmrc('@sample:registry=https://r.example/\n', {})
    assert.deepEqual(values.scopedRegistries, { '@sample': 'https://r.example/' })
  })

  it('flags auth keys and never keeps their values', () => {
    for (const key of ['//r.example/:_authToken', '//r.example/:_auth', '//r.example/:_password', '_authToken']) {
      const values = parseNpmrc(`${key}=secret-value\n`, {})
      assert.equal(values.hasAuth, true)
      assert.equal(JSON.stringify(values).includes('secret-value'), false)
    }
  })

  it('does not keep an auth value expanded from env', () => {
    const values = parseNpmrc('//r.example/:_authToken=${TOKEN}\n', { TOKEN: 'env-secret' })
    assert.equal(values.hasAuth, true)
    assert.equal(JSON.stringify(values).includes('env-secret'), false)
  })

  it('handles CRLF line endings', () => {
    const values = parseNpmrc('registry=https://r.example/\r\n', {})
    assert.equal(values.registry, 'https://r.example/')
  })

  it('strips userinfo from registry and scoped registry URLs and flags auth', () => {
    const values = parseNpmrc('registry=https://u:pw-secret@host.example/p/\n@s:registry=https://tok-secret@scoped.example/\n', {})
    assert.equal(values.registry, 'https://host.example/p/')
    assert.deepEqual(values.scopedRegistries, { '@s': 'https://scoped.example/' })
    assert.equal(values.hasAuth, true)
    assert.equal(/secret/.test(JSON.stringify(values)), false)
  })
})

describe('redactCredentials', () => {
  it('removes userinfo from URLs anywhere in the text', () => {
    const result = redactCredentials('GET https://user:s3cret@registry.example.test/pkg failed; see //bob:pw9@host/x')
    assert.equal(result, 'GET https://registry.example.test/pkg failed; see //host/x')
  })

  it('redacts auth assignments and bearer tokens', () => {
    const text = '//r.test/:_authToken=abc123\n_auth: dXNlcg==\n_password=hunter2 npm_token=tok Authorization: Bearer xyz.789'
    const result = redactCredentials(text)
    for (const secret of ['abc123', 'dXNlcg', 'hunter2', 'tok ', 'xyz.789']) assert.equal(result.includes(secret), false)
    assert.ok(result.includes('_authToken=[redacted]'))
  })

  it('leaves clean text unchanged', () => {
    assert.equal(redactCredentials('ERR_PNPM_NO_MATCHING_VERSION boom'), 'ERR_PNPM_NO_MATCHING_VERSION boom')
  })
})

describe('stripRegistryCredentials', () => {
  it('strips userinfo that contains whitespace', () => {
    assert.deepEqual(stripRegistryCredentials('https://user name:secret@host/'), { url: 'https://host/', hadCredentials: true })
  })
})

describe('redactCredentials with whitespace in userinfo', () => {
  it('does not leave the password behind', () => {
    assert.equal(redactCredentials('https://user name:secret@host/path').includes('secret'), false)
  })

  it('stays fast on long unbroken input', () => {
    const started = Date.now()
    redactCredentials('a'.repeat(200000))
    assert.ok(Date.now() - started < 500)
  })
})

describe('npmrc parsing like npm', () => {
  it('unquotes double and single quoted values', () => {
    assert.equal(parseNpmrc('registry="https://q.example/"\n', {}).registry, 'https://q.example/')
    assert.equal(parseNpmrc("registry='https://q.example/'\n", {}).registry, 'https://q.example/')
  })

  it('cuts unquoted values at an inline comment', () => {
    assert.equal(parseNpmrc('registry=https://r.example/ ;note\n', {}).registry, 'https://r.example/')
    assert.equal(parseNpmrc('registry=https://r.example/#frag\n', {}).registry, 'https://r.example/')
  })

  it('keeps escaped comment characters literal', () => {
    const entries = parseNpmrcEntries('//r.example/:_authToken=abc\\;def', {})
    assert.equal(entries[0].value, 'abc;def')
  })

  it('drops a scoped registry that is empty after expansion', () => {
    assert.deepEqual(parseNpmrc('@s:registry=${MISSING}\n', {}).scopedRegistries, {})
  })

  it('lists unscoped auth keys', () => {
    const values = parseNpmrc('_authToken=x\n//r.example/:_authToken=y\n', {})
    assert.deepEqual(values.unscopedAuthKeys, ['_authToken'])
    assert.equal(values.hasAuth, true)
  })
})

describe('npmConfigEnv', () => {
  it('finds the variable case-insensitively and prefers the lowercase key', () => {
    assert.equal(npmConfigEnv({ NPM_CONFIG_REGISTRY: 'https://e.example/' }, 'registry'), 'https://e.example/')
    assert.equal(
      npmConfigEnv({ NPM_CONFIG_REGISTRY: 'https://upper.example/', npm_config_registry: 'https://lower.example/' }, 'registry'),
      'https://lower.example/',
    )
    assert.equal(npmConfigEnv({}, 'registry'), undefined)
  })
})

describe('userNpmrcPath', () => {
  it('uses npm_config_userconfig with a home-relative prefix or falls back to the home npmrc', () => {
    assert.equal(userNpmrcPath({ npm_config_userconfig: '~/custom/.npmrc' }, '/home/u'), '/home/u/custom/.npmrc')
    assert.equal(userNpmrcPath({}, '/home/u'), '/home/u/.npmrc')
  })
})
