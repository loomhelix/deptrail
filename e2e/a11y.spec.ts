import { expect, test, type Page, type Route } from '@playwright/test'
import type { ChangesResponse } from '../src/actions/types.ts'
import type { ScanSummary } from '../src/server/router.ts'
import { missingManager } from '../test/helpers/package-managers.ts'
import { expectNoAxeViolations } from './a11y.ts'
import { startActionsFixture, type ActionsFixtureWithNpmRoot } from './actions-fixture.ts'
import { SHOP_NPM_ROOT, SHOP_ROOT } from './shop-monorepo.ts'
import {
  details,
  FAILED_OSV_NOTICE,
  issueGrouping,
  pageUrl,
  routeStaleAndFailedChecks,
  STALE_REGISTRY_NOTICE,
  tab,
  viewMenu,
  viewMenuButton,
} from './ui.ts'

const READY_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 240_000
const COLOR_SCHEMES = ['light', 'dark'] as const
const missingManagers = [missingManager('pnpm'), missingManager('npm')].filter((reason) => reason !== undefined)

test.skip(missingManagers.length > 0, missingManagers.join('; '))
test.describe.configure({ timeout: TEST_TIMEOUT_MS })

let fixture: ActionsFixtureWithNpmRoot | undefined

test.beforeAll(async () => {
  test.setTimeout(TEST_TIMEOUT_MS)
  fixture = await startActionsFixture({ npmRoot: true })
})

test.afterAll(async () => {
  await fixture?.stop()
  fixture = undefined
})

function running(): ActionsFixtureWithNpmRoot {
  if (fixture === undefined) throw new Error('the actions fixture is not running')
  return fixture
}

async function openWhenBothRootsAreReady(page: Page): Promise<void> {
  const scanUrl = new URL('/api/scan', running().url).toString()
  await page.goto(running().url)
  await expect
    .poll(
      async () => {
        const scan = (await (await page.request.get(scanUrl)).json()) as ScanSummary
        const ready = [SHOP_ROOT, SHOP_NPM_ROOT].every((rootId) => scan.roots.find((root) => root.id === rootId)?.actions.available === true)
        return scan.enrichment.state === 'done' && ready
      },
      { timeout: READY_TIMEOUT_MS },
    )
    .toBe(true)
  await page.goto(running().url)
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('issue-row').first()).toBeVisible({ timeout: READY_TIMEOUT_MS })
}

function changesUrl(rootId: string): string {
  return new URL(`/api/roots/${rootId}/changes`, running().url).toString()
}

async function addRecommendedFix(page: Page, rootId: string, nodeId: string): Promise<void> {
  const response = await page.request.post(changesUrl(rootId), {
    data: { nodeId, choice: 'recommended' },
    headers: { origin: new URL(running().url).origin },
  })
  expect(response.status()).toBe(201)
}

async function clearChanges(page: Page, rootId: string): Promise<void> {
  const response = await page.request.delete(changesUrl(rootId), { headers: { origin: new URL(running().url).origin } })
  expect(response.ok()).toBe(true)
}

async function changesOf(page: Page, rootId: string): Promise<ChangesResponse> {
  return (await (await page.request.get(changesUrl(rootId))).json()) as ChangesResponse
}

const GONE_HELPER_ID = 'helper@9.9.9'
const GONE_HELPER_REQUEST = /\/api\/roots\/shop\/nodes\/helper(@|%40)9\.9\.9\//
const GONE_HELPER_IN_URL = /helper(@|%40)9\.9\.9/

async function answerAsHelper(route: Route): Promise<void> {
  const response = await route.fetch({ url: route.request().url().replace(GONE_HELPER_IN_URL, 'helper%401.0.0') })
  const body = (await response.json()) as Record<string, unknown>
  const focus = body.focus
  const json = typeof focus === 'object' && focus !== null ? { ...body, focus: { ...focus, id: GONE_HELPER_ID } } : body
  await route.fulfill({ response, json })
}

async function revertIfApplied(page: Page, rootId: string): Promise<void> {
  await expect.poll(async () => (await changesOf(page, rootId)).job?.state, { timeout: READY_TIMEOUT_MS }).not.toBe('running')
  if (!(await changesOf(page, rootId)).revertable) return
  const reverted = await page.request.post(new URL(`/api/roots/${rootId}/revert`, running().url).toString(), {
    headers: { origin: new URL(running().url).origin },
  })
  expect(reverted.status()).toBe(202)
  await expect.poll(async () => (await changesOf(page, rootId)).job?.state, { timeout: READY_TIMEOUT_MS }).toBe('done')
}

for (const colorScheme of COLOR_SCHEMES) {
  test.describe(`the ${colorScheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await openWhenBothRootsAreReady(page)
    })

    test('Issues in All roots has no axe violations', async ({ page }) => {
      await expectNoAxeViolations(page, `Issues in All roots (${colorScheme})`)
    })

    test('Issues with an expanded multi-root group and a selected sub-row has no axe violations', async ({ page }) => {
      const grid = page.getByRole('treegrid', { name: 'Issues' })
      await expect(grid.getByTestId('issue-package').filter({ hasText: 'child-lib 1.0.0' })).toHaveAttribute('aria-expanded', 'true')
      const npmRow = grid.getByRole('row', { name: `child-lib 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })
      await expect(npmRow.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled({ timeout: READY_TIMEOUT_MS })
      await npmRow.getByText(SHOP_NPM_ROOT, { exact: true }).click()
      await expect(npmRow).toHaveAttribute('aria-selected', 'true')
      await expect(details(page).getByRole('heading', { level: 2 })).toHaveText('child-lib 1.0.0')
      await expectNoAxeViolations(page, `Issues with an expanded multi-root group (${colorScheme})`)
    })

    test('Issues with a selected sub-row that lists workspace packages has no axe violations', async ({ page }) => {
      const grid = page.getByRole('treegrid', { name: 'Issues' })
      const toolkitRow = grid.getByRole('row', { name: `toolkit 2.0.0 in ${SHOP_NPM_ROOT}`, exact: true })
      await expect(toolkitRow.getByTestId('workspace-name')).toHaveText(['api', 'web'], { timeout: READY_TIMEOUT_MS })
      await toolkitRow.getByText(SHOP_NPM_ROOT, { exact: true }).click()
      await expect(toolkitRow).toHaveAttribute('aria-selected', 'true')
      await expectNoAxeViolations(page, `Issues with a selected sub-row listing workspace packages (${colorScheme})`)
    })

    test('Issues grouped by direct dependency with expanded groups has no axe violations', async ({ page }) => {
      await viewMenuButton(page).click()
      await issueGrouping(page, 'Direct dependency').click()
      const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
      const parentHeader = grid.getByRole('row', { name: `parent-lib 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })
      await expect(parentHeader).toHaveAttribute('aria-expanded', 'true')
      const npmChild = grid.getByRole('row', { name: `child-lib 1.0.0 under helper 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })
      await expect(npmChild.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled({ timeout: READY_TIMEOUT_MS })
      await npmChild.click()
      await expect(npmChild).toHaveAttribute('aria-selected', 'true')
      await expectNoAxeViolations(page, `Issues grouped by direct dependency (${colorScheme})`)
    })

    test('Issues with the View menu open has no axe violations', async ({ page }) => {
      await viewMenuButton(page).click()
      await expect(viewMenu(page).getByRole('menuitemcheckbox', { name: 'dev', exact: true })).toBeVisible()
      await expectNoAxeViolations(page, `Issues with the View menu open (${colorScheme})`)
    })

    test('the Add recommended fixes dialog has no axe violations', async ({ page }) => {
      await page.getByRole('button', { name: 'Add recommended fixes…', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add recommended fixes' })
      await expect(dialog.getByRole('checkbox', { name: `${SHOP_NPM_ROOT} — 1 vulnerable package`, exact: true })).toBeChecked()
      await expectNoAxeViolations(page, `the Add recommended fixes dialog (${colorScheme})`)
    })

    test('Issues with the root switcher open has no axe violations', async ({ page }) => {
      await page.getByRole('banner').getByRole('button', { name: 'Root: All roots', exact: true }).click()
      await expect(page.getByRole('menu', { name: 'Root: All roots' })).toBeVisible()
      await expectNoAxeViolations(page, `Issues with the root switcher open (${colorScheme})`)
    })

    test('the keyboard help dialog has no axe violations', async ({ page }) => {
      await page.getByRole('banner').getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
      await expectNoAxeViolations(page, `the keyboard help dialog (${colorScheme})`)
    })

    test('the details of child-lib 1.0.0 in shop-npm have no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: 'child-lib@1.0.0' }))
      const panel = details(page)
      const recommended = panel.getByRole('region', { name: 'Actions' }).getByRole('radio', { name: 'Re-lock and update parent-lib', exact: true })
      await expect(recommended).toBeChecked({ timeout: READY_TIMEOUT_MS })
      await expect(panel.getByTestId('also-in')).toBeVisible()
      await expect(panel.getByTestId('why-here-row')).toHaveCount(2)
      await expectNoAxeViolations(page, `the details of child-lib (${colorScheme})`)
    })

    test('the details of toolkit 2.0.0 with More open have no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: 'toolkit@2.0.0' }))
      const panel = details(page)
      await expect(panel.getByRole('combobox', { name: 'Version' })).toHaveValue('2.1.0', { timeout: READY_TIMEOUT_MS })
      await expect(panel.getByTestId('header-label')).toHaveText(['↑ 3.0.0 major', 'no known issues'])
      await panel.getByTestId('details-more').getByText('More', { exact: true }).click()
      await expect(panel.getByTestId('details-more').getByRole('link', { name: 'npm', exact: true })).toBeVisible()
      await expectNoAxeViolations(page, `the details of toolkit (${colorScheme})`)
    })

    test('the details of a workspace package have no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: 'importer:web' }))
      const problems = details(page).getByRole('region', { name: 'Issues in dependencies' })
      await expect(problems.getByTestId('workspace-problem').first()).toBeVisible({ timeout: READY_TIMEOUT_MS })
      await expectNoAxeViolations(page, `the details of a workspace package (${colorScheme})`)
    })

    test('the Explore graph with a selection apart from its anchor and Options open has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'helper@1.0.0', view: 'explore', mode: 'graph', at: 'child-lib@1.0.0' }))
      const explore = page.getByRole('tabpanel')
      await expect(explore.getByRole('button', { name: 'Focus on helper 1.0.0', exact: true })).toBeVisible()
      await expect(explore.locator('[data-testid="graph-node"][data-id="child-lib@1.0.0"]')).toBeVisible()
      await explore.getByRole('button', { name: 'Options', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Options', exact: true }).getByLabel('Node limit', { exact: true })).toBeVisible()
      await expectNoAxeViolations(page, `the Explore graph with Options open (${colorScheme})`)
    })

    test('the Explore trail with a selection apart from its anchor and a highlighted path has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'helper@1.0.0', view: 'explore', mode: 'trail', at: 'child-lib@1.0.0' }))
      const explore = page.getByRole('tabpanel')
      const helperChip = explore.getByRole('listbox', { name: 'Direct dependencies', exact: true }).getByRole('option', { name: /^helper 1\.0\.0/ })
      await expect(helperChip).toHaveAttribute('aria-selected', 'true')
      await expect(explore.getByRole('listbox', { name: 'This package', exact: true }).getByRole('option')).toContainText(['child-lib 1.0.0'])
      await helperChip.focus()
      await expect(helperChip).toHaveClass(/trail__chip--on-path/)
      await expectNoAxeViolations(page, `the Explore trail (${colorScheme})`)
    })

    test('the Explore tree overview with an expanded workspace package and a selected row has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, view: 'explore', mode: 'tree' }))
      const tree = page.getByRole('tabpanel').getByRole('tree', { name: 'Dependencies' })
      const web = tree.getByRole('treeitem', { name: /^web/ })
      await web.getByRole('button', { name: 'Expand web', exact: true }).click()
      const parent = tree.getByRole('treeitem', { name: /^parent-lib 1\.0\.0/ })
      await parent.click()
      await expect(parent).toHaveAttribute('aria-selected', 'true')
      await expect(parent).toBeFocused()
      await expectNoAxeViolations(page, `the Explore tree overview (${colorScheme})`)
    })

    test('Explore in All roots without a selection has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { view: 'explore' }))
      await expect(page.getByRole('group', { name: 'Roots to explore', exact: true }).getByRole('button', { name: SHOP_ROOT, exact: true })).toBeVisible()
      await expectNoAxeViolations(page, `Explore in All roots (${colorScheme})`)
    })

    test('Changes with a section for each root has no axe violations', async ({ page }) => {
      await addRecommendedFix(page, SHOP_ROOT, 'child-lib@1.0.0')
      await addRecommendedFix(page, SHOP_NPM_ROOT, 'child-lib@1.0.0')
      try {
        await page.goto(pageUrl(running().url, { view: 'changes' }))
        const view = page.getByRole('region', { name: 'Changes', exact: true })
        await expect(view.getByTestId('root-changes')).toHaveCount(2)
        await expect(view.getByTestId('change-item')).toHaveCount(2)
        await view.getByTestId('change-item').first().focus()
        await expectNoAxeViolations(page, `Changes with a section for each root (${colorScheme})`)
      } finally {
        await clearChanges(page, SHOP_ROOT)
        await clearChanges(page, SHOP_NPM_ROOT)
      }
    })

    test('Changes with a preview, the Apply dialog, the applied and the reverted state have no axe violations', async ({ page }) => {
      await addRecommendedFix(page, SHOP_NPM_ROOT, 'child-lib@1.0.0')
      try {
        await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, view: 'changes' }))
        const section = page.getByRole('region', { name: 'Changes', exact: true }).getByRole('region', { name: SHOP_NPM_ROOT, exact: true })
        await section.getByRole('button', { name: 'Preview', exact: true }).click()
        const applyButton = section.getByRole('button', { name: 'Apply…', exact: true })
        await expect(applyButton).toBeVisible({ timeout: READY_TIMEOUT_MS })
        await expect(applyButton).not.toHaveAttribute('aria-disabled', 'true')
        const preview = section.getByRole('region', { name: 'Preview', exact: true })
        await preview.getByTestId('preview-package-changes').locator('summary').click()
        await expect(preview.getByTestId('preview-package-change').first()).toBeVisible()
        await expect(section.locator('.root-changes__step--done')).toHaveCount(2)
        await expectNoAxeViolations(page, `Changes with a preview (${colorScheme})`)

        await applyButton.click()
        const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
        await expectNoAxeViolations(page, `the Apply dialog (${colorScheme})`)

        await dialog.getByRole('checkbox', { name: 'Run install: npm ci' }).uncheck()
        await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
        const outcome = section.getByTestId('changes-outcome')
        await expect(outcome.getByTestId('install-hint')).toBeVisible({ timeout: READY_TIMEOUT_MS })
        await expect(section.locator('.root-changes__step--done')).toHaveCount(3)
        await expectNoAxeViolations(page, `Changes after apply (${colorScheme})`)

        await outcome.getByRole('button', { name: 'Revert files', exact: true }).click()
        await expect(outcome.getByTestId('job-outcome')).toHaveText(`Files restored in ${SHOP_NPM_ROOT}. 1 change is back in the list.`, { timeout: READY_TIMEOUT_MS })
        await expectNoAxeViolations(page, `Changes after revert (${colorScheme})`)
      } finally {
        await revertIfApplied(page, SHOP_NPM_ROOT)
        await clearChanges(page, SHOP_NPM_ROOT)
      }
    })

    test('the Add recommended fixes dialog after adding, with a root that failed, has no axe violations', async ({ page }) => {
      await page.route(`**/api/roots/${SHOP_ROOT}/changes/recommended`, (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The disk is full' }) }),
      )
      try {
        await page.getByRole('button', { name: 'Add recommended fixes…', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Add recommended fixes' })
        await dialog.getByRole('button', { name: 'Add fixes', exact: true }).click()
        await expect(dialog.getByRole('status')).toHaveText(`Added 1 fix to ${SHOP_NPM_ROOT}`, { timeout: READY_TIMEOUT_MS })
        await expect(dialog.getByRole('alert')).toHaveText(`Could not add fixes to ${SHOP_ROOT}: The disk is full`)
        await expect(dialog.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
        await expectNoAxeViolations(page, `the Add recommended fixes dialog after adding (${colorScheme})`)
      } finally {
        await page.unroute(`**/api/roots/${SHOP_ROOT}/changes/recommended`)
        await clearChanges(page, SHOP_NPM_ROOT)
      }
    })

    test('the search results have no axe violations', async ({ page }) => {
      await page.keyboard.press('ControlOrMeta+k')
      await page.getByRole('combobox', { name: 'Search packages' }).fill('child')
      await expect(page.getByRole('option', { name: `child-lib 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
      await expectNoAxeViolations(page, `the search results (${colorScheme})`)
    })

    test('the details of a version not in its root, of a package that moved after a rescan and of one that is in no root have no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { in: SHOP_ROOT, focus: GONE_HELPER_ID }))
      const panel = details(page)
      const missing = panel.getByTestId('details-missing')
      await expect(missing.getByText('helper 9.9.9 is not in shop.', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
      await expect(missing.getByRole('button')).toHaveCount(2)
      await expectNoAxeViolations(page, `the details of a version not in its root (${colorScheme})`)

      await page.route(GONE_HELPER_REQUEST, answerAsHelper)
      await page.reload()
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText('helper 1.0.0', { timeout: READY_TIMEOUT_MS })
      await expect(missing).toHaveCount(0)
      await page.unroute(GONE_HELPER_REQUEST, answerAsHelper)
      await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('menu', { name: 'Refresh' }).getByRole('menuitem', { name: 'Rescan files', exact: true }).click()
      await expect(panel.getByTestId('follow-notice')).toHaveText(/^Changed in shop: helper 9\.9\.9 → 1\.0\.0\. Showing the new version\./, { timeout: READY_TIMEOUT_MS })
      await expect.poll(() => new URL(page.url()).searchParams.get('focus')).toBe('helper@1.0.0')
      await expectNoAxeViolations(page, `the details of a package that moved (${colorScheme})`)

      await page.goto(pageUrl(running().url, { in: SHOP_ROOT, focus: 'ghost@1.0.0' }))
      await expect(panel.getByTestId('details-missing')).toHaveText('ghost is not in any root.', { timeout: READY_TIMEOUT_MS })
      await expectNoAxeViolations(page, `the details of a package in no root (${colorScheme})`)
    })

    test('the details with a stale and a failed check have no axe violations', async ({ page }) => {
      await routeStaleAndFailedChecks(page)
      await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: 'child-lib@1.0.0' }))
      await expect(details(page).getByTestId('check-notice').locator('p')).toHaveText([STALE_REGISTRY_NOTICE, FAILED_OSV_NOTICE], { timeout: READY_TIMEOUT_MS })
      await expectNoAxeViolations(page, `the details with stale and failed checks (${colorScheme})`)
    })

    test('the Explore tree of a workspace package with an expanded row and a selected row has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'parent-lib@1.0.0', view: 'explore', mode: 'tree', at: 'importer:web' }))
      const explore = page.getByRole('tabpanel')
      await expect(explore.getByRole('heading', { name: 'Dependencies of web', exact: true })).toBeVisible()
      const tree = explore.getByRole('tree', { name: 'Dependencies' })
      const parent = tree.getByRole('treeitem', { name: /^parent-lib 1\.0\.0/ })
      await expect(parent).toHaveAttribute('aria-selected', 'true', { timeout: READY_TIMEOUT_MS })
      await parent.getByRole('button', { name: 'Expand parent-lib', exact: true }).click()
      await expect(tree.getByRole('treeitem', { name: /^child-lib 1\.0\.0/ })).toBeVisible()
      await expectNoAxeViolations(page, `the Explore tree of a workspace package (${colorScheme})`)
    })

    test('the Explore graph of a whole root has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, view: 'explore', mode: 'graph' }))
      const explore = page.getByRole('tabpanel')
      await expect(explore.getByTestId('graph-canvas')).toBeVisible({ timeout: READY_TIMEOUT_MS })
      await expect(explore.getByTestId('graph-node').first()).toBeVisible()
      await expectNoAxeViolations(page, `the Explore graph of a whole root (${colorScheme})`)
    })

    test('Explore with an anchor that is gone has no axe violations', async ({ page }) => {
      await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'helper@1.0.0', view: 'explore', mode: 'trail', at: 'ghost@1.0.0' }))
      const explore = page.getByRole('tabpanel')
      await expect(explore.getByRole('alert')).toBeVisible({ timeout: READY_TIMEOUT_MS })
      await expect(explore.getByRole('button', { name: 'Focus on helper 1.0.0', exact: true })).toBeVisible()
      await expectNoAxeViolations(page, `Explore with an anchor that is gone (${colorScheme})`)
    })

    test('both panels collapsed has no axe violations', async ({ page }) => {
      await page.getByRole('button', { name: 'Hide roots panel ([)', exact: true }).click()
      await page.getByRole('button', { name: 'Hide details panel (])', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Show roots panel ([)', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Show details panel (])', exact: true })).toBeVisible()
      await expectNoAxeViolations(page, `both panels collapsed (${colorScheme})`)
    })
  })
}
