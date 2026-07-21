export function titleCase(str) {
  if (typeof str !== "string") {
    return str;
  }
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const ROMAN = [
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
  "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
];

/**
 * Lowercase roman numeral for a 1-based position (1 -> "i", 2 -> "ii").
 * Used for module numbering in the course/config trees. Falls back to the
 * plain number past the lookup table (> 20).
 */
export function toRoman(num) {
  return ROMAN[num - 1] ?? String(num);
}

export function courseTitleCase(str) {
  if (typeof str !== "string") {
    return str;
  }
  const words = str.split(" ");
  return words
    .map((word, index) => {
      if (index === 0) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}
