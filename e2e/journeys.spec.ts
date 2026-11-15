import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AddChangeRequest, ChangesResponse } from '../src/actions/types.ts'
import type { ScanSummary } from '../src/server/router.ts'
import { missingManager } from '../test/helpers/package-managers.ts'
import { CHILD_ADVISORY_ID, startActionsFixture, type ActionsFixtureWithNpmRoot } from './actions-fixture.ts'
import { SHOP_NPM_ROOT, SHOP_ROOT } from './shop-monorepo.ts'
import {
  chooseRoot,
  details,
  detailsLandmark,
  FAILED_OSV_NOTICE,
  issueGrouping,
  mode,
  pageUrl,
  routeStaleAndFailedChecks,
  STALE_REGISTRY_NOTICE,
  tab,
  viewMenu,
  viewMenuButton,
} from './ui.ts'

const READY_TIMEOUT_MS = 60_000
const LINE_GAP_PX = 8
const TEST_TIMEOUT_MS = 240_000
const HELPER_LABEL = 'helper 1.0.0'
const CHILD_ID = 'child-lib@1.0.0'
const CHILD_LABEL = 'child-lib 1.0.0'
const TOOLKIT_ID = 'toolkit@2.0.0'
const WEB_ID = 'importer:web'
const missingManagers = [missingManager('pnpm'), missingManager('npm')].filter((reason) => reason !== undefined)

function nestedRowName(root: string): RegExp {
  return new RegExp(`^${CHILD_LABEL.replaceAll('.', '\\.')} under .+ in ${root}$`)
}

test.skip(missingManagers.length > 0, missingManagers.join('; '))
test.describe.configure({ timeout: TEST_TIMEOUT_MS })

let fixture: ActionsFixtureWithNpmRoot | undefined

test.beforeEach(async () => {
  fixture = await startActionsFixture({ npmRoot: true })
})

test.afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

function running(): ActionsFixtureWithNpmRoot {
  if (fixture === undefined) throw new Error('the actions fixture is not running')
  return fixture
}

function apiUrl(path: string): string {
  return new URL(path, running().url).toString()
}

async function openWhenBothRootsAreReady(page: Page): Promise<void> {
  await page.goto(running().url)
  await expect
    .poll(
      async () => {
        const scan = (await (await page.request.get(apiUrl('/api/scan'))).json()) as ScanSummary
        const ready = [SHOP_ROOT, SHOP_NPM_ROOT].every((rootId) => scan.roots.find((root) => root.id === rootId)?.actions.available === true)
        return scan.enrichment.state === 'done' && ready
      },
      { timeout: READY_TIMEOUT_MS },
    )
    .toBe(true)
  await page.goto(running().url)
}

async function changesOf(page: Page, rootId: string): Promise<ChangesResponse> {
  return (await (await page.request.get(apiUrl(`/api/roots/${rootId}/changes`))).json()) as ChangesResponse
}

async function changeCount(page: Page, rootId: string): Promise<number> {
  return (await changesOf(page, rootId)).items.length
}

function changesView(page: Page) {
  return page.getByRole('region', { name: 'Changes', exact: true })
}

function rootSection(page: Page, rootId: string) {
  return changesView(page).getByRole('region', { name: rootId, exact: true })
}

function issuesGrid(page: Page) {
  return page.getByRole('treegrid', { name: 'Issues' })
}

function locationRow(page: Page, packageLabel: string, rootId: string) {
  return issuesGrid(page).getByRole('row', { name: `${packageLabel} in ${rootId}`, exact: true })
}

function packageRow(page: Page, packageLabel: string) {
  return issuesGrid(page).getByTestId('issue-package').filter({ hasText: packageLabel })
}

function typeToggle(page: Page, name: string) {
  return page.getByRole('group', { name: 'Issue types' }).getByRole('button', { name, exact: true })
}

test("the owner's scenario keeps shop-npm from the helper sub-row to Add to changes", async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const helperRow = locationRow(page, HELPER_LABEL, SHOP_NPM_ROOT)
  await helperRow.getByText(SHOP_NPM_ROOT, { exact: true }).click({ timeout: READY_TIMEOUT_MS })

  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
  await expect(page).toHaveURL(/[?&]in=shop-npm(&|$)/)
  await expect(page).toHaveURL(/[?&]focus=helper@1\.0\.0(&|$)/)
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)

  await tab(page, 'Explore').click()
  await expect(page).toHaveURL(/[?&]view=explore(&|$)/)
  await expect(page).toHaveURL(/[?&]in=shop-npm(&|$)/)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)

  await tab(page, 'Issues').click()
  await page.getByRole('button', { name: 'Hide details panel (])', exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveCount(0)
  await helperRow.getByRole('button', { name: 'Update…', exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  await expect(panel.getByRole('combobox', { name: 'Version' })).toBeFocused({ timeout: READY_TIMEOUT_MS })

  const update = panel.getByRole('region', { name: 'Actions' }).getByTestId('actions-update')
  await update.getByRole('button', { name: 'Add to changes' }).click()
  await expect(update.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeFocused()

  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  expect(await changeCount(page, SHOP_ROOT)).toBe(0)
  await expect(helperRow.getByRole('button', { name: '✓ In changes', exact: true })).toBeVisible()
  await expect(locationRow(page, HELPER_LABEL, SHOP_ROOT).getByRole('button', { name: 'Update…', exact: true })).toBeVisible()
})

test('the details of child-lib 1.0.0 in shop-npm read in task order: header, vulnerability, what to do, why it is here', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: CHILD_ID }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
  await expect(panel.getByTestId('also-in')).toHaveText(`also in ${SHOP_ROOT} (1.0.0)`)
  await expect(panel.getByTestId('header-label')).toHaveText(['high'])

  const advisory = panel.getByTestId('advisory')
  await expect(advisory).toHaveCount(1)
  await expect(advisory.getByRole('link', { name: CHILD_ADVISORY_ID, exact: true })).toBeVisible()
  await expect(advisory).toContainText('Fixed in 1.0.1')

  const whatToDo = panel.getByRole('region', { name: 'Actions' })
  await expect(whatToDo.getByRole('radio')).toHaveCount(2, { timeout: READY_TIMEOUT_MS })
  await expect(whatToDo.getByRole('radio', { name: 'Re-lock and update parent-lib', exact: true })).toBeChecked()
  await expect(whatToDo.getByRole('radio', { name: 'Override to 1.0.1', exact: true })).not.toBeChecked()

  const whyHere = panel.getByRole('region', { name: 'Dependents' })
  await expect(whyHere.getByTestId('why-here-row')).toHaveText(['helper 1.0.0 requires ^1.0.0 · from api', 'parent-lib 1.0.0 requires 1.0.0 · from web'])
  await expect(panel.getByRole('heading', { level: 3 })).toHaveText(['Vulnerability', 'Actions', 'Dependents'])
  for (const removed of ['Requested ranges', 'Upward tree', 'Versions in the monolith', 'Registry']) {
    await expect(panel.getByRole('region', { name: removed })).toHaveCount(0)
  }

  await panel.getByTestId('also-in').getByRole('button', { name: `${SHOP_ROOT} (1.0.0)`, exact: true }).click()
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_ROOT)
  await expect.poll(() => new URL(page.url()).searchParams.get('in')).toBe(SHOP_ROOT)
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)
  expect(new URL(page.url()).searchParams.get('focus')).toBe(CHILD_ID)
  await expect(panel.getByTestId('also-in')).toHaveText(`also in ${SHOP_NPM_ROOT} (1.0.0)`)
})

test('the details of toolkit 2.0.0 preselect 2.1.0 and Add to changes turns into ✓ In changes · Review', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: TOOLKIT_ID }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('toolkit 2.0.0')
  await expect(panel.getByTestId('header-label')).toHaveText(['↑ 3.0.0 major', 'no known issues'])
  await expect(panel.getByRole('region', { name: 'Dependents' }).getByTestId('why-here-row')).toHaveText([
    'api requires ^2.0.0 · direct dependency',
    'web requires ^2.0.0 · direct dependency',
  ])

  const update = panel.getByRole('region', { name: 'Actions' }).getByTestId('actions-update')
  await expect(update.getByRole('combobox', { name: 'Version' })).toHaveValue('2.1.0', { timeout: READY_TIMEOUT_MS })
  await update.getByRole('button', { name: 'Add to changes', exact: true }).click()
  const review = update.getByRole('button', { name: '✓ In changes · Review', exact: true })
  await expect(review).toBeFocused()
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  await review.click()
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('changes')
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)
  const item = rootSection(page, SHOP_NPM_ROOT).getByTestId('change-item')
  await expect(item).toHaveCount(1)
  await expect(item).toBeFocused()
})

test('a workspace package lists the issues in its dependencies and its changes, and opens its dependencies', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addRecommendedFix(page, SHOP_NPM_ROOT, CHILD_ID)
  await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: WEB_ID }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('web')
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
  await expect(panel.getByTestId('workspace-path')).toHaveText(`${SHOP_NPM_ROOT}/web`)

  const problems = panel.getByRole('region', { name: 'Issues in dependencies' })
  await expect(problems.getByTestId('workspace-problem').getByRole('button')).toHaveText([CHILD_LABEL, 'toolkit 2.0.0', 'parent-lib 1.0.0'])
  const changes = panel.getByRole('region', { name: `Changes in ${SHOP_NPM_ROOT}` })
  await expect(changes.getByRole('listitem')).toHaveText(['Fix child-lib 1.0.0'])

  await expect(panel.getByTestId('workspace-dependencies')).toContainText('2 direct dependencies')
  await panel.getByRole('button', { name: 'Explore dependencies', exact: true }).click()
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect(mode(page, 'Dependencies')).toHaveAttribute('aria-checked', 'true')
  expect(new URL(page.url()).searchParams.get('at')).toBe(WEB_ID)

  await problems.getByRole('button', { name: CHILD_LABEL, exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
})

test('with nothing selected, details ask to select an issue and summarize the roots of the scope', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const panel = details(page)
  await expect(panel.getByText('Select an issue to see available actions.', { exact: true })).toBeVisible()
  const npmRoot = panel.getByTestId('scope-root').filter({ hasText: SHOP_NPM_ROOT })
  await expect(npmRoot.getByRole('link', { name: '1 vulnerable', exact: true })).toBeVisible()

  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT }))
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(SHOP_NPM_ROOT)
  await expect(panel.getByTestId('scope-source')).toContainText('Exact versions from the lockfile.')
  await panel.getByRole('link', { name: '1 vulnerable', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('types')).toBe('vulnerability')
})

test('Add fix on the shop-npm sub-row of child-lib adds the fix to shop-npm only and turns into ✓ In changes', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const npmRow = locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT)
  const add = npmRow.getByRole('button', { name: 'Add fix', exact: true })
  await expect(add).toBeEnabled({ timeout: READY_TIMEOUT_MS })

  const addRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/changes'))
  await add.click()
  const request = await addRequest
  expect(new URL(request.url()).pathname).toBe(`/api/roots/${SHOP_NPM_ROOT}/changes`)
  expect(request.postDataJSON()).toMatchObject({ nodeId: CHILD_ID, choice: 'recommended' })

  const inChanges = npmRow.getByRole('button', { name: '✓ In changes', exact: true })
  await expect(inChanges).toBeVisible()
  await expect(inChanges).toBeFocused()
  await expect(page.locator('[aria-live="polite"]')).toHaveText(`Added fix for child-lib to ${SHOP_NPM_ROOT}`)
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  expect(await changeCount(page, SHOP_ROOT)).toBe(0)
  await expect(locationRow(page, CHILD_LABEL, SHOP_ROOT).getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled()
  await expect(tab(page, 'Changes')).toHaveText('Changes 1')
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)
  expect(new URL(page.url()).searchParams.has('focus')).toBe(false)

  await inChanges.click()
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('changes')
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)
  const item = rootSection(page, SHOP_NPM_ROOT).getByTestId('change-item')
  await expect(item).toHaveCount(1)
  await expect(item).toBeFocused()
})

test('arrows and Enter in Issues select the shop-npm sub-row of child-lib, and its recommended fix is the one details recommend', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = packageRow(page, CHILD_LABEL)
  await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: READY_TIMEOUT_MS })
  await expect(header).toHaveAttribute('tabindex', '0')
  const shopRow = locationRow(page, CHILD_LABEL, SHOP_ROOT)
  const npmRow = locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT)
  await expect(npmRow.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled({ timeout: READY_TIMEOUT_MS })

  await header.focus()
  await page.keyboard.press('ArrowDown')
  await expect(shopRow).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(npmRow).toBeFocused()
  await page.keyboard.press('Enter')

  await expect.poll(() => new URL(page.url()).searchParams.get('in')).toBe(SHOP_NPM_ROOT)
  await expect.poll(() => new URL(page.url()).searchParams.get('focus')).toBe(CHILD_ID)
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
  await expect(npmRow).toHaveAttribute('aria-selected', 'true')
  await expect(shopRow).toHaveAttribute('aria-selected', 'false')
  await expect(npmRow).toBeFocused()

  const recommended = (await npmRow.getByTestId('row-recommended').innerText()).trim()
  expect(recommended).not.toBe('')
  await expect(panel.getByRole('region', { name: 'Actions' }).getByRole('radio', { checked: true })).toHaveAccessibleName(recommended, {
    timeout: READY_TIMEOUT_MS,
  })

  await page.keyboard.press('ArrowLeft')
  await expect(header).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(npmRow).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(npmRow).toBeVisible()
})

test('search with shop-npm active keeps shop-npm on Enter', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const scopedUrl = new URL(running().url)
  scopedUrl.searchParams.set('root', SHOP_NPM_ROOT)
  await page.goto(scopedUrl.toString())

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Search packages' }).fill('helper')
  await expect(page.getByRole('option', { name: new RegExp(`in ${SHOP_NPM_ROOT}`) })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(page.getByRole('option').first()).toHaveAccessibleName(new RegExp(`in ${SHOP_NPM_ROOT}`))
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(/[?&]root=shop-npm(&|$)/)
  const details = page.getByRole('complementary', { name: 'Package details' }).getByTestId('details-body')
  await expect(details.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
})

test('a search pick in another root switches the scope to that root and announces it', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_ROOT }))
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Search packages' }).fill('helper')
  const npmOption = page.getByRole('option', { name: new RegExp(`in ${SHOP_NPM_ROOT}`) })
  await expect(npmOption).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(page.getByRole('option').first()).toHaveAccessibleName(new RegExp(`in ${SHOP_ROOT}$`))
  await npmOption.click()

  await expect.poll(() => searchParam(page, 'root')).toBe(SHOP_NPM_ROOT)
  expect(searchParam(page, 'focus')).toBe('helper@1.0.0')
  await expect(page.locator('[aria-live="polite"]')).toHaveText(`Switched to ${SHOP_NPM_ROOT}`)
  await expect(page.getByRole('banner').getByRole('button', { name: `Root: ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()
  await expect(details(page).getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
})

test('a stale focus in the URL says the version is not in that root, moves nothing and links the versions that are', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { in: SHOP_ROOT, focus: 'helper@9.9.9' }))
  const panel = details(page)
  const missing = panel.getByTestId('details-missing')
  await expect(missing.getByText('helper 9.9.9 is not in shop.', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(panel.getByTestId('follow-notice')).toHaveCount(0)
  await expect(missing.getByRole('button')).toHaveCount(2)
  await expect(missing.getByRole('button', { name: `Open ${HELPER_LABEL} in ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()
  expect(searchParam(page, 'focus')).toBe('helper@9.9.9')

  await missing.getByRole('button', { name: HELPER_LABEL, exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.0.0')
  expect(searchParam(page, 'in')).toBe(SHOP_ROOT)
  await expect(panel.getByTestId('follow-notice')).toHaveCount(0)
})

test('a package missing from its root offers the roots that still have it, and says when no root has it', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { in: SHOP_ROOT, focus: 'ghost@1.0.0' }))
  const panel = details(page)
  const missing = panel.getByTestId('details-missing')
  await expect(missing).toHaveText('ghost is not in any root.', { timeout: READY_TIMEOUT_MS })
  await expect(missing.getByRole('button')).toHaveCount(0)
  await expect(panel.getByTestId('follow-notice')).toHaveCount(0)

  await page.route(/\/api\/search\?/, async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    if (query !== 'ghost') return route.fallback()
    const hits = [{ name: 'ghost', versions: [{ version: '1.0.0', roots: [{ rootId: SHOP_NPM_ROOT, nodeId: 'ghost@1.0.0' }] }] }]
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hits) })
  })
  await page.reload()
  await expect(missing.getByText('ghost 1.0.0 is not in shop.', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await missing.getByRole('button', { name: `Open in ${SHOP_NPM_ROOT}`, exact: true }).click()
  await expect.poll(() => searchParam(page, 'in') ?? searchParam(page, 'root')).toBe(SHOP_NPM_ROOT)
  expect(searchParam(page, 'focus')).toBe('ghost@1.0.0')
})

test('Back after a follow clears the notice and Forward does not bring it back', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addChange(page, SHOP_NPM_ROOT, { nodeId: 'helper@1.0.0', choice: 'wanted' })
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, view: 'changes' }))
  const section = rootSection(page, SHOP_NPM_ROOT)
  await expect(section.getByTestId('change-item')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Search packages' }).fill('helper')
  await page.getByRole('option', { name: new RegExp(`^${HELPER_LABEL}.* in ${SHOP_NPM_ROOT}$`) }).click({ timeout: READY_TIMEOUT_MS })
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  expect(searchParam(page, 'focus')).toBe('helper@1.0.0')

  await section.getByRole('button', { name: 'Preview', exact: true }).click()
  await section.getByRole('button', { name: 'Apply…', exact: true }).click({ timeout: READY_TIMEOUT_MS })
  const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
  const install = dialog.getByRole('checkbox', { name: 'Run install: npm ci' })
  if (await install.isChecked()) await install.uncheck()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  const notice = panel.getByTestId('follow-notice')
  await expect(notice.getByText(`Applied in ${SHOP_NPM_ROOT}: helper 1.0.0 → 1.1.0. Showing the new version.`, { exact: true })).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  })
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.1.0')

  await page.goBack()
  await expect.poll(() => searchParam(page, 'focus')).toBeNull()
  await expect(notice).toHaveCount(0)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(SHOP_NPM_ROOT)
  await page.goForward()
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.1.0')
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('helper 1.1.0')
  await expect(notice).toHaveCount(0)
})

test('after a follow in shop-npm, switching to shop says the new version is not in shop and moves nothing', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addChange(page, SHOP_NPM_ROOT, { nodeId: 'helper@1.0.0', choice: 'wanted' })
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'helper@1.0.0', view: 'changes' }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL, { timeout: READY_TIMEOUT_MS })
  const section = rootSection(page, SHOP_NPM_ROOT)
  await section.getByRole('button', { name: 'Preview', exact: true }).click()
  await section.getByRole('button', { name: 'Apply…', exact: true }).click({ timeout: READY_TIMEOUT_MS })
  const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
  const install = dialog.getByRole('checkbox', { name: 'Run install: npm ci' })
  if (await install.isChecked()) await install.uncheck()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  const notice = panel.getByTestId('follow-notice')
  await expect(notice.getByText(`Applied in ${SHOP_NPM_ROOT}: helper 1.0.0 → 1.1.0. Showing the new version.`, { exact: true })).toBeVisible({
    timeout: READY_TIMEOUT_MS,
  })
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.1.0')

  await chooseRoot(page, SHOP_ROOT)
  await expect.poll(() => searchParam(page, 'root')).toBe(SHOP_ROOT)
  const missing = panel.getByTestId('details-missing')
  await expect(missing.getByText('helper 1.1.0 is not in shop.', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(notice).toHaveCount(0)
  await expect(page.locator('[aria-live="polite"]')).not.toHaveText(/^Changed in /)
  expect(searchParam(page, 'focus')).toBe('helper@1.1.0')
  await expect(missing.getByRole('button')).toHaveText([HELPER_LABEL, `Open in ${SHOP_NPM_ROOT}`])

  await missing.getByRole('button', { name: HELPER_LABEL, exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.0.0')
  expect(searchParam(page, 'root')).toBe(SHOP_ROOT)
  await expect(notice).toHaveCount(0)

  await page.goBack()
  await expect(missing.getByText('helper 1.1.0 is not in shop.', { exact: true })).toBeVisible()
  await missing.getByRole('button', { name: `Open in ${SHOP_NPM_ROOT}`, exact: true }).click()
  await expect.poll(() => searchParam(page, 'root')).toBe(SHOP_NPM_ROOT)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('helper 1.1.0')
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
})

test('a choose link moves the selection and the Explore anchor to the chosen node without a follow notice', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'helper@1.0.0', view: 'explore', mode: 'trail', at: 'helper@1.0.0' }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL, { timeout: READY_TIMEOUT_MS })

  const rootNodes = (id: string) => ({ rootId: SHOP_NPM_ROOT, nodeId: id })
  await page.route(/\/api\/search\?.*q=helper(&|$)/, (route) =>
    route.fulfill({
      json: [
        {
          name: 'helper',
          versions: [
            { version: '2.0.0', roots: [rootNodes(TOOLKIT_ID)] },
            { version: '1.0.0', roots: [rootNodes(CHILD_ID)] },
          ],
        },
      ],
    }),
  )
  await page.route(/\/api\/roots\/[^/]+\/nodes\/helper[^/]*\/dependents/, (route) =>
    route.fulfill({ status: 404, json: { error: 'Unknown node' } }),
  )

  await page.locator('body').evaluate((element) => {
    const view = element.ownerDocument.defaultView
    if (view === null) throw new Error('the page has no window')
    const url = new URL(view.location.href)
    url.searchParams.set('kinds', 'prod')
    view.history.pushState(null, '', url)
    view.dispatchEvent(new view.PopStateEvent('popstate'))
  })

  const missing = panel.getByTestId('details-missing')
  await expect(missing.getByRole('button')).toHaveText(['toolkit 2.0.0', 'child-lib 1.0.0'], { timeout: READY_TIMEOUT_MS })
  await missing.getByRole('button', { name: 'toolkit 2.0.0', exact: true }).click()

  await expect.poll(() => searchParam(page, 'focus')).toBe(TOOLKIT_ID)
  await expect.poll(() => searchParam(page, 'at')).toBe(TOOLKIT_ID)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('toolkit 2.0.0')
  await expect(panel.getByTestId('follow-notice')).toHaveCount(0)
})

test('a check that failed or is stale shows the yellow notice in the details header', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await routeStaleAndFailedChecks(page)
  await page.goto(pageUrl(running().url, { in: SHOP_NPM_ROOT, focus: CHILD_ID }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await expect(panel.getByTestId('check-notice').locator('p')).toHaveText([STALE_REGISTRY_NOTICE, FAILED_OSV_NOTICE], { timeout: READY_TIMEOUT_MS })
})

test('Explore with an anchor that is gone shows an alert, and Focus on the selection recovers', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: 'helper@1.0.0', view: 'explore', mode: 'trail', at: 'ghost@1.0.0' }))
  const explore = page.getByRole('tabpanel')
  const alert = explore.getByRole('alert')
  const notInRoot = `ghost 1.0.0 is not in ${SHOP_NPM_ROOT}.`
  for (const modeName of ['Graph', 'Dependencies', 'Dependents'] as const) {
    await expect(alert).toHaveText(notInRoot, { timeout: READY_TIMEOUT_MS })
    await expect(alert).not.toContainText('@')
    await expect(alert).not.toContainText('Unknown node')
    await mode(page, modeName).click()
  }
  await expect(alert).toHaveText(notInRoot)
  expect(searchParam(page, 'at')).toBe('ghost@1.0.0')

  await explore.getByRole('button', { name: `Focus on ${HELPER_LABEL}`, exact: true }).click()
  await expect.poll(() => searchParam(page, 'at')).toBe('helper@1.0.0')
  await expect(explore.getByRole('heading', { name: `Dependents of ${HELPER_LABEL} in ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()
  await expect(alert).toHaveCount(0)
  await expect(explore.getByRole('listbox', { name: 'This package', exact: true }).getByRole('option')).toContainText([HELPER_LABEL])
  await expect(explore.getByRole('button', { name: /^Focus on / })).toHaveCount(0)
})

test('the Graph around child-lib keeps every node and its badges clear of the other nodes', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: CHILD_ID, view: 'explore', mode: 'graph', at: CHILD_ID }))
  const nodes = page.getByTestId('graph-node')
  await expect(nodes).toHaveCount(5, { timeout: READY_TIMEOUT_MS })
  await expect(page.getByTestId('graph-badge').filter({ hasText: '1 vulnerable below' })).toHaveCount(4)
  const boxes = await nodes.evaluateAll((elements) =>
    elements.map((element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect()
      return { name: element.getAttribute('aria-label') ?? '', left, top, right, bottom }
    }),
  )
  const overlapping = boxes.flatMap((box, index) =>
    boxes
      .slice(index + 1)
      .filter((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)
      .map((other) => `${box.name} and ${other.name}`),
  )
  expect(overlapping).toEqual([])
})

test('after apply the details panel follows helper to 1.1.0, and the Explore anchor moves with it', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const helperUrl = new URL(running().url)
  helperUrl.searchParams.set('root', SHOP_NPM_ROOT)
  helperUrl.searchParams.set('focus', 'helper@1.0.0')
  helperUrl.searchParams.set('at', 'helper@1.0.0')
  await page.goto(helperUrl.toString())

  const details = page.getByRole('complementary', { name: 'Package details' }).getByTestId('details-body')
  await expect(details.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  const update = details.getByRole('region', { name: 'Actions' }).getByTestId('actions-update')
  await update.getByRole('button', { name: 'Add to changes' }).click({ timeout: READY_TIMEOUT_MS })
  await expect(update.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeVisible()

  helperUrl.searchParams.set('view', 'changes')
  await page.goto(helperUrl.toString())
  const view = page.getByRole('region', { name: 'Changes', exact: true })
  await view.getByRole('button', { name: 'Preview', exact: true }).click()
  await view.getByRole('button', { name: 'Apply…', exact: true }).click({ timeout: READY_TIMEOUT_MS })
  const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()

  await expect(details.getByRole('heading', { level: 2 })).toHaveText('helper 1.1.0', { timeout: READY_TIMEOUT_MS })
  const notice = details.getByTestId('follow-notice')
  await expect(notice.getByText('Applied in shop-npm: helper 1.0.0 → 1.1.0. Showing the new version.', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/[?&]focus=helper@1\.1\.0(&|$)/)
  await expect(page).toHaveURL(/[?&]at=helper@1\.1\.0(&|$)/)
  await expect(details.getByTestId('details-missing')).toHaveCount(0)

  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  await expect(detailsLandmark(page)).toBeFocused()
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('helper 1.1.0')
})

function searchParam(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name)
}

test('journey 5: a trail chip selects helper while the trail stays on child-lib, Focus on re-centers, and Back, Forward, scope and view changes keep the anchor right', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: CHILD_ID }))
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await panel.getByRole('region', { name: 'Dependents' }).getByRole('button', { name: 'Open in Explore', exact: true }).click()

  const explore = page.getByRole('tabpanel')
  const childTitle = explore.getByRole('heading', { name: `Dependents of ${CHILD_LABEL} in ${SHOP_NPM_ROOT}`, exact: true })
  await expect(childTitle).toBeFocused()
  const helperTitle = explore.getByRole('heading', { name: `Dependents of ${HELPER_LABEL} in ${SHOP_NPM_ROOT}`, exact: true })
  const chips = explore.getByTestId('trail-chip')
  const helperChip = chips.filter({ hasText: HELPER_LABEL })
  const parentChip = chips.filter({ hasText: 'parent-lib 1.0.0' })
  const focusOnHelper = explore.getByRole('button', { name: `Focus on ${HELPER_LABEL}`, exact: true })
  await expect(childTitle).toBeVisible()
  await expect(parentChip).toHaveCount(1)
  await expect(chips.filter({ hasText: CHILD_LABEL })).toHaveAttribute('aria-selected', 'true')
  await expect(explore.getByRole('button', { name: /^Focus on / })).toHaveCount(0)
  expect(searchParam(page, 'at')).toBe(CHILD_ID)

  await helperChip.click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.0.0')
  await expect(helperChip).toHaveAttribute('aria-selected', 'true')
  await expect(chips.filter({ hasText: CHILD_LABEL })).toHaveAttribute('aria-selected', 'false')
  await expect(childTitle).toBeVisible()
  await expect(parentChip).toHaveCount(1)
  expect(searchParam(page, 'at')).toBe(CHILD_ID)

  await focusOnHelper.click()
  await expect(helperTitle).toBeVisible()
  await expect(parentChip).toHaveCount(0)
  await expect(focusOnHelper).toHaveCount(0)
  await expect.poll(() => searchParam(page, 'at')).toBe('helper@1.0.0')
  await expect(page.locator(':focus')).toHaveCount(1)

  await page.goBack()
  await expect(childTitle).toBeVisible()
  await expect(parentChip).toHaveCount(1)
  await expect(focusOnHelper).toBeVisible()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  expect(searchParam(page, 'at')).toBe(CHILD_ID)

  await page.goForward()
  await expect(helperTitle).toBeVisible()
  await expect(parentChip).toHaveCount(0)
  await expect(focusOnHelper).toHaveCount(0)
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')
  await page.goBack()
  await expect(childTitle).toBeVisible()
  expect(searchParam(page, 'at')).toBe(CHILD_ID)

  await chooseRoot(page, SHOP_ROOT)
  await expect.poll(() => searchParam(page, 'root')).toBe(SHOP_ROOT)
  expect(searchParam(page, 'focus')).toBe('helper@1.0.0')
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')
  await expect(explore.getByRole('heading', { name: `Dependents of ${HELPER_LABEL} in ${SHOP_ROOT}`, exact: true })).toBeVisible()
  await expect(explore.getByRole('button', { name: /^Focus on / })).toHaveCount(0)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_ROOT)

  await page.goBack()
  await expect(childTitle).toBeVisible()
  expect(searchParam(page, 'root')).toBe(SHOP_NPM_ROOT)
  expect(searchParam(page, 'at')).toBe(CHILD_ID)
  await expect(focusOnHelper).toBeVisible()
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)

  await page.keyboard.press('1')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => searchParam(page, 'view')).toBeNull()
  expect(searchParam(page, 'at')).toBe(CHILD_ID)
  await page.keyboard.press('3')
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect(helperTitle).toBeVisible()
  await expect(focusOnHelper).toHaveCount(0)
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')
  expect(searchParam(page, 'focus')).toBe('helper@1.0.0')

  await mode(page, 'Graph').click()
  await expect.poll(() => searchParam(page, 'mode')).toBe('graph')
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')
  await mode(page, 'Dependents').click()
  await expect(helperTitle).toBeVisible()
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')

  await page.goBack()
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await expect(childTitle).toBeVisible()
  await expect(explore.getByRole('button', { name: /^Focus on / })).toHaveCount(0)
  expect(searchParam(page, 'focus')).toBe(CHILD_ID)
  expect(searchParam(page, 'at')).toBe(CHILD_ID)
  await page.goForward()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(HELPER_LABEL)
  await expect(helperTitle).toBeVisible()
  await expect(focusOnHelper).toHaveCount(0)
  expect(searchParam(page, 'view')).toBe('explore')
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')
})

test('in Explore a workspace package picked in the roots panel and a search pick become the shown package without Focus on', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_ROOT, focus: 'importer:api', view: 'explore', mode: 'tree', at: 'importer:api' }))
  const explore = page.getByRole('tabpanel')
  const focusOnButtons = explore.getByRole('button', { name: /^Focus on / })
  await expect(explore.getByRole('heading', { name: 'Dependencies of api', exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })

  const web = page.getByRole('navigation', { name: 'Roots' }).getByRole('tree', { name: 'Roots' }).getByRole('treeitem', { name: 'web', exact: true })
  await expect(web).toHaveCount(1)
  await web.click()
  await expect.poll(() => searchParam(page, 'focus')).toBe(WEB_ID)
  await expect(explore.getByRole('heading', { name: 'Dependencies of web', exact: true })).toBeVisible()
  expect(searchParam(page, 'at')).toBe(WEB_ID)
  await expect(focusOnButtons).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Search packages' }).fill('helper')
  await expect(page.getByRole('option').first()).toHaveAccessibleName(new RegExp(`^${HELPER_LABEL} .*in ${SHOP_ROOT}(?!-)`), { timeout: READY_TIMEOUT_MS })
  await page.keyboard.press('Enter')
  await expect.poll(() => searchParam(page, 'focus')).toBe('helper@1.0.0')
  await expect(explore.getByRole('heading', { name: `Dependencies of ${HELPER_LABEL}`, exact: true })).toBeVisible()
  expect(searchParam(page, 'at')).toBe('helper@1.0.0')
  await expect(focusOnButtons).toHaveCount(0)

  await page.goBack()
  await expect(explore.getByRole('heading', { name: 'Dependencies of web', exact: true })).toBeVisible()
  expect(searchParam(page, 'at')).toBe(WEB_ID)
})

test('Explore in All roots without a selection says it requires a single root and offers a button per root', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { view: 'explore' }))
  const explore = page.getByRole('tabpanel')
  await expect(explore.getByText('Explore requires a single root', { exact: true })).toBeVisible()
  const choices = explore.getByRole('group', { name: 'Roots to explore', exact: true })
  await expect(choices.getByRole('button', { name: SHOP_ROOT, exact: true })).toBeVisible()
  await choices.getByRole('button', { name: SHOP_NPM_ROOT, exact: true }).click()

  await expect.poll(() => searchParam(page, 'root')).toBe(SHOP_NPM_ROOT)
  await expect(page.getByRole('banner').getByRole('button', { name: `Root: ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()
  await expect(explore.getByRole('heading', { name: `Overview of ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()
  await expect(explore.getByText('Explore requires a single root', { exact: true })).toHaveCount(0)
})

async function firstRootId(page: Page): Promise<string> {
  const scan = (await (await page.request.get(apiUrl('/api/scan'))).json()) as ScanSummary
  const first = scan.roots[0]
  if (first === undefined) throw new Error('the scan lists no roots')
  return first.id
}

test('the root switcher in the header changes the scope with the mouse and with the keyboard', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = page.getByRole('banner')
  const switcher = header.getByRole('button', { name: 'Root: All roots', exact: true })
  await expect(switcher).toHaveAttribute('aria-haspopup', 'menu')
  await expect(switcher).toHaveAttribute('aria-expanded', 'false')

  await switcher.click()
  await expect(switcher).toHaveAttribute('aria-expanded', 'true')
  const menu = page.getByRole('menu', { name: 'Root: All roots' })
  await expect(menu.getByRole('menuitemradio', { name: 'All roots', exact: true })).toHaveAttribute('aria-checked', 'true')
  const npmItem = menu.getByRole('menuitemradio', { name: SHOP_NPM_ROOT, exact: true })
  await expect(npmItem).toHaveAttribute('aria-checked', 'false')
  await expect(npmItem).toContainText('npm')
  await npmItem.click()

  await expect(page).toHaveURL(/[?&]root=shop-npm(&|$)/)
  const npmSwitcher = header.getByRole('button', { name: `Root: ${SHOP_NPM_ROOT}`, exact: true })
  await expect(npmSwitcher).toBeFocused()
  await expect(npmSwitcher).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('menu')).toHaveCount(0)

  const expectedRoot = await firstRootId(page)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitemradio', { name: 'All roots', exact: true })).toBeFocused()
  await expect(page.getByRole('menuitemradio', { name: SHOP_NPM_ROOT, exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(expectedRoot)
  const chosenSwitcher = header.getByRole('button', { name: `Root: ${expectedRoot}`, exact: true })
  await expect(chosenSwitcher).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'All roots', exact: true })).toBeFocused()
  await page.keyboard.press('s')
  await expect(page.getByRole('menuitemradio', { name: expectedRoot, exact: true })).toBeFocused()
  await page.keyboard.press('a')
  await expect(page.getByRole('menuitemradio', { name: 'All roots', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(chosenSwitcher).toBeFocused()
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(expectedRoot)
})

test('the kinds chip shows a narrowed kinds filter and its × restores all kinds', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = page.getByRole('banner')
  await expect(header.getByText(/^(Dependency types: )?without dev$/)).toHaveCount(0)

  const view = viewMenuButton(page)
  await view.click()
  const devKind = viewMenu(page).getByRole('menuitemcheckbox', { name: 'dev', exact: true })
  await devKind.click()
  await expect(devKind).toHaveAttribute('aria-checked', 'false')
  await expect(header.getByText(/^(Dependency types: )?without dev$/)).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get('kinds')).toBe('prod,optional,peer')

  await header.getByRole('button', { name: 'Show all dependency types', exact: true }).click()
  await expect(header.getByText(/^(Dependency types: )?without dev$/)).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.has('kinds')).toBe(false)
  await expect(header.getByRole('button', { name: 'Root: All roots', exact: true })).toBeFocused()
  await view.click()
  await expect(devKind).toHaveAttribute('aria-checked', 'true')
})

test('the kinds in View ▾ filter Issues, and the menu works with the keyboard', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await expect(packageRow(page, CHILD_LABEL)).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(page.getByRole('navigation', { name: 'Roots' }).getByRole('checkbox', { name: 'dev', exact: true })).toHaveCount(0)

  const view = viewMenuButton(page)
  await view.focus()
  await page.keyboard.press('ArrowDown')
  const menu = viewMenu(page)
  const byPackage = issueGrouping(page, 'Package')
  await expect(byPackage).toBeFocused()
  await expect(byPackage).toHaveAttribute('aria-checked', 'true')
  const prodKind = menu.getByRole('menuitemcheckbox', { name: 'prod', exact: true })
  await page.keyboard.press('p')
  await expect(prodKind).toBeFocused()
  await page.keyboard.press(' ')
  await expect(prodKind).toHaveAttribute('aria-checked', 'false')
  await expect(prodKind).toBeFocused()
  await expect.poll(() => new URL(page.url()).searchParams.get('kinds')).toBe('dev,optional,peer')
  await expect(page.getByText('No issues of the selected types', { exact: true })).toBeVisible()
  await expect(page.getByText('No known issues in All roots', { exact: true })).toHaveCount(0)
  await expect(issuesGrid(page)).toHaveCount(0)
  await expect(typeToggle(page, 'Vulnerabilities 0')).toBeDisabled()

  await page.keyboard.press('Enter')
  await expect(prodKind).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(view).toBeFocused()
  await expect(packageRow(page, CHILD_LABEL)).toBeVisible()
  await expect(typeToggle(page, 'Vulnerabilities 1')).toBeEnabled()
})

test('the type toggles count packages, a type without issues is disabled and one type always stays on', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const vulnerabilities = typeToggle(page, 'Vulnerabilities 1')
  const deprecated = typeToggle(page, 'Deprecations 0')
  const updates = typeToggle(page, 'Updates 3')
  await expect(vulnerabilities).toHaveAttribute('aria-pressed', 'true', { timeout: READY_TIMEOUT_MS })
  await expect(deprecated).toBeDisabled()
  await expect(updates).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/^Checked /)).toHaveAttribute('title', /^Registry [\d,]+ packages · OSV [\d,]+ versions, [\d,]+ skipped$/)

  await updates.click()
  await expect(updates).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => new URL(page.url()).searchParams.get('types')).toBe('vulnerability,deprecated')
  await expect(issuesGrid(page).getByRole('heading', { name: 'Updates', exact: true })).toHaveCount(0)

  await vulnerabilities.click()
  await expect(vulnerabilities).toHaveAttribute('aria-pressed', 'true')
  await expect(packageRow(page, CHILD_LABEL)).toBeVisible()
  await updates.click()
  await expect(updates).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => new URL(page.url()).searchParams.has('types')).toBe(false)
})

test('Add recommended fixes… adds the recommended fix to each checked root and reports each root', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await expect(locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT).getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled({
    timeout: READY_TIMEOUT_MS,
  })
  const collectPaths: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'POST' && pathname.endsWith('/changes/recommended')) collectPaths.push(pathname)
  })

  const opener = page.getByRole('button', { name: 'Add recommended fixes…', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Add recommended fixes' })
  const shopChoice = dialog.getByRole('checkbox', { name: `${SHOP_ROOT} — 1 vulnerable package`, exact: true })
  const npmChoice = dialog.getByRole('checkbox', { name: `${SHOP_NPM_ROOT} — 1 vulnerable package`, exact: true })
  await expect(shopChoice).toBeChecked()
  await expect(npmChoice).toBeChecked()
  await dialog.getByRole('button', { name: 'Add fixes', exact: true }).click()

  await expect(dialog.getByText(`Added 1 fix to ${SHOP_ROOT}, 1 to ${SHOP_NPM_ROOT}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  expect(collectPaths).toEqual([`/api/roots/${SHOP_ROOT}/changes/recommended`, `/api/roots/${SHOP_NPM_ROOT}/changes/recommended`])
  expect(await changeCount(page, SHOP_ROOT)).toBe(1)
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  const review = dialog.getByRole('link', { name: 'Review changes', exact: true })
  await expect(review).toHaveAttribute('href', /[?&]view=changes(&|$)/)
  await expect(review).not.toHaveAttribute('href', /[?&]root=/)
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeFocused()
  await close.click()
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect(locationRow(page, CHILD_LABEL, SHOP_ROOT).getByRole('button', { name: '✓ In changes', exact: true })).toBeVisible()
  await expect(locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT).getByRole('button', { name: '✓ In changes', exact: true })).toBeVisible()
  await expect(tab(page, 'Changes')).toHaveText('Changes 2')

  await opener.click()
  await npmChoice.uncheck()
  await dialog.getByRole('button', { name: 'Add fixes', exact: true }).click()
  await expect(dialog.getByText(/^No fixes added; skipped child-lib 1\.0\.0 \(.+\)$/)).toBeVisible({ timeout: READY_TIMEOUT_MS })
  expect(collectPaths).toHaveLength(3)
  await dialog.getByRole('link', { name: 'Review changes', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('changes')
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)
  await expect(changesView(page).getByTestId('change-item')).toHaveCount(2)
  await expect(rootSection(page, SHOP_ROOT).getByTestId('change-item')).toBeFocused()
})

test('grouped by direct dependency, a sub-row adds its fix to its own root and the header selects the direct dependency', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await viewMenuButton(page).click()
  await issueGrouping(page, 'Direct dependency').click()
  await expect.poll(() => new URL(page.url()).searchParams.get('group')).toBe('direct')
  await expect(viewMenuButton(page)).toBeFocused()

  const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
  const parentHeader = grid.getByRole('row', { name: `parent-lib 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })
  await expect(parentHeader).toHaveAttribute('aria-expanded', 'true', { timeout: READY_TIMEOUT_MS })
  const npmChildRows = grid.getByRole('row', { name: nestedRowName(SHOP_NPM_ROOT) })
  await expect(npmChildRows).toHaveCount(2)
  const add = npmChildRows.first().getByRole('button', { name: 'Add fix', exact: true })
  await expect(add).toBeEnabled({ timeout: READY_TIMEOUT_MS })
  await add.click()
  await expect(npmChildRows.nth(0).getByRole('button', { name: '✓ In changes', exact: true })).toBeFocused()
  await expect(npmChildRows.nth(1).getByRole('button', { name: '✓ In changes', exact: true })).toBeVisible()
  await expect(grid.getByRole('row', { name: nestedRowName(SHOP_ROOT) }).first().getByRole('button', { name: 'Add fix', exact: true })).toBeVisible()
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  expect(await changeCount(page, SHOP_ROOT)).toBe(0)

  await parentHeader.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => new URL(page.url()).searchParams.get('in')).toBe(SHOP_NPM_ROOT)
  await expect.poll(() => new URL(page.url()).searchParams.get('focus')).toBe('parent-lib@1.0.0')
  await expect(parentHeader).toHaveAttribute('aria-selected', 'true')
  await expect(parentHeader).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(parentHeader).toHaveAttribute('aria-expanded', 'false')
  await expect(npmChildRows).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await expect(npmChildRows).toHaveCount(2)

  const disclosure = parentHeader.getByTestId('group-disclosure')
  const target = await disclosure.boundingBox()
  expect(target?.width).toBeGreaterThanOrEqual(24)
  expect(target?.height).toBeGreaterThanOrEqual(24)
  await disclosure.click()
  await expect(parentHeader).toHaveAttribute('aria-expanded', 'false')
  await expect(npmChildRows).toHaveCount(1)
  await disclosure.click()
  await expect(parentHeader).toHaveAttribute('aria-expanded', 'true')
  await expect(npmChildRows).toHaveCount(2)
})

type ViaLayout = { brokenNames: string[]; wrappedLists: string[] }

async function viaLayout(grid: Locator): Promise<ViaLayout> {
  return grid.evaluate((element, lineGap) => {
    const lineCount = (node: { ownerDocument: { createRange(): { selectNodeContents(target: unknown): void; getClientRects(): ArrayLike<{ bottom: number; width: number }> } } }) => {
      const range = node.ownerDocument.createRange()
      range.selectNodeContents(node)
      const bottoms = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0)
        .map((rect) => rect.bottom)
        .sort((left, right) => left - right)
      return bottoms.filter((bottom, index) => index === 0 || bottom - bottoms[index - 1] > lineGap).length
    }
    const lists = [...element.querySelectorAll('[data-testid="via-list"]')]
    const namesOf = (list: (typeof lists)[number]) => [...list.querySelectorAll('.via-list__name, [data-testid="workspace-name"]')]
    const names = lists.flatMap(namesOf)
    return {
      brokenNames: names.filter((name) => lineCount(name) > 1).map((name) => name.textContent ?? ''),
      wrappedLists: lists
        .filter((list) => namesOf(list).map((name) => name.textContent).join(', ') === 'api, web' && lineCount(list) > 1)
        .map((list) => list.textContent ?? ''),
    }
  }, LINE_GAP_PX)
}

test('at 1280 px no name under Via breaks across lines and a list of two short names stays on one line, in both groupings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openWhenBothRootsAreReady(page)
  await expect(packageRow(page, 'child-lib 1.0.0')).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(locationRow(page, CHILD_LABEL, SHOP_ROOT)).toBeVisible()
  expect(await viaLayout(issuesGrid(page))).toEqual({ brokenNames: [], wrappedLists: [] })

  await viewMenuButton(page).click()
  await issueGrouping(page, 'Direct dependency').click()
  const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
  await expect(grid.getByTestId('via-list').filter({ hasText: 'api, web' }).first()).toBeVisible({ timeout: READY_TIMEOUT_MS })
  expect(await viaLayout(grid)).toEqual({ brokenNames: [], wrappedLists: [] })
})

async function describedByIds(row: Locator): Promise<string[]> {
  return ((await row.getAttribute('aria-describedby')) ?? '').split(' ')
}

test('in both groupings a workspace package under Via is a workspace pill and a third-party package is not', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const toolkitRow = locationRow(page, 'toolkit 2.0.0', SHOP_NPM_ROOT)
  await expect(toolkitRow).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(toolkitRow.getByTestId('workspace-name')).toHaveText(['api', 'web'])
  const childRow = locationRow(page, CHILD_LABEL, SHOP_ROOT)
  await expect(childRow.getByTestId('via-list')).toContainText('parent-lib')
  await expect(childRow.getByTestId('workspace-name')).toHaveCount(0)
  expect(await describedByIds(toolkitRow)).toContain(await toolkitRow.getByTestId('via-list').getAttribute('id'))

  await viewMenuButton(page).click()
  await issueGrouping(page, 'Direct dependency').click()
  const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
  const toolkitHeader = grid.getByRole('row', { name: `toolkit 2.0.0 in ${SHOP_NPM_ROOT}`, exact: true })
  await expect(toolkitHeader.getByTestId('workspace-name')).toHaveText(['api', 'web'], { timeout: READY_TIMEOUT_MS })
  expect(await describedByIds(toolkitHeader)).toContain(await toolkitHeader.getByTestId('via-list').getAttribute('id'))
})

test('Refresh in the header rescans files and checks again, and ? opens the keyboard help', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = page.getByRole('banner')
  const refresh = header.getByRole('button', { name: 'Refresh', exact: true })
  await expect(refresh).toHaveAttribute('aria-haspopup', 'menu')

  await refresh.click()
  const menu = page.getByRole('menu', { name: 'Refresh' })
  await expect(menu).toHaveAccessibleDescription(/^Checked (just now|\d+ minutes? ago)$/)
  const checkAgain = menu.getByRole('menuitem', { name: 'Recheck registry and OSV', exact: true })
  await expect(checkAgain).not.toHaveAttribute('aria-disabled', 'true')
  const refreshRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/enrichment/refresh')
  await checkAgain.click()
  await refreshRequest
  await expect(refresh).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Rescan files', exact: true })).toBeFocused()
  const rescanRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/rescan')
  await page.keyboard.press('Enter')
  await rescanRequest
  await expect(refresh).toBeFocused()
  await expect(page.getByRole('navigation', { name: 'Roots' }).getByRole('button', { name: 'Rescan' })).toHaveCount(0)

  const help = header.getByRole('button', { name: 'Keyboard shortcuts', exact: true })
  await help.click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('row', { name: /Focus search/ })).toBeVisible()
  await expect(dialog.getByRole('row')).toHaveCount(7)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(help).toBeFocused()
})

async function addChange(page: Page, rootId: string, request: AddChangeRequest): Promise<void> {
  const response = await page.request.post(apiUrl(`/api/roots/${rootId}/changes`), {
    data: request,
    headers: { origin: new URL(running().url).origin },
  })
  expect(response.status()).toBe(201)
}

async function addRecommendedFix(page: Page, rootId: string, nodeId: string): Promise<void> {
  await addChange(page, rootId, { nodeId, choice: 'recommended' })
}

test('the roots panel collapses to a strip, expands again and keeps its state across a reload', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const roots = page.getByRole('navigation', { name: 'Roots' })
  const rootsTree = roots.getByRole('tree', { name: 'Roots' })
  const hide = roots.getByRole('button', { name: 'Hide roots panel ([)', exact: true })
  const show = roots.getByRole('button', { name: 'Show roots panel ([)', exact: true })
  await expect(roots.getByRole('heading', { name: 'Roots', exact: true })).toBeVisible()
  await expect(rootsTree).toBeVisible()
  await expect(show).toHaveCount(0)

  await hide.click()
  await expect(rootsTree).toHaveCount(0)
  await expect(show).toBeFocused()
  await expect.poll(async () => (await page.getByRole('main').boundingBox())?.x).toBe(36)

  await page.reload()
  await expect(show).toBeVisible()
  await expect(rootsTree).toHaveCount(0)

  await show.click()
  await expect(rootsTree).toBeVisible()
  await expect(hide).toBeFocused()
  await page.reload()
  await expect(rootsTree).toBeVisible()
  await expect(detailsLandmark(page).getByRole('button', { name: 'Hide details panel (])', exact: true })).toBeVisible()
  await expect(detailsLandmark(page).getByRole('heading', { name: 'Details', exact: true })).toBeVisible()
})

test('the change link on a root row opens Changes of that root', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addRecommendedFix(page, SHOP_NPM_ROOT, 'child-lib@1.0.0')
  await page.goto(running().url)

  const npmRow = page.getByRole('navigation', { name: 'Roots' }).getByRole('treeitem', { name: SHOP_NPM_ROOT, exact: true })
  await expect(npmRow.getByText('npm', { exact: true })).toBeVisible()
  await expect(npmRow.getByText('lockfile', { exact: true })).toHaveCount(0)
  await npmRow.getByRole('link', { name: '1 change', exact: true }).click()

  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(SHOP_NPM_ROOT)
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('changes')
  await expect(page.getByRole('region', { name: 'Changes', exact: true }).getByTestId('change-item')).toHaveCount(1)
})

test('Changes shows a section for each root with changes in All roots and only the scope root in one root', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addRecommendedFix(page, SHOP_NPM_ROOT, CHILD_ID)
  await page.goto(pageUrl(running().url, { view: 'changes' }))
  const view = changesView(page)
  await expect(rootSection(page, SHOP_NPM_ROOT).getByTestId('change-item')).toHaveCount(1)
  await expect(view.getByTestId('root-changes')).toHaveCount(1)

  await page.goto(pageUrl(running().url, { root: SHOP_ROOT, view: 'changes' }))
  const emptyShop = rootSection(page, SHOP_ROOT)
  await expect(emptyShop.getByText('No changes yet. Add fixes from Issues or the details panel.', { exact: true })).toBeVisible()
  await expect(view.getByTestId('root-changes')).toHaveCount(1)
  await expect(emptyShop.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0)
  await expect(emptyShop.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0)

  await addRecommendedFix(page, SHOP_ROOT, CHILD_ID)
  await page.goto(pageUrl(running().url, { view: 'changes' }))
  await expect(view.getByTestId('root-changes')).toHaveCount(2)
  await expect(view.getByRole('grid')).toHaveCount(2)
  for (const rootId of [SHOP_ROOT, SHOP_NPM_ROOT]) {
    const section = rootSection(page, rootId)
    await expect(section.getByTestId('change-count')).toHaveText('1 change')
    const steps = section.getByRole('list', { name: 'Steps', exact: true }).getByRole('listitem')
    await expect(steps).toHaveText(['1 Changes', '2 Preview', '3 Apply'])
    await expect(section.locator('[aria-current="step"]')).toHaveText('1 Changes')
    await expect(section.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled()
    await expect(section.getByRole('button', { name: 'Clear', exact: true })).toBeEnabled()
    const item = section.getByTestId('change-item')
    await expect(item).toHaveCount(1)
    await expect(item.getByTestId('change-badge')).toHaveText('high')
    await expect(item.getByTestId('change-goal')).toHaveText(`Fix child-lib 1.0.0 · ${CHILD_ADVISORY_ID}`)
    await expect(item.getByTestId('change-steps')).toContainText('Re-lock child-lib 1.0.0 → 1.0.1')
    await expect(item.getByRole('button', { name: 'Edit Fix child-lib 1.0.0', exact: true })).toHaveText('Edit')
    await expect(item.getByRole('button', { name: 'Remove Fix child-lib 1.0.0', exact: true })).toBeVisible()
  }
  await expect(tab(page, 'Changes')).toHaveText('Changes 2')

  await page.goto(pageUrl(running().url, { root: SHOP_ROOT, view: 'changes' }))
  await expect(rootSection(page, SHOP_ROOT).getByTestId('change-item')).toHaveCount(1)
  await expect(view.getByTestId('root-changes')).toHaveCount(1)
  await expect(tab(page, 'Changes')).toHaveText('Changes 1')
})

test('Edit on the toolkit change opens its version in details, and Save change replaces it twice in a row', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addChange(page, SHOP_NPM_ROOT, { nodeId: TOOLKIT_ID, choice: 'latest' })
  await page.goto(pageUrl(running().url, { view: 'changes' }))
  const section = rootSection(page, SHOP_NPM_ROOT)
  const item = section.getByTestId('change-item')
  await expect(item.getByTestId('change-goal')).toHaveText(/^Update toolkit to 3\.0\.0 · /)
  await expect(item.getByTestId('change-badge')).toHaveText('↑ major')
  await expect(item.getByTestId('change-warning')).toHaveText(['major update'])

  await item.getByRole('button', { name: 'Edit Update toolkit to 3.0.0', exact: true }).click()
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('toolkit 2.0.0')
  await expect(page).toHaveURL(/[?&]in=shop-npm(&|$)/)
  expect(new URL(page.url()).searchParams.has('root')).toBe(false)
  expect(new URL(page.url()).searchParams.get('view')).toBe('changes')
  const update = panel.getByRole('region', { name: 'Actions' }).getByTestId('actions-update')
  const version = update.getByRole('combobox', { name: 'Version' })
  await expect(version).toHaveValue('3.0.0', { timeout: READY_TIMEOUT_MS })
  await expect(version).toBeFocused()
  const save = update.getByRole('button', { name: 'Save change', exact: true })
  await expect(save).toBeVisible()

  await version.selectOption('2.1.0')
  await save.click()
  await expect(item.getByTestId('change-goal')).toHaveText(/^Update toolkit to 2\.1\.0 · /)
  const firstSave = await changesOf(page, SHOP_NPM_ROOT)
  expect(firstSave.items).toHaveLength(1)
  expect(firstSave.items[0]?.choice).toBe('wanted')

  await expect(item.getByRole('button', { name: 'Edit Update toolkit to 2.1.0', exact: true })).toBeVisible()
  await item.focus()
  await page.keyboard.press('Enter')
  await expect(version).toHaveValue('2.1.0')
  await expect(version).toBeFocused()
  await version.selectOption('3.0.0')
  await save.click()
  await expect(item.getByTestId('change-goal')).toHaveText(/^Update toolkit to 3\.0\.0 · /)
  const secondSave = await changesOf(page, SHOP_NPM_ROOT)
  expect(secondSave.items).toHaveLength(1)
  expect(secondSave.items[0]?.choice).toBe('latest')
  expect(secondSave.items[0]?.id).not.toBe(firstSave.items[0]?.id)
  await expect(item).toHaveCount(1)
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('Clear removes the changes of a root at once, Undo brings them back, and an edit after the preview asks to preview again', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addRecommendedFix(page, SHOP_NPM_ROOT, CHILD_ID)
  await addChange(page, SHOP_NPM_ROOT, { nodeId: TOOLKIT_ID, choice: 'wanted' })
  await page.goto(pageUrl(running().url, { view: 'changes' }))
  const section = rootSection(page, SHOP_NPM_ROOT)
  const items = section.getByTestId('change-item')
  await expect(items).toHaveCount(2)
  await expect(tab(page, 'Changes')).toHaveText('Changes 2')

  await items.first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(items.first()).toBeFocused()

  await section.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(items).toHaveCount(0)
  await expect(section.getByText('Cleared 2 changes.', { exact: true })).toBeVisible()
  const undo = section.getByRole('button', { name: 'Undo', exact: true })
  await expect(undo).toBeFocused()
  await expect(page.locator('[aria-live="polite"]')).toHaveText('Cleared 2 changes.')
  await expect(tab(page, 'Changes')).toHaveText('Changes 0')
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(0)

  await undo.click()
  await expect(items).toHaveCount(2)
  await expect(undo).toHaveCount(0)
  await expect(items.first()).toBeFocused()
  await expect(page.locator('[aria-live="polite"]')).toHaveText('Restored 2 changes.')
  await expect(tab(page, 'Changes')).toHaveText('Changes 2')
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(2)

  await section.getByRole('button', { name: 'Preview', exact: true }).click()
  const apply = section.getByRole('button', { name: 'Apply…', exact: true })
  await expect(apply).toBeEnabled({ timeout: READY_TIMEOUT_MS })
  await expect(section.locator('[aria-current="step"]')).toHaveText('3 Apply')
  await section.getByRole('button', { name: 'Remove Update toolkit to 2.1.0', exact: true }).click()
  await expect(items).toHaveCount(1)
  await expect(items.first()).toBeFocused()
  await expect(items.first().getByTestId('change-goal')).toHaveText(`Fix child-lib 1.0.0 · ${CHILD_ADVISORY_ID}`)
  await expect(tab(page, 'Changes')).toHaveText('Changes 1')
  await expect(section.getByRole('button', { name: 'Preview again', exact: true })).toBeEnabled()
  await expect(section.getByText('Changes were edited after this preview', { exact: true })).toBeVisible()
  await expect(page.locator('[aria-live="polite"]')).toHaveText('Changes were edited after this preview')
  await expect(section.locator('[aria-current="step"]')).toHaveText('2 Preview')
  await expect(apply).toHaveCount(0)
})

test('the roots tree selects a workspace package with the keyboard', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const scan = (await (await page.request.get(apiUrl('/api/scan'))).json()) as ScanSummary
  const firstRoot = scan.roots[0]
  if (firstRoot === undefined) throw new Error('the scan lists no roots')
  const rootPackage = firstRoot.importers.find((importer) => importer.path === firstRoot.path)
  expect(rootPackage?.dependencyCount ?? 0).toBe(0)
  const firstPackage = firstRoot.importers.find((importer) => importer.path !== firstRoot.path)
  if (firstPackage === undefined) throw new Error(`${firstRoot.id} has no workspace packages`)

  const tree = page.getByRole('navigation', { name: 'Roots' }).getByRole('tree', { name: 'Roots' })
  const allRoots = tree.getByRole('treeitem', { name: 'All roots', exact: true })
  await expect(allRoots).toHaveAttribute('tabindex', '0')
  await expect(tree.getByRole('treeitem', { level: 2 })).toHaveCount(0)

  await allRoots.focus()
  await page.keyboard.press('ArrowDown')
  const rootRow = tree.getByRole('treeitem', { name: firstRoot.id, exact: true })
  await expect(rootRow).toBeFocused()
  await expect(rootRow).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(rootRow).toHaveAttribute('aria-expanded', 'true')
  await expect(tree.getByRole('treeitem', { name: '(root)', exact: true })).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  const packageRow = tree.getByRole('treeitem', { name: firstPackage.name, exact: true })
  await expect(packageRow).toBeFocused()
  await expect(packageRow).toHaveText(firstPackage.name)
  await page.keyboard.press('Enter')

  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(firstRoot.id)
  await expect.poll(() => new URL(page.url()).searchParams.get('focus')).toBe(firstPackage.id)
  await expect(packageRow).toHaveAttribute('aria-selected', 'true')
  await expect(packageRow).toBeFocused()
  const details = page.getByRole('complementary', { name: 'Package details' }).getByTestId('details-body')
  await expect(details.getByRole('heading', { level: 2 })).toHaveText(firstPackage.name)
})

const CHILD_IN_NPM_ROOT = `${CHILD_LABEL} in ${SHOP_NPM_ROOT}`

function selectedPill(page: Page) {
  return page.getByRole('main').getByRole('group', { name: 'Selected', exact: true })
}

test('the keys 1, 2 and 3 open Issues, Changes and Explore, and do nothing while the search field has focus', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: CHILD_ID }))
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('2')
  await expect(tab(page, 'Changes')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('changes')

  await page.keyboard.press('3')
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('explore')
  await expect(mode(page, 'Dependents')).toHaveAttribute('aria-checked', 'true')
  const explore = page.getByRole('tabpanel')
  await expect(explore.getByRole('heading', { name: `Dependents of child-lib 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()

  await mode(page, 'Dependents').focus()
  await page.keyboard.press('ArrowRight')
  await expect(mode(page, 'Dependencies')).toBeFocused()
  await expect(mode(page, 'Dependencies')).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('tree')
  await expect(explore.getByRole('heading', { name: 'Dependencies of child-lib 1.0.0', exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(mode(page, 'Graph')).toHaveAttribute('aria-checked', 'true')
  await expect(explore.getByRole('heading', { name: `Graph around child-lib 1.0.0 in ${SHOP_NPM_ROOT}`, exact: true })).toBeVisible()

  await page.keyboard.press('1')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => new URL(page.url()).searchParams.has('view')).toBe(false)

  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('combobox', { name: 'Search packages' })
  await expect(search).toBeFocused()
  await page.keyboard.press('2')
  await page.keyboard.press('3')
  await expect(search).toHaveValue('23')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  expect(new URL(page.url()).searchParams.has('view')).toBe(false)
})

test('keys typed in an open menu or in the keyboard help stay there, and ? opens the help from anywhere', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = page.getByRole('banner')
  const switcher = header.getByRole('button', { name: 'Root: All roots', exact: true })
  await switcher.click()
  await expect(page.getByRole('menu', { name: 'Root: All roots' })).toBeVisible()
  await page.keyboard.press('2')
  await page.keyboard.press('[')
  await expect(page.getByRole('menu', { name: 'Root: All roots' })).toBeVisible()
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('navigation', { name: 'Roots' }).getByRole('tree', { name: 'Roots' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(switcher).toBeFocused()

  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('3')
  await page.keyboard.press(']')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect(detailsLandmark(page).getByRole('heading', { name: 'Details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(switcher).toBeFocused()
})

test('the selection pill names the selected package and its × clears the selection', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: CHILD_ID }))
  const pill = selectedPill(page)
  await expect(pill.getByText(CHILD_IN_NPM_ROOT, { exact: true })).toBeVisible()
  await expect(details(page).getByRole('heading', { level: 2 })).toHaveText('child-lib 1.0.0')

  await pill.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(pill).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.has('focus')).toBe(false)
  expect(new URL(page.url()).searchParams.get('root')).toBe(SHOP_NPM_ROOT)
  await expect(details(page).getByText('Select an issue to see available actions.', { exact: true })).toBeVisible()
  await expect(tab(page, 'Issues')).toBeFocused()
})

test('the Changes tab counts the changes of every root in All roots and of one root in a single root', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addRecommendedFix(page, SHOP_NPM_ROOT, CHILD_ID)
  await page.goto(running().url)
  await expect(tab(page, 'Changes')).toHaveText('Changes 1')
  await expect(tab(page, 'Issues')).toHaveAttribute('title', /^[\d,]+ packages? with issues in All roots$/)

  await chooseRoot(page, SHOP_ROOT)
  await expect(tab(page, 'Changes')).toHaveText('Changes 0')
  await expect(tab(page, 'Issues')).toHaveAttribute('title', new RegExp(`^[\\d,]+ packages? with issues in ${SHOP_ROOT}$`))
  await chooseRoot(page, SHOP_NPM_ROOT)
  await expect(tab(page, 'Changes')).toHaveText('Changes 1')
})

test('[ and ] collapse and expand the roots and details panels and move focus to their toggles', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await page.goto(pageUrl(running().url, { root: SHOP_NPM_ROOT, focus: CHILD_ID }))
  const roots = page.getByRole('navigation', { name: 'Roots' })
  const rootsTree = roots.getByRole('tree', { name: 'Roots' })
  const packageHeading = details(page).getByRole('heading', { level: 2 })
  await expect(rootsTree).toBeVisible()
  await expect(packageHeading).toHaveText(CHILD_LABEL)

  await page.keyboard.press('[')
  await expect(rootsTree).toHaveCount(0)
  await expect(roots.getByRole('button', { name: 'Show roots panel ([)', exact: true })).toBeFocused()
  await page.keyboard.press('[')
  await expect(rootsTree).toBeVisible()
  await expect(roots.getByRole('button', { name: 'Hide roots panel ([)', exact: true })).toBeFocused()

  await page.keyboard.press(']')
  await expect(packageHeading).toHaveCount(0)
  await expect(detailsLandmark(page).getByRole('button', { name: 'Show details panel (])', exact: true })).toBeFocused()
  await expect(selectedPill(page).getByText(CHILD_IN_NPM_ROOT, { exact: true })).toBeVisible()
  await page.keyboard.press(']')
  await expect(packageHeading).toHaveText(CHILD_LABEL)
  await expect(detailsLandmark(page).getByRole('button', { name: 'Hide details panel (])', exact: true })).toBeFocused()
})

test('a second click on the open root switcher closes it, and Space chooses a root without reopening the menu', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = page.getByRole('banner')
  const switcher = header.getByRole('button', { name: 'Root: All roots', exact: true })
  await switcher.click()
  const allRoots = page.getByRole('menuitemradio', { name: 'All roots', exact: true })
  await expect(allRoots).toBeFocused()

  const box = await switcher.boundingBox()
  if (box === null) throw new Error('the root switcher is not laid out')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(allRoots).toBeFocused()
  await page.mouse.up()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(switcher).toHaveAttribute('aria-expanded', 'false')
  await expect(switcher).toBeFocused()

  await switcher.evaluate((button) => {
    button.addEventListener('keyup', (event: { key: string; defaultPrevented: boolean }) => {
      if (event.key === ' ') button.setAttribute('data-space-keyup-prevented', String(event.defaultPrevented))
    })
  })
  const expectedRoot = await firstRootId(page)
  await page.keyboard.press('ArrowDown')
  await expect(allRoots).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press(' ')
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe(expectedRoot)
  const chosen = header.getByRole('button', { name: `Root: ${expectedRoot}`, exact: true })
  await expect(chosen).toBeFocused()
  await expect(chosen).toHaveAttribute('data-space-keyup-prevented', 'true')
  await expect(chosen).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('journey 1: Add fix in shop-npm, Preview, Apply without install, the outcome first, details follow, and Revert puts the change back', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const npmRow = locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT)
  const add = npmRow.getByRole('button', { name: 'Add fix', exact: true })
  await expect(add).toBeEnabled({ timeout: READY_TIMEOUT_MS })
  await npmRow.getByText(SHOP_NPM_ROOT, { exact: true }).click()
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
  await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
  await add.click()
  await npmRow.getByRole('button', { name: '✓ In changes', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('changes')

  const section = rootSection(page, SHOP_NPM_ROOT)
  const items = section.getByTestId('change-item')
  await expect(items).toHaveCount(1)
  await section.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = section.getByRole('region', { name: 'Preview', exact: true })
  await expect(preview.getByTestId('preview-goal')).toHaveText(['✓ child-lib: no affected version left (1.0.1)'], { timeout: READY_TIMEOUT_MS })
  await expect(preview.getByTestId('preview-meta')).toHaveText(/^npm \d+\.\d+\.\d+ · just now$/)
  const packageChanges = preview.getByTestId('preview-package-changes')
  await expect(packageChanges.locator('summary')).toHaveText(/^Package changes \(\d+\)$/)
  await expect(packageChanges.locator('summary').getByRole('heading', { level: 4 })).toHaveAccessibleName(/^Package changes \(\d+\)$/)
  await expect(preview.getByRole('heading', { level: 4 }).last()).toHaveText(/^Package changes \(\d+\)$/)
  await expect(packageChanges).toHaveJSProperty('open', false)
  const previewedFiles = (await changesOf(page, SHOP_NPM_ROOT)).preview?.files.map((file) => file.path) ?? []
  expect([...previewedFiles].sort()).toEqual(['package-lock.json', 'web/package.json'])

  const applyButton = section.getByRole('button', { name: 'Apply…', exact: true })
  await applyButton.click()
  const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
  await expect(dialog.getByText(`Writes ${previewedFiles.join(', ')} exactly as previewed.`, { exact: true })).toBeVisible()
  const install = dialog.getByRole('checkbox', { name: 'Run install: npm ci' })
  await install.uncheck()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const outcome = section.getByTestId('changes-outcome')
  await expect(outcome.getByTestId('job-outcome')).toHaveText(`Applied to ${SHOP_NPM_ROOT}. 1 goal met · files written: ${previewedFiles.join(', ')}.`, {
    timeout: READY_TIMEOUT_MS,
  })
  await expect(section.locator('header + [data-testid="changes-outcome"]')).toBeVisible()
  const hint = outcome.getByTestId('install-hint')
  await expect(hint).toHaveText(`node_modules was not updated. Run npm ci in ${SHOP_NPM_ROOT} when ready.`)
  await expect(hint.locator('code')).toHaveText('npm ci')
  await expect(outcome.getByTestId('revert-note')).toHaveText('Restores 2 files and puts 1 change back in the list.')
  await expect(section.getByTestId('changes-empty')).toHaveCount(0)
  await expect(items).toHaveCount(0)
  await expect(tab(page, 'Changes')).toHaveText('Changes 0')
  await expect(section).toBeFocused()

  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('child-lib 1.0.1', { timeout: READY_TIMEOUT_MS })
  await expect(panel.getByTestId('follow-notice').getByText(`Applied in ${SHOP_NPM_ROOT}: child-lib 1.0.0 → 1.0.1. Showing the new version.`, { exact: true })).toBeVisible()

  await outcome.getByRole('button', { name: 'Revert files', exact: true }).click()
  await expect(outcome.getByTestId('job-outcome')).toHaveText(`Files restored in ${SHOP_NPM_ROOT}. 1 change is back in the list.`, { timeout: READY_TIMEOUT_MS })
  await expect(section.locator('header + [data-testid="changes-outcome"]')).toBeVisible()
  await expect(outcome.getByTestId('install-hint')).toHaveCount(0)
  await expect(outcome.getByRole('button', { name: 'Revert files', exact: true })).toHaveCount(0)
  await expect(items).toHaveCount(1)
  await expect(items.first().getByTestId('change-goal')).toHaveText(`Fix child-lib 1.0.0 · ${CHILD_ADVISORY_ID}`)
  await expect(items.first()).toBeFocused()
  await expect(tab(page, 'Changes')).toHaveText('Changes 1')
  await expect(section.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled()
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL, { timeout: READY_TIMEOUT_MS })
})

test('Clear keeps its Undo when a scan refresh lands while the clear is still finishing', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addRecommendedFix(page, SHOP_NPM_ROOT, CHILD_ID)
  await addChange(page, SHOP_NPM_ROOT, { nodeId: TOOLKIT_ID, choice: 'wanted' })
  await page.goto(pageUrl(running().url, { view: 'changes' }))
  const section = rootSection(page, SHOP_NPM_ROOT)
  const items = section.getByTestId('change-item')
  await expect(items).toHaveCount(2)

  let releaseIndexReload: () => void = () => {}
  const indexReloadReleased = new Promise<void>((resolve) => {
    releaseIndexReload = resolve
  })
  let readsAfterClear: number | undefined
  await page.route(`**/api/roots/${SHOP_NPM_ROOT}/changes`, async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') readsAfterClear = 0
    else if (method === 'GET' && readsAfterClear !== undefined) {
      readsAfterClear += 1
      if (readsAfterClear === 2) await indexReloadReleased
    }
    await route.fallback()
  })

  await section.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect.poll(() => readsAfterClear).toBe(2)

  const scanAfterClear = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== '/api/scan') return false
    const scan = (await response.json()) as ScanSummary
    return scan.roots.find((root) => root.id === SHOP_NPM_ROOT)?.actions.changeCount === 0
  })
  const refresh = page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true })
  await refresh.click()
  await page.getByRole('menu', { name: 'Refresh' }).getByRole('menuitem', { name: 'Recheck registry and OSV', exact: true }).click()
  await scanAfterClear

  await expect(section).toBeVisible()
  await expect(section.getByText('Cleared 2 changes.', { exact: true })).toBeVisible()
  releaseIndexReload()
  const undo = section.getByRole('button', { name: 'Undo', exact: true })
  await expect(undo).toBeVisible()
  await expect(undo).not.toHaveAttribute('aria-disabled', 'true')
  await undo.click()
  await expect(items).toHaveCount(2)
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(2)
})

test('Save change replaces the edited change twice in a row without pressing Edit again', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  await addChange(page, SHOP_NPM_ROOT, { nodeId: TOOLKIT_ID, choice: 'latest' })
  await page.goto(pageUrl(running().url, { view: 'changes' }))
  const section = rootSection(page, SHOP_NPM_ROOT)
  const item = section.getByTestId('change-item')
  await item.getByRole('button', { name: 'Edit Update toolkit to 3.0.0', exact: true }).click()

  const panel = details(page)
  const update = panel.getByRole('region', { name: 'Actions' }).getByTestId('actions-update')
  const version = update.getByRole('combobox', { name: 'Version' })
  await expect(version).toHaveValue('3.0.0', { timeout: READY_TIMEOUT_MS })
  const save = update.getByRole('button', { name: 'Save change', exact: true })
  await version.selectOption('2.1.0')
  await save.click()
  await expect(item.getByTestId('change-goal')).toHaveText(/^Update toolkit to 2\.1\.0 · /)
  const firstSave = await changesOf(page, SHOP_NPM_ROOT)

  await expect(save).toBeVisible()
  await version.selectOption('3.0.0')
  await save.click()
  await expect(item.getByTestId('change-goal')).toHaveText(/^Update toolkit to 3\.0\.0 · /)
  const secondSave = await changesOf(page, SHOP_NPM_ROOT)
  expect(secondSave.items).toHaveLength(1)
  expect(secondSave.items[0]?.choice).toBe('latest')
  expect(secondSave.items[0]?.id).not.toBe(firstSave.items[0]?.id)
  await expect(item).toHaveCount(1)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(section.getByRole('alert')).toHaveCount(0)
})

const TAB_PRESS_LIMIT = 40

async function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((element) => element === element.ownerDocument.activeElement)
}

async function tabUntilFocused(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: READY_TIMEOUT_MS })
  for (let presses = 0; presses < TAB_PRESS_LIMIT && !(await isFocused(target)); presses += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

test('journey 6: the keyboard alone selects the shop-npm sub-row, adds its fix, previews, cancels Apply, collapses both panels and opens the help', async ({ page }) => {
  await openWhenBothRootsAreReady(page)
  const header = packageRow(page, CHILD_LABEL)
  const npmRow = locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT)
  const shopRow = locationRow(page, CHILD_LABEL, SHOP_ROOT)
  await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: READY_TIMEOUT_MS })
  await expect(npmRow.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled({ timeout: READY_TIMEOUT_MS })
  await expect(page.locator('body')).toBeFocused()

  await tabUntilFocused(page, header)
  await page.keyboard.press('ArrowDown')
  await expect(shopRow).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(npmRow).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => searchParam(page, 'focus')).toBe(CHILD_ID)
  expect(searchParam(page, 'in')).toBe(SHOP_NPM_ROOT)
  await expect(npmRow).toHaveAttribute('aria-selected', 'true')
  await expect(npmRow).toBeFocused()
  await expect(details(page).getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)

  await page.keyboard.press('Tab')
  await expect(npmRow.getByRole('button', { name: 'Add fix', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(npmRow.getByRole('button', { name: '✓ In changes', exact: true })).toBeFocused()
  await expect(page.locator('[aria-live="polite"]')).toHaveText(`Added fix for child-lib to ${SHOP_NPM_ROOT}`)
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
  expect(await changeCount(page, SHOP_ROOT)).toBe(0)

  await page.keyboard.press('2')
  await expect(tab(page, 'Changes')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Changes')).toBeFocused()
  const section = rootSection(page, SHOP_NPM_ROOT)
  await tabUntilFocused(page, section.getByRole('button', { name: 'Preview', exact: true }))
  await page.keyboard.press('Enter')
  const apply = section.getByRole('button', { name: 'Apply…', exact: true })
  await expect(apply).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(apply).not.toHaveAttribute('aria-disabled', 'true')
  await expect(apply).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(apply).toBeFocused()
  expect((await changesOf(page, SHOP_NPM_ROOT)).revertable).toBe(false)

  await page.keyboard.press('[')
  const roots = page.getByRole('navigation', { name: 'Roots' })
  await expect(roots.getByRole('button', { name: 'Show roots panel ([)', exact: true })).toBeFocused()
  await expect(roots.getByRole('tree', { name: 'Roots' })).toHaveCount(0)
  await page.keyboard.press(']')
  const showDetails = detailsLandmark(page).getByRole('button', { name: 'Show details panel (])', exact: true })
  await expect(showDetails).toBeFocused()
  await expect(details(page).getByRole('heading', { level: 2 })).toHaveCount(0)

  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toBeVisible()
  await expect(help.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(showDetails).toBeFocused()

  await page.keyboard.press('3')
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect(showDetails).toBeFocused()
  await page.keyboard.press('1')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect(showDetails).toBeFocused()
  expect(await changeCount(page, SHOP_NPM_ROOT)).toBe(1)
})
