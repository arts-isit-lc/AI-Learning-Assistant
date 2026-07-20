import { test, expect } from "@playwright/test"

/**
 * Phase 6 critical-flow smoke: login -> instructor courses -> course workspace
 * (Configuration) -> create-module wizard.
 *
 * Requirements to run (skips otherwise):
 *   - Dev server on the new shell: `VITE_UI_V2=true npm run dev` (+ Cognito/API env).
 *   - A seeded INSTRUCTOR account teaching >=1 course:
 *       E2E_INSTRUCTOR_EMAIL=...  E2E_INSTRUCTOR_PASSWORD=...
 *   - Browsers installed: `npx playwright install`.
 *
 * The deterministic logic (tree, wizard state, conflict-on-save, onNotify) is
 * covered by Vitest; this exercises the real end-to-end reachability.
 */
const EMAIL = process.env.E2E_INSTRUCTOR_EMAIL
const PASSWORD = process.env.E2E_INSTRUCTOR_PASSWORD

test("instructor can log in, open a course, and reach the module wizard", async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_INSTRUCTOR_EMAIL / E2E_INSTRUCTOR_PASSWORD to run this smoke.")

  await page.goto("/login")
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()

  // Instructor home (courses list).
  await expect(page).toHaveURL(/\/instructor\/courses/, { timeout: 15000 })

  // Open the first course; the Configuration tab is the default.
  await page.getByText(/[A-Z]{2,}\s?\d/).first().click()
  await expect(page).toHaveURL(/\/instructor\/courses\/[^/]+/)
  await expect(page.getByRole("heading", { name: "Concepts & modules" })).toBeVisible()

  // The other tabs are present in the workspace.
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible()

  // The create-module wizard is reachable and renders its first step.
  const base = new URL(page.url()).pathname.replace(/\/configuration$/, "")
  await page.goto(base + "/modules/new")
  await expect(page.getByRole("heading", { name: "Create module" })).toBeVisible()
  await expect(page.getByText("Details")).toBeVisible()
})
