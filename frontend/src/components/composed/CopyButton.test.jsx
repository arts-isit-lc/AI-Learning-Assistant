import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { CopyButton, COPY_FEEDBACK_DELAY_MS } from "./CopyButton"

// Tell the two glyphs apart without coupling to react-icons' SVG paths: the copy
// state renders <svg data-testid="icon-copy">, the confirmed state renders
// <svg data-testid="icon-check">. The mocks ignore incoming props (size/a11y) —
// the test only cares which glyph is on screen.
vi.mock("react-icons/md", () => ({
  MdContentCopy: () => <svg data-testid="icon-copy" />,
  MdCheck: () => <svg data-testid="icon-check" />,
}))

const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.useFakeTimers()
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("CopyButton", () => {
  it("shows the copy glyph and writes the value to the clipboard on click", () => {
    render(<CopyButton value="ABCD-1234" label="Copy access code" />)
    const button = screen.getByRole("button", { name: "Copy access code" })

    expect(screen.getByTestId("icon-copy")).toBeInTheDocument()
    expect(screen.queryByTestId("icon-check")).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledWith("ABCD-1234")
  })

  it("waits a beat, swaps to the checkmark, then reverts after another beat", () => {
    render(<CopyButton value="ABCD-1234" label="Copy access code" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy access code" }))

    // The copy glyph deliberately holds right after the click.
    expect(screen.getByTestId("icon-copy")).toBeInTheDocument()

    // Just shy of the first beat: still the copy glyph.
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_DELAY_MS - 1))
    expect(screen.getByTestId("icon-copy")).toBeInTheDocument()
    expect(screen.queryByTestId("icon-check")).not.toBeInTheDocument()

    // First beat elapses: checkmark.
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId("icon-check")).toBeInTheDocument()
    expect(screen.queryByTestId("icon-copy")).not.toBeInTheDocument()

    // Second beat elapses: back to the copy glyph.
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_DELAY_MS))
    expect(screen.getByTestId("icon-copy")).toBeInTheDocument()
    expect(screen.queryByTestId("icon-check")).not.toBeInTheDocument()
  })

  it("still confirms with the checkmark when the clipboard write is rejected", () => {
    writeText.mockRejectedValueOnce(new Error("denied"))
    render(<CopyButton value="ABCD-1234" label="Copy access code" />)

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Copy access code" }))
    ).not.toThrow()

    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_DELAY_MS))
    expect(screen.getByTestId("icon-check")).toBeInTheDocument()
  })

  it("doesn't throw or confirm when the clipboard API is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    render(<CopyButton value="ABCD-1234" label="Copy access code" />)

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Copy access code" }))
    ).not.toThrow()

    // The confirmation is timer-driven, so it still shows even without clipboard.
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_DELAY_MS))
    expect(screen.getByTestId("icon-check")).toBeInTheDocument()
  })

  it("is a no-op for an empty value (no write, no icon swap)", () => {
    render(<CopyButton value="" label="Copy access code" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy access code" }))

    expect(writeText).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_DELAY_MS * 2))
    expect(screen.getByTestId("icon-copy")).toBeInTheDocument()
    expect(screen.queryByTestId("icon-check")).not.toBeInTheDocument()
  })
})
