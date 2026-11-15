import { expect, test, type Locator, type Page } from '@playwright/test'
import { tokenizedUrl, VARIANTS_ROOT_ID } from './global-setup.ts'
import { openExploreOptions, openMode, pageUrl } from './ui.ts'

const SEMVER_ID = 'semver@5.7.2'
const PARSER_ID = 'vue-eslint-parser@9.4.3(eslint@9.17.0)'
const IMPORTER_IDS = ['importer:commerce-ui', 'importer:storefront', 'importer:tools/build']
const BUILD_CLUSTER = 'Only in @fixture/build (2)'
const ANCHOR_CLASS = /graph-node--anchor/
const WORKSPACE_FILL = 'rgb(239, 231, 251)'

async function openGraphOnSemver(page: Page): Promise<void> {
  await page.goto(tokenizedUrl())
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('combobox', { name: 'Search packages' })
  await expect(search).toBeFocused()
  await search.fill('semver')
  await page.getByRole('option', { name: 'semver 5.7.2 in npm-package', exact: true }).click()
  await openMode(page, 'Graph')
}

function graphNode(page: Page, id: string): Locator {
  return page.locator(`[data-testid="graph-node"][data-id="${id}"]`)
}

function importerNodes(page: Page): Locator {
  return page.locator('[data-testid="graph-node"][data-kind="importer"]')
}

async function setNumber(page: Page, label: string, value: number): Promise<void> {
  const options = await openExploreOptions(page)
  const input = options.getByLabel(label, { exact: true })
  await input.fill(String(value))
  await input.press('Enter')
  await input.press('Escape')
  await expect(options).toHaveCount(0)
}

async function chooseScope(page: Page, name: 'Around the package' | 'Whole root'): Promise<void> {
  const options = await openExploreOptions(page)
  const scope = options.getByRole('radio', { name, exact: true })
  await scope.check()
  await scope.press('Escape')
  await expect(options).toHaveCount(0)
}

function searchParam(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name)
}

async function viewportTransform(page: Page): Promise<{ x: number; y: number; k: number }> {
  const transform = (await page.getByTestId('graph-viewport').getAttribute('transform')) ?? ''
  const match = /^translate\((-?[\d.e+-]+) (-?[\d.e+-]+)\) scale\(([\d.e+-]+)\)$/.exec(transform)
  if (!match) throw new Error(`Unexpected transform ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) }
}

test('the graph puts the importers of semver 5.7.2 left of it, expands a stub, selects on a single click, keeps the anchor marked and re-centers with Focus on', async ({ page }) => {
  await openGraphOnSemver(page)
  const focusNode = graphNode(page, SEMVER_ID)
  await expect(focusNode).toBeVisible()
  await expect(focusNode).toHaveAttribute('aria-current', 'true')
  await expect(focusNode).toHaveClass(ANCHOR_CLASS)
  await expect(page.getByText('Click a package to select it. Drag to pan, scroll to zoom.', { exact: true })).toBeVisible()
  const focusTitle = focusNode.locator(':scope > title')
  await expect(focusTitle).toContainText('Explore is built around this package')
  await expect(focusTitle).toContainText('Click to select')
  await expect(focusTitle).not.toContainText('Double-click')
  await expect(focusTitle).not.toContainText('@5.7.2')
  await expect(focusNode).toHaveAccessibleName('semver 5.7.2')
  await expect(focusNode).toHaveAccessibleDescription(/(^|\. )Explore is built around this package\. Click to select$/)
  const importers = importerNodes(page)
  await expect(importers).toHaveCount(3)
  expect((await importers.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')))).sort()).toEqual(IMPORTER_IDS)
  const focusBox = await focusNode.boundingBox()
  for (const importer of await importers.all()) {
    const box = await importer.boundingBox()
    expect(box!.x + box!.width).toBeLessThan(focusBox!.x)
  }

  await setNumber(page, 'Levels up', 1)
  await expect.poll(() => searchParam(page, 'up')).toBe('1')
  const nodes = page.getByTestId('graph-node')
  await expect(nodes).toHaveCount(3)
  const stubs = page.getByTestId('graph-stub')
  await expect(stubs).toHaveCount(2)
  await expect(stubs.first()).toContainText('+1 path')
  await expect(stubs.first()).not.toContainText('+1 paths')
  await expect(stubs.first()).toHaveAttribute('aria-label', /^Show \+1 path (above|below) \S/)
  await expect(stubs.first()).not.toHaveAttribute('aria-label', /@\d|\(/)

  await stubs.first().click()
  await expect.poll(() => searchParam(page, 'up')).toBe('2')
  await expect(nodes).toHaveCount(5)

  await graphNode(page, PARSER_ID).click()
  await expect.poll(() => searchParam(page, 'focus')).toBe(PARSER_ID)
  await expect(graphNode(page, PARSER_ID)).toHaveAttribute('aria-current', 'true')
  await expect(focusNode).not.toHaveAttribute('aria-current', 'true')
  await expect(focusNode).toHaveClass(ANCHOR_CLASS)
  await expect(graphNode(page, PARSER_ID)).not.toHaveClass(ANCHOR_CLASS)
  await expect(focusNode).toHaveAccessibleDescription(/Explore is built around this package/)
  await expect(graphNode(page, PARSER_ID)).toHaveAccessibleDescription('Click to select')
  expect(searchParam(page, 'at')).toBe(SEMVER_ID)
  await expect(nodes).toHaveCount(5)

  await graphNode(page, PARSER_ID).dblclick()
  expect(searchParam(page, 'at')).toBe(SEMVER_ID)
  await expect(focusNode).toHaveClass(ANCHOR_CLASS)

  await page.getByRole('button', { name: 'Focus on vue-eslint-parser 9.4.3', exact: true }).click()
  await expect.poll(() => searchParam(page, 'at')).toBe(PARSER_ID)
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Graph around vue-eslint-parser 9.4.3 in npm-package', exact: true })).toBeVisible()
  await expect(graphNode(page, PARSER_ID)).toHaveClass(ANCHOR_CLASS)
  await expect(focusNode).not.toHaveClass(ANCHOR_CLASS)
  await expect(graphNode(page, PARSER_ID)).toHaveAccessibleDescription('Explore is built around this package. Click to select')
  await expect(focusNode).not.toHaveAccessibleDescription(/Explore is built around this package/)

  await openMode(page, 'Dependencies')
  await expect(page.getByTestId('tree-row').first()).toContainText('vue-eslint-parser 9.4.3')
  expect(searchParam(page, 'focus')).toBe(PARSER_ID)
})

test('the graph fills workspace package nodes with the workspace color and package nodes without it', async ({ page }) => {
  await openGraphOnSemver(page)
  const fillOf = (node: Locator) => node.locator('.graph-node__box').evaluate((box) => box.ownerDocument.defaultView?.getComputedStyle(box).fill ?? '')
  await expect(importerNodes(page)).toHaveCount(3)
  for (const importer of await importerNodes(page).all()) expect(await fillOf(importer)).toBe(WORKSPACE_FILL)
  expect(await fillOf(graphNode(page, SEMVER_ID))).not.toBe(WORKSPACE_FILL)
})

test('without a selected package the graph is the whole root with every workspace package', async ({ page }) => {
  await page.goto(pageUrl(tokenizedUrl(), { root: 'npm-package', view: 'explore', mode: 'graph' }))
  await expect(importerNodes(page)).toHaveCount(4)
  const options = await openExploreOptions(page)
  await expect(options.getByRole('radio', { name: 'Whole root', exact: true })).toBeChecked()
  await expect(options.getByRole('radio', { name: 'Around the package', exact: true })).toBeDisabled()
})

test('the whole-root scope groups packages into clusters that expand and collapse', async ({ page }) => {
  await openGraphOnSemver(page)
  await expect(graphNode(page, SEMVER_ID)).toBeVisible()
  await chooseScope(page, 'Whole root')
  await expect(importerNodes(page)).toHaveCount(4)
  const clusterNode = page.getByRole('button', { name: `Expand ${BUILD_CLUSTER}`, exact: true })
  await expect(clusterNode).toHaveAttribute('data-testid', 'graph-cluster')
  await expect(clusterNode.locator(':scope > title')).toHaveText('Packages only @fixture/build depends on\nClick to expand')
  await expect(page.getByRole('button', { name: /^Shared by / }).first()).toBeVisible()
  await expect(graphNode(page, 'read-pkg-up@7.0.1')).toHaveCount(0)

  await clusterNode.click()
  await expect(graphNode(page, 'read-pkg-up@7.0.1')).toBeVisible()
  await expect(graphNode(page, 'normalize-package-data@2.5.0')).toBeVisible()
  await expect(clusterNode).toHaveCount(0)

  const clusterToggle = page.getByRole('button', { name: BUILD_CLUSTER, exact: true })
  await expect(clusterToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(clusterToggle).toHaveAttribute('title', 'Packages only @fixture/build depends on')
  await clusterToggle.click()
  await expect(graphNode(page, 'read-pkg-up@7.0.1')).toHaveCount(0)
  await expect(clusterNode).toHaveCount(1)
  await expect(clusterToggle).toHaveAttribute('aria-pressed', 'false')
})

test('the node limit truncates the focus graph and warns when the whole root is larger', async ({ page }) => {
  await openGraphOnSemver(page)
  await expect(graphNode(page, SEMVER_ID)).toBeVisible()
  await setNumber(page, 'Node limit', 2)
  await expect(page.getByText('Showing the first 2 nodes. Reduce the depth to see a complete graph.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('graph-node')).toHaveCount(2)

  await chooseScope(page, 'Whole root')
  await expect(page.getByText(/^Showing 2 of \d+ nodes\. Narrow the scope to see all nodes\.$/)).toBeVisible()
  await expect(page.getByTestId('graph-node')).toHaveCount(2)
})

test('the graph zooms with the wheel within its limits and pans by dragging', async ({ page }) => {
  await openGraphOnSemver(page)
  await expect(graphNode(page, SEMVER_ID)).toBeVisible()
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  const corner = { x: canvas!.x + 6, y: canvas!.y + canvas!.height - 6 }
  await page.mouse.move(corner.x, corner.y)
  for (let step = 0; step < 6; step++) await page.mouse.wheel(0, -400)
  await expect.poll(async () => (await viewportTransform(page)).k).toBe(3)
  for (let step = 0; step < 12; step++) await page.mouse.wheel(0, 400)
  await expect.poll(async () => (await viewportTransform(page)).k).toBe(0.2)

  const before = await viewportTransform(page)
  await page.mouse.down()
  await page.mouse.move(corner.x + 120, corner.y - 60, { steps: 6 })
  await page.mouse.up()
  const after = await viewportTransform(page)
  expect(after.x - before.x).toBeCloseTo(120, 5)
  expect(after.y - before.y).toBeCloseTo(-60, 5)
  expect(after.k).toBe(0.2)
})

for (const width of [1280, 1440]) {
  test(`the whole-root graph numbers the peer variants of one version and keeps their boxes apart at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(pageUrl(tokenizedUrl(), { root: VARIANTS_ROOT_ID, view: 'explore', mode: 'graph' }))
    await expect(page.getByRole('heading', { name: `Graph of ${VARIANTS_ROOT_ID}`, exact: true })).toBeVisible()
    const collapsed = page.getByTestId('graph-cluster')
    await expect(collapsed).toHaveCount(2)
    await collapsed.first().click()
    await collapsed.first().click()
    await expect(collapsed).toHaveCount(0)
    const first = page.locator('[data-testid="graph-node"][aria-label^="peer-host 1.0.0"]', { hasText: /variant 1 of 2$/ })
    const second = page.locator('[data-testid="graph-node"][aria-label^="peer-host 1.0.0"]', { hasText: /variant 2 of 2$/ })
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    const boxes = [await first.boundingBox(), await second.boundingBox()]
    const [left, right] = boxes
    if (!left || !right) throw new Error('A variant node has no box')
    const apart = left.x + left.width <= right.x || right.x + right.width <= left.x || left.y + left.height <= right.y || right.y + right.height <= left.y
    expect(apart).toBe(true)
  })
}
