import { useMemo } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { MdInsights, MdCheck } from "react-icons/md"
import { useCoursePage, useCourses } from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import { getModuleStatus } from "@/utils/moduleStatus"
import { titleCase } from "@/utils/formatters"
import { PageContainer } from "@/components/composed/PageContainer"
import { Breadcrumb } from "@/components/composed/Breadcrumb"
import { EmptyState } from "@/components/composed/EmptyState"
import { ListRow } from "@/components/composed/ListRow"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"

const STATUS_BADGE = {
  complete: { label: "Complete", variant: "success" },
  in_progress: { label: "In progress", variant: "info" },
  incomplete: { label: "Not started", variant: "secondary" },
}

/** Group flat course_page rows into concepts, each with its modules + avg score. */
export function groupConcepts(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.concept_id)) {
      map.set(row.concept_id, {
        concept_id: row.concept_id,
        concept_name: row.concept_name,
        modules: [],
      })
    }
    map.get(row.concept_id).modules.push(row)
  }
  return Array.from(map.values()).map((concept) => {
    const scores = concept.modules.map((m) => m.module_score || 0)
    const average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
    return { ...concept, average }
  })
}

/** Student course view — concept accordion + module rows + Learning Journey. */
export function CourseView() {
  const { courseId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const expandAll = searchParams.get("expand") === "1"
  const { isInstructorAsStudent } = useAuth()

  const { data: rows = [], isLoading, isError } = useCoursePage(courseId)
  const coursesQuery = useCourses({ asInstructor: isInstructorAsStudent })
  const course = coursesQuery.data?.find((c) => c.course_id === courseId)

  const concepts = useMemo(() => groupConcepts(rows), [rows])
  const title = course
    ? `${String(course.course_department).toUpperCase()} ${course.course_number}`
    : "Course"
  const defaultOpen = expandAll ? concepts.map((c) => c.concept_id) : []

  return (
    <PageContainer>
      <Breadcrumb items={[{ label: "Courses", to: "/courses" }, { label: title }]} />

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-h2 font-semibold text-navy">{title}</h1>
          {course?.course_name && (
            <p className="text-body text-muted-foreground">{titleCase(course.course_name)}</p>
          )}
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" className="gap-2">
              <Icon icon={MdInsights} size={18} />
              Learning journey
            </Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Learning journey</SheetTitle>
            </SheetHeader>
            <ul className="mt-4 flex flex-col gap-4 overflow-y-auto">
              {concepts.map((concept, i) => (
                <li key={concept.concept_id} className="flex items-center gap-3">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-caption font-semibold ${
                      concept.average === 100
                        ? "bg-success text-success-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {concept.average === 100 ? <Icon icon={MdCheck} size={16} label="Complete" /> : i + 1}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-caption font-semibold text-foreground">
                      {titleCase(concept.concept_name)}
                    </span>
                    <span className="text-caption text-muted-foreground">{concept.average}% average</span>
                  </div>
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
      </div>

      <div className="mt-6">
        {isLoading ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&rsquo;t load this course</AlertTitle>
            <AlertDescription>Please refresh and try again.</AlertDescription>
          </Alert>
        ) : concepts.length === 0 ? (
          <EmptyState title="No modules yet" description="This course doesn't have any modules." />
        ) : (
          <Accordion type="multiple" defaultValue={defaultOpen} className="rounded-lg border border-border">
            {concepts.map((concept) => (
              <AccordionItem key={concept.concept_id} value={concept.concept_id} className="px-4">
                <AccordionTrigger>
                  <span className="flex items-center gap-2">
                    {titleCase(concept.concept_name)}
                    <span className="text-caption font-normal text-muted-foreground">
                      ({concept.modules.length})
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2 pb-2">
                    {concept.modules.map((module) => {
                      const status = STATUS_BADGE[getModuleStatus(module)]
                      return (
                        <ListRow
                          key={module.module_id}
                          onClick={() => navigate(`/courses/${courseId}/modules/${module.module_id}`)}
                        >
                          <span className="min-w-0 flex-1 truncate text-caption text-foreground">
                            {titleCase(module.module_name)}
                          </span>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </ListRow>
                      )
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </PageContainer>
  )
}
