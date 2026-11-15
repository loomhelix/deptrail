import { join } from 'node:path'

export type NpmrcEntry = { key: string; value: string }
export type NpmrcValues = {
  registry?: string
  scopedRegistries: Record<string, string>
  hasAuth: boolean
  unscopedAuthKeys: string[]
}

type Environment = Record<string, string | undefined>

const AUTH_KEY_SUFFIXES = ['_authToken', '_auth', '_password']
const SCOPED_REGISTRY_KEY = /^(@[^:]+):registry$/
const SCOPED_AUTH_KEY_PREFIX = '//'
const NPM_CONFIG_PREFIX = 'npm_config_'
const HOME_PREFIX = '~/'
const COMMENT_CHARACTERS = ';#'

const VARIABLE_REFERENCE = /\$\{[^}]+\}/

function expandVariables(value: string, env: Environment): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => env[name] ?? '')
}

const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i
const URL_USERINFO_IN_TEXT = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/?#\n]*@/gi
const PROTOCOL_RELATIVE_USERINFO = /(^|[\s'"(])\/\/[^/?#\s@]+@/g
const AUTH_ASSIGNMENT = /(_authToken|_auth|_password|npm_token)(\s*[=:]\s*)\S+/gi
const BEARER_TOKEN = /\bBearer\s+\S+/gi
const REDACTED = '[redacted]'

export function stripRegistryCredentials(url: string): { url: string; hadCredentials: boolean } {
  const stripped = url.replace(URL_USERINFO, '$1')
  return { url: stripped, hadCredentials: stripped !== url }
}

export function redactCredentials(text: string): string {
  return text
    .replace(URL_USERINFO_IN_TEXT, '$1')
    .replace(PROTOCOL_RELATIVE_USERINFO, '$1//')
    .replace(AUTH_ASSIGNMENT, `$1$2${REDACTED}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
}

function cutAtInlineComment(value: string): string {
  let kept = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    const next = value[index + 1]
    if (character === '\\' && next !== undefined && COMMENT_CHARACTERS.includes(next)) {
      kept += next
      index++
    } else if (COMMENT_CHARACTERS.includes(character)) {
      break
    } else {
      kept += character
    }
  }
  return kept.trim()
}

function unquoteValue(rawValue: string): string {
  const isWrappedIn = (quote: string) => rawValue.length >= 2 && rawValue.startsWith(quote) && rawValue.endsWith(quote)
  if (isWrappedIn('"')) {
    try {
      return String(JSON.parse(rawValue))
    } catch {
      return rawValue
    }
  }
  if (isWrappedIn("'")) return rawValue.slice(1, -1)
  return cutAtInlineComment(rawValue)
}

export function parseNpmrcEntries(text: string, env: Environment): NpmrcEntry[] {
  const entries: NpmrcEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = expandVariables(unquoteValue(line.slice(separatorIndex + 1).trim()), env)
    entries.push({ key, value })
  }
  return entries
}

export function withoutVariableReferences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !VARIABLE_REFERENCE.test(line))
    .join('\n')
}

export function npmConfigEnv(env: Environment, name: string): string | undefined {
  const exactKey = `${NPM_CONFIG_PREFIX}${name}`
  if (env[exactKey] !== undefined) return env[exactKey]
  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === exactKey && env[key] !== undefined)
  return matchingKey === undefined ? undefined : env[matchingKey]
}

export function userNpmrcPath(env: Environment, home: string): string {
  const configured = npmConfigEnv(env, 'userconfig')
  if (configured === undefined || configured === '') return join(home, '.npmrc')
  return configured.startsWith(HOME_PREFIX) ? join(home, configured.slice(HOME_PREFIX.length)) : configured
}

export function parseNpmrc(text: string, env: Environment): NpmrcValues {
  const values: NpmrcValues = { scopedRegistries: {}, hasAuth: false, unscopedAuthKeys: [] }
  for (const { key, value } of parseNpmrcEntries(text, env)) {
    if (AUTH_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
      values.hasAuth = true
      if (!key.startsWith(SCOPED_AUTH_KEY_PREFIX)) values.unscopedAuthKeys.push(key)
      continue
    }
    const scopedMatch = SCOPED_REGISTRY_KEY.exec(key)
    if (key !== 'registry' && !scopedMatch) continue
    const registry = stripRegistryCredentials(value)
    if (registry.hadCredentials) values.hasAuth = true
    if (!scopedMatch) values.registry = registry.url
    else if (registry.url !== '') values.scopedRegistries[scopedMatch[1]] = registry.url
  }
  return values
}
