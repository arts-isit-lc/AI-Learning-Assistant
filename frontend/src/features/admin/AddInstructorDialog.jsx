import { useState } from "react"
import { toast } from "react-toastify"
import { MdAdd } from "react-icons/md"
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
 * "Add instructor" page action (admin chrome). Renders the header-row trigger
 * button + an email dialog that elevates a user to instructor (creating a
 * pending row if they haven't signed up yet). Lives in the admin section header
 * (`AdminLayout`), matching the frame where the action sits on the tab row —
 * not inside the list pane.
 */
export function AddInstructorDialog() {
  const elevate = useElevateInstructor()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")

  const submit = (e) => {
    e.preventDefault()
    const value = email.trim()
    if (!value) return
    elevate.mutate(value, {
      onSuccess: () => {
        setEmail("")
        setOpen(false)
        toast.success("Instructor added")
      },
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Add instructor <Icon icon={MdAdd} size={18} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle>Add instructor(s)</DialogTitle>
            </DialogHeader>
            <DialogDescription>
              To add an instructor, enter their email address below. They get instructor access the
              next time they sign in.
            </DialogDescription>
            <Input
              id="instructor-email"
              type="email"
              aria-label="Email address"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              maxLength={40}
            />
            <DialogFooter className="border-t border-border pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
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
