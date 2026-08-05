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
          "group flex flex-1 items-center justify-between text-caption font-semibold transition-all",
          "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "[&[data-state=open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        {/* Chevron greys to #BFBFBF (neutral-400) while the trigger is hovered. */}
        <Icon
          icon={MdExpandMore}
          size={24}
          className="shrink-0 transition duration-fast group-hover:text-neutral-400"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
})

const AccordionContent = React.forwardRef(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className="overflow-hidden text-caption data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none"
      {...props}
    >
      {/* Keep the trigger→content gap INSIDE the clipped, animated box (pt-4 on
          the inner element) rather than as an outer margin. An outer margin isn't
          clipped by overflow-hidden and isn't part of the height keyframe, so it
          snaps in/out and makes the slide look janky. This mirrors ModuleAccordion
          so every accordion opens/closes with the same smooth slide + fade. */}
      <div className={cn("pb-4 pt-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
})

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
