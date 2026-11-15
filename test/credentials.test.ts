import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readRegistryCredentials, type CredentialSources } from '../src/enrich/credentials.ts'
import { createSecretSet } from '../src/config/secrets.ts'

function credentialsFor(sources: Partial<CredentialSources>) {
  return readRegistryCredentials({ projectNpmrc: null, userNpmrc: null, env: {}, ...sources }, createSecretSet())
}

const base64 = (text: string) => Buffer.from(text).toString('base64')

describe('readRegistryCredentials', () => {
  it('gives a bearer token for the matching host regardless of protocol', () => {
    const credentials = credentialsFor({ projectNpmrc: '//r.example/:_authToken=tok-abcdef' })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), 'Bearer tok-abcdef')
    assert.equal(credentials.authorizationFor('http://r.example/pkg'), 'Bearer tok-abcdef')
    assert.equal(credentials.authorizationFor('https://other.example/pkg'), undefined)
  })

  it('prefers the longest matching path prefix', () => {
    const credentials = credentialsFor({
      projectNpmrc: '//r.example/:_authToken=root-token-1\n//r.example/team/:_authToken=team-token-1',
    })
    assert.equal(credentials.authorizationFor('https://r.example/team/pkg'), 'Bearer team-token-1')
    assert.equal(credentials.authorizationFor('https://r.example/other/pkg'), 'Bearer root-token-1')
  })

  it('matches the port exactly', () => {
    const credentials = credentialsFor({ projectNpmrc: '//r.example:8443/:_authToken=port-token-1' })
    assert.equal(credentials.authorizationFor('https://r.example:8443/x'), 'Bearer port-token-1')
    assert.equal(credentials.authorizationFor('https://r.example/x'), undefined)
  })

  it('gives basic authorization for _auth', () => {
    const credentials = credentialsFor({ projectNpmrc: '//r.example/:_auth=dXNlcjpwYXNz' })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), 'Basic dXNlcjpwYXNz')
  })

  it('combines username and base64 _password', () => {
    const credentials = credentialsFor({
      projectNpmrc: `//r.example/:username=alice\n//r.example/:_password=${base64('pw-secret')}`,
    })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), `Basic ${base64('alice:pw-secret')}`)
  })

  it('lets the project config override the user config for the same key', () => {
    const credentials = credentialsFor({
      userNpmrc: '//r.example/:_authToken=user-token-1',
      projectNpmrc: '//r.example/:_authToken=project-token-1',
    })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), 'Bearer project-token-1')
  })

  it('uses user config keys the project config does not set', () => {
    const credentials = credentialsFor({
      userNpmrc: '//r.example/:_authToken=user-token-1',
      projectNpmrc: '//s.example/:_authToken=project-token-1',
    })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), 'Bearer user-token-1')
  })

  it('reads userinfo from a registry value', () => {
    const credentials = credentialsFor({ projectNpmrc: 'registry=https://bob:pw-secret@r.example/' })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), `Basic ${base64('bob:pw-secret')}`)
  })

  it('reads userinfo from a scoped registry and from the npm_config_registry variable', () => {
    const scoped = credentialsFor({ projectNpmrc: '@acme:registry=https://bob:pw-secret@s.example/npm/' })
    assert.equal(scoped.authorizationFor('https://s.example/npm/pkg'), `Basic ${base64('bob:pw-secret')}`)
    const fromEnv = credentialsFor({ env: { NPM_CONFIG_REGISTRY: 'https://eve:pw-secret@e.example/' } })
    assert.equal(fromEnv.authorizationFor('https://e.example/pkg'), `Basic ${base64('eve:pw-secret')}`)
  })

  it('expands environment variables in values', () => {
    const credentials = credentialsFor({
      projectNpmrc: '//r.example/:_authToken=${TOKEN}',
      env: { TOKEN: 'env-token-1' },
    })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), 'Bearer env-token-1')
  })

  it('ignores unscoped auth keys', () => {
    const credentials = credentialsFor({ projectNpmrc: '_authToken=tok-abcdef' })
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), undefined)
  })

  it('registers unscoped auth values and their decoded forms as secrets without sending them anywhere', () => {
    const secrets = createSecretSet()
    const credentials = readRegistryCredentials(
      {
        userNpmrc: '_authToken=user-unscoped-token-1',
        projectNpmrc: `_authToken=project-unscoped-token-1\n_auth=${base64('carol:auth-secret-1')}\n_password=${base64('password-secret-1')}`,
        env: {},
      },
      secrets,
    )
    assert.equal(credentials.authorizationFor('https://registry.npmjs.org/pkg'), undefined)
    for (const secret of [
      'user-unscoped-token-1',
      'project-unscoped-token-1',
      base64('carol:auth-secret-1'),
      'carol:auth-secret-1',
      'auth-secret-1',
      base64('password-secret-1'),
      'password-secret-1',
    ]) {
      assert.equal(secrets.redact(`x ${secret} y`), 'x [redacted] y', secret)
    }
  })

  it('returns nothing for URLs without a web protocol or a path', () => {
    const credentials = credentialsFor({ projectNpmrc: '//r.example/:_authToken=tok-abcdef' })
    assert.equal(credentials.authorizationFor('mailto:x@y'), undefined)
    assert.equal(credentials.authorizationFor('localhost:4873/pkg'), undefined)
    assert.equal(credentials.authorizationFor('not a url'), undefined)
  })

  it('treats empty values as absent so shorter prefixes still apply', () => {
    const nested = credentialsFor({
      projectNpmrc: '//r.example/:_authToken=root-token-1\n//r.example/team/:_authToken=${MISSING}',
    })
    assert.equal(nested.authorizationFor('https://r.example/team/pkg'), 'Bearer root-token-1')
    const overriding = credentialsFor({
      userNpmrc: '//registry.npmjs.org/:_authToken=user-token-1',
      projectNpmrc: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
    })
    assert.equal(overriding.authorizationFor('https://registry.npmjs.org/pkg'), 'Bearer user-token-1')
  })

  it('survives malformed percent-encoding in userinfo and still registers other secrets', () => {
    const secrets = createSecretSet()
    const credentials = readRegistryCredentials(
      { projectNpmrc: 'registry=https://bob:100%@r.example/\n//s.example/:_authToken=field-token-1', userNpmrc: null, env: {} },
      secrets,
    )
    assert.equal(credentials.authorizationFor('https://r.example/pkg'), `Basic ${base64('bob:100%')}`)
    assert.equal(secrets.redact('x field-token-1 y'), 'x [redacted] y')
  })
})
