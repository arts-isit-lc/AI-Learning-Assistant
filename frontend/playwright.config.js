import { defineConfig, devices } from '@playwright/test'

// Playwright E2E harness for the OCELIA rebuild.
// Real critical-flow smokes (login/role routing, course join, student chat +
// streaming, ...) are authored in Phase 5+. Phase 1 lands the harness + one
// public smoke (the /style-guide token preview) so `npm run test:e2e` works.
//
// First run needs browsers: `npx playwright install`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
