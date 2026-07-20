import { test, expect } from "@playwright/test"

/**
 * Phase 7 critical-flow smoke: login -> admin instructor management -> a detail,
 * and course management -> the create form.
 *
 * Requirements to run (skips otherwise):
 *   - Dev server on the new shell: `VITE_UI_V2=true npm run dev` (+ Cognito/API env).
 *   - A seeded ADMIN account with >=1 instructor:
 *       E2E_ADMIN_EMAIL=...  E2E_ADMIN_PASSWORD=...
 *   - Browsers installed: `npx playwright install`.
 *
 * The deterministic logic (CRUD, replace-pattern assignment, toggles) is covered
 * by Vitest; this exercises the real end-to-end reachability.
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL
const PASSWORD = process.env.E2E_ADMIN_PASSWORD

test("admin can log in, open an instructor, and reach the create-course form", async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD to run this smoke.")

  await page.goto("/login")
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()

  // Admin lands on the instructor management area.
  await expect(page).toHaveURL(/\/admin\/instructors/, { timeout: 15000 })
  await expect(page.getByRole("heading", { name: "Instructors" })).toBeVisible()

  // Open the first instructor -> detail pane shows the assigned-courses card.
  await page.locator("button", { hasText: "@" }).first().click()
  await expect(page.getByRole("heading", { name: "Assigned courses" })).toBeVisible()

  // Course management + the create form are reachable.
  await page.getByRole("link", { name: "Courses" }).click()
  await expect(page).toHaveURL(/\/admin\/courses/)
  await page.getByRole("button", { name: /new course/i }).click()
  await expect(page).toHaveURL(/\/admin\/courses\/new/)
  await expect(page.getByRole("heading", { name: "Create a course" })).toBeVisible()
})
