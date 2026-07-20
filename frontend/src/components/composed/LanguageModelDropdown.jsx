import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

/**
 * LLM selection dropdown (instructor Settings). Thin wrapper over `Select`.
 * @param {{ value?: string, onChange?: (id: string) => void, models?: Array<{ id: string, name: string }>, placeholder?: string, className?: string, "aria-label"?: string }} props
 */
export function LanguageModelDropdown({
  value,
  onChange,
  models = [],
  placeholder = "Select a model",
  className,
  "aria-label": ariaLabel = "Language model",
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
