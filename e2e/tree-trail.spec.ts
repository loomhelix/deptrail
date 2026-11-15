import { expect, test, type Page } from '@playwright/test'
import { LINKED_ROOT_ID, tokenizedUrl, WIDE_ROOT_DEPENDENCY_COUNT, WIDE_ROOT_ID } from './global-setup.ts'
import { exploreOptionsButton, openExploreOptions, openMode, pageUrl } from './ui.ts'

const MAX_RENDERED_ROWS = 200

function treeUrl(root?: string, anchor?: string): string {
  return pageUrl(tokenizedUrl(), { ...(root === undefined ? {} : { root }), view: 'explore', mode: 'tree', ...(anchor === undefined ? {} : { at: anchor }) })
}

function searchParam(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name)
}

async function focusFromSearch(page: Page, query: string, optionName: string): Promise<void> {
  await page.goto(treeUrl())
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('combobox', { name: 'Search packages' })
  await expect(search).toBeFocused()
  await search.fill(query)
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

test('expanding down the tree reveals the duplicate semver 5.7.2 flagged as a duplicate', async ({ page }) => {
  await focusFromSearch(page, 'eslint-plugin-vue', 'eslint-plugin-vue 9.32.0 in npm-package')
  const rows = page.getByTestId('tree-row')
  await expect(rows.first()).toContainText('eslint-plugin-vue 9.32.0')
  const parserRow = rows.filter({ hasText: 'vue-eslint-parser 9.4.3' })
  await expect(parserRow).toHaveCount(1)
  await parserRow.getByRole('button', { name: 'Expand vue-eslint-parser' }).click()
  const semverRow = rows.filter({ hasText: 'semver 5.7.2' })
  await expect(semverRow).toHaveCount(1)
  const duplicateBadge = semverRow.getByText('dup', { exact: true })
  await expect(duplicateBadge).toBeVisible()
  await expect(duplicateBadge).toHaveAttribute('title', /5\.7\.2/)
  await expect(duplicateBadge).toHaveAttribute('title', /7\.6\.3/)
  await expect(duplicateBadge).toHaveAttribute('title', /6\.3\.1/)
  await expect(rows.filter({ hasText: 'eslint 9.17.0' }).getByText('dup', { exact: true })).toHaveCount(0)
})

test('the duplicates-only filter keeps the paths to duplicates visible', async ({ page }) => {
  await focusFromSearch(page, 'eslint-plugin-vue', 'eslint-plugin-vue 9.32.0 in npm-package')
  const rows = page.getByTestId('tree-row')
  await rows.filter({ hasText: 'vue-eslint-parser 9.4.3' }).getByRole('button', { name: 'Expand vue-eslint-parser' }).click()
  await expect(rows.filter({ hasText: 'semver 5.7.2' })).toHaveCount(1)
  const options = await openExploreOptions(page)
  await options.getByRole('checkbox', { name: 'Duplicates only', exact: true }).check()
  await expect.poll(() => new URL(page.url()).searchParams.get('dup')).toBe('1')
  await expect(rows.filter({ hasText: 'semver 5.7.2' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'vue-eslint-parser 9.4.3' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'eslint 9.17.0' })).toHaveCount(0)
})

test('a root with 2 000 dependencies renders only the visible rows and scrolls to the last one', async ({ page }) => {
  await page.goto(treeUrl(WIDE_ROOT_ID))
  const rows = page.getByTestId('tree-row')
  await expect(rows.filter({ hasText: 'pkg-0000 1.0.0' })).toHaveCount(1)
  expect(await rows.count()).toBeLessThan(MAX_RENDERED_ROWS)
  const lastName = `pkg-${WIDE_ROOT_DEPENDENCY_COUNT - 1} 1.0.0`
  await expect(rows.filter({ hasText: lastName })).toHaveCount(0)
  await page.getByTestId('tree-scroller').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(rows.filter({ hasText: lastName })).toHaveCount(1)
  expect(await rows.count()).toBeLessThan(MAX_RENDERED_ROWS)
})

test('a direct dependency focus appears once in the trail', async ({ page }) => {
  await focusFromSearch(page, 'eslint-plugin-vue', 'eslint-plugin-vue 9.32.0 in npm-package')
  await openMode(page, 'Dependents')
  const columns = page.getByTestId('trail-column')
  await expect(columns.first().getByTestId('trail-chip')).toContainText(['commerce-ui', 'storefront'])
  await expect(page.getByTestId('trail-chip').filter({ hasText: 'eslint-plugin-vue 9.32.0' })).toHaveCount(1)
  await expect(page.locator('[data-testid="trail-chip"][aria-selected="true"]')).toHaveCount(1)
})

test('switching views does not reload the duplicates', async ({ page }) => {
  let duplicateRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/duplicates') duplicateRequests += 1
  })
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await expect(page.getByTestId('tree-row').first()).toBeVisible()
  await openMode(page, 'Dependents')
  await expect(page.getByTestId('trail-chip').first()).toBeVisible()
  await openMode(page, 'Dependencies')
  await openMode(page, 'Dependents')
  await expect(page.getByTestId('trail-chip').first()).toBeVisible()
  expect(duplicateRequests).toBe(1)
})

test('the trail lists the importers of semver 5.7.2 first under fixed titles, a chip click selects in place, and Focus on re-centers the trail', async ({ page }) => {
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await openMode(page, 'Dependents')
  const columns = page.getByTestId('trail-column')
  await expect(columns.getByRole('heading')).toHaveText(['Workspace packages', 'Direct dependencies', 'Via', 'This package'])
  const importers = page.getByRole('listbox', { name: 'Workspace packages', exact: true }).getByRole('option')
  await expect(importers).toHaveCount(3)
  await expect(importers).toContainText(['commerce-ui', 'storefront', 'tools/build'])
  await expect(importers.filter({ hasText: 'tools/build' })).toHaveAttribute('title', 'workspace package @fixture/build')
  const directDependencies = page.getByRole('listbox', { name: 'Direct dependencies', exact: true }).getByRole('option')
  await expect(directDependencies).toContainText(['eslint-plugin-vue 9.32.0', 'read-pkg-up 7.0.1'])
  await expect(directDependencies.filter({ hasText: 'read-pkg-up 7.0.1' })).toHaveAttribute('title', 'read-pkg-up 7.0.1')
  for (const title of await columns.getByTestId('trail-chip').evaluateAll((chips) => chips.map((chip) => chip.getAttribute('title') ?? ''))) {
    expect(title).not.toContain('importer:')
    expect(title).not.toContain('@5.7.2')
  }
  await expect(columns.getByTestId('trail-chip').filter({ hasText: 'semver 5.7.2' })).toHaveAttribute('aria-selected', 'true')
  await columns.getByTestId('trail-chip').filter({ hasText: 'vue-eslint-parser 9.4.3' }).click()
  await expect.poll(() => searchParam(page, 'focus')).toBe('vue-eslint-parser@9.4.3(eslint@9.17.0)')
  expect(searchParam(page, 'at')).toBe('semver@5.7.2')
  expect(searchParam(page, 'view')).toBe('explore')
  expect(searchParam(page, 'mode')).toBeNull()
  await expect(columns.getByTestId('trail-chip').filter({ hasText: 'vue-eslint-parser 9.4.3' })).toHaveAttribute('aria-selected', 'true')
  await expect(columns.getByTestId('trail-chip').filter({ hasText: 'semver 5.7.2' })).toHaveAttribute('aria-selected', 'false')
  await expect(columns.getByRole('heading')).toHaveText(['Workspace packages', 'Direct dependencies', 'Via', 'This package'])
  await expect(page.getByRole('listbox', { name: 'This package', exact: true }).getByRole('option')).toContainText(['semver 5.7.2'])
  await expect(importers).toHaveCount(3)

  await page.getByRole('button', { name: 'Focus on vue-eslint-parser 9.4.3', exact: true }).click()
  await expect.poll(() => searchParam(page, 'at')).toBe('vue-eslint-parser@9.4.3(eslint@9.17.0)')
  await expect(columns.last().getByTestId('trail-chip')).toContainText(['eslint 9.17.0', 'semver 5.7.2'])
})

test('workspace packages are workspace pills in the trail and the tree overview', async ({ page }) => {
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await openMode(page, 'Dependents')
  const importers = page.getByRole('listbox', { name: 'Workspace packages', exact: true }).getByRole('option')
  await expect(importers).toHaveCount(3)
  await expect(importers.getByTestId('workspace-name')).toHaveText(['@fixture/commerce-ui', '@fixture/storefront', '@fixture/build'])
  await expect(page.getByRole('listbox', { name: 'Direct dependencies', exact: true }).getByTestId('workspace-name')).toHaveCount(0)
  await expect(page.getByRole('listbox', { name: 'This package', exact: true }).getByTestId('workspace-name')).toHaveCount(0)

  await page.goto(treeUrl('npm-package'))
  const rows = page.getByTestId('tree-row')
  const buildRow = rows.filter({ hasText: '@fixture/build' })
  await expect(buildRow.getByTestId('workspace-name')).toHaveCount(1)
  await buildRow.getByRole('button', { name: 'Expand @fixture/build' }).click()
  const readerRow = rows.filter({ hasText: 'read-pkg-up 7.0.1' })
  await expect(readerRow).toBeVisible()
  await expect(readerRow.getByTestId('workspace-name')).toHaveCount(0)
})

test('hovering or focusing a trail chip highlights the paths through it', async ({ page }) => {
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await openMode(page, 'Dependents')
  const chips = page.getByTestId('trail-chip')
  const onPath = /trail__chip--on-path/
  const build = chips.filter({ hasText: 'tools/build' })
  await build.hover()
  for (const label of ['tools/build', 'read-pkg-up 7.0.1', 'normalize-package-data 2.5.0', 'semver 5.7.2']) {
    await expect(chips.filter({ hasText: label })).toHaveClass(onPath)
  }
  for (const label of ['commerce-ui', 'eslint-plugin-vue 9.32.0', 'vue-eslint-parser 9.4.3']) {
    await expect(chips.filter({ hasText: label })).not.toHaveClass(onPath)
  }

  await page.mouse.move(0, 0)
  await expect(chips.filter({ hasText: 'read-pkg-up 7.0.1' })).not.toHaveClass(onPath)
  await chips.filter({ hasText: 'eslint-plugin-vue 9.32.0' }).focus()
  for (const label of ['commerce-ui', 'storefront', 'eslint-plugin-vue 9.32.0', 'vue-eslint-parser 9.4.3', 'semver 5.7.2']) {
    await expect(chips.filter({ hasText: label })).toHaveClass(onPath)
  }
  await expect(chips.filter({ hasText: 'read-pkg-up 7.0.1' })).not.toHaveClass(onPath)
})

test('the arrow keys move through each trail column and between columns along the paths, and Enter selects without moving the anchor', async ({ page }) => {
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await openMode(page, 'Dependents')
  const chips = page.getByTestId('trail-chip')
  const chip = (label: string) => chips.filter({ hasText: label })
  await expect(chip('semver 5.7.2')).toHaveAttribute('tabindex', '0')
  await expect(page.locator('[data-testid="trail-chip"][tabindex="0"]')).toHaveCount(1)

  await chip('semver 5.7.2').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(chip('normalize-package-data 2.5.0')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(chip('vue-eslint-parser 9.4.3')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(chip('eslint-plugin-vue 9.32.0')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(chip('commerce-ui')).toBeFocused()
  await page.keyboard.press('End')
  await expect(chip('tools/build')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(chip('read-pkg-up 7.0.1')).toBeFocused()
  await expect(page.locator('[data-testid="trail-chip"][tabindex="0"]')).toHaveCount(1)

  await page.keyboard.press('Enter')
  await expect.poll(() => searchParam(page, 'focus')).toBe('read-pkg-up@7.0.1')
  expect(searchParam(page, 'at')).toBe('semver@5.7.2')
  await expect(chip('read-pkg-up 7.0.1')).toHaveAttribute('aria-selected', 'true')
  await expect(chip('read-pkg-up 7.0.1')).toBeFocused()
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Dependents of semver 5.7.2 in npm-package', exact: true })).toBeVisible()
})

test('the trail without an anchor explains how to start, and points to Focus on when a package is selected', async ({ page }) => {
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package', view: 'explore' }))
  const explore = page.getByRole('tabpanel')
  await expect(explore.getByText('Select a package to see its dependents.', { exact: true })).toBeVisible()

  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package', focus: 'read-pkg-up@7.0.1', view: 'explore' }))
  await expect(explore.getByText('read-pkg-up 7.0.1 is selected. Focus on it to see its dependents.', { exact: true })).toBeVisible()
  await expect(explore.getByText('Select a package to see its dependents.', { exact: true })).toHaveCount(0)
  await explore.getByRole('button', { name: 'Focus on read-pkg-up 7.0.1', exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'This package', exact: true }).getByRole('option')).toContainText(['read-pkg-up 7.0.1'])
})

test('the tree overview lists the workspace packages, a click selects in place and the arrow keys move through the tree', async ({ page }) => {
  await page.goto(treeUrl('npm-package'))
  const explore = page.getByRole('tabpanel')
  await expect(explore.getByRole('heading', { name: 'Overview of npm-package', exact: true })).toBeVisible()
  const tree = explore.getByRole('tree', { name: 'Dependencies' })
  const topLevel = tree.getByRole('treeitem', { level: 1 })
  await expect(topLevel).toHaveCount(4)
  await expect(topLevel.first()).toContainText('npm-package')
  await expect(topLevel).toContainText(['npm-package', '@fixture/commerce-ui', '@fixture/storefront', '@fixture/build'])
  await expect(topLevel.filter({ hasText: '@fixture/build' })).toHaveAttribute('aria-expanded', 'false')

  const rows = page.getByTestId('tree-row')
  const buildRow = rows.filter({ hasText: '@fixture/build' })
  await buildRow.getByRole('button', { name: 'Expand @fixture/build' }).click()
  const readerRow = rows.filter({ hasText: 'read-pkg-up 7.0.1' })
  await expect(readerRow).toContainText('requires ^7.0.1')
  await expect(readerRow).toHaveAttribute('aria-level', '2')

  await readerRow.click()
  await expect.poll(() => searchParam(page, 'focus')).toBe('read-pkg-up@7.0.1')
  expect(searchParam(page, 'at')).toBeNull()
  await expect(readerRow).toHaveAttribute('aria-selected', 'true')
  await expect(readerRow).toBeFocused()
  await expect(topLevel).toHaveCount(4)
  await expect(explore.getByRole('heading', { name: 'Overview of npm-package', exact: true })).toBeVisible()
  await expect(explore.getByRole('button', { name: 'Focus on read-pkg-up 7.0.1', exact: true })).toBeVisible()

  await page.keyboard.press('ArrowRight')
  const normalizeRow = rows.filter({ hasText: 'normalize-package-data 2.5.0' })
  await expect(normalizeRow).toHaveCount(1)
  await expect(normalizeRow).not.toContainText('requires')
  await page.keyboard.press('ArrowLeft')
  await expect(normalizeRow).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(buildRow).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(buildRow).toHaveAttribute('aria-expanded', 'false')
  await expect(readerRow).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(buildRow).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(readerRow).toBeFocused()
  await page.keyboard.press('Home')
  await expect(topLevel.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect.poll(() => searchParam(page, 'focus')).toBe('importer:commerce-ui')
  expect(searchParam(page, 'at')).toBeNull()
  await expect(topLevel.filter({ hasText: '@fixture/commerce-ui' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-testid="tree-row"][tabindex="0"]')).toHaveCount(1)
})

test('in the tree overview a workspace package that another one depends on expands only in its own top-level row', async ({ page }) => {
  await page.goto(treeUrl(LINKED_ROOT_ID))
  const tree = page.getByRole('tabpanel').getByRole('tree', { name: 'Dependencies' })
  const topLevel = tree.getByRole('treeitem', { level: 1 })
  await expect(topLevel).toHaveCount(3)
  await expect(topLevel).toContainText(['@linked/web', '@linked/tokens', '@linked/ui'])
  const topWeb = topLevel.filter({ hasText: '@linked/web' })
  const topUi = topLevel.filter({ hasText: '@linked/ui' })
  const nested = tree.getByRole('treeitem', { level: 2 })

  await topWeb.getByRole('button', { name: 'Expand @linked/web', exact: true }).click()
  const nestedUi = nested.filter({ hasText: '@linked/ui' })
  await expect(nestedUi).toContainText('workspace package, listed below')
  await expect(nestedUi).not.toHaveAttribute('aria-expanded')
  await expect(nestedUi.getByRole('button')).toHaveCount(0)
  await expect(topUi).toHaveAttribute('aria-expanded', 'false')

  await topUi.getByRole('button', { name: 'Expand @linked/ui', exact: true }).click()
  await expect(topUi).toHaveAttribute('aria-expanded', 'true')
  await expect(topUi).not.toContainText('shown above')
  const nestedTokens = nested.filter({ hasText: '@linked/tokens' })
  await expect(nestedTokens).toContainText('workspace package, listed above')
  await expect(nested).toHaveCount(2)
  await expect(nestedUi).not.toHaveAttribute('aria-expanded')
  await expect(topWeb).toHaveAttribute('aria-expanded', 'true')

  await topUi.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(topUi).toHaveAttribute('aria-expanded', 'false')
  await expect(nestedTokens).toHaveCount(0)
  await expect(nestedUi).toHaveCount(1)
})

test('a tree click on a package selects it while the tree stays on its anchor', async ({ page }) => {
  await focusFromSearch(page, 'eslint-plugin-vue', 'eslint-plugin-vue 9.32.0 in npm-package')
  const rows = page.getByTestId('tree-row')
  const parserRow = rows.filter({ hasText: 'vue-eslint-parser 9.4.3' })
  await parserRow.click()
  await expect.poll(() => searchParam(page, 'focus')).toBe('vue-eslint-parser@9.4.3(eslint@9.17.0)')
  expect(searchParam(page, 'at')).toBe('eslint-plugin-vue@9.32.0(eslint@9.17.0)')
  await expect(rows.first()).toContainText('eslint-plugin-vue 9.32.0')
  await expect(parserRow).toHaveAttribute('aria-selected', 'true')
  await expect(parserRow).not.toContainText('requires')
})

test('Options opens with the keyboard, holds Duplicates only, and Escape closes it back onto its button', async ({ page }) => {
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await openMode(page, 'Dependents')
  await expect(page.getByTestId('trail-chip').first()).toBeVisible()
  const button = exploreOptionsButton(page)
  await button.focus()
  await page.keyboard.press('Enter')
  const options = page.getByRole('dialog', { name: 'Options', exact: true })
  const duplicatesOnly = options.getByRole('checkbox', { name: 'Duplicates only', exact: true })
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(duplicatesOnly).toBeFocused()
  await expect(options.getByLabel('Levels up', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Space')
  await expect(duplicatesOnly).toBeChecked()
  await expect.poll(() => new URL(page.url()).searchParams.get('dup')).toBe('1')
  await page.keyboard.press('Escape')
  await expect(options).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('navigation', { name: 'Roots' }).getByRole('checkbox', { name: 'Duplicates only' })).toHaveCount(0)
})

test('a conflict answer from a root that is rebuilding is not shown as an error and the tree recovers', async ({ page }) => {
  let childrenRequests = 0
  await page.route(/\/api\/roots\/[^/]+\/nodes\/[^/]+\/children/, async (route) => {
    childrenRequests += 1
    if (childrenRequests === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Root npm-package is scanning' }) })
      return
    }
    await route.continue()
  })
  await page.goto(treeUrl('npm-package', 'importer:.'))
  await expect(page.getByTestId('tree-row').filter({ hasText: 'semver 7.6.3' })).toHaveCount(1)
  expect(childrenRequests).toBeGreaterThan(1)
  await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveCount(0)
})

test('a conflict answer while a row of the tree overview expands keeps every expanded row open and loads them once the root is ready', async ({ page }) => {
  let childrenRequests = 0
  await page.route(/\/api\/roots\/[^/]+\/nodes\/[^/]+\/children/, async (route) => {
    childrenRequests += 1
    if (childrenRequests === 2) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Root npm-package is scanning' }) })
      return
    }
    await route.continue()
  })
  await page.goto(treeUrl('npm-package'))
  const explore = page.getByRole('tabpanel')
  const tree = explore.getByRole('tree', { name: 'Dependencies' })
  const topLevel = tree.getByRole('treeitem', { level: 1 })
  const buildRow = topLevel.filter({ hasText: '@fixture/build' })
  const commerceRow = topLevel.filter({ hasText: '@fixture/commerce-ui' })
  const nested = tree.getByRole('treeitem', { level: 2 })

  await buildRow.getByRole('button', { name: 'Expand @fixture/build', exact: true }).click()
  await expect(nested.filter({ hasText: 'read-pkg-up 7.0.1' })).toHaveCount(1)
  const buildChildren = await nested.count()
  await commerceRow.getByRole('button', { name: 'Expand @fixture/commerce-ui', exact: true }).click()

  await expect.poll(() => childrenRequests).toBeGreaterThan(2)
  await expect(buildRow).toHaveAttribute('aria-expanded', 'true')
  await expect(commerceRow).toHaveAttribute('aria-expanded', 'true')
  await expect(nested.filter({ hasText: 'read-pkg-up 7.0.1' })).toHaveCount(1)
  await expect.poll(() => nested.count()).toBeGreaterThan(buildChildren)
  await expect(explore.getByRole('alert')).toHaveCount(0)
  await expect(explore.getByText('failed to load', { exact: true })).toHaveCount(0)
})

test('the closed Options button names Duplicates only while it is on', async ({ page }) => {
  await focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
  await openMode(page, 'Dependents')
  const button = exploreOptionsButton(page)
  await expect(button).toHaveText('Options')
  const options = await openExploreOptions(page)
  await options.getByRole('checkbox', { name: 'Duplicates only', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(options).toHaveCount(0)
  await expect(button).toHaveText('Options · Duplicates only')
  await expect(page.getByRole('button', { name: 'Options · Duplicates only', exact: true })).toBeVisible()
})
