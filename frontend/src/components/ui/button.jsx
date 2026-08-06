import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * OCELIA button. UI + CTA families expressed via `variant`; sizes via `size`.
 * Every variant carries the full state set (hover / focus-visible / active /
 * disabled) from tokens. `loading` disables the control (prevents
 * double-submit) and, regardless of variant, swaps the button to the brand
 * purple (`bg-primary` / #6829C2) at full opacity showing only a spinner — the
 * label is visually hidden (kept `sr-only` for the accessible name) for the
 * duration of the animation and the disabled fade is suppressed so the surface
 * doesn't dim. `asChild` renders the styles onto a child
 * element (e.g. a router `<Link>`).
 */
const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none text-caption font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // Primary CTA (#6829C2 / white): hover darkens to #2E0666 (primary-dark),
        // and the press (active) goes to #000 (neutral-900), springing back to
        // #6829C2 once the click is released. Inactive (disabled) is #BFBFBF
        // (neutral-400) fill with white text at full opacity — overriding the base
        // disabled:opacity-50 fade so it renders a true grey. (The loading state
        // re-forces the brand-purple surface via disabled:bg-primary below.)
        default:
          "bg-primary text-primary-foreground hover:bg-primary-dark active:bg-neutral-900 disabled:bg-neutral-400 disabled:text-primary-foreground disabled:opacity-100",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        // Primary-bordered button (#6829C2 border + text on white) — modal-footer
        // secondary/Cancel action + the "Add X" triggers. Hover paints the lavender
        // #F2E8FF (primary-subtle) surface and darkens BOTH the border and the text
        // to #2E0666 (primary-dark); the press (active) deepens the surface to
        // #AA78F0 (primary-active), keeping the #2E0666 border + text, and springs
        // back to the resting state on release. Any icon inherits the text colour
        // via currentColor, so it tracks these transitions automatically. Disabled
        // (inactive) is #BFBFBF (neutral-400) border + text on the white fill, at
        // full opacity so it renders true grey — overriding the base
        // disabled:opacity-50 fade.
        outline:
          "border border-primary bg-background text-primary hover:border-primary-dark hover:bg-primary-subtle hover:text-primary-dark active:border-primary-dark active:bg-primary-active active:text-primary-dark disabled:border-neutral-400 disabled:text-neutral-400 disabled:opacity-100",
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
        // Brand-purple text button: no border, no fill, #6829C2 (primary) text at
        // rest. Hover paints the lavender #F2E8FF (primary-subtle) surface and
        // darkens the text to #2E0666 (primary-dark); the press (active) deepens
        // the surface to #AA78F0 (primary-active) with the same #2E0666 text,
        // springing back to the resting state once the click is released.
        ghostPrimary:
          "text-primary hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark",
        danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        cta: "bg-navy text-navy-foreground hover:bg-navy/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-11 px-6 text-body",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
  )
}

const Button = React.forwardRef(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
  ref
) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      className={cn(
        buttonVariants({ variant, size }),
        className,
        // While loading: brand purple (#6829C2) surface + white spinner
        // (border-current), regardless of variant, at full opacity (the button is
        // disabled while loading, so defeat the base disabled:opacity-50 fade).
        // `disabled:bg-primary` keeps the surface purple even though the button is
        // disabled — otherwise the default variant's disabled:bg-neutral-400 (a
        // higher-specificity :disabled rule) would grey out the loading surface.
        // Appended last so tailwind-merge lets it win over the variant's bg/text.
        loading && "bg-primary text-primary-foreground disabled:bg-primary disabled:opacity-100"
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : loading ? (
        // Keep the label in place but transparent so the button reserves its exact
        // width + height (no shrink/jump when the text swaps to the spinner), then
        // overlay a centred spinner. opacity-0 (not sr-only, which removes the box)
        // preserves BOTH the layout size and the accessible name for screen readers.
        <>
          <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </span>
          <span className="opacity-0">{children}</span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
})

export { Button, buttonVariants }
