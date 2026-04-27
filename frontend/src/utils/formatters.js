export function titleCase(str) {
  if (typeof str !== "string") {
    return str;
  }
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
