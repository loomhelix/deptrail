import type { EnrichmentProblem, EnrichmentStatus } from '../../src/enrich/types.ts'
import { checkingProgressText, CREDENTIALS_HINT, problemLineText } from './vocabulary.ts'

const CREDENTIALS_REASON_PREFIX = 'rejected credentials'

export function credentialsHint(reason: string): string | undefined {
  return reason.startsWith(CREDENTIALS_REASON_PREFIX) ? CREDENTIALS_HINT : undefined
}

function originWithoutScheme(origin: string): string {
  return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
}

export function problemLine(problem: EnrichmentProblem): string {
  return problemLineText(originWithoutScheme(problem.origin), problem.message, problem.count)
}

export function problemHint(problem: EnrichmentProblem): string | undefined {
  return credentialsHint(problem.message)
}

export function progressLine(status: EnrichmentStatus): string {
  return checkingProgressText(status.registry.done, status.registry.total)
}
