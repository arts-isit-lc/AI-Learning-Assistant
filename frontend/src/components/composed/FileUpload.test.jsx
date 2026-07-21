import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FileUpload } from "./FileUpload"

describe("FileUpload", () => {
  it("emits selected files via onFiles", () => {
    const onFiles = vi.fn()
    const { container } = render(<FileUpload onFiles={onFiles} />)
    const input = container.querySelector('input[type="file"]')
    const file = new File(["x"], "notes.pdf", { type: "application/pdf" })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onFiles).toHaveBeenCalled()
    expect(onFiles.mock.calls[0][0][0].name).toBe("notes.pdf")
  })

  it("shows the click-to-upload affordance and accepted-types hint", () => {
    render(<FileUpload onFiles={vi.fn()} hint="OCELIA can receive jpg, bmp, cbr, pdf, csv" />)
    expect(screen.getByRole("button", { name: "Upload files" })).toBeInTheDocument()
    expect(screen.getByText(/OCELIA can receive/i)).toBeInTheDocument()
  })

  it("is non-interactive when disabled", () => {
    render(<FileUpload onFiles={vi.fn()} disabled />)
    expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled()
  })
})
