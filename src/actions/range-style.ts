import { valid, validRange } from 'semver'
import { isNonRegistrySpec } from '../adapters/package-manifest.ts'

export type RangeRewrite = { editable: true; specifier: string; formChanged: boolean } | { editable: false; reason: string }

const CARET_PATTERN = /^\^\d+(\.\d+){0,2}$/
const TILDE_PATTERN = /^~\d+(\.\d+){0,2}$/
const ALIAS_PREFIX = 'npm:'

export function catalogNameOf(specifier: string): string | undefined {
  if (!specifier.startsWith('catalog:')) return undefined
  return specifier.slice('catalog:'.length) || 'default'
}

function rewriteAlias(specifier: string, target: string): RangeRewrite {
  const separator = specifier.lastIndexOf('@')
  if (separator <= ALIAS_PREFIX.length) return { editable: false, reason: `${specifier} has no version range` }
  const rewritten = rewriteRange(specifier.slice(separator + 1), target)
  if (!rewritten.editable) return rewritten
  return { ...rewritten, specifier: `${specifier.slice(0, separator + 1)}${rewritten.specifier}` }
}

export function rewriteRange(specifier: string, target: string): RangeRewrite {
  if (specifier.startsWith('workspace:')) return { editable: false, reason: 'workspace: specifiers are not edited' }
  if (specifier.startsWith('catalog:')) return { editable: false, reason: 'catalog entries are edited in pnpm-workspace.yaml' }
  if (specifier.startsWith(ALIAS_PREFIX)) return rewriteAlias(specifier, target)
  if (isNonRegistrySpec(specifier)) return { editable: false, reason: `${specifier} is not a registry range` }
  if (CARET_PATTERN.test(specifier)) return { editable: true, specifier: `^${target}`, formChanged: false }
  if (TILDE_PATTERN.test(specifier)) return { editable: true, specifier: `~${target}`, formChanged: false }
  if (valid(specifier) !== null) return { editable: true, specifier: target, formChanged: false }
  if (validRange(specifier) !== null) return { editable: true, specifier: `^${target}`, formChanged: true }
  return { editable: false, reason: `dist-tag ${specifier} is not edited` }
}
