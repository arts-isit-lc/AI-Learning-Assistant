import { useState, useEffect } from "react";
import apiClient from "../services/api";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * FigureImage fetches and displays a figure image from the figure_url endpoint.
 *
 * Loads the presigned URL on mount, displays a skeleton while loading,
 * and gracefully degrades (renders nothing) on error.
 *
 * Props:
 *   figureId - The retrieval_id or figure_id to resolve
 */
const FigureImage = ({ figureId }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!figureId) {
      setLoading(false);
      setError(true);
      return;
    }

    let cancelled = false;

    apiClient
      .get("student/figure_url", { figure_id: figureId })
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [figureId]);

  if (loading) {
    return <Skeleton className="h-48 w-full rounded" />;
  }

  if (error || !data?.url) {
    return null;
  }

  return (
    <figure className="my-4">
      <img
        src={data.url}
        alt={data.caption || "Course figure"}
        className="max-w-full rounded border border-border"
        loading="lazy"
      />
      {data.caption && (
        <figcaption className="text-xs text-muted-foreground mt-2">
          {data.caption}
        </figcaption>
      )}
    </figure>
  );
};

export default FigureImage;
