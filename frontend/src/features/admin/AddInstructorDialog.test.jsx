import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const elevate = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
vi.mock("@/services/queries", () => ({ useElevateInstructor: () => elevate }))
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AddInstructorDialog } from "./AddInstructorDialog"

beforeEach(() => {
  elevate.mutateAsync.mockClear()
  elevate.mutateAsync.mockResolvedValue({})
})

describe("AddInstructorDialog", () => {
  it("opens from the header trigger and elevates the entered email", async () => {
    render(<AddInstructorDialog />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    await userEvent.type(screen.getByLabelText("Email address"), "new@x.com")
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }))
    expect(elevate.mutateAsync).toHaveBeenCalledWith("new@x.com")
  })

  it("multi-add adds a field and elevates every entered email", async () => {
    render(<AddInstructorDialog />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    await userEvent.type(screen.getByLabelText("Email address"), "a@x.com")
    await userEvent.click(screen.getByRole("button", { name: "multi-add +" }))
    await userEvent.type(screen.getByLabelText("Email address 2"), "b@x.com")
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }))
    expect(elevate.mutateAsync).toHaveBeenCalledWith("a@x.com")
    expect(elevate.mutateAsync).toHaveBeenCalledWith("b@x.com")
    expect(elevate.mutateAsync).toHaveBeenCalledTimes(2)
  })
})
