import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mutate = vi.fn()
vi.mock("@/services/queries", () => ({
  useEnrollCourse: () => ({ mutate, isPending: false }),
}))

import { JoinCourseDialog } from "./JoinCourseDialog"

beforeEach(() => mutate.mockReset())

describe("JoinCourseDialog", () => {
  it("shows a validation error when the code is empty", async () => {
    render(<JoinCourseDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Join course" }))
    expect(await screen.findByText("Enter your access code")).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("submits a valid access code", async () => {
    render(<JoinCourseDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText(/access code/i), "65XH19000jo12")
    await userEvent.click(screen.getByRole("button", { name: "Join course" }))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith("65XH19000jo12", expect.any(Object))
    )
  })
})
