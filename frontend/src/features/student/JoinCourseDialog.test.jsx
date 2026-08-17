import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mutate = vi.fn()
vi.mock("@/services/queries", () => ({
  useEnrollCourse: () => ({ mutate, isPending: false }),
}))

import { JoinCourseDialog } from "./JoinCourseDialog"

beforeEach(() => mutate.mockReset())

describe("JoinCourseDialog", () => {
  it("hovers the Join course button to #2E0666 (primary-dark)", () => {
    render(<JoinCourseDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole("button", { name: "Join course" })).toHaveClass("hover:bg-primary-dark")
  })

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

  it("shows the already-joined message inline under the code field on a 409", async () => {
    render(<JoinCourseDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText(/access code/i), "65XH19000jo12")
    await userEvent.click(screen.getByRole("button", { name: "Join course" }))
    await waitFor(() => expect(mutate).toHaveBeenCalled())

    // Drive the mutation's onError as an already-enrolled (409) failure.
    const [, opts] = mutate.mock.calls[0]
    act(() => opts.onError({ status: 409 }))

    const err = await screen.findByText(
      "You've already joined this course. To access it, close this dialog window and find the course on your Courses dashboard.",
    )
    // Rendered in red (destructive) directly under the access-code input.
    expect(err).toHaveClass("text-caption", "text-destructive")
    expect(screen.getByLabelText(/access code/i)).toHaveAttribute("aria-invalid", "true")
  })

  it("shows an invalid-code message inline on a 404/400", async () => {
    render(<JoinCourseDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText(/access code/i), "badcode")
    await userEvent.click(screen.getByRole("button", { name: "Join course" }))
    await waitFor(() => expect(mutate).toHaveBeenCalled())

    const [, opts] = mutate.mock.calls[0]
    act(() => opts.onError({ status: 404 }))

    expect(await screen.findByText("That access code isn't valid.")).toBeInTheDocument()
  })
})
