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
 * OCELIA top banner (`Header` frame 859:7184) — the UBC signature (crest in a
 * full-height bordered box + purple letter-spaced OCELIA wordmark) on the left,
 * the account menu on the right. Brand + account ONLY: role navigation lives in
 * the bars below the banner (instructor → `InstructorTabBar`; admin → its layout
 * nav), never in the banner itself.
 *
 * @param {{ role: "student"|"instructor"|"admin" }} props
 */
export function AppHeader({ role }) {
  const { user, signOut, isInstructorAsStudent, setIsInstructorAsStudent } = useAuth()
  const account = user?.email || user?.username || ""

  return (
    <header className="sticky top-0 z-sticky border-b border-border bg-background">
      <div className="flex h-20 items-center justify-between pr-4 sm:pr-6">
        <Link
          to="/"
          aria-label="OCELIA home"
          className="flex items-center gap-4 self-stretch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="flex h-full w-20 items-center justify-center border-r border-border">
            <img src={ubcLogo} alt="University of British Columbia" className="h-11 w-auto" />
          </span>
          <span className="text-h2 font-semibold tracking-[0.3em] text-primary">OCELIA</span>
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-3 rounded-md px-2 py-1.5 text-caption text-foreground transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Account menu"
          >
            <Avatar className="h-9 w-9">
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
