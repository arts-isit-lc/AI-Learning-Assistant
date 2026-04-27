/**
 * Sanitize a file name by replacing non-alphanumeric characters (except . _ -) with underscores.
 */
export function cleanFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Remove the file extension from a file name.
 * e.g. "document.pdf" → "document"
 */
export function removeFileExtension(fileName) {
  return fileName.replace(/\.[^/.]+$/, "");
}

/**
 * Get the file extension from a file name.
 * e.g. "document.pdf" → "pdf", "noext" → ""
 */
export function getFileType(filename) {
  const parts = filename.split(".");
  if (parts.length > 1) {
    return parts.pop();
  }
  return "";
}
