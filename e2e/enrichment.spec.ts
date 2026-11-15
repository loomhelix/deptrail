import { expect, test, type Page } from '@playwright/test'
import type { IssueRowsResponse, ScanSummary } from '../src/server/router.ts'
import { FIXTURE_TOKEN, SEMVER_ADVISORY_ID } from './fake-enrichment.ts'
import { fakeOsvUrl, fakeRegistryUrl, PRIVATE_PACKAGE, PRIVATE_PACKAGE_VERSION, PRIVATE_ROOT_ID, tokenizedUrl } from './global-setup.ts'
import { chooseIssueGrouping, details, expectTableFitsPanel, issueGrouping, mode, pageUrl, locationOverlaps, showOnlyRootsPanel, tab, textLineCount, viaBreaks, viewMenuButton } from './ui.ts'

const ENRICHMENT_TIMEOUT_MS = 30_000
const CHECKING_FIX_TEXT = 'Checking fix…'
const BUILD_IMPORTER_ID = 'importer:tools/build'
const SEMVER_ID = 'semver@5.7.2'
const RECOMMENDED_MIN_WIDTH = 180

async function openWhenEnriched(page: Page, params: Record<string, string>): Promise<void> {
  const url = pageUrl(tokenizedUrl(), params)
  await page.goto(url)
  await expect
    .poll(
      async () => {
        const response = await page.request.get(new URL('/api/scan', url).toString())
        const scan = (await response.json()) as { enrichment: { state: string } }
        return scan.enrichment.state
      },
      { timeout: ENRICHMENT_TIMEOUT_MS },
    )
    .toBe('done')
}

test('the tree flags the deprecated, outdated and vulnerable-below packages under tools/build', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: BUILD_IMPORTER_ID, view: 'explore', mode: 'tree', at: BUILD_IMPORTER_ID })
  const rows = page.getByTestId('tree-row')
  const readerRow = rows.filter({ hasText: 'read-pkg-up 7.0.1' })
  await expect(readerRow).toHaveCount(1)
  await expect(readerRow.getByText('deprecated', { exact: true })).toBeVisible()
  await expect(readerRow.getByText('↑ 11.0.0 major', { exact: true })).toBeVisible()
  await expect(readerRow.getByText('1 vulnerable below · high', { exact: true })).toBeVisible()
  await expect(readerRow.getByText('requires ^7.0.1', { exact: true })).toBeVisible()

  await readerRow.getByRole('button', { name: 'Expand read-pkg-up' }).click()
  await rows.filter({ hasText: 'normalize-package-data 2.5.0' }).getByRole('button', { name: 'Expand normalize-package-data' }).click()
  const semverRow = rows.filter({ hasText: 'semver 5.7.2' })
  await expect(semverRow).toHaveCount(1)
  await expect(semverRow.getByText('high', { exact: true })).toBeVisible()
  await expect(semverRow.getByText('↑', { exact: false })).toHaveCount(0)
  await expect(semverRow).not.toContainText('requires')
})

test('the tree overview flags the packages under each workspace package with the same badges', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', view: 'explore', mode: 'tree' })
  const rows = page.getByTestId('tree-row')
  await rows.filter({ hasText: '@fixture/build' }).getByRole('button', { name: 'Expand @fixture/build' }).click()
  const readerRow = rows.filter({ hasText: 'read-pkg-up 7.0.1' })
  await expect(readerRow.getByText('deprecated', { exact: true })).toBeVisible()
  await expect(readerRow.getByText('↑ 11.0.0 major', { exact: true })).toBeVisible()
  await expect(readerRow.getByText('1 vulnerable below · high', { exact: true })).toBeVisible()
  await expect(readerRow.getByText('requires ^7.0.1', { exact: true })).toBeVisible()
})

test('the trail of semver 5.7.2 badges its chips with the same words', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: SEMVER_ID, view: 'explore', mode: 'trail', at: SEMVER_ID })
  const chips = page.getByTestId('trail-chip')
  await expect(chips.filter({ hasText: 'semver 5.7.2' }).getByText('high', { exact: true })).toBeVisible()
  const readerChip = chips.filter({ hasText: 'read-pkg-up 7.0.1' })
  await expect(readerChip.getByText('deprecated', { exact: true })).toBeVisible()
  await expect(readerChip).toHaveAttribute('title', 'read-pkg-up 7.0.1')
  const readerBelow = readerChip.getByText('1 vulnerable below', { exact: true })
  await expect(readerBelow).toBeVisible()
  await expect(readerBelow).toHaveAttribute('title', '1 vulnerable below · high')
})

test('the graph focused on semver 5.7.2 shows a high pill on it', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: SEMVER_ID, view: 'explore', mode: 'graph', at: SEMVER_ID })
  const semverNode = page.locator(`[data-testid="graph-node"][data-id="${SEMVER_ID}"]`)
  await expect(semverNode).toBeVisible()
  await expect(semverNode.getByTestId('graph-badge').getByText('high', { exact: true })).toHaveCount(1)
})

function issuesSection(page: Page, title: string) {
  return page.getByTestId('issues-section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

test('the Issues tab shows a count and lists the issues in three sections', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', view: 'issues' })
  await expect(tab(page, 'Issues')).toHaveText(/^Issues \d+$/)

  const vulnerable = issuesSection(page, 'Vulnerabilities').getByTestId('issue-row').filter({ hasText: 'semver 5.7.2' })
  await expect(vulnerable).toHaveCount(1)
  await expect(vulnerable.getByText('high', { exact: true })).toBeVisible()
  await expect(vulnerable).toContainText('GHSA-e2e0-semv-0001')
  await expect(vulnerable.getByTestId('row-recommended')).toHaveText('Re-lock eslint-plugin-vue', { timeout: ENRICHMENT_TIMEOUT_MS })
  await expect(vulnerable.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled()
  await expect(page.getByRole('treegrid', { name: 'Issues' }).getByRole('columnheader', { name: 'Root', exact: true })).toHaveCount(0)

  await expect(issuesSection(page, 'Deprecations').getByTestId('issue-row').filter({ hasText: 'read-pkg-up 7.0.1' })).toHaveCount(1)

  const outdated = issuesSection(page, 'Updates').getByTestId('issue-row').filter({ hasText: 'eslint-plugin-vue 9.32.0' })
  await expect(outdated).toHaveCount(1)
  await expect(outdated).toContainText('→ 9.33.0')
})

test('grouping by direct dependency lists semver under both direct parents', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', view: 'issues' })
  await chooseIssueGrouping(page, 'Direct dependency')
  const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
  await expect(grid.getByRole('columnheader', { name: 'Root', exact: true })).toHaveCount(0)
  const groups = grid.getByTestId('issue-group')
  for (const direct of ['read-pkg-up 7.0.1', 'eslint-plugin-vue 9.32.0']) {
    const group = groups.filter({ has: page.getByRole('row', { name: `${direct} in npm-package`, exact: true }) })
    await expect(group).toHaveCount(1)
    const semverRow = group.getByTestId('issue-group-row').filter({ hasText: 'semver 5.7.2' })
    await expect(semverRow).toHaveCount(1)
    await expect(semverRow.getByTestId('row-recommended')).toHaveText('Re-lock eslint-plugin-vue', { timeout: ENRICHMENT_TIMEOUT_MS })
    await expect(semverRow.getByRole('button', { name: 'Add fix', exact: true })).toBeEnabled()
  }
  const reader = groups.getByRole('row', { name: 'read-pkg-up 7.0.1 in npm-package', exact: true })
  await expect(reader.getByText('deprecated', { exact: true })).toBeVisible()
  await expect(reader.getByText('1 vulnerable below · high', { exact: true })).toBeVisible()
  await expect(reader.getByRole('button', { name: 'Update…', exact: true })).toBeVisible()
})

test('nested rows of one package under two direct dependencies have different accessible names', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', view: 'issues' })
  await chooseIssueGrouping(page, 'Direct dependency')
  const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
  const underReader = grid.getByRole('row', { name: 'semver 5.7.2 under read-pkg-up 7.0.1 in npm-package', exact: true })
  const underPlugin = grid.getByRole('row', { name: 'semver 5.7.2 under eslint-plugin-vue 9.32.0 in npm-package', exact: true })
  await expect(underReader).toHaveCount(1)
  await expect(underPlugin).toHaveCount(1)
})

test('a group heading is described by the more-not-listed note when paths are left out', async ({ page }) => {
  const hiddenCount = 3
  await page.route(/\/api\/issues\?.*groupBy=direct/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { groups: { issuesTruncated: number }[] }
    const groups = body.groups.map((group, position) => (position === 0 ? { ...group, issuesTruncated: hiddenCount } : group))
    await route.fulfill({ response, json: { ...body, groups } })
  })
  await openWhenEnriched(page, { root: 'npm-package', view: 'issues' })
  await chooseIssueGrouping(page, 'Direct dependency')
  const grid = page.getByRole('treegrid', { name: 'Issues by direct dependency' })
  const noteText = `+${hiddenCount} more not listed`
  const note = grid.getByText(noteText, { exact: true })
  await expect(note).toHaveCount(1)
  const heading = grid.getByTestId('issue-group').filter({ has: page.getByText(noteText, { exact: true }) }).getByTestId('issue-group-header')
  await expect(heading).toHaveAccessibleDescription(new RegExp(`\\+${hiddenCount} more not listed$`))
})

test('the check progress is focusable and describes its details', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', view: 'issues' })
  const progress = page.getByText(/^Checked /)
  await expect(progress).toHaveAttribute('tabindex', '0')
  await progress.focus()
  await expect(progress).toBeFocused()
  await expect(progress).toHaveAccessibleName(/^Checked /)
  await expect(progress).toHaveAccessibleDescription(/^Registry [\d,]+ packages · OSV [\d,]+ versions, [\d,]+ skipped$/)
})

test('clicking an issue row selects the package, the state survives a reload and Explore shows why it is here', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', view: 'issues' })
  const vulnerable = issuesSection(page, 'Vulnerabilities').getByTestId('issue-row').filter({ hasText: 'semver 5.7.2' })
  await vulnerable.getByText('semver 5.7.2', { exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: /semver 5\.7\.2/ })).toBeVisible()
  await expect(vulnerable).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/focus=semver@5\.7\.2/)

  await chooseIssueGrouping(page, 'Direct dependency')
  await page.reload()
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-selected', 'true')
  await viewMenuButton(page).click()
  await expect(issueGrouping(page, 'Direct dependency')).toHaveAttribute('aria-checked', 'true')

  await issueGrouping(page, 'Package').click()
  await expect(vulnerable).toHaveAttribute('aria-selected', 'true')
  await tab(page, 'Explore').click()
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect(mode(page, 'Dependents')).toHaveAttribute('aria-checked', 'true')
  await expect(page).toHaveURL(/view=explore/)
  await expect(page).toHaveURL(/focus=semver@5\.7\.2/)
})

test('the details panel of semver 5.7.2 shows the advisory, the actions and the dependents, and the root count', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: SEMVER_ID })
  const panel = details(page)
  await expect(panel.getByTestId('header-label')).toHaveText(['high'])
  const advisory = panel.getByTestId('advisory')
  await expect(advisory).toHaveCount(1)
  await expect(advisory.getByRole('link', { name: SEMVER_ADVISORY_ID })).toBeVisible()
  await expect(advisory).toContainText('Fixed in 5.7.3')

  await expect(panel.getByRole('region', { name: 'Dependents' }).getByTestId('why-here-row')).toHaveText([
    'normalize-package-data 2.5.0 requires 2 || 3 || 4 || 5 · from @fixture/build',
    'vue-eslint-parser 9.4.3 requires 5.7.2 · from @fixture/commerce-ui, @fixture/storefront',
  ])
  await expect(panel.getByRole('heading', { level: 3 })).toHaveText(['Vulnerability', 'Actions', 'Dependents'])
  for (const removed of ['Requested ranges', 'Registry', 'Upward tree', 'Versions in the monolith']) {
    await expect(panel.getByRole('region', { name: removed })).toHaveCount(0)
  }
  await expect(panel.getByText(/OSV\.dev has no advisories/)).toHaveCount(0)

  const roots = page.getByRole('navigation', { name: 'Roots' })
  await expect(roots.getByRole('treeitem', { name: 'npm-package', exact: true }).getByRole('link', { name: '1 vulnerable', exact: true })).toBeVisible()
})

test('read-pkg-up 7.0.1 lists the vulnerable package below it and shows its deprecation', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: 'read-pkg-up@7.0.1' })
  const panel = details(page)
  await expect(panel.getByTestId('header-label')).toHaveText(['deprecated', '↑ 11.0.0 major', '1 vulnerable below · high'])
  await expect(panel.getByTestId('deprecation')).toContainText('Renamed to read-package-up')
  const below = panel.getByTestId('vulnerable-below')
  await below.getByText('Vulnerable dependencies', { exact: true }).click()
  await below.getByRole('button', { name: 'semver 5.7.2', exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('semver 5.7.2')
})

test('a direct dependency with only an update says no known issues and keeps the check times and the npm link under More', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: 'semver@7.6.3' })
  const panel = details(page)
  await expect(panel.getByTestId('header-label')).toHaveText(['↑ 7.7.0 minor', 'no known issues'])
  await expect(panel.getByTestId('advisory')).toHaveCount(0)
  const more = panel.getByTestId('details-more')
  await more.getByText('More', { exact: true }).click()
  await expect(more).toContainText('Registry checked')
  await expect(more.getByRole('link', { name: 'npm', exact: true })).toHaveAttribute('href', 'https://www.npmjs.com/package/semver')
  await expect(more.getByRole('link', { name: 'OSV', exact: true })).toHaveCount(0)
})

test('the landing summary claims no known issues only after the checks are done', async ({ page }) => {
  await openWhenEnriched(page, {})
  const summary = details(page)
  const rootRows = summary.getByTestId('scope-root')
  const cleanRoots = rootRows.filter({ hasText: 'No known issues' })
  await expect(cleanRoots.first()).toBeVisible()
  const cleanRootCount = await cleanRoots.count()

  for (const [state, text] of [
    ['running', 'Checking packages…'],
    ['offline', 'Offline: started with --offline'],
  ] as const) {
    await page.route('**/api/scan', async (route) => {
      const response = await route.fetch()
      const scan = (await response.json()) as { enrichment: { state: string } }
      await route.fulfill({ response, json: { ...scan, enrichment: { ...scan.enrichment, state } } })
    })
    await page.reload()
    await expect(rootRows.filter({ hasText: text })).toHaveCount(cleanRootCount)
    await expect(summary.getByText('No known issues', { exact: true })).toHaveCount(0)
    await page.unroute('**/api/scan')
  }
})

test('the summaries, the details header and an empty Issues never claim clean after failed checks or a root that failed to scan', async ({ page }) => {
  await openWhenEnriched(page, {})
  const scanUrl = new URL('/api/scan', tokenizedUrl()).toString()
  const settled = (await (await page.request.get(scanUrl)).json()) as ScanSummary
  const cleanRoot = settled.roots.find((root) => root.issueCounts !== undefined && root.issueCounts.vulnerable + root.issueCounts.deprecated + root.issueCounts.outdatedDirect === 0)
  const otherRoot = settled.roots.find((root) => root.id !== cleanRoot?.id)
  if (cleanRoot === undefined || otherRoot === undefined) throw new Error('the fixture has no root without issues')
  const failedChecks = 'No known issues in the checked packages; 3 checks failed'
  const problems = [{ source: 'osv', origin: 'https://api.osv.dev', message: 'timed out', count: 3 }]
  await page.route('**/api/scan', async (route) => {
    const response = await route.fetch()
    const scan = (await response.json()) as ScanSummary
    await route.fulfill({ response, json: { ...scan, enrichment: { ...scan.enrichment, state: 'done', problems } } })
  })

  await page.reload()
  const summary = details(page)
  const rootRows = summary.getByTestId('scope-root')
  await expect(rootRows.filter({ hasText: failedChecks }).first()).toBeVisible()
  await expect(summary.getByText('No known issues', { exact: true })).toHaveCount(0)

  await page.goto(pageUrl(tokenizedUrl(), { root: cleanRoot.id }))
  const empty = page.getByTestId('issues-empty')
  await expect(empty).toHaveText(failedChecks)
  await expect(details(page).getByTestId('scope-root')).toHaveText(failedChecks)

  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package', focus: 'semver@7.6.3' }))
  const more = details(page).getByTestId('details-more')
  await more.getByText('More', { exact: true }).click()
  await expect(more).toContainText('Registry checked')
  await expect(details(page).getByTestId('header-label')).toHaveText(['↑ 7.7.0 minor'])

  await page.unroute('**/api/scan')
  await page.route('**/api/scan', async (route) => {
    const response = await route.fetch()
    const scan = (await response.json()) as ScanSummary
    const roots = scan.roots.map((root) => (root.id === otherRoot.id ? { ...root, status: 'failed', error: 'broken lockfile' } : root))
    await route.fulfill({ response, json: { ...scan, roots } })
  })
  await page.route(/\/api\/issues\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, rows: [] }) }))
  await page.goto(pageUrl(tokenizedUrl(), {}))
  await expect(empty).toHaveText(`No known issues in the checked packages; ${otherRoot.id} failed to scan`)
  await expect(page.getByText('No known issues in All roots', { exact: true })).toHaveCount(0)
})

async function showSemverPulledInBy(page: Page, directName: string): Promise<void> {
  await openWhenEnriched(page, { root: 'npm-package' })
  const rowsUrl = new URL('/api/issues?root=npm-package', tokenizedUrl()).toString()
  const { rows } = (await (await page.request.get(rowsUrl)).json()) as IssueRowsResponse
  const semver = rows.find((row) => row.name === 'semver' && row.version === '5.7.2')
  if (semver === undefined) throw new Error('the fixture has no semver 5.7.2 issue in npm-package')
  const widened = {
    ...semver,
    locations: semver.locations.map((location) => ({ ...location, via: [{ direct: `${directName}@1.0.0`, importers: [] }, ...location.via] })),
  }
  await page.route(/\/api\/issues\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, rows: [widened] }) }))
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package' }))
}

async function showSemverInTwoRoots(page: Page, secondRoot: string, directName: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openWhenEnriched(page, {})
  const rowsUrl = new URL('/api/issues', tokenizedUrl()).toString()
  const { rows } = (await (await page.request.get(rowsUrl)).json()) as IssueRowsResponse
  const semver = rows.find((row) => row.name === 'semver' && row.version === '5.7.2')
  const [first] = semver?.locations ?? []
  if (semver === undefined || first === undefined) throw new Error('the fixture has no semver 5.7.2 issue')
  const location = { ...first, via: [{ direct: `${directName}@1.0.0`, importers: [] }, ...first.via] }
  const widened = { ...semver, locations: [location, { ...location, rootId: secondRoot }] }
  await page.route(/\/api\/issues/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, rows: [widened] }) }))
  await page.goto(pageUrl(tokenizedUrl(), {}))
  await expect(page.getByRole('treegrid').getByTestId('issue-location')).toHaveCount(2)
}

test('in all roots at 1440 px a level-2 root label with a long path segment never runs into its Via list', async ({ page }) => {
  await showSemverInTwoRoots(page, 'application/commerce-web-documentation/dev', 'eslint')
  expect(await locationOverlaps(page)).toEqual([])
  await expectTableFitsPanel(page)
})

test('in all roots at 1440 px a long scoped name under Via in a level-2 row takes at most two lines', async ({ page }) => {
  const longName = '@sample/karma-selenium4-webdriver-launcher'
  await showSemverInTwoRoots(page, PRIVATE_ROOT_ID, longName)
  const names = page.getByRole('treegrid').getByTestId('issue-location').getByText(longName, { exact: true })
  await expect(names).toHaveCount(2)
  for (const name of await names.all()) expect(await textLineCount(name)).toBeLessThanOrEqual(2)
  expect(await locationOverlaps(page)).toEqual([])
  await expectTableFitsPanel(page)
})

test('a Via name longer than its line keeps the word Via before it and the comma after it on its own lines', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await showSemverPulledInBy(page, `@fixture/${'a-very-long-package-name-'.repeat(3)}end`)
  const list = page.getByRole('treegrid').getByTestId('via-list').first()
  await expect(list).toBeVisible()
  expect(await textLineCount(list)).toBeGreaterThan(2)
  expect(await viaBreaks(list)).toEqual({ linesStartingWithComma: 0, prefixAlone: false })
})

test('at 1440 px a long scoped name under Via takes at most two lines and the table fits its panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const longName = '@sample/karma-selenium4-webdriver-launcher'
  await showSemverPulledInBy(page, longName)
  const table = page.getByRole('treegrid')
  const name = table.getByTestId('via-list').first().getByText(longName, { exact: true })
  await expect(name).toBeVisible()
  const lines = await textLineCount(name)
  expect(lines).toBeLessThanOrEqual(2)
  await expectTableFitsPanel(page)
})

test('at 1440 px the issues table fits its panel with a long name under Via and still loads the recommended fix', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await showSemverPulledInBy(page, `@fixture/${'a-very-long-package-name-'.repeat(8)}end`)
  const table = page.getByRole('treegrid')
  await expect(table.getByTestId('issue-row').first()).toBeVisible()
  await expectTableFitsPanel(page)
  const recommendedWidth = await table.evaluate((element) => element.querySelector('thead th:last-child')?.getBoundingClientRect().width ?? 0)
  expect(recommendedWidth).toBeGreaterThanOrEqual(RECOMMENDED_MIN_WIDTH)
  await expect(table.getByTestId('row-recommended').first()).not.toHaveText('Checking fix…')
})

test('at 1440 px the issues table of all roots fits its panel when scoped names have no hyphen to wrap at', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openWhenEnriched(page, {})
  const rowsUrl = new URL('/api/issues', tokenizedUrl()).toString()
  const { rows } = (await (await page.request.get(rowsUrl)).json()) as IssueRowsResponse
  const semver = rows.find((row) => row.name === 'semver' && row.version === '5.7.2')
  if (semver === undefined) throw new Error('the fixture has no semver 5.7.2 issue')
  const scopedName = '@fixturescope/jquery.nicescroll'
  const widened = {
    ...semver,
    name: scopedName,
    locations: semver.locations.map((location) => ({ ...location, via: [{ direct: `${scopedName}@1.0.0`, importers: [] }, ...location.via] })),
  }
  await page.route(/\/api\/issues/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, rows: [widened] }) }))
  await page.goto(pageUrl(tokenizedUrl(), {}))
  const table = page.getByRole('treegrid')
  await expect(table.getByTestId('issue-row').first()).toBeVisible()
  await expectTableFitsPanel(page)
})

test('a root name without a slash never breaks at a hyphen in the issues table, and in N roots stays on one line', async ({ page }) => {
  await openWhenEnriched(page, {})
  const table = page.getByRole('treegrid')
  await expect(table.getByTestId('issue-row').first()).toBeVisible()
  const brokenLabels = await table.evaluate((element) => {
    const lineCount = (node: { ownerDocument: { createRange(): { selectNodeContents(node: unknown): void; getClientRects(): ArrayLike<{ top: number }> } } }) => {
      const range = node.ownerDocument.createRange()
      range.selectNodeContents(node)
      return new Set([...Array.from(range.getClientRects())].map((rect) => Math.round(rect.top))).size
    }
    return [...element.querySelectorAll('td.issue-rows__root > span, [data-testid="location-label"]')]
      .filter((span) => {
        const text = (span.textContent ?? '').trim()
        return text.startsWith('in ') || !/[ /]/.test(text)
      })
      .filter((span) => lineCount(span) > 1)
      .map((span) => span.textContent)
  })
  expect(brokenLabels).toEqual([])
})

test('a row loads its recommended fix and keeps the cell in view when an unbreakable name is very long', async ({ page }) => {
  await showSemverPulledInBy(page, `@fixture/${'x'.repeat(400)}`)
  const recommended = page.getByRole('treegrid').getByTestId('row-recommended').first()
  await expect(recommended).toBeInViewport()
  await expectTableFitsPanel(page)
  await expect(recommended).not.toHaveText('Checking fix…')
})

test('opening Issues asks for the issue rows once per revision', async ({ page }) => {
  await openWhenEnriched(page, {})
  await page.waitForLoadState('networkidle')
  const answeredRevisions: Promise<number>[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/issues') return
    answeredRevisions.push(response.json().then((body: IssueRowsResponse) => body.revision))
  })
  await page.reload()
  await expect(page.getByRole('treegrid').getByTestId('issue-row').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  const revisions = await Promise.all(answeredRevisions)
  expect(revisions.length).toBeGreaterThan(0)
  expect(new Set(revisions).size).toBe(revisions.length)
})

test('a workspace package does not claim clean dependencies when the paths to a package with issues were capped', async ({ page }) => {
  await openWhenEnriched(page, { root: 'npm-package', focus: SEMVER_ID })
  const rowsUrl = new URL('/api/issues?root=npm-package', tokenizedUrl()).toString()
  const { rows } = (await (await page.request.get(rowsUrl)).json()) as IssueRowsResponse
  const semver = rows.find((row) => row.name === 'semver' && row.locations.some((location) => location.rootId === 'npm-package'))
  if (semver === undefined) throw new Error('the fixture has no semver issue in npm-package')
  const importers = new Set(semver.locations.flatMap((location) => location.via.flatMap((entry) => entry.importers)))
  const scan = (await (await page.request.get(new URL('/api/scan', tokenizedUrl()).toString())).json()) as ScanSummary
  const outside = scan.roots.find((root) => root.id === 'npm-package')?.importers.find((importer) => !importers.has(importer.id))
  if (outside === undefined) throw new Error('every workspace package of npm-package pulls in semver')
  const cappedRow = {
    ...semver,
    locations: semver.locations.map((location) => (location.rootId === 'npm-package' ? { ...location, viaTruncated: 4 } : location)),
  }
  await page.route(/\/api\/issues\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, rows: [cappedRow] }) }))

  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package', focus: outside.id }))
  const state = details(page).getByTestId('workspace-problems-state')
  await expect(state).toHaveText('May be incomplete: not all paths to 1 package with issues are listed')
  await expect(details(page).getByText('No known issues in dependencies', { exact: true })).toHaveCount(0)
})

test('a private-scope package is explained, never sent to OSV and the token never reaches the page', async ({ page }) => {
  await openWhenEnriched(page, { root: PRIVATE_ROOT_ID, focus: `${PRIVATE_PACKAGE}@${PRIVATE_PACKAGE_VERSION}` })
  const notChecked = details(page).getByTestId('header-label').filter({ hasText: 'not checked' })
  await expect(notChecked).toHaveAttribute('title', 'Private scope with a registry in .npmrc; not sent to OSV')

  const osvRequests = await (await page.request.get(new URL('/__requests', fakeOsvUrl()).toString())).text()
  expect(osvRequests).not.toContain('@acme')
  const registryRequests = await (await page.request.get(new URL('/__requests', fakeRegistryUrl()).toString())).text()
  expect(registryRequests).toContain(`Bearer ${FIXTURE_TOKEN}`)
  expect(await page.locator('body').innerText()).not.toContain(FIXTURE_TOKEN)
})

const FITTING_WIDTHS = [1280, 1440] as const
const FORTY_CHARACTER_NAME = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'
const FORTY_CHARACTER_SCOPED_NAME = `@scope/${'q'.repeat(33)}`

type WidthCase = { title: string; name?: string; direct?: string; grouping?: 'Direct dependency' }

const WIDTH_CASES: readonly WidthCase[] = [
  { title: 'all roots' },
  { title: 'a 40-character package name without separators', name: FORTY_CHARACTER_NAME },
  { title: 'a 40-character name without separators under Via', direct: FORTY_CHARACTER_NAME },
  { title: 'a 40-character scoped package name', name: FORTY_CHARACTER_SCOPED_NAME },
  { title: 'a 40-character scoped name under Via', direct: FORTY_CHARACTER_SCOPED_NAME },
  { title: 'the Direct grouping', grouping: 'Direct dependency' },
  { title: 'the Direct grouping with a 40-character name', name: FORTY_CHARACTER_NAME, grouping: 'Direct dependency' },
  { title: 'the Direct grouping with a 40-character scoped name', name: FORTY_CHARACTER_SCOPED_NAME, grouping: 'Direct dependency' },
]

async function showWidenedRows(page: Page, widthCase: WidthCase): Promise<void> {
  await openWhenEnriched(page, {})
  const rowsUrl = new URL('/api/issues', tokenizedUrl()).toString()
  const { rows } = (await (await page.request.get(rowsUrl)).json()) as IssueRowsResponse
  const widened = rows.map((row) => ({
    ...row,
    name: widthCase.name ?? row.name,
    locations: row.locations.map((location) => ({
      ...location,
      via: widthCase.direct === undefined ? location.via : [{ direct: `${widthCase.direct}@1.0.0`, importers: [] }, ...location.via],
    })),
  }))
  await page.route(/\/api\/issues\?(?!.*groupBy=direct)/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, rows: widened }) }))
  await page.route(/\/api\/issues\?.*groupBy=direct/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { groups: { name: string; issues: { name: string }[] }[] }
    const groups = body.groups.map((group) => ({
      ...group,
      name: widthCase.direct ?? widthCase.name ?? group.name,
      issues: group.issues.map((issue) => ({ ...issue, name: widthCase.name ?? issue.name })),
    }))
    await route.fulfill({ response, json: { ...body, groups } })
  })
  await page.goto(pageUrl(tokenizedUrl(), {}))
  if (widthCase.grouping !== undefined) await chooseIssueGrouping(page, widthCase.grouping)
  await expect(page.getByRole('treegrid').getByTestId(widthCase.grouping === undefined ? 'issue-row' : 'issue-group-header').first()).toBeVisible()
  await expect(page.getByTestId('row-recommended').filter({ hasText: CHECKING_FIX_TEXT })).toHaveCount(0, { timeout: ENRICHMENT_TIMEOUT_MS })
}

for (const width of FITTING_WIDTHS) {
  for (const widthCase of WIDTH_CASES) {
    test(`at ${width} px with both panels open the issues table fits its panel: ${widthCase.title}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await showWidenedRows(page, widthCase)
      await expectTableFitsPanel(page)
    })
  }
}

for (const widthCase of WIDTH_CASES) {
  test(`at 1280 px with only the roots panel open the issues table fits its panel: ${widthCase.title}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await showWidenedRows(page, widthCase)
    await showOnlyRootsPanel(page)
    await expectTableFitsPanel(page)
  })
}
