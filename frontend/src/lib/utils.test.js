import { describe, it, expect } from "vitest"
import { cn } from "./utils"

describe("cn — tailwind-merge with OCELIA custom font-size tokens", () => {
  it("keeps a custom font-size token when a text color is also present", () => {
    // Regression: text-caption used to be dropped by text-primary-foreground
    // (tailwind-merge treated the custom size as a text color), leaving buttons
    // with no font-size and inheriting 16px instead of the intended 14px.
    const result = cn("text-caption", "text-primary-foreground")
    expect(result).toContain("text-caption")
    expect(result).toContain("text-primary-foreground")
  })

  it("mirrors the Button base + default variant merge (keeps the caption size)", () => {
    const result = cn("text-caption font-semibold bg-primary text-primary-foreground", "h-7 px-6")
    expect(result).toContain("text-caption")
    expect(result).toContain("text-primary-foreground")
  })

  it("still lets a later custom font-size override an earlier one (same group)", () => {
    expect(cn("text-caption", "text-body")).toBe("text-body")
    expect(cn("text-h4", "text-h2")).toBe("text-h2")
  })
})
