import { Link } from "react-router-dom"
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
  DropdownMenuSeparator,
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
 * (#808080), per the frame.
 *
 * @param {{ role: "student"|"instructor"|"admin" }} props
 */
export function AppHeader({ role }) {
  const { user, signOut, isInstructorAsStudent, setIsInstructorAsStudent } = useAuth()
  const account = user?.email || user?.username || ""

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
          <span className="flex items-center px-6 text-h2 font-semibold tracking-[0.5em] text-primary">
            OCELIA
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
          <DropdownMenuContent align="end">
            {account && (
              <>
                <DropdownMenuLabel className="max-w-[16rem] truncate">{account}</DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            {role === "instructor" && (
              <DropdownMenuItem onClick={() => setIsInstructorAsStudent((v) => !v)}>
                <Icon icon={isInstructorAsStudent ? MdVisibilityOff : MdVisibility} size={16} />
                {isInstructorAsStudent ? "Exit student view" : "View as student"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={signOut}>
              <Icon icon={MdLogout} size={16} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
