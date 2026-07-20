import { useRef } from "react"
import { MdSend } from "react-icons/md"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"

const MAX_LENGTH = 2096
const MAX_HEIGHT = 128 // px (max-h-32)

/**
 * Sticky chat composer. Enter submits, Shift+Enter inserts a newline. The
 * textarea auto-grows to `max-h-32` then scrolls. Send + typing are blocked
 * while `disabled` (submitting / AI typing / creating session).
 *
 * @param {{ onSubmit: (text: string) => void, disabled?: boolean }} props
 */
export function ChatInput({ onSubmit, disabled = false }) {
  const ref = useRef(null)

  const submit = () => {
    const value = ref.current?.value.trim()
    if (!value || disabled) return
    onSubmit(value)
    if (ref.current) {
      ref.current.value = ""
      ref.current.style.height = "auto"
    }
  }

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const handleInput = (event) => {
    const el = event.target
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }

  return (
    <div className="flex items-end gap-2">
      <Textarea
        ref={ref}
        rows={1}
        maxLength={MAX_LENGTH}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder="Message AI Assistant..."
        aria-label="Message AI Assistant"
        className="max-h-32 min-h-10 resize-none"
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={submit}
        disabled={disabled}
        aria-label="Send message"
      >
        <Icon icon={MdSend} size={20} />
      </Button>
    </div>
  )
}
