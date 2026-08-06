import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { CourseHeader } from "./CourseHeader"

// Renders inside a router because the "‹ COURSES" back link is a <Link>.
function renderHeader(props) {
  return render(
    <MemoryRouter>
      <CourseHeader {...props} />
    </MemoryRouter>
  )
}

const COURSE = {
  course_id: "c1",
  course_department: "geog",
  course_number: "412",
  course_name: "water management: theory, policy and practice",
  term: "2025 Winter Term 2",
  section: "101",
  instructors: [
    { first_name: "Ada", last_name: "Lovelace", user_email: "ada@ubc.ca" },
    { first_name: "Alan", last_name: "Turing", user_email: "alan@ubc.ca" },
  ],
}

describe("CourseHeader", () => {
  it("removes the Courses link underline on hover", () => {
    renderHeader({ course: COURSE })
    expect(screen.getByRole("link", { name: /courses/i })).toHaveClass("underline", "hover:no-underline")
  })

  it("removes the Reduce control underline on hover", () => {
    renderHeader({ course: COURSE, collapsible: true, onToggleCollapse: () => {} })
    expect(screen.getByRole("button", { name: /reduce/i })).toHaveClass("underline", "hover:no-underline")
  })

  it("renders the course code as the heading", () => {
    renderHeader({ course: COURSE })
    expect(screen.getByRole("heading", { name: "GEOG 412" })).toBeInTheDocument()
  })

  it("lists every instructor with a name and a mailto email link (Figma 143:1427)", () => {
    renderHeader({ course: COURSE })

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByText("Alan Turing")).toBeInTheDocument()

    expect(screen.getByRole("link", { name: "ada@ubc.ca" })).toHaveAttribute(
      "href",
      "mailto:ada@ubc.ca"
    )
    expect(screen.getByRole("link", { name: "alan@ubc.ca" })).toHaveAttribute(
      "href",
      "mailto:alan@ubc.ca"
    )
  })

  it("shows term and section in the top-right meta, prefixing 'Section'", () => {
    renderHeader({ course: COURSE })
    expect(screen.getByText("2025 Winter Term 2")).toBeInTheDocument()
    // section is a bare token ("101") stored on the course; the header labels it.
    expect(screen.getByText("Section 101")).toBeInTheDocument()
  })

  it("falls back to the email alone for an invited instructor with no name yet", () => {
    renderHeader({
      course: {
        ...COURSE,
        instructors: [{ user_email: "invited@ubc.ca", first_name: null, last_name: null }],
      },
    })
    expect(screen.getByRole("link", { name: "invited@ubc.ca" })).toHaveAttribute(
      "href",
      "mailto:invited@ubc.ca"
    )
  })

  it("renders no instructor emails when the list is empty", () => {
    renderHeader({ course: { ...COURSE, instructors: [] } })
    expect(screen.queryByRole("link", { name: /ubc\.ca/ })).not.toBeInTheDocument()
  })

  it("omits the term/section meta when the course has neither", () => {
    renderHeader({ course: { ...COURSE, term: null, section: null } })
    expect(screen.queryByText("2025 Winter Term 2")).not.toBeInTheDocument()
    expect(screen.queryByText("Section 101")).not.toBeInTheDocument()
  })

  it("never renders a Syllabus button (feature intentionally omitted)", () => {
    renderHeader({ course: COURSE })
    expect(screen.queryByText(/syllabus/i)).not.toBeInTheDocument()
  })

  it("reduced (chat) shows the back link + compact code + Expand, hiding the details from AT (Figma 209:4781)", () => {
    renderHeader({ course: COURSE, collapsible: true, collapsed: true, onToggleCollapse: () => {} })

    expect(screen.getByRole("link", { name: /courses/i })).toBeInTheDocument()
    // Compact code in the reduced one-liner is a span, not the h1 title — the h1
    // stays mounted for the slide but is hidden from assistive tech.
    expect(screen.getByText("GEOG 412", { selector: "span" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /expand/i })).toBeInTheDocument()

    // Details are collapsed and hidden from assistive tech: the h1 title and the
    // instructor email links are out of the accessibility tree.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "ada@ubc.ca" })).not.toBeInTheDocument()
  })

  it("shows the instructor list on the expanded chat header too (shared component)", () => {
    renderHeader({ course: COURSE, collapsible: true, collapsed: false, onToggleCollapse: () => {} })
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "ada@ubc.ca" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reduce/i })).toBeInTheDocument()
  })

  it("skeletons the course identity while loading — no placeholder 'Course' title flashes, back link stays", () => {
    renderHeader({ loading: true })
    // The wait is announced (role=status), matching the app-wide loading pattern.
    expect(screen.getByRole("status", { name: /loading course/i })).toBeInTheDocument()
    // No stale "Course" heading pops in before the real code resolves.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument()
    // Static chrome (the back link) is still available during the wait.
    expect(screen.getByRole("link", { name: /courses/i })).toBeInTheDocument()
  })

  it("shows a compact skeleton (not a 'Course' placeholder) when reduced while loading", () => {
    renderHeader({ loading: true, collapsible: true, collapsed: true, onToggleCollapse: () => {} })
    expect(screen.queryByText("Course")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /courses/i })).toBeInTheDocument()
  })
})
