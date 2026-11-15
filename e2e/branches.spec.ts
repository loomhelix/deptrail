import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ScanSummary } from '../src/server/router.ts'
import { missingManager } from '../test/helpers/package-managers.ts'
import { expectNoAxeViolations } from './a11y.ts'
import { DEFAULT_REF, FIX_REF, fixtureGit } from './git-history.ts'
import { SHOP_ROOT, startShopMonorepo, type ShopMonorepo } from './shop-monorepo.ts'
import { expectTableFitsPanel, pageUrl } from './ui.ts'

const READY_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 180_000
const COMMIT_ACTIONS_REASON = 'Actions apply to the working tree. Switch to it to change files.'
const SCAN_POLL_SETTLE_MS = 2_000
const RELOAD_TIMEOUT_MS = 15_000
const SPARE_BRANCHES = ['spare/one', 'spare/two', 'spare/three', 'spare/four']
const pnpmMissing = missingManager('pnpm')

test.skip(pnpmMissing !== undefined, pnpmMissing)
test.describe.configure({ timeout: TEST_TIMEOUT_MS })

let fixture: ShopMonorepo | undefined

test.beforeAll(async () => {
  test.setTimeout(TEST_TIMEOUT_MS)
  fixture = await startShopMonorepo({ npmRoot: false, git: true })
})

test.afterAll(async () => {
  await fixture?.stop()
  fixture = undefined
})

function running(): ShopMonorepo {
  if (fixture === undefined) throw new Error('the git fixture is not running')
  return fixture
}

function urlWith(params: Readonly<Record<string, string>>): string {
  return pageUrl(running().url, params)
}

async function waitForChecks(page: Page, scanPath = '/api/scan'): Promise<void> {
  await expect
    .poll(
      async () => {
        const scan = (await (await page.request.get(new URL(scanPath, running().url).toString())).json()) as ScanSummary
        return scan.enrichment.state === 'done' && scan.roots.every((root) => root.status === 'ready')
      },
      { timeout: READY_TIMEOUT_MS },
    )
    .toBe(true)
}

function issueRow(page: Page, text: string): Locator {
  return page.getByTestId('issue-row').filter({ hasText: text })
}

function compareView(page: Page): Locator {
  return page.getByRole('region', { name: 'Compare' })
}

function tableRow(scope: Locator, ...texts: string[]): Locator {
  return texts.reduce((rows, text) => rows.filter({ hasText: text }), scope.getByRole('row'))
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

test('switches to a branch and back', async ({ page }) => {
  await page.goto(running().url)
  await waitForChecks(page)
  await page.goto(urlWith({ root: SHOP_ROOT }))
  const switcher = page.getByRole('button', { name: 'Source: Working tree', exact: true })
  await expect(switcher).toContainText('Working tree')
  await expect(switcher).toContainText('main')
  await expect(issueRow(page, 'child-lib 1.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })

  await switcher.click()
  await page.getByRole('combobox', { name: 'Select source' }).fill('fix')
  await page.getByRole('option', { name: /^fix\/child-lib/ }).click()
  await page.waitForURL((url) => url.searchParams.get('ref') === FIX_REF)
  await expect(page.getByText(/^Viewing fix\/child-lib at [0-9a-f]{7}, committed /)).toBeVisible()
  await expect(page).toHaveTitle(/^fix\/child-lib · /)
  await expect(page.getByRole('button', { name: 'Source: fix/child-lib', exact: true })).toContainText(shortCommit(running().history!.fix))
  await expect(issueRow(page, 'toolkit 2.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(issueRow(page, 'child-lib 1.0.0')).toHaveCount(0)

  await page.getByRole('button', { name: 'Back to working tree', exact: true }).click()
  await page.waitForURL((url) => !url.searchParams.has('ref'))
  await expect(page.getByText(/^Viewing /)).toHaveCount(0)
  await expect(issueRow(page, 'child-lib 1.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
})

test('keeps actions on the working tree', async ({ page }) => {
  await page.goto(running().url)
  await waitForChecks(page)
  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT, view: 'changes' }))
  await expect(page.getByText('Changes apply to the working tree.', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Changes/ })).toHaveText('Changes')

  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT }))
  await expect(issueRow(page, 'toolkit 2.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(page.getByRole('button', { name: 'Add fix', exact: true })).toHaveCount(0)

  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT, focus: 'toolkit@2.0.0' }))
  const actions = page.getByRole('complementary', { name: 'Package details' }).getByRole('region', { name: 'Actions' })
  await expect(actions.getByText(COMMIT_ACTIONS_REASON, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })

  await page.getByRole('button', { name: /^Refresh/ }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Reload branch' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Rescan files' })).toHaveCount(0)
})

test('compares two states', async ({ page }) => {
  await page.goto(running().url)
  await waitForChecks(page)
  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT }))
  await expect(issueRow(page, 'toolkit 2.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await page.keyboard.press('4')
  const compare = compareView(page)
  await expect(compare.getByRole('button', { name: 'Base: origin/main', exact: true })).toBeVisible()
  await expect(tableRow(compare, 'child-lib 1.0.0', 'resolved')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(tableRow(compare, 'web', 'parent-lib', '1.0.0', '1.1.0')).toBeVisible()
  await expect(tableRow(compare, 'web', 'toolkit', '^3.0.0', '^2.0.0')).toBeVisible()
  await expect(tableRow(compare, 'api', 'helper', '^1.0.0', '^1.1.0')).toBeVisible()
  await expect(tableRow(compare, 'child-lib', 'upgraded')).toBeVisible()
  await expect(tableRow(compare, 'toolkit', '2.0.0, 3.0.0', 'changed')).toBeVisible()
  await expect(compare.getByRole('status')).toContainText('1 root changed')

  await expectNoAxeViolations(page, 'Compare')

  await compare.getByRole('button', { name: 'child-lib', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Package details' }).getByRole('heading', { level: 2, name: /^child-lib/ })).toContainText('1.0.1')
})

test('compares since the merge base', async ({ page }) => {
  await page.goto(running().url)
  await waitForChecks(page)
  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT, view: 'compare' }))
  const compare = compareView(page)
  await expect(tableRow(compare, 'toolkit', 'changed')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await compare.getByRole('checkbox', { name: 'Since merge base' }).check()
  await page.waitForURL((url) => url.searchParams.get('mb') === '1')
  await expect(compare.getByText(`merge base ${shortCommit(running().history!.initial)}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(tableRow(compare, 'child-lib', 'upgraded')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(tableRow(compare, 'toolkit')).toHaveCount(0)
})

test('swaps base and target', async ({ page }) => {
  await page.goto(running().url)
  await waitForChecks(page)
  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT, view: 'compare' }))
  const compare = compareView(page)
  await expect(tableRow(compare, 'child-lib 1.0.0', 'resolved')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await compare.getByRole('button', { name: 'Swap', exact: true }).click()
  await page.waitForURL((url) => url.searchParams.get('ref') === DEFAULT_REF && url.searchParams.get('base') === FIX_REF)
  await expect(tableRow(compareView(page), 'child-lib 1.0.0', 'introduced')).toBeVisible({ timeout: READY_TIMEOUT_MS })
})

test('falls back for a ref that no longer exists', async ({ page }) => {
  await page.goto(running().url)
  await page.goto(urlWith({ ref: 'refs/heads/gone' }))
  await expect(page.getByRole('alert')).toContainText('Could not open refs/heads/gone: Unknown ref refs/heads/gone. Showing the working tree.')
  await expect(page.getByRole('button', { name: 'Source: Working tree', exact: true })).toBeVisible()
})

test('the source menu passes axe', async ({ page }) => {
  await page.goto(running().url)
  await page.getByRole('button', { name: 'Source: Working tree', exact: true }).click()
  await expect(page.getByRole('option', { name: /^fix\/child-lib/ })).toBeVisible()
  await expectNoAxeViolations(page, 'the source menu')
})

for (const width of [1280, 1440]) {
  test(`fits the compare tables at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(running().url)
    await waitForChecks(page)
    await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT, view: 'compare' }))
    await expect(tableRow(compareView(page), 'child-lib 1.0.0', 'resolved')).toBeVisible({ timeout: READY_TIMEOUT_MS })
    await expectTableFitsPanel(page)
    const overflow = await compareView(page).evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}

test('reloads a branch that the server dropped', async ({ page }) => {
  const { history, repoDir, url } = running()
  await page.goto(url)
  await waitForChecks(page)
  await page.goto(urlWith({ ref: FIX_REF, root: SHOP_ROOT }))
  await expect(issueRow(page, 'toolkit 2.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await waitForChecks(page, `/api/commits/${history!.fix}/scan`)
  await page.waitForTimeout(SCAN_POLL_SETTLE_MS)
  const git = fixtureGit(repoDir)
  const spareRefs = SPARE_BRANCHES.map((name) => {
    git(['update-ref', `refs/heads/${name}`, git(['commit-tree', `${history!.main}^{tree}`, '-p', history!.main, '-m', name])])
    return `refs/heads/${name}`
  })
  try {
    for (const ref of spareRefs) {
      const opened = await page.request.post(new URL('/api/sources', url).toString(), { data: { ref }, headers: { origin: new URL(url).origin } })
      expect(opened.status()).toBe(200)
    }
    const reloaded = page.waitForEvent('load', { timeout: RELOAD_TIMEOUT_MS })
    await issueRow(page, 'toolkit 2.0.0').click()
    await reloaded
    await expect(page.getByText(/^Viewing fix\/child-lib at /)).toBeVisible()
    await expect(issueRow(page, 'toolkit 2.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
    await expect(page.getByText(/Unknown source/)).toHaveCount(0)
  } finally {
    for (const ref of spareRefs) git(['update-ref', '-d', ref])
  }
})
