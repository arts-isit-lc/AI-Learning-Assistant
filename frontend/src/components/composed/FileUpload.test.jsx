import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FileUpload } from "./FileUpload"

describe("FileUpload", () => {
  it("emits selected files via onFiles", () => {
    const onFiles = vi.fn()
    render(<FileUpload onFiles={onFiles} />)
    const input = screen.getByLabelText("Upload files")
    const file = new File(["x"], "notes.pdf", { type: "application/pdf" })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onFiles).toHaveBeenCalled()
    expect(onFiles.mock.calls[0][0][0].name).toBe("notes.pdf")
  })

  it("does not emit when disabled", () => {
    const onFiles = vi.fn()
    render(<FileUpload onFiles={onFiles} disabled />)
    expect(screen.getByRole("button", { name: "Browse files" })).toBeDisabled()
  })
})
