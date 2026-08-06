import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { MdClose } from "react-icons/md"
import { Icon } from "./icon"
import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

// --- Stacked-modal awareness -------------------------------------------------
// When a second modal (e.g. a ConfirmDialog) opens over an existing one, the
// lower modal should recede so focus lands on the top modal. A modal that isn't
// the top-most drops below the overlay layer (z-sticky < z-overlay) and hides
// its own backdrop, so the top modal's overlay dims it like a normal receding
// modal; closing the top modal restores it. Tracked via a tiny module-level
// stack — mount order equals open order (Radix only mounts DialogContent while
// open), so the last-mounted content is the active/top one. A module store (not
// context) means no provider wrapping is required and isolated renders still
// work.
let dialogSeq = 0
const openDialogIds = []
const dialogListeners = new Set()

function emitDialogStackChange() {
  for (const listener of dialogListeners) listener()
}
function pushDialog(id) {
  openDialogIds.push(id)
  emitDialogStackChange()
}
function popDialog(id) {
  const i = openDialogIds.indexOf(id)
  if (i !== -1) {
    openDialogIds.splice(i, 1)
    emitDialogStackChange()
  }
}
function subscribeDialogStack(listener) {
  dialogListeners.add(listener)
  return () => dialogListeners.delete(listener)
}
function getTopDialogId() {
  return openDialogIds.length ? openDialogIds[openDialogIds.length - 1] : null
}

/**
 * True when another DialogContent is stacked above this one — i.e. this modal is
 * not the top-most open modal and should recede. Registers this modal in the
 * shared stack on mount (via layout effect, so the recede/restore is applied
 * before paint — no flash) and deregisters on unmount/close.
 */
function useIsBehindTopDialog() {
  const [id] = React.useState(() => ++dialogSeq)
  React.useLayoutEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])
  const topId = React.useSyncExternalStore(subscribeDialogStack, getTopDialogId, getTopDialogId)
  return topId !== null && topId !== id
}

const DialogOverlay = React.forwardRef(function DialogOverlay({ className, behind = false, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      data-dialog-overlay=""
      className={cn(
        "fixed inset-0 z-overlay animate-fade-in bg-black/50 transition-opacity",
        // While behind a stacked modal, hide this backdrop so the top modal's
        // overlay is the single dimming layer (avoids a double-dark stack).
        behind && "opacity-0",
        className
      )}
      {...props}
    />
  )
})

// Portal only mounts its children while the dialog is open, so registering the
// stack membership here (rather than in DialogContent's body) means a closed
// dialog never counts toward the stack — only actually-open modals recede each
// other.
const DialogContentImpl = React.forwardRef(function DialogContentImpl({ className, children, ...props }, ref) {
  const behind = useIsBehindTopDialog()
  return (
    <>
      <DialogOverlay behind={behind} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // Standard modal chrome (Figma): 36px left/right/bottom padding, 56px
          // top (the extra top room clears the close control), and a uniform
          // 32px (gap-8) vertical rhythm between sections (header / body /
          // footer). Full-bleed modals (CourseWizard / EditModule) opt out with
          // `gap-0 p-0` and space/pad themselves.
          //
          // Height is capped at 85vh (arbitrary viewport value, approved: no
          // token maps to a viewport fraction) so a modal can never exceed the
          // screen and hide its actions. As a flex column, a `DialogBody` scrolls
          // (flex-1 + min-h-0 + overflow) while the shrink-0 header/footer stay
          // pinned. Short modals size to content — the cap only bites when tall.
          "fixed left-1/2 top-1/2 flex max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-8 rounded-sm border border-border bg-background px-9 pb-9 pt-14 shadow-modal animate-fade-in transition-opacity",
          // Top-most modal sits at z-modal (1300). A modal stacked beneath an
          // open one drops to z-sticky (1100) — below the overlay layer (1200) —
          // so the top modal's backdrop dims it as it recedes.
          behind ? "z-sticky" : "z-modal",
          className
        )}
        {...props}
      >
        {children}
        {/* Close X (non-chevron interactive icon): #6829C2 (primary) default,
            #2E0666 (primary-dark) hover, #000 (neutral-900) while pressed. */}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md text-primary transition-colors duration-fast hover:text-primary-dark active:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <Icon icon={MdClose} size={24} label="Close" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </>
  )
})

const DialogContent = React.forwardRef(function DialogContent(props, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogContentImpl ref={ref} {...props} />
    </DialogPrimitive.Portal>
  )
})

// Standard modal header (Figma): the title sits over a full-width divider, with
// 8px (pb-2) between them. Opt out with `border-b-0` / `pb-0` when a dialog
// wants no divider. `shrink-0` keeps it pinned when the body scrolls.
function DialogHeader({ className, ...props }) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-1.5 border-b border-border pb-2 text-left", className)}
      {...props}
    />
  )
}

// Scrollable modal body: the region between the pinned header and footer. As a
// flex child it takes the leftover height (`flex-1`) and, once the modal hits
// its 85vh cap, scrolls its own overflow (`min-h-0` + `overflow-y-auto`) instead
// of pushing the footer off-screen. Inherits the 32px (gap-8) section rhythm;
// short content sizes naturally (nothing to scroll). Radix Select/Popover menus
// portal out, so this overflow never clips them.
function DialogBody({ className, ...props }) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto", className)} {...props} />
  )
}

// Standard modal footer (Figma): a full-width divider over the action row, with
// 16px (pt-4) between the divider and the buttons. Action buttons render at the
// Figma 16px (`text-base`) — set here so dialogs don't size each button by hand
// (the Button default is `text-caption`/14px). `shrink-0` keeps it pinned when
// the body scrolls.
function DialogFooter({ className, ...props }) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end [&>button]:text-base",
        className
      )}
      {...props}
    />
  )
}

const DialogTitle = React.forwardRef(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("text-h4 font-semibold text-neutral-900", className)}
      {...props}
    />
  )
})

const DialogDescription = React.forwardRef(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description ref={ref} className={cn("text-body text-foreground", className)} {...props} />
  )
})

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
