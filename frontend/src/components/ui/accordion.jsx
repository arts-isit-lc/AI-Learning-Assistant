import * as React from "react"
import * as AccordionPrimitive from "@radix-ui/react-accordion"
import { MdExpandMore } from "react-icons/md"
import { Icon } from "./icon"
import { cn } from "@/lib/utils"

const Accordion = AccordionPrimitive.Root

const AccordionItem = React.forwardRef(function AccordionItem({ className, ...props }, ref) {
  return <AccordionPrimitive.Item ref={ref} className={cn("border-b border-border", className)} {...props} />
})

const AccordionTrigger = React.forwardRef(function AccordionTrigger({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        ref={ref}
        className={cn(
          "flex flex-1 items-center justify-between py-4 text-caption font-semibold transition-all",
          "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "[&[data-state=open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <Icon icon={MdExpandMore} size={18} className="shrink-0 transition-transform duration-fast" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
})

const AccordionContent = React.forwardRef(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className="overflow-hidden text-caption data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn("pb-4 pt-0", className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
})

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
