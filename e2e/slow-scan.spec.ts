import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { copyFixtureMonolith, createWorkDirs, startDeptrail, type RunningDeptrail } from './global-setup.ts'
import { pageUrl } from './ui.ts'

const GATED_ROOT = 'npm-package'
const MANIFEST_ONLY_ROOT = 'scripts/release'

const RESOLVED_RELEASE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      semver:',
  '        specifier: ^7.6.0',
  '        version: 7.6.3',
  'packages:',
  '  semver@7.6.3:',
  '    resolution: {integrity: sha512-fixture}',
  'snapshots:',
  '  semver@7.6.3: {}',
].join('\n')

type GatedDeptrail = { deptrail: RunningDeptrail; npmrcGate: string; resolveGate: string }

function createGate(gatePath: string): void {
  execFileSync('mkfifo', [gatePath])
}

async function releaseGate(gatePath: string): Promise<void> {
  await writeFile(gatePath, '')
}

async function releaseGateIfWaiting(gatePath: string): Promise<void> {
  try {
    const handle = await open(gatePath, constants.O_WRONLY | constants.O_NONBLOCK)
    await handle.close()
  } catch {}
}

async function withGatedDeptrail(exercise: (gated: GatedDeptrail) => Promise<void>): Promise<void> {
  const dirs = await createWorkDirs()
  const fakeBin = path.join(dirs.base, 'bin')
  const npmrcGate = path.join(dirs.repo, GATED_ROOT, '.npmrc')
  const resolveGate = path.join(dirs.base, 'resolve-gate')
  let deptrail: RunningDeptrail | undefined
  try {
    await copyFixtureMonolith(dirs.repo)
    await rm(npmrcGate)
    createGate(npmrcGate)
    createGate(resolveGate)
    await mkdir(fakeBin)
    const fakePnpm = path.join(fakeBin, 'pnpm')
    await writeFile(fakePnpm, `#!/bin/sh\ncat "${resolveGate}" > /dev/null\ncat > pnpm-lock.yaml <<'LOCK'\n${RESOLVED_RELEASE_LOCKFILE}\nLOCK\n`)
    await chmod(fakePnpm, 0o755)
    deptrail = await startDeptrail(dirs, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` }, ['--offline'])
    await exercise({ deptrail, npmrcGate, resolveGate })
  } finally {
    await releaseGateIfWaiting(npmrcGate)
    await releaseGateIfWaiting(resolveGate)
    await deptrail?.stop()
    await rm(dirs.base, { recursive: true, force: true })
  }
}

async function openRoot(page: Page, deptrail: RunningDeptrail, root?: string): Promise<void> {
  await page.goto(pageUrl(deptrail.url, { ...(root === undefined ? {} : { root }), view: 'explore', mode: 'tree' }))
}

async function expandWorkspacePackage(page: Page, name: string): Promise<void> {
  await page.getByTestId('tree-row').filter({ hasText: name }).getByRole('button', { name: `Expand ${name}`, exact: true }).click()
}

function rootRegion(page: Page, root: string) {
  return page.getByRole('navigation', { name: 'Roots' }).getByRole('treeitem', { name: root, exact: true })
}

test('a root selected while it is scanning shows the scanning state and then its tree with duplicate flags', async ({ page }) => {
  await withGatedDeptrail(async ({ deptrail, npmrcGate }) => {
    await openRoot(page, deptrail, GATED_ROOT)
    await expect(rootRegion(page, GATED_ROOT).getByText('scanning', { exact: true })).toBeVisible()
    await expect(page.getByRole('tabpanel')).toContainText(`Scanning ${GATED_ROOT}…`)
    await releaseGate(npmrcGate)
    await expandWorkspacePackage(page, GATED_ROOT)
    const semverRow = page.getByTestId('tree-row').filter({ hasText: 'semver 7.6.3' })
    await expect(semverRow).toHaveCount(1)
    await expect(semverRow.getByText('dup', { exact: true })).toBeVisible()
    await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveCount(0)
  })
})

test('duplicate flags appear for a root that finished after the page loaded the duplicates', async ({ page }) => {
  await withGatedDeptrail(async ({ deptrail, npmrcGate }) => {
    const duplicateLoads: number[] = []
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/duplicates') duplicateLoads.push(response.status())
    })
    await openRoot(page, deptrail)
    await expect(rootRegion(page, GATED_ROOT).getByText('scanning', { exact: true })).toBeVisible()
    await expect.poll(() => duplicateLoads.length).toBeGreaterThan(0)
    await releaseGate(npmrcGate)
    await expect(rootRegion(page, GATED_ROOT).getByText('scanning', { exact: true })).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox', { name: 'Search packages' }).fill('semver')
    await page.getByRole('option', { name: `semver 7.6.3 in ${GATED_ROOT}`, exact: true }).click()
    await expect(page.getByTestId('tree-row').first().getByText('dup', { exact: true })).toBeVisible()
  })
})

test('rescanning the shown root swaps the view to the scanning state and back to a fresh tree', async ({ page }) => {
  await withGatedDeptrail(async ({ deptrail, npmrcGate }) => {
    await releaseGate(npmrcGate)
    await openRoot(page, deptrail, GATED_ROOT)
    await expandWorkspacePackage(page, GATED_ROOT)
    const semverRow = page.getByTestId('tree-row').filter({ hasText: 'semver 7.6.3' })
    await expect(semverRow).toHaveCount(1)
    await page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rescan files', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toContainText(`Scanning ${GATED_ROOT}…`)
    await releaseGate(npmrcGate)
    await expandWorkspacePackage(page, GATED_ROOT)
    await expect(semverRow).toHaveCount(1)
    await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveCount(0)
  })
})

test('resolving the versions of a manifest-only root replaces its tree with the resolved one', async ({ page }) => {
  await withGatedDeptrail(async ({ deptrail, npmrcGate, resolveGate }) => {
    await releaseGate(npmrcGate)
    await openRoot(page, deptrail, MANIFEST_ONLY_ROOT)
    const rows = page.getByTestId('tree-row')
    await expect(rows.first()).toContainText('release-scripts')
    await expect(rows.filter({ hasText: 'semver 7.6.3' })).toHaveCount(0)
    await rootRegion(page, MANIFEST_ONLY_ROOT).getByRole('button', { name: 'Resolve versions' }).click()
    await expect(page.getByRole('tabpanel')).toContainText(`Scanning ${MANIFEST_ONLY_ROOT}…`)
    await releaseGate(resolveGate)
    await expect(rootRegion(page, MANIFEST_ONLY_ROOT).getByText('resolved today', { exact: true })).toBeVisible()
    const resolvedSemver = rows.filter({ hasText: 'semver 7.6.3' })
    await expect(resolvedSemver).toHaveCount(1)
    await expect(resolvedSemver.getByText('dup', { exact: true })).toHaveAttribute('title', new RegExp(MANIFEST_ONLY_ROOT))
  })
})
