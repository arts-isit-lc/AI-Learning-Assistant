import { MdClose, MdRefresh } from "react-icons/md"
import { useFileUrl } from "@/services/queries"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Reference-document column shown beside the chat when a material is opened
 * (?doc=:fileId). Resolves the presigned URL via the data layer and renders it
 * in an iframe (browsers display PDFs/images inline); degrades to a retry.
 */
export function ReferenceDocPanel({ fileId, fileName, onClose }) {
  const { data, isLoading, isError, refetch } = useFileUrl(fileId, { enabled: Boolean(fileId) })

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden rounded-sm border border-border bg-background"
      aria-label="Reference document"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="truncate text-caption font-semibold text-foreground">
          {fileName || "Reference"}
        </span>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close document">
          <Icon icon={MdClose} size={18} />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="p-4">
            <Skeleton className="h-full min-h-64 w-full" />
          </div>
        ) : isError || !data?.presignedurl ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-caption text-muted-foreground">Couldn&rsquo;t load this document.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1">
              <Icon icon={MdRefresh} size={16} />
              Retry
            </Button>
          </div>
        ) : (
          <iframe title={fileName || "Reference document"} src={data.presignedurl} className="h-full w-full" />
        )}
      </div>
    </aside>
  )
}
