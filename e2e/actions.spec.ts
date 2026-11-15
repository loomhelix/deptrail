import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { ChangesResponse, Job } from '../src/actions/types.ts'
import type { SearchHit } from '../src/query/search.ts'
import type { ScanSummary } from '../src/server/router.ts'
import { missingManager } from '../test/helpers/package-managers.ts'
import { ACTIONS_ROOT, CHILD_ADVISORY_ID, startActionsFixture, type ActionsFixture } from './actions-fixture.ts'
import { LIBS_ROOT, OUTSIDE_ROOT, startShopMonorepo } from './shop-monorepo.ts'
import { expectTableFitsPanel } from './ui.ts'

const READY_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 180_000
const CHILD_ID = 'child-lib@1.0.0'
const TOOLKIT_ID = 'toolkit@2.0.0'
const UNDECLARED_REASON = 'The lockfile lists ../../libs/ui, which pnpm-workspace.yaml does not declare'
const pnpmMissing = missingManager('pnpm')

test.skip(pnpmMissing !== undefined, pnpmMissing)
test.describe.configure({ timeout: TEST_TIMEOUT_MS })

let fixture: ActionsFixture | undefined

test.beforeEach(async () => {
  fixture = await startActionsFixture()
})

test.afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

function running(): ActionsFixture {
  if (fixture === undefined) throw new Error('the actions fixture is not running')
  return fixture
}

function apiUrl(path: string): string {
  return new URL(path, running().url).toString()
}

async function openWhenReady(page: Page, focus: string): Promise<void> {
  const url = new URL(running().url)
  await page.goto(url.toString())
  await expect
    .poll(
      async () => {
        const scan = (await (await page.request.get(apiUrl('/api/scan'))).json()) as ScanSummary
        const root = scan.roots.find((candidate) => candidate.id === ACTIONS_ROOT)
        return scan.enrichment.state === 'done' && root?.actions.available === true
      },
      { timeout: READY_TIMEOUT_MS },
    )
    .toBe(true)
  url.searchParams.set('root', ACTIONS_ROOT)
  url.searchParams.set('focus', focus)
  await page.goto(url.toString())
}

function actionsSection(page: Page) {
  return page.getByRole('complementary', { name: 'Package details' }).getByRole('region', { name: 'Actions' })
}

test('the details panel of child-lib 1.0.0 offers the fixes and adds the recommended one', async ({ page }) => {
  await openWhenReady(page, CHILD_ID)
  const actions = actionsSection(page)
  await expect(actions.getByText(`Fix ${CHILD_ADVISORY_ID} in ${ACTIONS_ROOT}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })

  const chain = actions.getByRole('radio', { name: 'Re-lock and update parent-lib', exact: true })
  await expect(chain).toBeChecked()
  const chainOption = actions.getByTestId('fix-option').filter({ has: page.getByRole('radio', { name: 'Re-lock and update parent-lib', exact: true }) })
  await expect(chainOption).toContainText('recommended')
  await expect(chainOption).toContainText('Re-lock child-lib 1.0.0 → 1.0.1')
  await expect(chainOption).toContainText('Update parent-lib in web to 1.1.0')

  const overrideOption = actions.getByTestId('fix-option').filter({ has: page.getByRole('radio', { name: 'Override to 1.0.1', exact: true }) })
  await expect(overrideOption).toContainText('Override child-lib@<1.0.1 to 1.0.1 in pnpm-workspace.yaml')
  await expect(overrideOption.getByRole('radio')).not.toBeChecked()

  const fixBlock = actions.getByTestId('actions-fix')
  await fixBlock.getByRole('button', { name: 'Add to changes' }).click()
  await expect(fixBlock.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeFocused()
  const changes = (await (await page.request.get(apiUrl(`/api/roots/${ACTIONS_ROOT}/changes`))).json()) as ChangesResponse
  expect(changes.items).toHaveLength(1)
  expect(changes.items[0]?.choice).toBe('chain')

  await overrideOption.getByRole('radio').check()
  await expect(fixBlock.getByText('In changes: Re-lock and update parent-lib', { exact: true })).toBeVisible()
  const replaceRequest = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === `/api/roots/${ACTIONS_ROOT}/changes/${changes.items[0]?.id}`)
  await fixBlock.getByRole('button', { name: 'Replace in changes', exact: true }).click()
  expect((await replaceRequest).postDataJSON()).toEqual({ nodeId: CHILD_ID, choice: 'override', kinds: ['prod', 'dev', 'optional', 'peer'] })
  await expect(fixBlock.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeFocused()
  await expect(fixBlock.getByText('In changes: Re-lock and update parent-lib', { exact: true })).toHaveCount(0)
  const replaced = (await (await page.request.get(apiUrl(`/api/roots/${ACTIONS_ROOT}/changes`))).json()) as ChangesResponse
  expect(replaced.items).toHaveLength(1)
  expect(replaced.items[0]?.choice).toBe('override')
})

test('the details panel of toolkit 2.0.0 offers an update in both workspace packages', async ({ page }) => {
  await openWhenReady(page, TOOLKIT_ID)
  const actions = actionsSection(page)
  const version = actions.getByRole('combobox', { name: 'Version' })
  await expect(version).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(version.locator('option')).toHaveText(['3.0.0 · latest · major', '2.1.0 · in range', '2.0.0 · current'])
  await expect(version).toHaveValue('2.1.0')

  const importers = actions.getByTestId('update-importer')
  await expect(importers).toHaveCount(2)
  for (const name of ['web', 'api']) {
    const row = importers.filter({ has: page.getByText(name, { exact: true }) })
    await expect(row.getByRole('checkbox')).toBeDisabled()
    await expect(row).toContainText('^2.0.0')
    await expect(row).toContainText('unchanged (2.1.0 is in range)')
    await expect(row).not.toContainText('→')
  }
  await expect(actions.getByTestId('update-warning')).toHaveCount(0)

  await version.selectOption('3.0.0')
  for (const name of ['web', 'api']) {
    const row = importers.filter({ has: page.getByText(name, { exact: true }) })
    await expect(row.getByRole('checkbox')).toBeChecked()
    await expect(row).toContainText('^2.0.0 → ^3.0.0')
  }
  await expect(actions.getByTestId('update-warning')).toHaveText(['major update'])

  await version.selectOption('2.1.0')
  const updateBlock = actions.getByTestId('actions-update')
  await updateBlock.getByRole('button', { name: 'Add to changes' }).click()
  await expect(updateBlock.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeFocused()
  const changes = (await (await page.request.get(apiUrl(`/api/roots/${ACTIONS_ROOT}/changes`))).json()) as ChangesResponse
  expect(changes.items).toHaveLength(1)
  expect(changes.items[0]?.choice).toBe('wanted')
  expect(changes.items[0]?.steps).toEqual([expect.objectContaining({ kind: 'relock', name: 'toolkit', from: '2.0.0', to: '2.1.0' })])

  await version.selectOption('3.0.0')
  await expect(updateBlock.getByText('In changes: Re-lock to 2.1.0', { exact: true })).toBeVisible()
  await updateBlock.getByRole('button', { name: 'Replace in changes', exact: true }).click()
  await expect(updateBlock.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeFocused()
  const replaced = (await (await page.request.get(apiUrl(`/api/roots/${ACTIONS_ROOT}/changes`))).json()) as ChangesResponse
  expect(replaced.items).toHaveLength(1)
  expect(replaced.items[0]?.choice).toBe('latest')
  expect(replaced.items[0]?.id).not.toBe(changes.items[0]?.id)
})

test('the actions load from the node even while the scan summary still reports the package manager check', async ({ page }) => {
  await page.route('**/api/scan', async (route) => {
    const response = await route.fetch()
    const scan = (await response.json()) as ScanSummary
    const roots = scan.roots.map((root) =>
      root.id === ACTIONS_ROOT ? { ...root, actions: { ...root.actions, available: false, reason: 'Checking pnpm…' } } : root,
    )
    await route.fulfill({ response, json: { ...scan, roots } })
  })
  await openWhenReady(page, CHILD_ID)
  const actions = actionsSection(page)
  await expect(actions.getByText(`Fix ${CHILD_ADVISORY_ID} in ${ACTIONS_ROOT}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(actions.getByText('Checking pnpm…')).toHaveCount(0)
})

async function versionsInRoot(page: Page, name: string): Promise<string[]> {
  const hits = (await (await page.request.get(apiUrl(`/api/search?q=${encodeURIComponent(name)}`))).json()) as SearchHit[]
  const hit = hits.find((candidate) => candidate.name === name)
  return (hit?.versions ?? []).filter((entry) => entry.roots.some((root) => root.rootId === ACTIONS_ROOT)).map((entry) => entry.version)
}

test('the changes view previews, applies and reverts the recommended fix of child-lib 1.0.0', async ({ page }) => {
  const webManifest = path.join(running().rootDir, 'web', 'package.json')
  const lockfile = path.join(running().rootDir, 'pnpm-lock.yaml')
  const originalManifest = await readFile(webManifest, 'utf8')
  const originalLockfile = await readFile(lockfile, 'utf8')

  await openWhenReady(page, CHILD_ID)
  const actions = actionsSection(page)
  await expect(actions.getByText(`Fix ${CHILD_ADVISORY_ID} in ${ACTIONS_ROOT}`, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await actions.getByRole('button', { name: 'Add to changes' }).click()
  await expect(actions.getByRole('button', { name: '✓ In changes · Review', exact: true })).toBeVisible()

  const changesTab = page.getByRole('tab', { name: /^Changes/ })
  await expect(changesTab).toHaveText('Changes 1')
  const rootEntry = page.getByRole('navigation', { name: 'Roots' }).getByRole('treeitem', { name: ACTIONS_ROOT, exact: true })
  await expect(rootEntry.getByRole('link', { name: '1 change', exact: true })).toBeVisible()

  await changesTab.click()
  await expect(page).toHaveURL(/view=changes/)
  const view = page.getByRole('region', { name: 'Changes', exact: true })
  const section = view.getByRole('region', { name: ACTIONS_ROOT, exact: true })
  await expect(view.getByTestId('root-changes')).toHaveCount(1)
  const items = section.getByTestId('change-item')
  await expect(items).toHaveCount(1)
  await expect(items.first().getByTestId('change-goal')).toHaveText(`Fix child-lib 1.0.0 · ${CHILD_ADVISORY_ID}`)
  await expect(items.first().getByTestId('change-steps')).toHaveText('Re-lock child-lib 1.0.0 → 1.0.1; Update parent-lib in web to 1.1.0')
  await expect(items.first().getByRole('button', { name: 'Remove Fix child-lib 1.0.0', exact: true })).toBeVisible()
  await expect(section.getByTestId('change-count')).toHaveText('1 change')
  await expect(section.locator('[aria-current="step"]')).toHaveText('1 Changes')

  await section.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = section.getByRole('region', { name: 'Preview', exact: true })
  await expect(preview.getByTestId('preview-goal')).toHaveText(['✓ child-lib: no affected version left (1.0.1)'], { timeout: READY_TIMEOUT_MS })
  await expect(section.locator('[aria-current="step"]')).toHaveText('3 Apply')

  const webFile = preview.getByTestId('preview-file').filter({ hasText: 'web/package.json' })
  await expect(webFile.getByTestId('file-stats')).toHaveText('+1 −1')
  await webFile.getByText('web/package.json', { exact: true }).click()
  const webDiff = webFile.getByTestId('file-diff')
  await expect(webDiff).toContainText('-    "parent-lib": "1.0.0",')
  await expect(webDiff).toContainText('+    "parent-lib": "1.1.0",')

  const lockFile = preview.getByTestId('preview-file').filter({ hasText: 'pnpm-lock.yaml' })
  await expect(lockFile).toBeVisible()
  await lockFile.getByText('pnpm-lock.yaml', { exact: true }).click()
  await expect(lockFile.getByTestId('file-diff')).toContainText('parent-lib@1.1.0')

  const applyButton = section.getByRole('button', { name: 'Apply…', exact: true })
  await expect(preview.getByRole('button', { name: 'Apply…' })).toHaveCount(0)
  await applyButton.click()
  const dialog = page.getByRole('dialog', { name: 'Apply 1 change to shop?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(applyButton).toBeFocused()
  await applyButton.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Writes web/package.json, pnpm-lock.yaml exactly as previewed.', { exact: true })).toBeVisible()
  const install = dialog.getByRole('checkbox', { name: 'Run install: pnpm install --frozen-lockfile' })
  await expect(install).not.toBeChecked()
  await expect(dialog).toContainText('Runs dependency build scripts that your pnpm settings allow.')
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()

  const outcome = section.getByTestId('changes-outcome')
  await expect(outcome.getByTestId('job-outcome')).toHaveText('Applied to shop. 1 goal met · files written: web/package.json, pnpm-lock.yaml.', {
    timeout: READY_TIMEOUT_MS,
  })
  await expect(section.locator('header + [data-testid="changes-outcome"]')).toBeVisible()
  await expect(outcome.getByTestId('install-hint')).toHaveText('node_modules was not updated. Run pnpm install --frozen-lockfile in shop when ready.')
  await expect(outcome.getByTestId('install-hint').locator('code')).toHaveText('pnpm install --frozen-lockfile')
  await expect(outcome.getByTestId('revert-note')).toHaveText('Restores 2 files and puts 1 change back in the list.')
  await expect(section.getByTestId('changes-empty')).toHaveCount(0)
  await expect(section.getByRole('list', { name: 'Steps', exact: true }).getByRole('listitem')).toHaveClass([
    /root-changes__step--done/,
    /root-changes__step--done/,
    /root-changes__step--done/,
  ])
  await expect(dialog).toHaveCount(0)
  expect(JSON.parse(await readFile(webManifest, 'utf8')).dependencies['parent-lib']).toBe('1.1.0')
  expect(await versionsInRoot(page, 'child-lib')).toEqual(['1.0.1'])
  await expect(changesTab).toHaveText('Changes 0')
  await expect(items).toHaveCount(0)
  await expect(section.locator('[aria-current="step"]')).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0)
  const details = page.getByRole('complementary', { name: 'Package details' }).getByTestId('details-body')
  const notice = details.getByTestId('follow-notice')
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('child-lib 1.0.1', { timeout: READY_TIMEOUT_MS })
  await expect(notice.getByText('Applied in shop: child-lib 1.0.0 → 1.0.1. Showing the new version.', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/[?&]focus=child-lib@1\.0\.1(&|$)/)
  await expect(details.getByText(/Unknown node/)).toHaveCount(0)
  await expect(details.getByText(CHILD_ADVISORY_ID, { exact: true })).toHaveCount(0)

  await outcome.getByRole('button', { name: 'Revert files' }).click()
  await expect(outcome.getByTestId('job-outcome')).toHaveText('Files restored in shop. 1 change is back in the list.', { timeout: READY_TIMEOUT_MS })
  await expect(section.locator('header + [data-testid="changes-outcome"]')).toBeVisible()
  await expect(outcome.getByTestId('install-hint')).toHaveCount(0)
  await expect(view.getByRole('button', { name: 'Revert files' })).toHaveCount(0)
  await expect(items).toHaveCount(1)
  await expect(items.first().getByTestId('change-goal')).toHaveText(`Fix child-lib 1.0.0 · ${CHILD_ADVISORY_ID}`)
  await expect(changesTab).toHaveText('Changes 1')
  await expect(section.getByRole('button', { name: 'Preview', exact: true })).toBeVisible()
  expect(await readFile(webManifest, 'utf8')).toBe(originalManifest)
  expect(await readFile(lockfile, 'utf8')).toBe(originalLockfile)
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('child-lib 1.0.0', { timeout: READY_TIMEOUT_MS })
  await expect(notice.getByText('Reverted in shop: child-lib 1.0.1 → 1.0.0. Showing the new version.', { exact: true })).toBeVisible()
  await expect(details.getByText(CHILD_ADVISORY_ID, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(details.getByTestId('details-missing')).toHaveCount(0)
})

function issuesUrl(kinds?: readonly string[]): string {
  const url = new URL(running().url)
  url.searchParams.set('root', ACTIONS_ROOT)
  url.searchParams.set('view', 'issues')
  if (kinds !== undefined) url.searchParams.set('kinds', kinds.join(','))
  return url.toString()
}

test('the issues view adds the recommended fix of child-lib 1.0.0 and collects the rest', async ({ page }) => {
  await openWhenReady(page, CHILD_ID)
  await page.goto(issuesUrl(['prod', 'dev']))
  const childRow = page.getByTestId('issue-row').filter({ hasText: 'child-lib 1.0.0' })
  await expect(childRow).toBeVisible({ timeout: READY_TIMEOUT_MS })
  await expect(childRow.getByTestId('row-recommended')).toHaveText('Re-lock and update parent-lib', { timeout: READY_TIMEOUT_MS })

  const addRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/roots/${ACTIONS_ROOT}/changes`)
  await childRow.getByRole('button', { name: 'Add fix', exact: true }).click()
  expect((await addRequest).postDataJSON()).toEqual({ nodeId: CHILD_ID, choice: 'recommended', kinds: ['prod', 'dev'] })
  await expect(childRow.getByRole('button', { name: '✓ In changes', exact: true })).toBeVisible()
  await expect(childRow.getByTestId('row-recommended')).toHaveText('Re-lock and update parent-lib')
  await expect(page.getByRole('tab', { name: /^Changes/ })).toHaveText('Changes 1')

  await page.getByRole('button', { name: 'Add recommended fixes…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add recommended fixes' })
  await expect(dialog.getByRole('checkbox')).toHaveCount(1)
  await expect(dialog.getByRole('checkbox', { name: `${ACTIONS_ROOT} — 1 vulnerable package`, exact: true })).toBeChecked()
  const collectRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/changes/recommended'))
  await dialog.getByRole('button', { name: 'Add fixes', exact: true }).click()
  expect((await collectRequest).postDataJSON()).toEqual({ kinds: ['prod', 'dev'] })
  await expect(
    dialog.getByText('No fixes added; skipped child-lib 1.0.0 (Fix child-lib 1.0.0 is already in the changes of shop)', { exact: true }),
  ).toBeVisible({ timeout: READY_TIMEOUT_MS })
})

const RUNNING_LOG = ['Progress: resolved 1, reused 1, downloaded 0, added 0', 'Progress: resolved 4, reused 4, downloaded 0, added 0', 'Lockfile is up to date']
const FAILURE_LOG = ['ERR_PNPM_FAKE the registry answered 500']
const PREVIEW_FAILURE = 'pnpm exited with code 1'

function craftedJob(job: Job, fails: boolean, since: number): Job {
  const fullLog = fails ? [...RUNNING_LOG, ...FAILURE_LOG] : RUNNING_LOG
  const shared = { id: job.id, rootId: job.rootId, kind: job.kind, phase: 'resolving' as const, log: fullLog.slice(since), firstLine: since }
  return fails ? { ...shared, state: 'failed', error: PREVIEW_FAILURE } : { ...shared, state: 'running' }
}

test('the job log stays collapsed while a job runs, opens by itself when the job fails, and keeps what the user chose', async ({ page }) => {
  await openWhenReady(page, CHILD_ID)
  const added = await page.request.post(apiUrl(`/api/roots/${ACTIONS_ROOT}/changes`), {
    data: { nodeId: CHILD_ID, choice: 'recommended' },
    headers: { origin: new URL(running().url).origin },
  })
  expect(added.status()).toBe(201)

  let fails = false
  let latestJob: Job | undefined
  let jobPolls = 0
  let changesReads = 0
  await page.route('**/api/jobs/*', async (route) => {
    jobPolls += 1
    const response = await route.fetch()
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? '0')
    const job = craftedJob((await response.json()) as Job, fails, since)
    latestJob = craftedJob(job, fails, 0)
    await route.fulfill({ response, json: job })
  })
  await page.route(`**/api/roots/${ACTIONS_ROOT}/changes`, async (route) => {
    if (route.request().method() !== 'GET' || latestJob === undefined) {
      await route.fallback()
      return
    }
    changesReads += 1
    const response = await route.fetch()
    const changes = (await response.json()) as ChangesResponse
    await route.fulfill({ response, json: { ...changes, preview: undefined, job: latestJob } })
  })

  const url = new URL(running().url)
  url.searchParams.set('root', ACTIONS_ROOT)
  url.searchParams.set('view', 'changes')
  await page.goto(url.toString())
  const section = page.getByRole('region', { name: 'Changes', exact: true }).getByRole('region', { name: ACTIONS_ROOT, exact: true })
  await section.getByRole('button', { name: 'Preview', exact: true }).click()

  const jobStatus = section.getByTestId('changes-job')
  await expect(jobStatus.getByRole('status')).toHaveText('Resolving the lockfile…')
  await expect(section.locator('header + [data-testid="changes-job"]')).toBeVisible()
  const runningLog = jobStatus.getByTestId('job-log')
  await expect(runningLog.locator('summary')).toHaveText('Log · 3 lines')
  await expect(runningLog).toHaveJSProperty('open', false)
  await expect(runningLog.getByTestId('job-lines')).toBeHidden()

  await runningLog.locator('summary').click()
  await expect(runningLog).toHaveJSProperty('open', true)
  const pollsWhenOpened = jobPolls
  await expect.poll(() => jobPolls, { timeout: READY_TIMEOUT_MS }).toBeGreaterThan(pollsWhenOpened + 1)
  await expect(runningLog).toHaveJSProperty('open', true)
  await expect(runningLog.getByTestId('job-lines')).toBeVisible()

  fails = true
  const outcome = section.getByTestId('changes-outcome')
  await expect(outcome.getByRole('alert')).toHaveText(`Preview failed: ${PREVIEW_FAILURE}`, { timeout: READY_TIMEOUT_MS })
  await expect(section.locator('header + [data-testid="changes-outcome"]')).toBeVisible()
  const failedLog = outcome.getByTestId('job-log')
  await expect(failedLog).toHaveJSProperty('open', true)
  await expect(failedLog.locator('summary')).toHaveText('Log · 4 lines')
  await expect(failedLog.getByTestId('job-lines')).toBeVisible()
  await expect(failedLog.getByTestId('job-lines')).toContainText('ERR_PNPM_FAKE the registry answered 500')
  await expect(jobStatus).toHaveCount(0)

  await failedLog.locator('summary').click()
  await expect(failedLog).toHaveJSProperty('open', false)
  const readsWhenCollapsed = changesReads
  const reload = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/roots/${ACTIONS_ROOT}/changes`)
  await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('menu', { name: 'Refresh' }).getByRole('menuitem', { name: 'Rescan files', exact: true }).click()
  await reload
  expect(changesReads).toBeGreaterThan(readsWhenCollapsed)
  await page.waitForTimeout(500)
  await expect(failedLog).toHaveJSProperty('open', false)
  await expect(outcome.getByRole('alert')).toHaveText(`Preview failed: ${PREVIEW_FAILURE}`)
})

const OUTSIDE_PACKAGE = '../../libs/ui/package.json'
const OUTSIDE_WRITE_SENTENCE = `${OUTSIDE_PACKAGE} (also in ${LIBS_ROOT})`

test('a root with a workspace package outside it fixes child-lib there and warns about the other lockfile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const monorepo = await startShopMonorepo({ npmRoot: false, outsideRoot: true })
  try {
    const outsideManifest = path.join(monorepo.rootDirs[LIBS_ROOT], 'ui', 'package.json')
    const url = new URL(monorepo.url)
    await page.goto(url.toString())
    await expect
      .poll(
        async () => {
          const scan = (await (await page.request.get(new URL('/api/scan', url).toString())).json()) as ScanSummary
          const roots = [OUTSIDE_ROOT, LIBS_ROOT].map((rootId) => scan.roots.find((root) => root.id === rootId))
          return scan.enrichment.state === 'done' && roots.every((root) => root?.actions.available === true)
        },
        { timeout: READY_TIMEOUT_MS },
      )
      .toBe(true)
    await page.goto(url.toString())

    const grid = page.getByRole('treegrid', { name: 'Issues' })
    const storeRow = grid.getByRole('row', { name: `child-lib 1.0.0 in ${OUTSIDE_ROOT}`, exact: true })
    const add = storeRow.getByRole('button', { name: 'Add fix', exact: true })
    await expect(add).toBeEnabled({ timeout: READY_TIMEOUT_MS })
    await add.click()
    await expectTableFitsPanel(page)

    await page.getByRole('tab', { name: /^Changes/ }).click()
    const view = page.getByRole('region', { name: 'Changes', exact: true })
    const section = view.getByRole('region', { name: OUTSIDE_ROOT, exact: true })
    await expect(section.getByTestId('change-item')).toHaveCount(1)
    await section.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = section.getByRole('region', { name: 'Preview', exact: true })
    await expect(preview.getByTestId('preview-goal')).toHaveText(['✓ child-lib: no affected version left (1.0.1)'], { timeout: READY_TIMEOUT_MS })
    await expect(preview.getByTestId('preview-warning')).toHaveText([`${LIBS_ROOT} also uses ${OUTSIDE_PACKAGE}: its lockfile is not updated; run pnpm install in ${LIBS_ROOT}`])

    await section.getByRole('button', { name: 'Apply…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Apply 1 change to ${OUTSIDE_ROOT}?` })
    await expect(dialog).toContainText(OUTSIDE_WRITE_SENTENCE)
    await expect(dialog).toContainText('Install also writes node_modules in 1 workspace package outside the root.')
    const installCheckbox = dialog.getByRole('checkbox', { name: 'Run install: pnpm install --frozen-lockfile' })
    await expect(installCheckbox).toHaveAccessibleDescription(/node_modules in 1 workspace package outside the root/)
    await installCheckbox.uncheck()
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const outcome = section.getByTestId('changes-outcome')
    await expect(outcome.getByTestId('job-outcome')).toContainText(`Applied to ${OUTSIDE_ROOT}.`, { timeout: READY_TIMEOUT_MS })
    await expect(outcome).toContainText(`Lockfile not updated: ${LIBS_ROOT}. Run pnpm install there.`)
    expect(JSON.parse(await readFile(outsideManifest, 'utf8')).dependencies['parent-lib']).toBe('1.1.0')

    await outcome.getByRole('button', { name: 'Revert files', exact: true }).click()
    await expect(outcome.getByTestId('job-outcome')).toContainText(`Files restored in ${OUTSIDE_ROOT}.`, { timeout: READY_TIMEOUT_MS })
    expect(JSON.parse(await readFile(outsideManifest, 'utf8')).dependencies['parent-lib']).toBe('1.0.0')
  } finally {
    await monorepo.stop()
  }
})

test('an unavailable root states its reason once above the issues', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const monorepo = await startShopMonorepo({ npmRoot: false, outsideRoot: true, undeclaredOutsidePackage: true })
  try {
    const url = new URL(monorepo.url)
    const nodeActionRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/actions')) nodeActionRequests.push(request.url())
    })
    await page.goto(url.toString())
    await expect
      .poll(
        async () => {
          const scan = (await (await page.request.get(new URL('/api/scan', url).toString())).json()) as ScanSummary
          const store = scan.roots.find((root) => root.id === OUTSIDE_ROOT)
          return scan.enrichment.state === 'done' && store?.actions.available === false
        },
        { timeout: READY_TIMEOUT_MS },
      )
      .toBe(true)
    await page.goto(url.toString())

    const note = page.getByText(`${OUTSIDE_ROOT}: ${UNDECLARED_REASON}`, { exact: true })
    await expect(note).toHaveCount(1, { timeout: READY_TIMEOUT_MS })
    const grid = page.getByRole('treegrid', { name: 'Issues' })
    const rows = grid.getByRole('row', { name: `child-lib 1.0.0 in ${OUTSIDE_ROOT}`, exact: true })
    expect(await rows.count()).toBeGreaterThan(0)
    for (const row of await rows.all()) {
      await expect(row.getByTestId('row-recommended')).toHaveText('Unavailable')
      await expect(row).toHaveAccessibleDescription(new RegExp(`${OUTSIDE_ROOT}: ${UNDECLARED_REASON}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    await expect(grid.getByText(UNDECLARED_REASON)).toHaveCount(0)
    expect(nodeActionRequests.filter((requestUrl) => requestUrl.includes(encodeURIComponent(OUTSIDE_ROOT)))).toEqual([])
  } finally {
    await monorepo.stop()
  }
})
