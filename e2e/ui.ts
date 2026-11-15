import type { Locator, Page } from '@playwright/test'
import type { PackageInsight } from '../src/query/package-insight.ts'

export type TabName = 'Issues' | 'Changes' | 'Explore'
export type ModeName = 'Dependents' | 'Dependencies' | 'Graph'

export function pageUrl(base: string, params: Readonly<Record<string, string>> = {}): string {
  const url = new URL(base)
  const search = new URLSearchParams(url.search)
  for (const [name, value] of Object.entries(params)) search.set(name, value)
  url.search = search.toString()
  return url.toString()
}

export function tab(page: Page, name: TabName): Locator {
  return page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: new RegExp(`^${name}( \\d[\\d,]*)?$`) })
}

export async function openTab(page: Page, name: TabName): Promise<void> {
  await tab(page, name).click()
}

export function mode(page: Page, name: ModeName): Locator {
  return page.getByRole('radiogroup', { name: 'Explore mode' }).getByRole('radio', { name, exact: true })
}

export async function openMode(page: Page, name: ModeName): Promise<void> {
  await openTab(page, 'Explore')
  await mode(page, name).click()
}

export async function chooseRoot(page: Page, label: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: /^Root: / }).click()
  await page.getByRole('menu').getByRole('menuitemradio', { name: label, exact: true }).click()
}

export function detailsLandmark(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Package details' })
}

export function details(page: Page): Locator {
  return detailsLandmark(page).getByTestId('details-body')
}

export type IssueGroupingName = 'Package' | 'Direct dependency'

export function viewMenuButton(page: Page): Locator {
  return page.getByRole('main').getByRole('button', { name: 'View', exact: true })
}

export function viewMenu(page: Page): Locator {
  return page.getByRole('menu', { name: 'View' })
}

export function issueGrouping(page: Page, name: IssueGroupingName): Locator {
  return viewMenu(page).getByRole('menuitemradio', { name, exact: true })
}

export async function chooseIssueGrouping(page: Page, name: IssueGroupingName): Promise<void> {
  await viewMenuButton(page).click()
  await issueGrouping(page, name).click()
}

export function exploreOptionsButton(page: Page): Locator {
  return page.getByRole('tabpanel').getByRole('button', { name: /^Options( · Duplicates only)?$/ })
}

export async function openExploreOptions(page: Page): Promise<Locator> {
  const button = exploreOptionsButton(page)
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  return page.getByRole('dialog', { name: 'Options', exact: true })
}

const STALE_CHECK_AGE_MS = 2 * 60 * 60 * 1000
const INSIGHT_REQUEST = /\/api\/roots\/[^/]+\/nodes\/[^/]+\/insight(\?|$)/
export const STALE_REGISTRY_NOTICE = 'Registry data is from 2 hours ago; the last check failed.'
export const FAILED_OSV_NOTICE = 'Could not check OSV: the request timed out.'

export async function routeStaleAndFailedChecks(page: Page): Promise<void> {
  await page.route(INSIGHT_REQUEST, async (route) => {
    const response = await route.fetch()
    const insight = (await response.json()) as PackageInsight
    const registry: PackageInsight['registry'] = { ...insight.registry, state: 'stale', fetchedAt: new Date(Date.now() - STALE_CHECK_AGE_MS).toISOString() }
    const vulnerabilities: PackageInsight['vulnerabilities'] = { ...insight.vulnerabilities, state: 'failed', message: 'the request timed out' }
    await route.fulfill({ response, json: { ...insight, registry, vulnerabilities } })
  })
}

export interface TableColumnWidth {
  readonly header: string
  readonly width: number
  readonly scrollWidth: number
}

export interface IssueTableSizes {
  readonly table: number
  readonly tableScrollWidth: number
  readonly panel: number
  readonly panelClientWidth: number
  readonly columns: readonly TableColumnWidth[]
}

const TEXT_LINE_GAP_PX = 8

type TextRange = { selectNodeContents(target: unknown): void; getClientRects(): ArrayLike<{ bottom: number; width: number }> }
type TextNode = { textContent: string | null }
type CharacterRange = { setStart(node: TextNode, offset: number): void; setEnd(node: TextNode, offset: number): void; getBoundingClientRect(): { bottom: number } }
type TextDocument = { createTreeWalker(root: unknown, filter: number): { nextNode(): TextNode | null }; createRange(): CharacterRange }

type Box = { top: number; bottom: number; left: number; right: number }
type LocationElement = {
  textContent: string | null
  ownerDocument: { createRange(): { selectNodeContents(target: unknown): void; getBoundingClientRect(): Box } }
  querySelector(selector: string): LocationElement | null
  getBoundingClientRect(): Box
}

export async function locationOverlaps(page: Page): Promise<string[]> {
  return page.getByTestId('issue-location').evaluateAll((locations: LocationElement[]) =>
    locations.flatMap((location) => {
      const label = location.querySelector('[data-testid="location-label"]')
      const via = location.querySelector('[data-testid="via-list"]')
      if (label === null || via === null) return []
      const range = label.ownerDocument.createRange()
      range.selectNodeContents(label)
      const labelBox = range.getBoundingClientRect()
      const viaBox = via.getBoundingClientRect()
      const sharesLine = viaBox.top < labelBox.bottom - 1
      return sharesLine && labelBox.right > viaBox.left + 1 ? [label.textContent ?? ''] : []
    }),
  )
}

export type ViaBreaks = { linesStartingWithComma: number; prefixAlone: boolean }

const SHOW_TEXT = 4

export async function viaBreaks(list: Locator): Promise<ViaBreaks> {
  return list.evaluate(
    (element, { lineGap, showText }) => {
      const owner: { ownerDocument: TextDocument } = element
      const doc = owner.ownerDocument
      const walker = doc.createTreeWalker(element, showText)
      const texts: TextNode[] = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if ((node.textContent ?? '').trim() !== '') texts.push(node)
      const bottomOf = (node: TextNode, offset: number) => {
        const range = doc.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        return range.getBoundingClientRect().bottom
      }
      const lastOf = (node: TextNode) => (node.textContent ?? '').length - 1
      const startsLine = (node: TextNode, previous: TextNode) => Math.abs(bottomOf(node, 0) - bottomOf(previous, lastOf(previous))) > lineGap
      const linesStartingWithComma = texts.filter((node, index) => index > 0 && (node.textContent ?? '').startsWith(',') && startsLine(node, texts[index - 1])).length
      const [prefix, firstName] = texts
      const prefixAlone = prefix !== undefined && firstName !== undefined && startsLine(firstName, prefix)
      return { linesStartingWithComma, prefixAlone }
    },
    { lineGap: TEXT_LINE_GAP_PX, showText: SHOW_TEXT },
  )
}

export async function textLineCount(locator: Locator): Promise<number> {
  return locator.evaluate((element, lineGap) => {
    const owner: { ownerDocument: { createRange(): TextRange } } = element
    const range = owner.ownerDocument.createRange()
    range.selectNodeContents(element)
    const bottoms = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0)
      .map((rect) => rect.bottom)
      .sort((left, right) => left - right)
    return bottoms.filter((bottom, index) => index === 0 || bottom - bottoms[index - 1] > lineGap).length
  }, TEXT_LINE_GAP_PX)
}

export async function measureIssueTables(page: Page): Promise<IssueTableSizes[]> {
  return page.locator('table, [role="treegrid"]').evaluateAll((elements) =>
    elements.map((element) => {
      const panel = element.parentElement
      return {
        table: element.getBoundingClientRect().width,
        tableScrollWidth: element.scrollWidth,
        panel: panel?.getBoundingClientRect().width ?? 0,
        panelClientWidth: panel?.clientWidth ?? 0,
        columns: [...element.querySelectorAll('thead th')].map((cell) => ({
          header: (cell.textContent ?? '').trim(),
          width: cell.getBoundingClientRect().width,
          scrollWidth: cell.scrollWidth,
        })),
      }
    }),
  )
}

export async function expectTableFitsPanel(page: Page): Promise<void> {
  const tables = await measureIssueTables(page)
  if (tables.length === 0) throw new Error('the page has no table to measure')
  for (const sizes of tables) {
    const report = JSON.stringify(sizes.columns)
    if (sizes.tableScrollWidth > sizes.panelClientWidth) throw new Error(`table scrollWidth ${sizes.tableScrollWidth} exceeds panel clientWidth ${sizes.panelClientWidth}: ${report}`)
    if (sizes.table > sizes.panel) throw new Error(`table width ${sizes.table} exceeds panel width ${sizes.panel}: ${report}`)
  }
}

export async function showOnlyRootsPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hide details panel (])', exact: true }).click()
  await page.getByRole('button', { name: 'Show details panel (])', exact: true }).waitFor()
}
