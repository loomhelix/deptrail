import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createProcessRunner } from '../../src/adapters/command-runner.ts'
import { parseManagerVersion } from '../../src/actions/overrides-location.ts'
import { LOCKFILE_ONLY_ARGS, SANDBOX_TIMEOUT_MS, commandText } from '../../src/actions/recipes.ts'
import type { PackageManagerName } from '../../src/actions/types.ts'

const OFFLINE_COREPACK_ENV = { COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }

export function installedVersion(name: PackageManagerName): string | undefined {
  const probe = spawnSync(name, ['--version'], { env: { ...process.env, ...OFFLINE_COREPACK_ENV }, encoding: 'utf8' })
  return probe.error === undefined && probe.status === 0 ? parseManagerVersion(probe.stdout) : undefined
}

export function missingManager(name: PackageManagerName): string | undefined {
  return installedVersion(name) === undefined ? `${name} is not on PATH` : undefined
}

export function packageManagerEnv(workDir: string, registryUrl: string): Record<string, string | undefined> {
  const configDir = path.join(workDir, 'package-manager')
  const userConfig = path.join(configDir, 'npmrc')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(userConfig, '')
  return {
    ...process.env,
    npm_config_registry: `${registryUrl}/`,
    npm_config_cache: path.join(configDir, 'npm-cache'),
    npm_config_store_dir: path.join(configDir, 'pnpm-store'),
    npm_config_cache_dir: path.join(configDir, 'pnpm-cache'),
    npm_config_userconfig: userConfig,
    npm_config_update_notifier: 'false',
    ...OFFLINE_COREPACK_ENV,
  }
}

export async function lockProject(dir: string, manager: PackageManagerName, env: Record<string, string | undefined>): Promise<void> {
  const args = LOCKFILE_ONLY_ARGS[manager]
  const result = await createProcessRunner().run({ command: manager, args, cwd: dir, env, timeoutMs: SANDBOX_TIMEOUT_MS })
  if (result.code !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter((text) => text !== '').join('\n')
    throw new Error(`${commandText(manager, args)} failed in ${dir}:\n${output}`)
  }
}
