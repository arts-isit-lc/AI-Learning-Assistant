import { useRef, useState } from "react"
import { MdUploadFile } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"

/**
 * Drag-and-drop file upload dropzone (Figma FileUpload). Calls `onFiles(File[])`
 * on drop or browse. Per-file progress/status is rendered by the caller (the
 * wizard owns the upload state).
 *
 * @param {{ onFiles?: (files: File[]) => void, accept?: string, disabled?: boolean, className?: string }} props
 */
export function FileUpload({ onFiles, accept, disabled = false, className }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || [])
    if (files.length) onFiles?.(files)
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-6 text-center transition-colors",
        dragging && "border-primary bg-primary/5",
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
      <Icon icon={MdUploadFile} size={28} className="text-muted-foreground" />
      <p className="text-caption text-muted-foreground">Drag and drop files here, or</p>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()}>
        Browse files
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        aria-label="Upload files"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />
    </div>
  )
}
