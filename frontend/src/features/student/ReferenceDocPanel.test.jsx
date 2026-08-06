import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let urlResult
vi.mock("@/services/queries", () => ({
  useFileUrl: () => urlResult,
}))

import { ReferenceDocPanel } from "./ReferenceDocPanel"

beforeEach(() => {
  urlResult = {
    data: { presignedurl: "https://example.test/doc.pdf" },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }
})

describe("ReferenceDocPanel", () => {
  it("renders the document iframe when the URL resolves", () => {
    render(<ReferenceDocPanel fileId="f1" fileName="notes.pdf" onClose={vi.fn()} />)
    expect(screen.getByTitle("notes.pdf")).toBeInTheDocument()
  })

  it("announces a labelled loading region while the document loads", () => {
    urlResult = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() }
    render(<ReferenceDocPanel fileId="f1" fileName="notes.pdf" onClose={vi.fn()} />)
    expect(screen.getByRole("status", { name: /loading document/i })).toBeInTheDocument()
  })

  it("shows an accessible ErrorState with a working retry when the URL fails", async () => {
    const refetch = vi.fn()
    urlResult = { data: undefined, isLoading: false, isError: true, refetch }
    render(<ReferenceDocPanel fileId="f1" fileName="notes.pdf" onClose={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Couldn't load this document" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → document)", async () => {
    const refetch = vi.fn()
    urlResult = { data: undefined, isLoading: false, isError: true, refetch }
    const { rerender } = render(<ReferenceDocPanel fileId="f1" fileName="notes.pdf" onClose={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Couldn't load this document" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    urlResult = {
      data: { presignedurl: "https://example.test/doc.pdf" },
      isLoading: false,
      isError: false,
      refetch,
    }
    rerender(<ReferenceDocPanel fileId="f1" fileName="notes.pdf" onClose={vi.fn()} />)
    expect(screen.getByTitle("notes.pdf")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load this document" })).not.toBeInTheDocument()
  })
})
