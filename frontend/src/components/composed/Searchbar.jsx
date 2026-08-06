import { useEffect, useRef, useState } from "react"
import { MdSearch, MdClose } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"

/**
 * Debounced search input. Fires `onChange(value)` after `debounceMs` of idle so
 * queries aren't spammed on every keystroke (perceived-performance, plan §10).
 *
 * The trailing affordance swaps with the field's content: an empty field shows
 * the (decorative) search glyph; once there's text it becomes an interactive
 * clear "x" — #6829C2 (primary) at rest, #2E0666 (primary-dark) on hover, #000
 * (neutral-900) while pressed. Clicking it clears the field immediately (fires
 * `onChange("")`), so the "x" disappears until the user types again.
 */
export function Searchbar({
  value = "",
  onChange,
  placeholder = "Search",
  debounceMs = 250,
  className,
  inputClassName,
}) {
  const [text, setText] = useState(value)
  const timer = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const handleChange = (event) => {
    const next = event.target.value
    setText(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange?.(next), debounceMs)
  }

  const handleClear = () => {
    setText("")
    clearTimeout(timer.current)
    // Clear immediately (no debounce) and return focus so the user can retype.
    onChange?.("")
    inputRef.current?.focus()
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        ref={inputRef}
        type="search"
        aria-label={placeholder}
        value={text}
        onChange={handleChange}
        placeholder={placeholder}
        className={cn("pr-9", inputClassName)}
      />
      {text ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-primary transition-colors duration-fast hover:text-primary-dark active:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={MdClose} size={24} />
        </button>
      ) : (
        <Icon
          icon={MdSearch}
          size={24}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      )}
    </div>
  )
}
