import { useRef, useState } from "react"
import { MdCloudUpload } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Drag-and-drop file upload dropzone (Figma `Wizard/FileUpload`). The whole
 * dashed zone is clickable ("Click to upload a file or drag"); calls
 * `onFiles(File[])` on drop or browse. Per-file progress/status is rendered by
 * the caller (the wizard owns the upload state).
 *
 * @param {{ onFiles?: (files: File[]) => void, accept?: string, hint?: string, disabled?: boolean, className?: string }} props
 */
export function FileUpload({
  onFiles,
  accept,
  hint = "OCELIA can receive jpg, bmp, cbr, pdf, csv",
  disabled = false,
  className,
}) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || [])
    if (files.length) onFiles?.(files)
  }

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-[hsl(var(--border-subtle))] p-10 text-center transition-colors",
        dragging && "border-primary bg-primary-subtle",
        disabled && "pointer-events-none opacity-50",
        className
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
    >
      <Icon icon={MdCloudUpload} size={44} className="text-primary" />
      <button
        type="button"
        aria-label="Upload files"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="text-body text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Click to upload a file or drag
      </button>
      <p className="text-caption text-muted-foreground">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />
    </div>
  )
}
