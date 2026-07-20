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
import { FormField } from "@/components/composed/FormField"

const schema = z.object({
  code: z.string().trim().min(1, "Enter your access code"),
})

/**
 * Join-by-code modal (RHF + Zod → `useEnrollCourse`). Validation + enrollment
 * errors render inline in the form; success closes and toasts.
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
          <DialogTitle>Join a course</DialogTitle>
          <DialogDescription>Enter the access code provided by your instructor.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FormField label="Access code" error={errors.code?.message}>
            <Input placeholder="e.g. 65XH19000jo12" autoFocus {...register("code")} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={enroll.isPending}>
              Join
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
