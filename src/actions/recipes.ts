import type { ProcessRunner } from '../adapters/command-runner.ts'
import type { SecretSet } from '../config/secrets.ts'
import { parseManagerVersion } from './overrides-location.ts'
import type { PackageManagerName } from './types.ts'

export const SANDBOX_TIMEOUT_MS = 300_000
export const INSTALL_TIMEOUT_MS = 900_000
export const PROBE_TIMEOUT_MS = 60_000

const STDERR_TAIL_LENGTH = 400

export const LOCKFILE_ONLY_ARGS: Record<PackageManagerName, readonly string[]> = {
  pnpm: ['install', '--lockfile-only', '--ignore-scripts'],
  npm: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
}

export const FROZEN_INSTALL_ARGS: Record<PackageManagerName, readonly string[]> = {
  pnpm: ['install', '--frozen-lockfile'],
  npm: ['ci'],
}

export function commandText(manager: PackageManagerName, args: readonly string[]): string {
  return [manager, ...args].join(' ')
}

export async function probeManager(
  runner: ProcessRunner,
  manager: PackageManagerName,
  cwd: string,
  env: Record<string, string | undefined>,
  secrets: SecretSet,
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  try {
    const result = await runner.run({ command: manager, args: ['--version'], cwd, env, timeoutMs: PROBE_TIMEOUT_MS })
    if (result.code !== 0) {
      const tail = secrets.redact(result.stderr).trim().slice(-STDERR_TAIL_LENGTH)
      return { ok: false, reason: `${manager} --version failed: ${tail}` }
    }
    const version = parseManagerVersion(result.stdout)
    return version ? { ok: true, version } : { ok: false, reason: `${manager} --version printed no version` }
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code
    return { ok: false, reason: code === 'ENOENT' ? `${manager} was not found` : `${manager} could not be started` }
  }
}
