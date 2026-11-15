import { expect, test, type Page } from '@playwright/test'
import type { ScanSummary } from '../src/server/router.ts'
import { tokenizedUrl } from './global-setup.ts'
import { details, mode, openMode, pageUrl, tab } from './ui.ts'

const SEMVER_PARENTS = ['normalize-package-data 2.5.0', 'vue-eslint-parser 9.4.3']

async function focusFromSearch(page: Page, query: string, optionName: string): Promise<void> {
  await page.goto(tokenizedUrl())
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('combobox', { name: 'Search packages' })
  await expect(search).toBeFocused()
  await search.fill(query)
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

function focusSemver572(page: Page): Promise<void> {
  return focusFromSearch(page, 'semver', 'semver 5.7.2 in npm-package')
}

function whyHereParents(page: Page) {
  return details(page).getByRole('region', { name: 'Dependents' }).getByTestId('why-here-row').getByRole('button')
}

test('the header names the scanned repository by its directory, a monorepo', async ({ page }) => {
  await page.goto(tokenizedUrl())
  const header = page.getByRole('banner')
  await expect(header.getByText('monorepo', { exact: true })).toBeVisible()
  await expect(header).not.toContainText('monolith')
})

test('has no source switcher outside a git repository', async ({ page }) => {
  const gitInfo = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/git')
  await page.goto(tokenizedUrl())
  expect(await (await gitInfo).json()).toEqual({ available: false, reason: 'This directory is not in a git repository', quiet: true })
  const header = page.getByRole('banner')
  await expect(header.getByRole('button', { name: /^Root: / })).toBeVisible()
  await expect(header.getByRole('button', { name: /^Source: / })).toHaveCount(0)
  await expect(header.getByText('Branches unavailable', { exact: true })).toHaveCount(0)
})

test('search picks a version and the details panel lists its dependents', async ({ page }) => {
  await focusSemver572(page)
  const panel = details(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('semver 5.7.2')
  await expect(panel.getByTestId('root-badge')).toHaveText('npm-package')
  await expect(whyHereParents(page)).toHaveText(SEMVER_PARENTS)
  await panel.getByTestId('details-more').getByText('More', { exact: true }).click()
  await expect(panel.getByRole('link', { name: 'npm', exact: true })).toHaveAttribute('href', 'https://www.npmjs.com/package/semver')
  const url = new URL(page.url())
  expect(url.searchParams.get('in')).toBe('npm-package')
  expect(url.searchParams.get('focus')).toBe('semver@5.7.2')
})

test('a manifest-only root shows its badge and the resolve button, a lockfile root shows neither', async ({ page }) => {
  await page.goto(tokenizedUrl())
  const roots = page.getByRole('navigation', { name: 'Roots' })
  const manifestOnly = roots.getByRole('treeitem', { name: 'scripts/release', exact: true })
  await expect(manifestOnly.getByText('manifest only', { exact: true })).toBeVisible()
  await expect(manifestOnly.getByRole('button', { name: 'Resolve versions' })).toBeVisible()
  const lockfile = roots.getByRole('treeitem', { name: 'npm-package', exact: true })
  await expect(lockfile.getByText('pnpm', { exact: true })).toBeVisible()
  await expect(lockfile.getByText('lockfile', { exact: true })).toHaveCount(0)
  await expect(lockfile.getByRole('button', { name: 'Resolve versions' })).toHaveCount(0)
})

test('the roots panel lists the root package.json only when it has dependencies and shows a path that differs from the name', async ({
  page,
}) => {
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package' }))
  const tree = page.getByRole('navigation', { name: 'Roots' }).getByRole('tree', { name: 'Roots' })
  const npmPackage = tree.getByRole('treeitem', { name: 'npm-package', exact: true })
  await expect(npmPackage).toHaveAttribute('aria-expanded', 'true')
  await expect(npmPackage).toHaveAttribute('aria-current', 'true')
  const packages = tree.getByRole('treeitem', { level: 2 })
  await expect(packages).toHaveCount(4)
  await expect(packages.first()).toHaveAccessibleName('(root)')
  const build = tree.getByRole('treeitem', { name: '@fixture/build', exact: true })
  await expect(build.getByText('tools/build', { exact: true })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'services/api', exact: true })).toHaveAttribute('aria-expanded', 'false')
})

test('the roots panel shows a long workspace package name and path in full', async ({ page }) => {
  const longName = '@fixture/a-workspace-package-with-a-really-long-name'
  const longPath = 'npm-package/tools/a-really-long-directory-name/with-several/levels-below-it'
  await page.route('**/api/scan', async (route) => {
    const response = await route.fetch()
    const scan = (await response.json()) as ScanSummary
    const roots = scan.roots.map((root) =>
      root.id !== 'npm-package'
        ? root
        : { ...root, importers: root.importers.map((importer) => (importer.id === 'importer:tools/build' ? { ...importer, name: longName, path: longPath } : importer)) },
    )
    await route.fulfill({ response, json: { ...scan, roots } })
  })
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package' }))
  const row = page.getByRole('navigation', { name: 'Roots' }).getByRole('treeitem', { name: longName, exact: true })
  await expect(row).toContainText('a-really-long-directory-name')
  const clipped = await row.evaluate((element) => [...element.querySelectorAll('span')].filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.textContent))
  expect(clipped).toEqual([])
})

test('the roots panel shows the path of a workspace package outside its root relative to the root', async ({ page }) => {
  await page.route('**/api/scan', async (route) => {
    const response = await route.fetch()
    const scan = (await response.json()) as ScanSummary
    const roots = scan.roots.map((root) =>
      root.id !== 'npm-package'
        ? root
        : { ...root, importers: root.importers.map((importer) => (importer.id === 'importer:tools/build' ? { ...importer, path: 'shared/build-tools' } : importer)) },
    )
    await route.fulfill({ response, json: { ...scan, roots } })
  })
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package' }))
  const row = page.getByRole('navigation', { name: 'Roots' }).getByRole('treeitem', { name: '@fixture/build', exact: true })
  await expect(row).toContainText('../shared/build-tools')
})

test('a separator in also in stays on the line of the root before it', async ({ page }) => {
  const otherRoots = ['application/commerce-web-enterprise/dev/npm-package', 'frontend/storefront-nuxt-with-a-long-name', 'tools/one-more-root']
  await page.route(/\/api\/search\?/, async (route) => {
    const response = await route.fetch()
    const hits = (await response.json()) as { name: string; versions: { version: string; roots: { rootId: string; nodeId: string }[] }[] }[]
    const widened = hits.map((hit) =>
      hit.name !== 'semver'
        ? hit
        : {
            ...hit,
            versions: hit.versions.map((entry) =>
              entry.version !== '5.7.2' ? entry : { ...entry, roots: [...entry.roots, ...otherRoots.map((rootId) => ({ rootId, nodeId: 'semver@5.7.2' }))] },
            ),
          },
    )
    await route.fulfill({ response, json: widened })
  })
  await focusSemver572(page)
  const alsoIn = details(page).getByTestId('also-in')
  await expect(alsoIn).toContainText('tools/one-more-root')
  const commasAwayFromTheirRoot = await alsoIn.evaluate((element) => {
    const page = element.ownerDocument
    const textNodesOnly = 4
    const walker = page.createTreeWalker(element, textNodesOnly)
    const characters: { node: NonNullable<ReturnType<typeof walker.nextNode>>; index: number }[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? ''
      for (let index = 0; index < text.length; index++) if (text[index]?.trim() !== '') characters.push({ node, index })
    }
    const rectOf = ({ node, index }: (typeof characters)[number]) => {
      const range = page.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      return range.getBoundingClientRect()
    }
    return characters.flatMap((character, position) => {
      const previous = characters[position - 1]
      if (character.node.textContent?.[character.index] !== ',' || previous === undefined) return []
      const comma = rectOf(character)
      const before = rectOf(previous)
      return Math.abs(comma.top - before.top) > before.height / 2 ? [previous.node.textContent ?? ''] : []
    })
  })
  expect(commasAwayFromTheirRoot).toEqual([])
})

test('the details header keeps the peer suffix of the only variant in its title and names a variant among several', async ({ page }) => {
  const parser = 'vue-eslint-parser@9.4.3(eslint@9.17.0)'
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package', focus: parser }))
  const heading = details(page).getByRole('heading', { level: 2, name: 'vue-eslint-parser 9.4.3' })
  await expect(heading).toHaveAttribute('title', '(eslint@9.17.0)')
  await expect(details(page).getByText('(eslint@9.17.0)', { exact: true })).toHaveCount(0)

  await page.route(/\/api\/search\?/, async (route) => {
    const response = await route.fetch()
    const hits = (await response.json()) as { name: string; versions: { version: string; roots: { rootId: string; nodeId: string }[] }[] }[]
    const withSecondVariant = hits.map((hit) =>
      hit.name !== 'vue-eslint-parser'
        ? hit
        : { ...hit, versions: hit.versions.map((entry) => ({ ...entry, roots: [...entry.roots, { rootId: 'npm-package', nodeId: 'vue-eslint-parser@9.4.3(eslint@8.0.0)' }] })) },
    )
    await route.fulfill({ response, json: withSecondVariant })
  })
  await page.reload()
  await expect(details(page).getByText('variant 2 of 2 (eslint 9.17.0)', { exact: true })).toBeVisible()
})

test('reloading the page keeps the focus', async ({ page }) => {
  await focusSemver572(page)
  const panel = details(page)
  await expect(whyHereParents(page)).toHaveText(SEMVER_PARENTS)
  await page.reload()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('semver 5.7.2')
  await expect(whyHereParents(page)).toHaveText(SEMVER_PARENTS)
})

test('switching views keeps the focus', async ({ page }) => {
  await focusSemver572(page)
  await openMode(page, 'Graph')
  await expect(page.locator('[data-testid="graph-node"][data-id="semver@5.7.2"]')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('view')).toBe('explore')
  expect(new URL(page.url()).searchParams.get('mode')).toBe('graph')
  expect(new URL(page.url()).searchParams.get('focus')).toBe('semver@5.7.2')
  await openMode(page, 'Dependencies')
  await expect(page.getByTestId('tree-row').first()).toContainText('semver 5.7.2')
  await expect(details(page).getByRole('heading', { level: 2 })).toHaveText('semver 5.7.2')
})

test('Dependents names each parent with its range and the workspace packages above it, and opens Explore', async ({ page }) => {
  await focusFromSearch(page, 'eslint', 'eslint 9.17.0 in npm-package')
  const panel = details(page)
  const whyHere = panel.getByRole('region', { name: 'Dependents' })
  await expect(whyHere.getByTestId('why-here-row')).toHaveText([
    'eslint-plugin-vue 9.32.0 requires ^8.57.0 || ^9.0.0 · from @fixture/commerce-ui, @fixture/storefront',
    'vue-eslint-parser 9.4.3 requires >=6.0.0 · from @fixture/commerce-ui, @fixture/storefront',
  ])
  for (const removed of ['Upward tree', 'Requested ranges', 'Versions in the monolith']) {
    await expect(panel.getByRole('region', { name: removed })).toHaveCount(0)
  }

  await whyHere.getByRole('button', { name: 'Open in Explore', exact: true }).click()
  await expect(tab(page, 'Explore')).toHaveAttribute('aria-selected', 'true')
  await expect(mode(page, 'Dependents')).toHaveAttribute('aria-checked', 'true')
  expect(new URL(page.url()).searchParams.get('at')).toBe('eslint@9.17.0')

  await whyHere.getByRole('button', { name: 'vue-eslint-parser 9.4.3', exact: true }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('vue-eslint-parser 9.4.3')
  await expect(whyHere.getByTestId('why-here-row')).toHaveText(['eslint-plugin-vue 9.32.0 requires ^9.4.3 · from @fixture/commerce-ui, @fixture/storefront'])
})

test('an error appears in a banner at the top of the center, not in the roots panel', async ({ page }) => {
  await page.route(/\/api\/rescan(\?|$)/, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the disk is read-only' }) }),
  )
  await page.goto(tokenizedUrl())
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rescan files', exact: true }).click()
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Could not start a rescan: the disk is read-only')
  await expect(page.getByRole('navigation', { name: 'Roots' }).getByRole('alert')).toHaveCount(0)
})

test('the kinds chip is announced with its subject', async ({ page }) => {
  await page.goto(pageUrl(tokenizedUrl(), { kinds: 'prod,optional,peer' }))
  const chip = page.getByRole('banner').locator('.kinds-chip__text')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText(/^Dependency types: without dev$/)
})

test('clicking a health link in the roots panel makes its row the active row', async ({ page }) => {
  await page.goto(tokenizedUrl())
  const roots = page.getByRole('navigation', { name: 'Roots' })
  const rowWithLink = roots.getByRole('treeitem').filter({ has: page.locator('.root__link') }).first()
  await expect(rowWithLink).toBeVisible()
  const rowName = await rowWithLink.getAttribute('aria-labelledby')
  const link = rowWithLink.locator('.root__link').first()
  await link.click()
  const activeRows = roots.locator('[role="treeitem"][tabindex="0"]')
  await expect(activeRows).toHaveCount(1)
  await expect(activeRows.first().locator('.root__title')).toHaveText(await page.locator(`[id="${rowName}"]`).innerText())
})

test('the details panel toggle shows up and down chevrons below 820 px and sideways ones above', async ({ page }) => {
  const toggleIconPath = (name: RegExp) => page.getByRole('complementary', { name: 'Package details' }).getByRole('button', { name }).locator('path')
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto(tokenizedUrl())
  await expect(toggleIconPath(/^Show /)).toHaveAttribute('d', 'm18 15-6-6-6 6')
  await toggleIconPath(/^Show /).click()
  await expect(toggleIconPath(/^Hide /)).toHaveAttribute('d', 'm6 9 6 6 6-6')
  await toggleIconPath(/^Hide /).click()
  await expect(toggleIconPath(/^Show /)).toHaveAttribute('d', 'm18 15-6-6-6 6')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(toggleIconPath(/^Show /)).toHaveAttribute('d', 'm11 17-5-5 5-5M18 17l-5-5 5-5')
})
