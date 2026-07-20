import { test, expect } from "@playwright/test"

/**
 * Phase 5 critical-flow smoke: login -> course -> module chat.
 *
 * Requirements to run (cannot run in CI without them, so the test skips):
 *   - The dev server must serve the new shell: `VITE_UI_V2=true npm run dev`
 *     (or set it in frontend/.env), plus the usual Cognito/API env vars.
 *   - A seeded student account enrolled in >=1 course with >=1 module:
 *       E2E_STUDENT_EMAIL=...  E2E_STUDENT_PASSWORD=...
 *   - Browsers installed: `npx playwright install`.
 *
 * The deterministic logic (streaming, components, routing) is covered by the
 * Vitest suites; this exercises the real end-to-end happy path.
 */
const EMAIL = process.env.E2E_STUDENT_EMAIL
const PASSWORD = process.env.E2E_STUDENT_PASSWORD

test("student can log in, open a course, and reach a module chat", async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_STUDENT_EMAIL / E2E_STUDENT_PASSWORD to run this smoke.")

  // Login (the shell reuses the existing Cognito login form).
  await page.goto("/login")
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()

  // Land on the student home (course grid).
  await expect(page).toHaveURL(/\/courses/, { timeout: 15000 })

  // Open the first course (click its course-code text on the CourseCard).
  await page.getByText(/[A-Z]{2,}\s?\d/).first().click()
  await expect(page).toHaveURL(/\/courses\/[^/]+/)

  // Expand the first concept and open its first module.
  const firstConcept = page.getByRole("button", { name: /\(\d+\)/ }).first()
  if (await firstConcept.isVisible().catch(() => false)) {
    await firstConcept.click()
  }
  await page.getByText(/complete|in progress|not started/i).first().click()

  // Module chat is reachable and interactive.
  await expect(page).toHaveURL(/\/courses\/[^/]+\/modules\/[^/]+/)
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible()
  await expect(page.getByLabel("Message AI Assistant")).toBeVisible()
})
