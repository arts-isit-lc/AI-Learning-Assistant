import { useState } from "react"
import { toast } from "react-toastify"
import { MdAdd, MdClose } from "react-icons/md"
import { useElevateInstructor } from "@/services/queries"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

/**
 * "Add instructor" page action (admin chrome). Header-row trigger + an email
 * dialog that elevates users to instructor (creating pending rows for those who
 * haven't signed up yet). Matches the `Modal/Admin/Add Instructor` frame:
 * title-over-divider, prompt, one-or-more email fields with a `multi-add +`
 * link, then a divider over the Cancel (purple outline) / Send invite footer.
 */
export function AddInstructorDialog() {
  const elevate = useElevateInstructor()
  const [open, setOpen] = useState(false)
  const [emails, setEmails] = useState([""])

  const setEmailAt = (index, value) =>
    setEmails((prev) => prev.map((e, i) => (i === index ? value : e)))
  const addField = () => setEmails((prev) => [...prev, ""])
  const removeField = (index) => setEmails((prev) => prev.filter((_, i) => i !== index))

  const close = () => {
    setOpen(false)
    setEmails([""])
  }

  const submit = async (e) => {
    e.preventDefault()
    const values = [...new Set(emails.map((v) => v.trim()).filter(Boolean))]
    if (values.length === 0) return
    const results = await Promise.allSettled(values.map((email) => elevate.mutateAsync(email)))
    const added = results.filter((r) => r.status === "fulfilled").length
    const failed = results.length - added
    if (added > 0) {
      toast.success(added === 1 ? "Instructor added" : `${added} instructors added`)
    }
    if (failed > 0) {
      toast.error(`${failed} ${failed === 1 ? "invite" : "invites"} could not be sent`)
    }
    if (added > 0) close()
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Add instructor <Icon icon={MdAdd} size={18} />
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-6">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle>Add instructor(s)</DialogTitle>
            </DialogHeader>
            <DialogDescription className="text-body text-foreground">
              To add an instructor, enter their email address below. They get instructor access the
              next time they sign in.
            </DialogDescription>

            <div className="flex flex-col gap-3">
              {emails.map((email, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    type="email"
                    aria-label={index === 0 ? "Email address" : `Email address ${index + 1}`}
                    placeholder="Email address"
                    value={email}
                    onChange={(e) => setEmailAt(index, e.target.value)}
                    required={index === 0}
                    autoFocus={index === 0}
                    maxLength={40}
                  />
                  {emails.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove email ${index + 1}`}
                      onClick={() => removeField(index)}
                    >
                      <Icon icon={MdClose} size={18} />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addField}
              className="self-start text-body text-foreground transition-colors duration-fast hover:text-primary"
            >
              multi-add +
            </button>

            <DialogFooter className="border-t border-border pt-4">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={elevate.isPending}>
                Send invite
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
