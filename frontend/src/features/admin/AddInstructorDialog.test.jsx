import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const elevate = { mutate: vi.fn(), isPending: false }
vi.mock("@/services/queries", () => ({ useElevateInstructor: () => elevate }))

import { AddInstructorDialog } from "./AddInstructorDialog"

beforeEach(() => {
  elevate.mutate.mockClear()
})

describe("AddInstructorDialog", () => {
  it("opens from the header trigger and elevates the entered email", async () => {
    render(<AddInstructorDialog />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    await userEvent.type(screen.getByLabelText("Email"), "new@x.com")
    await userEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(elevate.mutate).toHaveBeenCalledWith("new@x.com", expect.any(Object))
  })
})
