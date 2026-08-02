import { MdClose } from "react-icons/md"
import { useFileUrl } from "@/services/queries"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"

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
          <Icon icon={MdClose} size={24} />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="p-4">
            <Skeleton className="h-full min-h-64 w-full" />
          </div>
        ) : isError || !data?.presignedurl ? (
          <ErrorState
            className="h-full border-0"
            title="Couldn't load this document"
            description="The document couldn't be opened. Please try again."
            retryLabel="Retry"
            onRetry={() => refetch()}
          />
        ) : (
          <iframe title={fileName || "Reference document"} src={data.presignedurl} className="h-full w-full" />
        )}
      </div>
    </aside>
  )
}
