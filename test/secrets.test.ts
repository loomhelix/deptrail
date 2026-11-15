import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSecretSet, processSecrets } from '../src/config/secrets.ts'
import { readRegistryCredentials } from '../src/enrich/credentials.ts'
import { createErrorLog } from '../src/server/error-log.ts'

describe('secret set', () => {
  it('redacts values read from credentials', () => {
    const secrets = createSecretSet()
    readRegistryCredentials(
      {
        projectNpmrc: `//r.example/:_authToken=tok-abcdef\n//r.example/:_auth=${Buffer.from('u:decoded-auth').toString('base64')}`,
        userNpmrc: null,
        env: {},
      },
      secrets,
    )
    assert.equal(secrets.redact('x tok-abcdef y'), 'x [redacted] y')
    assert.equal(secrets.redact('x decoded-auth y').includes('decoded-auth'), false)
  })

  it('redacts the decoded password and userinfo passwords', () => {
    const secrets = createSecretSet()
    readRegistryCredentials(
      {
        projectNpmrc: `//r.example/:username=alice\n//r.example/:_password=${Buffer.from('pw-secret').toString('base64')}\nregistry=https://bob:userinfo-pw@s.example/`,
        userNpmrc: null,
        env: {},
      },
      secrets,
    )
    assert.equal(secrets.redact('a pw-secret b'), 'a [redacted] b')
    assert.equal(secrets.redact('a userinfo-pw b'), 'a [redacted] b')
  })

  it('does not add values shorter than the minimum length', () => {
    const secrets = createSecretSet()
    secrets.add('abcde')
    assert.equal(secrets.redact('x abcde y'), 'x abcde y')
  })

  it('replaces the longest known value first', () => {
    const secrets = createSecretSet()
    secrets.add('abcdef')
    secrets.add('abcdefgh')
    assert.equal(secrets.redact('x abcdefgh y'), 'x [redacted] y')
  })

  it('still applies pattern based redaction', () => {
    assert.equal(createSecretSet().redact('Bearer something-else'), 'Bearer [redacted]')
  })

  it('feeds the server error log through the process-wide set', () => {
    processSecrets.add('canary-secret-1')
    let written = ''
    createErrorLog({ write: (text) => (written += text) })('scan', new Error('leaked canary-secret-1 here'))
    assert.equal(written.includes('canary-secret-1'), false)
    assert.ok(written.includes('leaked'))
  })
})
