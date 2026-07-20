import { test, expect } from '@playwright/test'

// Phase 1 smoke: the token-preview / style-guide route renders on the new
// Tailwind + token system without auth. This proves the E2E harness runs
// end-to-end (dev server -> browser -> route). Critical-flow smokes
// (login/role routing, course join, chat streaming, ...) arrive in Phase 5+.
test('style guide token preview renders', async ({ page }) => {
  await page.goto('/style-guide')
  await expect(
    page.getByRole('heading', { name: /OCELIA design tokens/i })
  ).toBeVisible()
})
