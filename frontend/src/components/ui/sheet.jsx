import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva } from "class-variance-authority"
import { MdClose } from "react-icons/md"
import { Icon } from "./icon"
import { cn } from "@/lib/utils"

const Sheet = SheetPrimitive.Root
const SheetTrigger = SheetPrimitive.Trigger
const SheetClose = SheetPrimitive.Close

const SheetOverlay = React.forwardRef(function SheetOverlay({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Overlay
      ref={ref}
      className={cn("fixed inset-0 z-overlay animate-fade-in bg-black/50", className)}
      {...props}
    />
  )
})

const sheetVariants = cva("fixed z-modal flex flex-col gap-4 bg-background p-6 shadow-modal", {
  variants: {
    side: {
      top: "inset-x-0 top-0 border-b border-border",
      bottom: "inset-x-0 bottom-0 border-t border-border",
      left: "inset-y-0 left-0 h-full w-3/4 max-w-sm border-r border-border",
      right: "inset-y-0 right-0 h-full w-3/4 max-w-sm border-l border-border",
    },
  },
  defaultVariants: { side: "right" },
})

const SheetContent = React.forwardRef(function SheetContent(
  { side = "right", className, children, ...props },
  ref
) {
  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <SheetPrimitive.Close className="absolute right-4 top-4 rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <Icon icon={MdClose} size={18} label="Close" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
})

function SheetHeader({ className, ...props }) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />
}

function SheetFooter({ className, ...props }) {
  return <div className={cn("mt-auto flex flex-col gap-2", className)} {...props} />
}

const SheetTitle = React.forwardRef(function SheetTitle({ className, ...props }, ref) {
  return <SheetPrimitive.Title ref={ref} className={cn("text-h4 font-semibold text-navy", className)} {...props} />
})

const SheetDescription = React.forwardRef(function SheetDescription({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Description ref={ref} className={cn("text-caption text-muted-foreground", className)} {...props} />
  )
})

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
