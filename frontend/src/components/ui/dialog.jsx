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
          "fixed left-1/2 top-1/2 z-modal grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-sm border border-border bg-background p-10 shadow-modal animate-fade-in",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <Icon icon={MdClose} size={18} label="Close" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

function DialogHeader({ className, ...props }) {
  return <div className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />
}

function DialogFooter({ className, ...props }) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
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
    <DialogPrimitive.Description ref={ref} className={cn("text-caption text-muted-foreground", className)} {...props} />
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
