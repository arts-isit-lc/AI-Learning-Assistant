import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { CourseProvider, useCourse, extractIds } from "./CourseContext"

function Probe() {
  const { courseId, moduleId } = useCourse()
  return (
    <div>
      <span data-testid="course">{courseId ?? "none"}</span>
      <span data-testid="module">{moduleId ?? "none"}</span>
    </div>
  )
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CourseProvider>
        <Probe />
      </CourseProvider>
    </MemoryRouter>
  )
}

describe("extractIds", () => {
  it("reads courseId from student, instructor, and admin paths", () => {
    expect(extractIds("/courses/c1")).toEqual({ courseId: "c1", moduleId: null })
    expect(extractIds("/instructor/courses/c2/settings")).toEqual({
      courseId: "c2",
      moduleId: null,
    })
    expect(extractIds("/admin/courses/c3")).toEqual({ courseId: "c3", moduleId: null })
  })

  it("reads moduleId but ignores the 'new' sentinel", () => {
    expect(extractIds("/courses/c1/modules/m1")).toEqual({ courseId: "c1", moduleId: "m1" })
    expect(extractIds("/instructor/courses/c1/modules/new")).toEqual({
      courseId: "c1",
      moduleId: null,
    })
    expect(extractIds("/instructor/courses/c1/modules/m9/edit")).toEqual({
      courseId: "c1",
      moduleId: "m9",
    })
  })

  it("returns nulls when there is no course in the path", () => {
    expect(extractIds("/admin/instructors")).toEqual({ courseId: null, moduleId: null })
    expect(extractIds("/")).toEqual({ courseId: null, moduleId: null })
  })
})

describe("CourseProvider", () => {
  it("derives the active IDs from the URL", () => {
    renderAt("/courses/abc/modules/xyz")
    expect(screen.getByTestId("course")).toHaveTextContent("abc")
    expect(screen.getByTestId("module")).toHaveTextContent("xyz")
  })
})
