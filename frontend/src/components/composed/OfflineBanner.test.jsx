import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"

let online = true
vi.mock("@tanstack/react-query", () => ({
  onlineManager: {
    isOnline: () => online,
    subscribe: () => () => {},
  },
}))

import { OfflineBanner } from "./OfflineBanner"

beforeEach(() => {
  online = true
})

describe("OfflineBanner", () => {
  it("renders nothing while online", () => {
    online = true
    const { container } = render(<OfflineBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a status banner while offline", () => {
    online = false
    render(<OfflineBanner />)
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i)
  })
})
