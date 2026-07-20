import { useStudentMessages } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { BackButton } from "@/components/composed/BackButton"
import { EmptyState } from "@/components/composed/EmptyState"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { MdForum } from "react-icons/md"

const MASTERY_MARK = "STUDENT ACHIEVED COMPETENCY"

/** Highlight the mastery marker inside an otherwise plain message. */
function renderContent(text) {
  if (!text) return null
  if (!text.includes(MASTERY_MARK)) return text
  const [before, ...rest] = text.split(MASTERY_MARK)
  return (
    <>
      {before}
      <span className="rounded bg-success/15 px-1 font-semibold text-success">{MASTERY_MARK}</span>
      {rest.join(MASTERY_MARK)}
    </>
  )
}

/**
 * Read-only viewer of one student's chat history across the course's modules
 * (ported from the legacy StudentDetails). Module tabs -> session accordions ->
 * messages. Rendered inline within the Students tab (via `?student=` param).
 *
 * @param {{ courseId: string, email: string, name?: string, onBack: () => void }} props
 */
export function StudentDetail({ courseId, email, name, onBack }) {
  const { data: byModule = {}, isLoading, isError } = useStudentMessages(courseId, email)
  const moduleNames = Object.keys(byModule)

  return (
    <div className="flex flex-col gap-4">
      <BackButton onClick={onBack}>Back to students</BackButton>
      <div>
        <h2 className="text-h4 font-semibold text-navy">{name || email}</h2>
        <p className="text-caption text-muted-foreground">{email}</p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&rsquo;t load chat history</AlertTitle>
          <AlertDescription>Please refresh and try again.</AlertDescription>
        </Alert>
      ) : moduleNames.length === 0 ? (
        <EmptyState
          icon={MdForum}
          title="No chat history"
          description="This student hasn't chatted with any modules in this course yet."
        />
      ) : (
        <Tabs defaultValue={moduleNames[0]}>
          <TabsList className="flex-wrap">
            {moduleNames.map((m) => (
              <TabsTrigger key={m} value={m}>
                {titleCase(m)}
              </TabsTrigger>
            ))}
          </TabsList>
          {moduleNames.map((m) => {
            const sessions = Array.isArray(byModule[m]) ? byModule[m] : []
            return (
              <TabsContent key={m} value={m}>
                {sessions.length === 0 ? (
                  <p className="py-4 text-caption text-muted-foreground">No sessions in this module.</p>
                ) : (
                  <Accordion type="multiple">
                    {sessions.map((session, i) => (
                      <AccordionItem key={i} value={`${m}-${i}`}>
                        <AccordionTrigger>{session?.sessionName || `Session ${i + 1}`}</AccordionTrigger>
                        <AccordionContent>
                          <ul className="flex flex-col gap-2">
                            {(session?.messages || []).map((msg, j) => (
                              <li
                                key={j}
                                className={cn(
                                  "rounded-md p-2 text-caption",
                                  msg?.student_sent ? "bg-secondary" : "bg-muted"
                                )}
                              >
                                <span className="font-semibold">
                                  {msg?.student_sent ? "Student" : "Assistant"}:{" "}
                                </span>
                                {renderContent(msg?.message_content)}
                              </li>
                            ))}
                          </ul>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                )}
              </TabsContent>
            )
          })}
        </Tabs>
      )}
    </div>
  )
}
