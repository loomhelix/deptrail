import type { FakeNpmRegistry } from '../test/helpers/fake-npm-registry.ts'
import { SHOP_NPM_ROOT, SHOP_ROOT, startShopMonorepo } from './shop-monorepo.ts'

export { CHILD_ADVISORY_ID } from './shop-monorepo.ts'

export const ACTIONS_ROOT = SHOP_ROOT

export type ActionsFixture = { url: string; rootDir: string; registry: FakeNpmRegistry; stop(): Promise<void> }
export type ActionsFixtureWithNpmRoot = ActionsFixture & { npmRootDir: string }

export async function startActionsFixture(): Promise<ActionsFixture>
export async function startActionsFixture(options: { npmRoot: true }): Promise<ActionsFixtureWithNpmRoot>
export async function startActionsFixture(options?: { npmRoot: boolean }): Promise<ActionsFixture | ActionsFixtureWithNpmRoot> {
  const monorepo = await startShopMonorepo({ npmRoot: options?.npmRoot ?? false })
  const fixture: ActionsFixture = { url: monorepo.url, rootDir: monorepo.rootDirs[SHOP_ROOT], registry: monorepo.registry, stop: monorepo.stop }
  if (options?.npmRoot !== true) return fixture
  return { ...fixture, npmRootDir: monorepo.rootDirs[SHOP_NPM_ROOT] }
}
