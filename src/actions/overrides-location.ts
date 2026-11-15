import { coerce, gte } from 'semver'
import { parse } from 'yaml'
import type { ManagerInfo, OverridesFile } from './types.ts'

export type OverridesLocation = { file: OverridesFile; warning?: string }

const PNPM_FIELD_IGNORED_WARNING = 'pnpm 11 ignores the pnpm field of package.json, so the override goes to pnpm-workspace.yaml'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseYamlRecord(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const parsed: unknown = parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseJsonRecord(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function parseManagerVersion(output: string): string | undefined {
  return coerce(output.trim())?.version
}

export function declaredOverridesFiles(files: { workspaceYaml: string | null; rootManifest: string | null }): OverridesFile[] {
  const declared: OverridesFile[] = []
  const workspace = parseYamlRecord(files.workspaceYaml)
  const workspaceOverrides = workspace?.overrides
  if (isRecord(workspaceOverrides) && Object.keys(workspaceOverrides).length > 0) declared.push('pnpm-workspace.yaml')
  const manifest = parseJsonRecord(files.rootManifest)
  if (isRecord(manifest?.pnpm) && isRecord(manifest.pnpm.overrides)) declared.push('package.json#pnpm.overrides')
  if (isRecord(manifest?.overrides)) declared.push('package.json#overrides')
  return declared
}

function atLeast(version: string, minimum: string): boolean {
  const coerced = coerce(version)
  return coerced !== null && gte(coerced, minimum)
}

export function overridesLocation(manager: ManagerInfo, declared: readonly OverridesFile[]): OverridesLocation {
  if (manager.name === 'npm') return { file: 'package.json#overrides' }
  const pnpmDeclared = declared.find((file) => file === 'pnpm-workspace.yaml' || file === 'package.json#pnpm.overrides')
  if (pnpmDeclared === 'package.json#pnpm.overrides' && atLeast(manager.version, '11.0.0')) {
    return { file: 'pnpm-workspace.yaml', warning: PNPM_FIELD_IGNORED_WARNING }
  }
  if (pnpmDeclared !== undefined) return { file: pnpmDeclared }
  return { file: atLeast(manager.version, '10.0.0') ? 'pnpm-workspace.yaml' : 'package.json#pnpm.overrides' }
}
