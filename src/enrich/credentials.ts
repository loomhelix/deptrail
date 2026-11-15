import { npmConfigEnv, parseNpmrcEntries, type NpmrcEntry } from '../config/npmrc.ts'
import type { SecretSet } from '../config/secrets.ts'

export type AuthorizationLookup = (url: string) => string | undefined
export type RegistryCredentials = { authorizationFor: AuthorizationLookup }
export type CredentialSources = {
  projectNpmrc: string | null
  userNpmrc: string | null
  env: Record<string, string | undefined>
}

type CredentialFields = Partial<Record<'_authToken' | '_auth' | '_password' | 'username', string>>

const CREDENTIAL_FIELDS = ['_authToken', '_auth', '_password', 'username'] as const
const UNSCOPED_SECRET_FIELDS = ['_authToken', '_auth', '_password'] as const
const WEB_PROTOCOLS = ['http:', 'https:']
const SCOPED_REGISTRY_KEY = /^@[^:]+:registry$/

function splitCredentialKey(key: string): { prefix: string; field: keyof CredentialFields } | undefined {
  if (!key.startsWith('//')) return undefined
  const separatorIndex = key.lastIndexOf(':')
  const prefix = key.slice(0, separatorIndex)
  const field = key.slice(separatorIndex + 1)
  const knownField = CREDENTIAL_FIELDS.find((candidate) => candidate === field)
  if (separatorIndex === -1 || knownField === undefined) return undefined
  return { prefix: prefix.endsWith('/') ? prefix : `${prefix}/`, field: knownField }
}

function encodeBasic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8')
}

function addFieldSecrets(fields: CredentialFields, secrets: SecretSet): void {
  for (const value of Object.values(fields)) secrets.add(value)
  if (fields._auth !== undefined) {
    const decodedAuth = decodeBase64(fields._auth)
    secrets.add(decodedAuth)
    secrets.add(decodedAuth.slice(decodedAuth.indexOf(':') + 1))
  }
  if (fields._password !== undefined) secrets.add(decodeBase64(fields._password))
}

function authorizationFromFields(fields: CredentialFields, secrets: SecretSet): string | undefined {
  addFieldSecrets(fields, secrets)
  const decodedPassword = fields._password === undefined ? undefined : decodeBase64(fields._password)
  if (fields._authToken !== undefined) return `Bearer ${fields._authToken}`
  if (fields._auth !== undefined) return `Basic ${fields._auth}`
  if (fields.username !== undefined && decodedPassword !== undefined) return encodeBasic(fields.username, decodedPassword)
  return undefined
}

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function userinfoAuthorization(registry: string, secrets: SecretSet): { prefix: string; authorization: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(registry)
  } catch {
    return undefined
  }
  if (parsed.username === '') return undefined
  const password = decodeUserinfo(parsed.password)
  secrets.add(password)
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
  return { prefix: `//${parsed.host}${path}`, authorization: encodeBasic(decodeUserinfo(parsed.username), password) }
}

function addUnscopedSecrets(entries: NpmrcEntry[], secrets: SecretSet): void {
  for (const { key, value } of entries) {
    const field = UNSCOPED_SECRET_FIELDS.find((candidate) => candidate === key)
    if (field !== undefined && value !== '') addFieldSecrets({ [field]: value }, secrets)
  }
}

function collectFields(entries: NpmrcEntry[], fieldsByPrefix: Map<string, CredentialFields>) {
  for (const { key, value } of entries) {
    const credentialKey = splitCredentialKey(key)
    if (credentialKey === undefined) continue
    if (value === '') continue
    const fields = fieldsByPrefix.get(credentialKey.prefix) ?? {}
    fields[credentialKey.field] = value
    fieldsByPrefix.set(credentialKey.prefix, fields)
  }
}

function registryValues(entries: NpmrcEntry[], env: CredentialSources['env']): string[] {
  const fromEntries = entries
    .filter(({ key }) => key === 'registry' || SCOPED_REGISTRY_KEY.test(key))
    .map(({ value }) => value)
  const fromEnv = npmConfigEnv(env, 'registry')
  return fromEnv === undefined ? fromEntries : [...fromEntries, fromEnv]
}

function candidatePrefixes(url: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  if (!WEB_PROTOCOLS.includes(parsed.protocol) || !parsed.pathname.startsWith('/')) return []
  const rootPrefix = `//${parsed.host}/`
  const candidates = [`//${parsed.host}${parsed.pathname}`]
  let current = candidates[0]
  while (current !== rootPrefix) {
    const withoutTrailingSlash = current.endsWith('/') ? current.slice(0, -1) : current
    current = withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/') + 1)
    candidates.push(current)
  }
  return candidates
}

export function readRegistryCredentials(sources: CredentialSources, secrets: SecretSet): RegistryCredentials {
  const entries = [
    ...parseNpmrcEntries(sources.userNpmrc ?? '', sources.env),
    ...parseNpmrcEntries(sources.projectNpmrc ?? '', sources.env),
  ]
  addUnscopedSecrets(entries, secrets)
  const fieldsByPrefix = new Map<string, CredentialFields>()
  collectFields(entries, fieldsByPrefix)
  const authorizationByPrefix = new Map<string, string>()
  for (const registry of registryValues(entries, sources.env)) {
    const fromUserinfo = userinfoAuthorization(registry, secrets)
    if (fromUserinfo !== undefined) authorizationByPrefix.set(fromUserinfo.prefix, fromUserinfo.authorization)
  }
  for (const [prefix, fields] of fieldsByPrefix) {
    const authorization = authorizationFromFields(fields, secrets)
    if (authorization !== undefined) authorizationByPrefix.set(prefix, authorization)
  }
  return {
    authorizationFor: (url) => {
      for (const candidate of candidatePrefixes(url)) {
        const authorization = authorizationByPrefix.get(candidate)
        if (authorization !== undefined) return authorization
      }
      return undefined
    },
  }
}
