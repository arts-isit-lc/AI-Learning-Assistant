/**
 * Upload Progress Feedback — Configuration Constants
 *
 * Controls timing and thresholds for the file upload progress tracking
 * and data ingestion status polling system.
 */

/** Polling interval for checking file processing status (milliseconds) */
export const POLLING_INTERVAL_MS = 3000;

/** Maximum time to poll before showing a timeout warning (seconds) */
export const POLLING_TIMEOUT_SECONDS = 300;

/** XHR upload timeout matching presigned URL expiry (milliseconds) */
export const XHR_UPLOAD_TIMEOUT_MS = 300000;

/** Grace period before showing "Waiting for processing..." for not_found files (milliseconds) */
export const NOT_FOUND_GRACE_PERIOD_MS = 30000;

/** Threshold before showing warning for not_found files (milliseconds) */
export const NOT_FOUND_WARNING_THRESHOLD_MS = 60000;

/** File statuses that block the Save button */
export const BLOCKING_STATUSES = [
  'uploading',
  'upload_failed',
  'pending',
  'processing',
  'not_found',
  'timed_out',
  'failed',
];

/** Terminal statuses that indicate a file is done (successfully or not) */
export const TERMINAL_STATUSES = ['complete', 'failed'];

/** Statuses that indicate polling should continue */
export const POLLING_ACTIVE_STATUSES = ['pending', 'processing', 'not_found', 'timed_out'];
