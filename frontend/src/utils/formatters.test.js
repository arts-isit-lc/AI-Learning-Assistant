import { describe, it, expect } from "vitest"
import { titleCase, courseTitleCase, toRoman } from "./formatters"

describe("titleCase", () => {
  it("capitalizes each word and passes non-strings through", () => {
    expect(titleCase("water management")).toBe("Water Management")
    expect(titleCase(null)).toBe(null)
  })
})

describe("courseTitleCase", () => {
  it("uppercases the first word (the code) and title-cases the rest", () => {
    expect(courseTitleCase("geog 210")).toBe("GEOG 210")
  })
})

describe("toRoman", () => {
  it("maps 1-based positions to lowercase roman numerals", () => {
    expect(toRoman(1)).toBe("i")
    expect(toRoman(2)).toBe("ii")
    expect(toRoman(4)).toBe("iv")
    expect(toRoman(20)).toBe("xx")
  })

  it("falls back to the plain number past the lookup table", () => {
    expect(toRoman(21)).toBe("21")
  })
})
