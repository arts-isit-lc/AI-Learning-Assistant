import { useFigureUrl } from "@/services/queries"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Renders a figure block's image, resolving its presigned URL via the data
 * layer (Query dedupes/caches across re-mounts). Degrades to nothing on error.
 */
export function FigureImage({ figureId }) {
  const { data, isLoading, isError } = useFigureUrl(figureId, { enabled: Boolean(figureId) })

  if (isLoading) return <Skeleton className="h-48 w-full rounded" />
  if (isError || !data?.url) return null

  return (
    <figure className="my-4">
      <img
        src={data.url}
        alt={data.caption || "Course figure"}
        className="max-w-full rounded border border-border"
        loading="lazy"
      />
      {data.caption && (
        <figcaption className="mt-2 text-caption text-muted-foreground">{data.caption}</figcaption>
      )}
    </figure>
  )
}
