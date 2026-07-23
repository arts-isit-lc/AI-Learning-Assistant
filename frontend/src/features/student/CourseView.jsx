import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { MdCheckCircle, MdRadioButtonUnchecked } from "react-icons/md"
import { useCoursePage, useCourses } from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import { getModuleStatus } from "@/utils/moduleStatus"
import { groupConcepts, computeConceptProgress } from "@/utils/courseProgress"
import { titleCase, toRoman } from "@/utils/formatters"
import { PageContainer } from "@/components/composed/PageContainer"
import { EmptyState } from "@/components/composed/EmptyState"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"
import { CourseHeader } from "./CourseHeader"
import { LearningJourneyBar } from "./LearningJourneyBar"

// groupConcepts lives in utils/courseProgress; re-exported for existing imports/tests.
export { groupConcepts }

/**
 * Student course view — Figma 143:1427 (collapsed) / 151:3297 (expanded).
 * Shared `CourseHeader` + `LearningJourneyBar`, then a Concepts accordion where
 * each concept is a bordered card showing `X/Y completed` (modules) and, when
 * expanded, its module links with a completion circle.
 */
export function CourseView() {
  const { courseId } = useParams()
  const [searchParams] = useSearchParams()
  const expandAll = searchParams.get("expand") === "1"
  const { isInstructorAsStudent } = useAuth()

  const { data: rows = [], isLoading, isError } = useCoursePage(courseId)
  const coursesQuery = useCourses({ asInstructor: isInstructorAsStudent })
  const course = coursesQuery.data?.find((c) => c.course_id === courseId)

  const { concepts, totalConcepts, completedConcepts, percent } = useMemo(
    () => computeConceptProgress(rows),
    [rows]
  )

  const conceptIds = concepts.map((c) => c.concept_id)
  const [open, setOpen] = useState([])
  const seededRef = useRef(false)
  useEffect(() => {
    if (!seededRef.current && expandAll && conceptIds.length) {
      seededRef.current = true
      setOpen(conceptIds)
    }
  }, [expandAll, conceptIds])

  return (
    <PageContainer>
      <CourseHeader course={course} />
      <LearningJourneyBar
        concepts={concepts}
        completedConcepts={completedConcepts}
        totalConcepts={totalConcepts}
        percent={percent}
      />

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg leading-7 font-semibold text-neutral-900">Concepts</h2>
        <div className="flex items-center gap-2 text-caption">
          <button
            type="button"
            onClick={() => setOpen(conceptIds)}
            className="font-semibold text-lg text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Expand all
          </button>
          <span className="text-border" aria-hidden="true">|</span>
          <button
            type="button"
            onClick={() => setOpen([])}
            className="font-semibold text-lg text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Collapse all
          </button>
        </div>
      </div>

      <div className="mt-3">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
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
          <Accordion type="multiple" value={open} onValueChange={setOpen} className="flex flex-col gap-2">
            {concepts.map((concept, i) => (
              <AccordionItem
                key={concept.concept_id}
                value={concept.concept_id}
                className="rounded-sm border border-border px-4"
              >
                <AccordionTrigger className="gap-3 font-normal hover:no-underline">
                  <span className="flex flex-1 items-center justify-between gap-3 pr-2 text-left">
                    <span className="text-neutral-900">
                      {i + 1}. {titleCase(concept.concept_name)}
                    </span>
                    <span className="shrink-0 text-foreground">
                      {concept.completedModules}/{concept.totalModules} completed
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <p className="mb-2 text-caption font-semibold text-neutral-900">Modules:</p>
                  <ul className="flex flex-col gap-3">
                    {concept.modules.map((module, idx) => {
                      const complete = getModuleStatus(module) === "complete"
                      return (
                        <li key={module.module_id} className="flex items-center justify-between gap-3">
                          <Link
                            to={`/courses/${courseId}/modules/${module.module_id}`}
                            className="text-caption text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {toRoman(idx + 1)}. {titleCase(module.module_name)}
                          </Link>
                          {complete ? (
                            <Icon icon={MdCheckCircle} size={20} className="shrink-0 text-success" label="Complete" />
                          ) : (
                            <Icon
                              icon={MdRadioButtonUnchecked}
                              size={20}
                              className="shrink-0 text-muted-foreground"
                              label="Not complete"
                            />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </PageContainer>
  )
}
