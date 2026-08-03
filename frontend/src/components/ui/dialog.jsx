import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { MdClose } from "react-icons/md"
import { Icon } from "./icon"
import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn("fixed inset-0 z-overlay animate-fade-in bg-black/50", className)}
      {...props}
    />
  )
})

const DialogContent = React.forwardRef(function DialogContent({ className, children, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // Standard modal chrome (Figma): 36px left/right/bottom padding, 56px
          // top (the extra top room clears the close control), and a uniform
          // 32px (gap-8) vertical rhythm between sections (header / body /
          // footer). Full-bleed modals (CourseWizard / EditModule) opt out with
          // `gap-0 p-0` and space/pad themselves.
          "fixed left-1/2 top-1/2 z-modal flex w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-8 rounded-sm border border-border bg-background px-9 pb-9 pt-14 shadow-modal animate-fade-in",
          className
        )}
        {...props}
      >
        {children}
        {/* Close X: #404040 (foreground) at rest, greying to neutral-400 (#BFBFBF)
            on hover — the same colour the dropdown chevron greys to. */}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md text-foreground transition-colors duration-fast hover:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <Icon icon={MdClose} size={24} label="Close" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

// Standard modal header (Figma): the title sits over a full-width divider, with
// 8px (pb-2) between them. Opt out with `border-b-0` / `pb-0` when a dialog
// wants no divider.
function DialogHeader({ className, ...props }) {
  return (
    <div className={cn("flex flex-col gap-1.5 border-b border-border pb-2 text-left", className)} {...props} />
  )
}

// Standard modal footer (Figma): a full-width divider over the action row, with
// 16px (pt-4) between the divider and the buttons. Action buttons render at the
// Figma 16px (`text-base`) — set here so dialogs don't size each button by hand
// (the Button default is `text-caption`/14px).
function DialogFooter({ className, ...props }) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end [&>button]:text-base",
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
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
