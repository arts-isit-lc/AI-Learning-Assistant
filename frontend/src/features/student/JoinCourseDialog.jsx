import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useCourses, useEnrollCourse } from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const schema = z.object({
  code: z.string().trim().min(1, "Enter your access code"),
})

const ALREADY_JOINED_MESSAGE =
  "You've already joined this course. To access it, close this dialog window and find the course on your Courses dashboard."

/**
 * Join-by-code modal — Figma `Modal/Join course` (859:6784): title over a
 * divider, instructions, a course-code input, a privacy notice, and Cancel /
 * Join course actions. RHF + Zod → `useEnrollCourse`; validation + enrollment
 * errors render inline; success closes the modal. (Copy reworded off the frame's
 * "6-digit" — the access code is the 16-char code, per decision B3.)
 */
export function JoinCourseDialog({ open, onOpenChange }) {
  const { isInstructorAsStudent } = useAuth()
  // Same cached query StudentHome already loads (matching the asInstructor flag),
  // so this adds no extra request. Each course carries its access code.
  const { data: courses = [] } = useCourses({ asInstructor: isInstructorAsStudent })
  const enroll = useEnrollCourse()
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { code: "" } })

  const close = (value) => {
    if (!value) reset()
    onOpenChange(value)
  }

  const onSubmit = ({ code }) => {
    // `code` is already trimmed by the Zod schema. Pre-check it against the
    // student's enrolled courses so an already-joined code shows the message
    // (and keeps the modal open) without a round trip that would otherwise
    // report success and close the modal.
    if (courses.some((c) => c.course_access_code === code)) {
      setError("code", { message: ALREADY_JOINED_MESSAGE })
      return
    }
    enroll.mutate(code, {
      onSuccess: () => {
        reset()
        onOpenChange(false)
      },
      onError: (err) => {
        let message
        if (err?.status === 409) {
          // Backend backstop for the already-enrolled case (e.g. a course not in
          // the cached list yet), mirroring the pre-check above.
          message = ALREADY_JOINED_MESSAGE
        } else if (err?.status === 404 || err?.status === 400) {
          message = "That access code isn't valid."
        } else {
          message = "Couldn't join the course. Please try again."
        }
        setError("code", { message })
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join course</DialogTitle>
        </DialogHeader>
        {/* min-h-0 + flex-1 lets the form fill the capped modal so DialogBody
            scrolls between the pinned header and footer. */}
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col gap-8">
          <DialogBody>
            <DialogDescription>
              Enter the access code from your instructor or administrator to join the course on OCELIA.
            </DialogDescription>
            <div className="flex flex-col gap-1.5">
              <Input
                aria-label="Access code"
                placeholder="Enter access code"
                autoFocus
                aria-invalid={errors.code ? true : undefined}
                {...register("code")}
              />
              {errors.code && <p className="text-caption text-destructive">{errors.code.message}</p>}
            </div>
            <p className="text-base text-muted-foreground">
              <span className="font-semibold text-foreground">Privacy notice:</span> OCELIA collects
              usage data to help evaluate course activity and improve your experience. This data is
              anonymized and does not include personally identifiable information. By joining a course,
              you agree to this data collection.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" className="hover:bg-primary-dark" loading={enroll.isPending}>
              Join course
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
