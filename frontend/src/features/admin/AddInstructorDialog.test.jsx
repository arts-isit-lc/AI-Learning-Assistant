import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const elevate = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
vi.mock("@/services/queries", () => ({ useElevateInstructor: () => elevate }))

import { AddInstructorDialog } from "./AddInstructorDialog"

beforeEach(() => {
  elevate.mutateAsync.mockClear()
  elevate.mutateAsync.mockResolvedValue({})
})

describe("AddInstructorDialog", () => {
  it("shows the trigger with a white default background that hovers to #F2E8FF (primary-subtle)", () => {
    render(<AddInstructorDialog />)
    const trigger = screen.getByRole("button", { name: "Add instructor" })
    // Outline variant: white (bg-background) at rest, primary-subtle on hover —
    // matching Add concept / Add module. Not the solid-purple default.
    expect(trigger).toHaveClass("bg-background")
    expect(trigger).toHaveClass("hover:bg-primary-subtle")
    expect(trigger).not.toHaveClass("bg-primary")
  })

  it("hovers the Send invite button to #2E0666 (primary-dark)", async () => {
    render(<AddInstructorDialog />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    expect(screen.getByRole("button", { name: "Send invite" })).toHaveClass("hover:bg-primary-dark")
  })

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

  it("keeps the dialog open and reports failures when some invites fail", async () => {
    elevate.mutateAsync.mockRejectedValue(new Error("boom"))
    render(<AddInstructorDialog />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    await userEvent.type(screen.getByLabelText("Email address"), "bad@x.com")
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be sent/i)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByLabelText("Email address")).toHaveValue("bad@x.com")
  })
})
