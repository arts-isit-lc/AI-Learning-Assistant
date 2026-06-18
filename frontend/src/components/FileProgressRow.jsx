import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  X,
  RotateCcw,
} from "lucide-react";

/**
 * FileProgressRow - Displays upload/processing progress for a single file.
 *
 * @param {Object} props
 * @param {string} props.fileName - Display name of the file
 * @param {string} props.status - Current state: 'uploading' | 'upload_complete' | 'upload_failed' | 'pending' | 'processing' | 'complete' | 'failed' | 'not_found' | 'timed_out'
 * @param {number} props.progress - Upload progress 0-100 (only used during 'uploading')
 * @param {string|null} props.error - Error message if failed
 * @param {string|null} props.notFoundContext - 'waiting' | 'warning' | null (from useProcessingPoller.getNotFoundContext)
 * @param {function} props.onRetry - Retry handler (shown on failure states)
 * @param {function} props.onRemove - Remove handler (shown on failure states and during upload)
 * @param {function} props.onAbort - Abort handler (shown during upload)
 */
function FileProgressRow({
  fileName,
  status,
  progress,
  error,
  notFoundContext,
  onRetry,
  onRemove,
  onAbort,
}) {
  function renderStatusContent() {
    switch (status) {
      case "uploading":
        return (
          <>
            <Progress value={progress} className="flex-1" />
            <span className="text-xs font-medium text-muted-foreground">
              {progress}%
            </span>
          </>
        );

      case "upload_complete":
        return (
          <>
            <Progress indeterminate className="flex-1" />
            <span className="text-xs text-muted-foreground">Preparing...</span>
          </>
        );

      case "pending":
      case "processing":
        return (
          <>
            <Progress indeterminate className="flex-1" />
            <span className="text-xs text-muted-foreground">
              Processing...
            </span>
          </>
        );

      case "complete":
        return (
          <>
            <CheckCircle2
              className="h-4 w-4 text-green-600 flex-shrink-0"
              aria-label="Processing complete"
            />
            <span className="text-xs font-medium text-green-600">Ready</span>
          </>
        );

      case "upload_failed":
      case "failed":
        return (
          <>
            <AlertCircle
              className="h-4 w-4 text-destructive flex-shrink-0"
              aria-label="Error"
            />
            <span className="text-xs text-destructive truncate">
              {error || "An error occurred"}
            </span>
          </>
        );

      case "not_found":
        if (notFoundContext === "warning") {
          return (
            <>
              <Clock
                className="h-4 w-4 text-yellow-600 flex-shrink-0"
                aria-label="Processing hasn't started"
              />
              <span className="text-xs text-yellow-600">
                Processing hasn&apos;t started
              </span>
            </>
          );
        }
        // Default: waiting context or null
        return (
          <>
            <Progress indeterminate className="flex-1" />
            <span className="text-xs text-muted-foreground">
              Waiting for processing...
            </span>
          </>
        );

      case "timed_out":
        return (
          <>
            <Clock
              className="h-4 w-4 text-yellow-600 flex-shrink-0"
              aria-label="Taking longer than expected"
            />
            <span className="text-xs text-yellow-600">
              Taking longer than expected
            </span>
          </>
        );

      default:
        return null;
    }
  }

  function renderActions() {
    switch (status) {
      case "uploading":
        return (
          <button
            type="button"
            onClick={onAbort}
            className="hover:bg-muted rounded p-1 transition-colors"
            aria-label="Cancel upload"
            title="Cancel upload"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        );

      case "upload_failed":
      case "failed":
        return (
          <>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="hover:bg-muted rounded p-1 transition-colors"
                aria-label="Retry upload"
                title="Retry upload"
              >
                <RotateCcw className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="hover:bg-muted rounded p-1 transition-colors"
                aria-label="Remove file"
                title="Remove file"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
          </>
        );

      case "timed_out":
        return (
          onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="hover:bg-muted rounded p-1 transition-colors"
              aria-label="Remove file"
              title="Remove file"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )
        );

      case "not_found":
        if (notFoundContext === "warning") {
          return (
            onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="hover:bg-muted rounded p-1 transition-colors"
                aria-label="Remove file"
                title="Remove file"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            )
          );
        }
        return null;

      case "complete":
      default:
        return null;
    }
  }

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-md bg-muted/30">
      {/* File name */}
      <span className="text-sm font-medium truncate min-w-0 flex-shrink">
        {fileName}
      </span>

      {/* Progress/Status area */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {renderStatusContent()}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {renderActions()}
      </div>
    </div>
  );
}

export default FileProgressRow;
