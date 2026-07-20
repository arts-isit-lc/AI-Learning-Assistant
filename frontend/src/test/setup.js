// Vitest global setup — runs before every test file.
// Adds jest-dom matchers (toBeInTheDocument, toHaveClass, ...) and unmounts
// React trees after each test so component tests stay isolated/deterministic.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

// jsdom doesn't implement a handful of layout/DOM APIs that Radix + cmdk touch
// (ScrollArea/Select/DropdownMenu). Polyfill them so component tests run.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {}
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || function () {
    return false
  }
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || function () {}
}
