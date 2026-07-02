import { useState, useEffect } from "react";
import apiClient from "../services/api";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * L1: module-level cache of resolved figure_url responses, keyed by figureId.
 *
 * A single AI message can render several figures, and figures re-mount whenever
 * the thread re-renders — without a cache each mount fires its own
 * figure_url call (1–3 DB round-trips + a fresh presign). Caching the in-flight
 * promise dedupes concurrent mounts of the same figure to one request and
 * reuses the result across re-mounts. Entries carry a timestamp and are treated
 * as stale before the 1-hour presigned URL expires, so a long-lived session
 * never renders a dead URL. Failures are not cached (a later mount can retry).
 */
const figureCache = new Map(); // figureId -> { promise, ts }
const FIGURE_TTL_MS = 50 * 60 * 1000; // refresh before the 1h presigned URL expires

function fetchFigure(figureId) {
  const cached = figureCache.get(figureId);
  if (cached && Date.now() - cached.ts < FIGURE_TTL_MS) {
    return cached.promise;
  }
  const promise = apiClient
    .get("student/figure_url", { figure_id: figureId })
    .catch((err) => {
      figureCache.delete(figureId); // don't cache failures — allow a retry
      throw err;
    });
  figureCache.set(figureId, { promise, ts: Date.now() });
  return promise;
}

/**
 * FigureImage fetches and displays a figure image from the figure_url endpoint.
 *
 * Loads the presigned URL on mount (via the shared cache), shows a skeleton
 * while loading, and gracefully degrades (renders nothing) on error.
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
    setLoading(true);
    setError(false);

    fetchFigure(figureId)
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
