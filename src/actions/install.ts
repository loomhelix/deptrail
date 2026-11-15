import type { ProcessRunner } from '../adapters/command-runner.ts'
import type { SecretSet } from '../config/secrets.ts'
import { FROZEN_INSTALL_ARGS, INSTALL_TIMEOUT_MS, commandText } from './recipes.ts'
import type { PackageManagerName } from './types.ts'

export type InstallOutcome = { ok: true } | { ok: false; reason: string; cancelled: boolean }

export type FrozenInstallInput = {
  manager: PackageManagerName
  rootDir: string
  runner: ProcessRunner
  env: Record<string, string | undefined>
  secrets: SecretSet
  signal: AbortSignal
  onLine: (line: string) => void
}

export async function runFrozenInstall(input: FrozenInstallInput): Promise<InstallOutcome> {
  const args = FROZEN_INSTALL_ARGS[input.manager]
  const text = commandText(input.manager, args)
  try {
    const result = await input.runner.run({
      command: input.manager,
      args,
      cwd: input.rootDir,
      env: input.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      signal: input.signal,
      onLine: (line) => input.onLine(input.secrets.redact(line)),
    })
    if (result.cancelled) return { ok: false, reason: 'canceled', cancelled: true }
    if (result.timedOut) return { ok: false, reason: `${text} did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes`, cancelled: false }
    if (result.code !== 0) return { ok: false, reason: `${text} exited with code ${result.code}`, cancelled: false }
    return { ok: true }
  } catch (failure) {
    const reason = (failure as NodeJS.ErrnoException).code === 'ENOENT' ? `${input.manager} was not found` : `${input.manager} could not be started`
    return { ok: false, reason, cancelled: false }
  }
}
