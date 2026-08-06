import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { MdCheckCircle, MdRadioButtonUnchecked } from "react-icons/md"
import { cn } from "@/lib/utils"
import { useCoursePage, useCourses } from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import { getModuleStatus } from "@/utils/moduleStatus"
import { groupConcepts, computeConceptProgress } from "@/utils/courseProgress"
import { titleCase, toRoman } from "@/utils/formatters"
import { PageContainer } from "@/components/composed/PageContainer"
import { EmptyState } from "@/components/composed/EmptyState"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { toUserMessage } from "@/services/apiError"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"
import { Collapse } from "@/components/ui/collapse"
import { CourseHeader } from "./CourseHeader"
import { LearningJourneyBar } from "./LearningJourneyBar"

// groupConcepts lives in utils/courseProgress; re-exported for existing imports/tests.
export { groupConcepts }

/**
 * Student course view — Figma 143:1427. Shared `CourseHeader` + `LearningJourneyBar`,
 * then a Concepts accordion where each concept is a bordered card showing
 * `X/Y completed` (modules) and, when expanded, its module links with a completion
 * circle.
 *
 * The header is collapsible (Reduce/Expand, top-right) like the module chat
 * (Figma 162:3817 / 209:4781): reduced, it shrinks to `‹ COURSES  <code>` and the
 * Learning Journey bar gives way to a full-bleed rule, keeping the Concepts list
 * in focus.
 */
export function CourseView() {
  const { courseId } = useParams()
  const { isInstructorAsStudent } = useAuth()

  const { data: rows = [], isLoading, isError, error, refetch } = useCoursePage(courseId)
  const coursesQuery = useCourses({ asInstructor: isInstructorAsStudent })
  const course = coursesQuery.data?.find((c) => c.course_id === courseId)

  const { concepts, totalConcepts, completedConcepts, percent } = useMemo(
    () => computeConceptProgress(rows),
    [rows]
  )

  const conceptIds = concepts.map((c) => c.concept_id)
  const [open, setOpen] = useState([])
  // Collapsible course header (Reduce/Expand, top-right), mirroring the module chat.
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  // Expand/Collapse-all toggle — "Expand all" is active by default, so every
  // concept is open on first load; only the two toggle buttons change this.
  const [expandedMode, setExpandedMode] = useState(true)
  const seededRef = useRef(false)
  useEffect(() => {
    if (!seededRef.current && conceptIds.length) {
      seededRef.current = true
      setOpen(conceptIds)
    }
  }, [conceptIds])

  return (
    <PageContainer>
      <CourseHeader
        course={course}
        loading={coursesQuery.isLoading}
        collapsible
        collapsed={headerCollapsed}
        onToggleCollapse={() => setHeaderCollapsed((v) => !v)}
      />
      {/* Learning Journey — slides open/closed with the header via the shared
          Collapse primitive. The full-bleed wrapper owns the edge-to-edge bottom
          rule, which remains as the separator once reduced; the bar renders
          `fullBleed={false}` so the clip doesn't crop that rule. */}
      <div className="relative left-1/2 w-screen -translate-x-1/2 border-b border-border">
        <Collapse open={!headerCollapsed}>
          <LearningJourneyBar
            concepts={concepts}
            completedConcepts={completedConcepts}
            totalConcepts={totalConcepts}
            percent={percent}
            loading={isLoading}
            fullBleed={false}
          />
        </Collapse>
      </div>

      <div className="mt-6 mb-6 flex items-center justify-between">
        <h2 className="text-lg leading-7 font-semibold text-neutral-900">Concepts</h2>
        <div className="flex items-center gap-2 text-caption">
          <button
            type="button"
            aria-pressed={expandedMode}
            onClick={() => {
              setExpandedMode(true)
              setOpen(conceptIds)
            }}
            className={cn(
              "text-lg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              expandedMode ? "font-semibold text-primary" : "font-normal text-neutral-500"
            )}
          >
            Expand all
          </button>
          <span className="text-border" aria-hidden="true">|</span>
          <button
            type="button"
            aria-pressed={!expandedMode}
            onClick={() => {
              setExpandedMode(false)
              setOpen([])
            }}
            className={cn(
              "text-lg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !expandedMode ? "font-semibold text-primary" : "font-normal text-neutral-500"
            )}
          >
            Collapse all
          </button>
        </div>
      </div>

      <div>
        {isLoading ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading concepts">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't load this course"
            description={toUserMessage(error)}
            onRetry={() => refetch()}
          />
        ) : concepts.length === 0 ? (
          <EmptyState title="No modules yet" description="This course doesn't have any modules." />
        ) : (
          <Accordion type="multiple" value={open} onValueChange={setOpen} className="flex flex-col gap-2">
            {concepts.map((concept, i) => (
              <AccordionItem
                key={concept.concept_id}
                value={concept.concept_id}
                className="border border-border p-4"
              >
                <AccordionTrigger className="gap-4 font-normal hover:no-underline">
                  <span className="flex flex-1 items-center justify-between gap-3 pr-2 text-left">
                    <span className="text-neutral-900 text-lg leading-7">
                      {i + 1}. {titleCase(concept.concept_name)}
                    </span>
                    <span className="shrink-0 text-foreground text-lg leading-7">
                      {concept.completedModules}/{concept.totalModules} completed
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="ml-20 mt-8 pb-0 mr-14">
                  <p className="mb-4 text-lg leading-7 font-semibold text-neutral-900">Modules:</p>
                  <ul className="flex flex-col gap-4 text-lg leading-7">
                    {concept.modules.map((module, idx) => {
                      const complete = getModuleStatus(module) === "complete"
                      return (
                        <li key={module.module_id} className="flex items-center justify-between gap-3">
                          <Link
                            to={`/courses/${courseId}/modules/${module.module_id}`}
                            className="text-lg leading-7 text-primary underline underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {toRoman(idx + 1)}. {titleCase(module.module_name)}
                          </Link>
                          {complete ? (
                            <Icon icon={MdCheckCircle} size={24} className="shrink-0 text-success" label="Complete" />
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
