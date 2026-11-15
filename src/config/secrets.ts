import { redactCredentials } from './npmrc.ts'

export type SecretSet = { add(value: string): void; redact(text: string): string }

export const MIN_SECRET_LENGTH = 6
const REDACTED = '[redacted]'

export function createSecretSet(): SecretSet {
  const known = new Set<string>()
  return {
    add(value) {
      if (value.length >= MIN_SECRET_LENGTH) known.add(value)
    },
    redact(text) {
      const longestFirst = [...known].sort((left, right) => right.length - left.length)
      const withoutKnown = longestFirst.reduce((current, secret) => current.split(secret).join(REDACTED), text)
      return redactCredentials(withoutKnown)
    },
  }
}

export const processSecrets: SecretSet = createSecretSet()
