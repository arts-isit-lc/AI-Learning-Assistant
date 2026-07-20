import { useEffect, useRef, useState } from "react"
import { MdSearch } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"

/**
 * Debounced search input. Fires `onChange(value)` after `debounceMs` of idle so
 * queries aren't spammed on every keystroke (perceived-performance, plan §10).
 */
export function Searchbar({ value = "", onChange, placeholder = "Search", debounceMs = 250, className }) {
  const [text, setText] = useState(value)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const handleChange = (event) => {
    const next = event.target.value
    setText(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange?.(next), debounceMs)
  }

  return (
    <div className={cn("relative", className)}>
      <Icon
        icon={MdSearch}
        size={18}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={placeholder}
        value={text}
        onChange={handleChange}
        placeholder={placeholder}
        className="pl-9"
      />
    </div>
  )
}
