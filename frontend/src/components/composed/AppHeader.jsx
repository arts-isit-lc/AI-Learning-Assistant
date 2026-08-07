import { Link, useNavigate } from "react-router"
import { MdLogout, MdVisibility, MdVisibilityOff } from "react-icons/md"
import { useAuth } from "@/context/AuthContext"
import { Icon } from "@/components/ui/icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import ubcLogo from "@/assets/ubc-logo.svg"

/** Two-letter initials from an email/username for the avatar fallback. */
function initialsFrom(text) {
  if (!text) return "?"
  const name = String(text).split("@")[0]
  const parts = name.split(/[.\-_\s]+/).filter(Boolean)
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")
  return (letters || name[0] || "?").toUpperCase()
}

/**
 * OCELIA top banner (Figma `Header` 859:7184 — Student/Instructor/Administrator
 * variants share this layout). Structure matches the frame exactly:
 *   [ crest | OCELIA ]  ......................  [ avatar  email ]
 * The crest sits in a right-bordered box, the purple letter-spaced OCELIA
 * wordmark next to it; the account cluster is a left-bordered full-height box
 * with a solid-purple avatar + the account **email** in purple. Brand + account
 * ONLY — role navigation lives in the bars below (instructor → `InstructorTabBar`;
 * admin → its layout nav), never in the banner. All dividers use `border-border`
 * (#808080), per the frame. The role-specific affordance (the "View as student"
 * toggle) is keyed off the derived `role` from AuthContext, so the component
 * needs no role prop.
 */
export function AppHeader() {
  const { user, role, signOut, isInstructorAsStudent, setIsInstructorAsStudent } = useAuth()
  const navigate = useNavigate()
  const account = user?.email || user?.username || ""

  // "View as student" is an instructor-only affordance, keyed off the real
  // derived `role`. While previewing, the instructor is on the student route
  // (inside StudentLayout), yet their role stays "instructor" — so gating on the
  // true role keeps the "Exit student view" control reachable there to flip back.
  const canViewAsStudent = role === "instructor"

  // The app chooses the experience from the URL (see roleHome), not from the
  // flag alone — so the toggle must set the flag AND navigate to the matching
  // home. Same seam as ConfigurationTab's `openStudentView`. Pass an explicit
  // boolean (not an updater) so the flag and the navigation target stay in sync.
  const toggleStudentView = () => {
    const next = !isInstructorAsStudent
    setIsInstructorAsStudent(next)
    navigate(next ? "/courses" : "/instructor/courses")
  }

  return (
    <header className="sticky top-0 z-sticky border-b border-border bg-background">
      <div className="flex items-stretch justify-between">
        <Link
          to="/"
          aria-label="OCELIA home"
          className="flex items-stretch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="flex items-center border-r border-border px-6 py-4">
            <img src={ubcLogo} alt="University of British Columbia" className="h-12 w-auto" />
          </span>
          <span className="flex items-center px-6">
            <img src="/OCELIA_logo.svg" alt="OCELIA" className="h-9 w-auto" />
          </span>
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-4 self-stretch border-l border-border px-6 text-caption text-primary transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label="Account menu"
          >
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground">
                {initialsFrom(account)}
              </AvatarFallback>
            </Avatar>
            {account && <span className="hidden max-w-[16rem] truncate sm:inline">{account}</span>}
          </DropdownMenuTrigger>
          {/*
            Account menu — Figma `Modal/UserAccount` (1679:7719). A 180px white
            card: black email header, then purple icon+text rows separated by
            #808080 (border) dividers, each row filling with #F2E8FF
            (primary-subtle) on hover/focus. p-0 + rounded-[4px] + overflow-hidden
            so the stacked full-width rows clip to the card's rounded corners.
          */}
          <DropdownMenuContent
            align="start"
            sideOffset={4}
            className="w-[180px] rounded-[4px] p-0 shadow-modal"
          >
            {account && (
              <DropdownMenuLabel className="truncate border-b border-border px-2 py-2 font-normal text-neutral-900">
                {account}
              </DropdownMenuLabel>
            )}
            {canViewAsStudent && (
              <DropdownMenuItem
                onClick={toggleStudentView}
                className="rounded-none border-b border-border px-2 py-2 text-primary hover:bg-primary-subtle focus:bg-primary-subtle focus:text-primary"
              >
                <Icon icon={isInstructorAsStudent ? MdVisibilityOff : MdVisibility} size={16} />
                {isInstructorAsStudent ? "Exit student view" : "View as student"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={signOut}
              className="rounded-none rounded-b-[4px] px-2 py-2 text-primary hover:bg-primary-subtle focus:bg-primary-subtle focus:text-primary"
            >
              <Icon icon={MdLogout} size={16} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
