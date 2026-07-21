import { clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Teach tailwind-merge about OCELIA's custom font-size tokens (text-h2 / text-h4
// / text-body / text-caption, defined in tailwind.config `fontSize`). Without
// this, tailwind-merge misclassifies them as text-COLOR utilities and silently
// drops them whenever the class list also has a real text color — e.g. the
// Button base `text-caption` was being stripped by a variant's
// `text-primary-foreground`, leaving buttons at the inherited 16px instead of
// the intended 14px. Registering them in the `font-size` group keeps size and
// colour as independent, non-conflicting classes.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["h2", "h4", "body", "caption"] }],
    },
  },
})

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
