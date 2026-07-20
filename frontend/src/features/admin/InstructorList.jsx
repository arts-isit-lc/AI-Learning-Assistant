import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdAdd } from "react-icons/md"
import { useAdminInstructors, useElevateInstructor } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { Searchbar } from "@/components/composed/Searchbar"
import { ListRow } from "@/components/composed/ListRow"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

/** Display name for an instructor, falling back to the email before signup. */
export function instructorLabel(instructor) {
  if (instructor.first_name && instructor.last_name) {
    return `${titleCase(instructor.first_name)} ${titleCase(instructor.last_name)}`
  }
  return instructor.user_email
}

/**
 * Instructor management master pane (rendered as the SplitLayout `list`). Search
 * + navigate to a detail; "Add" opens an email dialog that elevates a user to
 * instructor (creating a pending row if they haven't signed up yet).
 */
export function InstructorList() {
  const navigate = useNavigate()
  const { instructorId } = useParams()
  const selectedEmail = instructorId ? decodeURIComponent(instructorId) : null

  const { data: instructors = [], isLoading } = useAdminInstructors()
  const elevate = useElevateInstructor()
  const [query, setQuery] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [email, setEmail] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return instructors
    return instructors.filter((i) => `${instructorLabel(i)} ${i.user_email}`.toLowerCase().includes(q))
  }, [instructors, query])

  const submitAdd = (e) => {
    e.preventDefault()
    const value = email.trim()
    if (!value) return
    elevate.mutate(value, {
      onSuccess: () => {
        setEmail("")
        setAddOpen(false)
        toast.success("Instructor added")
      },
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-h4 font-semibold text-navy">Instructors</h1>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Icon icon={MdAdd} size={18} /> Add
        </Button>
      </div>
      <Searchbar value={query} onChange={setQuery} placeholder="Search instructors" />

      <div className="flex max-h-[calc(100vh-16rem)] flex-col gap-2 overflow-y-auto">
        {isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)
        ) : filtered.length === 0 ? (
          <p className="px-1 text-caption text-muted-foreground">No instructors found.</p>
        ) : (
          filtered.map((instructor) => {
            const named = Boolean(instructor.first_name && instructor.last_name)
            return (
              <ListRow
                key={instructor.user_email}
                selected={selectedEmail === instructor.user_email}
                onClick={() =>
                  navigate(`/admin/instructors/${encodeURIComponent(instructor.user_email)}`)
                }
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-caption font-semibold text-foreground group-aria-[current=true]:text-primary-foreground">
                    {instructorLabel(instructor)}
                  </span>
                  <span className="truncate text-caption text-muted-foreground group-aria-[current=true]:text-primary-foreground/80">
                    {named ? instructor.user_email : "Invited — awaiting signup"}
                  </span>
                </div>
              </ListRow>
            )
          })
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <form onSubmit={submitAdd}>
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
              <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={elevate.isPending}>
                Add instructor
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
