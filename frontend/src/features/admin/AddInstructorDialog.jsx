import { useState } from "react"
import { toast } from "react-toastify"
import { MdAdd } from "react-icons/md"
import { useElevateInstructor } from "@/services/queries"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Add an instructor</DialogTitle>
              <DialogDescription>
                Enter the instructor&rsquo;s email. They get instructor access the next time they sign in.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex flex-col gap-1.5">
              <Label htmlFor="instructor-email">Email</Label>
              <Input
                id="instructor-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                maxLength={40}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={elevate.isPending}>
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
