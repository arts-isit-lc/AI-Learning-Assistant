import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "react-toastify"
import { useEnrollCourse } from "@/services/queries"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const schema = z.object({
  code: z.string().trim().min(1, "Enter your access code"),
})

/**
 * Join-by-code modal — Figma `Modal/Join course` (859:6784): title over a
 * divider, instructions, a course-code input, a privacy notice, and Cancel /
 * Join course actions. RHF + Zod → `useEnrollCourse`; validation + enrollment
 * errors render inline; success closes and toasts. (Copy reworded off the frame's
 * "6-digit" — the access code is the 16-char code, per decision B3.)
 */
export function JoinCourseDialog({ open, onOpenChange }) {
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
    enroll.mutate(code, {
      onSuccess: () => {
        toast.success("Joined course!")
        reset()
        onOpenChange(false)
      },
      onError: (err) => {
        setError("code", {
          message:
            err?.status === 404 || err?.status === 400
              ? "That access code isn't valid."
              : "Couldn't join the course. Please try again.",
        })
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join course</DialogTitle>
        </DialogHeader>
        <div className="border-t border-border" aria-hidden="true" />
        <DialogDescription className="text-body text-foreground">
          Enter the access code from your instructor or administrator to join the course on OCELIA.
        </DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Input
              aria-label="Access code"
              placeholder="Enter course code"
              autoFocus
              aria-invalid={errors.code ? true : undefined}
              {...register("code")}
            />
            {errors.code && <p className="text-caption text-destructive">{errors.code.message}</p>}
          </div>
          <p className="text-caption text-muted-foreground">
            <span className="font-semibold text-foreground">Privacy notice:</span> OCELIA collects usage
            data to help evaluate course activity and improve your experience. This data is anonymized and
            does not include personally identifiable information. By joining a course, you agree to this
            data collection.
          </p>
          <DialogFooter className="border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={enroll.isPending}>
              Join course
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
