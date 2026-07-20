import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FileRow } from "./FileRow"

describe("FileRow", () => {
  it("shows the file name and fires onDelete", async () => {
    const onDelete = vi.fn()
    render(<FileRow file={{ file_id: "f1", file_name: "syllabus.pdf" }} onDelete={onDelete} />)
    expect(screen.getByText("syllabus.pdf")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Delete syllabus.pdf" }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
