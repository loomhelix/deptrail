import { defineConfig, devices } from '@playwright/test'

const WALKTHROUGH_ENABLED = process.env.DEPTRAIL_WALKTHROUGH === '1'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  ...(WALKTHROUGH_ENABLED ? {} : { grepInvert: /@walkthrough/ }),
  globalSetup: './global-setup.ts',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
