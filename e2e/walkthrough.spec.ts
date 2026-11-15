import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ScanSummary } from '../src/server/router.ts'
import { missingManager } from '../test/helpers/package-managers.ts'
import { CHILD_ADVISORY_ID, startActionsFixture, type ActionsFixtureWithNpmRoot } from './actions-fixture.ts'
import { SHOP_NPM_ROOT, SHOP_ROOT } from './shop-monorepo.ts'
import { details, detailsLandmark, mode, tab } from './ui.ts'

const WALKTHROUGH_DIR = fileURLToPath(new URL('../test-results/walkthrough/', import.meta.url))
const VIEWPORT = { width: 1440, height: 900 }
const MIN_FONT_SIZE_PX = 12
const READY_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 300_000
const CHILD_LABEL = 'child-lib 1.0.0'
const FIXED_CHILD_LABEL = 'child-lib 1.0.1'
const TOOLKIT_LABEL = 'toolkit 2.0.0'
const HELPER_LABEL = 'helper 1.0.0'
const CHILD_FIX_GOAL = `Fix child-lib 1.0.0 · ${CHILD_ADVISORY_ID}`
const APPLY_OUTCOME = /^Applied to shop-npm\. 1 goal met · files written: .+\.$/
const FOLLOW_NOTICE = `Applied in ${SHOP_NPM_ROOT}: child-lib 1.0.0 → 1.0.1. Showing the new version.`
const FILES_RESTORED = `Files restored in ${SHOP_NPM_ROOT}. 1 change is back in the list.`
const ON_PATH = /trail__chip--on-path/
const missingManagers = [missingManager('pnpm'), missingManager('npm')].filter((reason) => reason !== undefined)

test.skip(missingManagers.length > 0, missingManagers.join('; '))
test.describe.configure({ timeout: TEST_TIMEOUT_MS })
test.use({ viewport: VIEWPORT })

async function openWhenBothRootsAreReady(page: Page, fixture: ActionsFixtureWithNpmRoot): Promise<void> {
  await page.goto(fixture.url)
  await expect
    .poll(
      async () => {
        const scan = (await (await page.request.get(new URL('/api/scan', fixture.url).toString())).json()) as ScanSummary
        const ready = [SHOP_ROOT, SHOP_NPM_ROOT].every((rootId) => scan.roots.find((root) => root.id === rootId)?.actions.available === true)
        return scan.enrichment.state === 'done' && ready
      },
      { timeout: READY_TIMEOUT_MS },
    )
    .toBe(true)
  await page.goto(fixture.url)
}

function issuesGrid(page: Page): Locator {
  return page.getByRole('treegrid', { name: 'Issues' })
}

function packageRow(page: Page, packageLabel: string): Locator {
  return issuesGrid(page).getByTestId('issue-package').filter({ hasText: packageLabel })
}

function locationRow(page: Page, packageLabel: string, rootId: string): Locator {
  return issuesGrid(page).getByRole('row', { name: `${packageLabel} in ${rootId}`, exact: true })
}

function rootSection(page: Page, rootId: string): Locator {
  return page.getByRole('region', { name: 'Changes', exact: true }).getByRole('region', { name: rootId, exact: true })
}

function whatToDo(page: Page): Locator {
  return details(page).getByRole('region', { name: 'Actions' })
}

function trailChip(page: Page, label: string): Locator {
  return page.getByTestId('trail-chip').filter({ hasText: label })
}

function horizontalOverflowPx(page: Page): Promise<number> {
  return page.locator('html').evaluate((root) => root.scrollWidth - root.clientWidth)
}

async function scrollToNearestEdge(target: Locator): Promise<void> {
  await target.evaluate((element) => element.scrollIntoView({ block: 'nearest' }))
}

function textUnderMinimumFontSize(page: Page): Promise<string[]> {
  return page.locator('body *').evaluateAll(
    (elements, minimumPx) =>
      elements.flatMap((element) => {
        const ownText = [...element.childNodes]
          .filter((child) => child.nodeType === child.TEXT_NODE)
          .map((child) => child.textContent)
          .join('')
          .trim()
        if (ownText === '' || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return []
        const fontSizePx = Number.parseFloat(element.ownerDocument.defaultView.getComputedStyle(element).fontSize)
        return fontSizePx < minimumPx ? [`${fontSizePx}px <${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">: ${ownText.slice(0, 60)}`] : []
      }),
    MIN_FONT_SIZE_PX,
  )
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${WALKTHROUGH_DIR}${name}.png` })
  expect.soft(await textUnderMinimumFontSize(page), `text under ${MIN_FONT_SIZE_PX}px at ${name}`).toEqual([])
  expect.soft(await horizontalOverflowPx(page), `horizontal scroll at ${name}`).toBe(0)
}

test('walks through the redesigned UI at 1440 px', { tag: '@walkthrough' }, async ({ page }) => {
  const fixture = await startActionsFixture({ npmRoot: true })
  try {
    await openWhenBothRootsAreReady(page, fixture)
    const childHeader = packageRow(page, CHILD_LABEL)
    await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
    await expect(childHeader).toBeVisible({ timeout: READY_TIMEOUT_MS })
    await capture(page, '01-issues-all-roots')

    const shopChildRow = locationRow(page, CHILD_LABEL, SHOP_ROOT)
    const npmChildRow = locationRow(page, CHILD_LABEL, SHOP_NPM_ROOT)
    const npmAddFix = npmChildRow.getByRole('button', { name: 'Add fix', exact: true })
    await expect(childHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(npmAddFix).toBeEnabled({ timeout: READY_TIMEOUT_MS })
    await expect(shopChildRow.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled({ timeout: READY_TIMEOUT_MS })
    await childHeader.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(npmChildRow).toBeFocused()
    await capture(page, '02-child-lib-group')

    const panel = details(page)
    const shopToolkitRow = locationRow(page, TOOLKIT_LABEL, SHOP_ROOT)
    await shopToolkitRow.getByRole('button', { name: 'Update…', exact: true }).click()
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(TOOLKIT_LABEL)
    const update = whatToDo(page).getByTestId('actions-update')
    await expect(update.getByRole('combobox', { name: 'Version' })).toHaveValue('2.1.0', { timeout: READY_TIMEOUT_MS })
    await update.getByRole('button', { name: 'Add to changes', exact: true }).click()
    await expect(update.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeVisible()
    await expect(shopToolkitRow.getByRole('button', { name: '✓ In changes', exact: true })).toBeVisible()

    await npmChildRow.getByText(SHOP_NPM_ROOT, { exact: true }).click()
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
    await expect(panel.getByTestId('root-badge')).toHaveText(SHOP_NPM_ROOT)
    await expect(whatToDo(page).getByRole('radio', { checked: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
    await capture(page, '03-child-lib-details-in-shop-npm')

    await npmAddFix.click()
    await expect(npmChildRow.getByRole('button', { name: '✓ In changes', exact: true })).toBeFocused()
    await expect(shopChildRow.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled()
    await expect(page.locator('[aria-live="polite"]')).toHaveText(`Added fix for child-lib to ${SHOP_NPM_ROOT}`)
    await capture(page, '04-add-fix-in-shop-npm')

    await tab(page, 'Changes').click()
    const shopSection = rootSection(page, SHOP_ROOT)
    const npmSection = rootSection(page, SHOP_NPM_ROOT)
    const npmItems = npmSection.getByTestId('change-item')
    await expect(shopSection.getByTestId('change-item')).toHaveCount(1)
    await expect(npmItems.getByTestId('change-goal')).toHaveText([CHILD_FIX_GOAL])
    await expect(tab(page, 'Changes')).toHaveText('Changes 2')
    await capture(page, '05-changes-two-roots')

    await npmSection.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = npmSection.getByRole('region', { name: 'Preview', exact: true })
    await expect(preview.getByTestId('preview-goal')).toHaveText([/^✓/], { timeout: READY_TIMEOUT_MS })
    const webFile = preview.getByTestId('preview-file').filter({ hasText: 'web/package.json' })
    await webFile.getByText('web/package.json', { exact: true }).click()
    await expect(webFile.getByTestId('file-diff')).toContainText('parent-lib')
    await scrollToNearestEdge(webFile)
    await capture(page, '06-preview-in-shop-npm')

    await npmSection.getByRole('button', { name: 'Apply…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${SHOP_NPM_ROOT}?` })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'Run install: npm ci' }).uncheck()
    await capture(page, '07-apply-dialog')
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const outcome = npmSection.getByTestId('changes-outcome')
    await expect(outcome.getByTestId('job-outcome')).toHaveText(APPLY_OUTCOME, { timeout: READY_TIMEOUT_MS })
    await expect(outcome.getByTestId('install-hint')).toHaveText(`node_modules was not updated. Run npm ci in ${SHOP_NPM_ROOT} when ready.`)
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(FIXED_CHILD_LABEL, { timeout: READY_TIMEOUT_MS })
    await expect(panel.getByTestId('follow-notice').getByText(FOLLOW_NOTICE, { exact: true })).toBeVisible()
    await capture(page, '08-applied-and-selection-followed')

    await outcome.getByRole('button', { name: 'Revert files', exact: true }).click()
    await expect(outcome.getByTestId('job-outcome')).toHaveText(FILES_RESTORED, { timeout: READY_TIMEOUT_MS })
    await expect(npmItems.getByTestId('change-goal')).toHaveText([CHILD_FIX_GOAL])
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL, { timeout: READY_TIMEOUT_MS })
    await capture(page, '09-reverted-change-back')

    const toolkitItem = shopSection.getByTestId('change-item')
    await toolkitItem.getByRole('button', { name: 'Edit Update toolkit to 2.1.0', exact: true }).click()
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(TOOLKIT_LABEL)
    const version = update.getByRole('combobox', { name: 'Version' })
    await expect(version).toBeFocused({ timeout: READY_TIMEOUT_MS })
    await version.selectOption('3.0.0')
    const save = update.getByRole('button', { name: 'Save change', exact: true })
    await expect(save).toBeVisible()
    await capture(page, '10-toolkit-update-edit')
    await save.click()
    await expect(toolkitItem.getByTestId('change-goal')).toHaveText(/^Update toolkit to 3\.0\.0 · /)

    await tab(page, 'Issues').click()
    await npmChildRow.getByText(SHOP_NPM_ROOT, { exact: true }).click()
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(CHILD_LABEL)
    await panel.getByRole('button', { name: 'Open in Explore', exact: true }).click()
    await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
    await expect(mode(page, 'Dependents')).toBeChecked()
    const helperChip = trailChip(page, HELPER_LABEL)
    await helperChip.hover()
    await expect(helperChip).toHaveClass(ON_PATH)
    await expect(trailChip(page, 'api')).toHaveClass(ON_PATH)
    await expect(trailChip(page, 'web')).not.toHaveClass(ON_PATH)
    await capture(page, '11-explore-trail-path')

    await page.keyboard.press('[')
    await page.keyboard.press(']')
    await expect(page.getByRole('navigation', { name: 'Roots' }).getByRole('tree', { name: 'Roots' })).toHaveCount(0)
    await expect(detailsLandmark(page).getByRole('button', { name: 'Show details panel (])', exact: true })).toBeVisible()
    await mode(page, 'Graph').click()
    await expect(page.getByTestId('graph-node').first()).toBeVisible({ timeout: READY_TIMEOUT_MS })
    await capture(page, '12-graph-panels-collapsed')
  } finally {
    await fixture.stop()
  }
})
