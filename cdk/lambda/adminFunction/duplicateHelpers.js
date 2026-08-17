/**
 * Pure helpers for POST /admin/duplicate_course file duplication.
 *
 * These are deliberately free of any AWS SDK / DB imports so they can be unit
 * tested in isolation (see cdk/test/duplicate-helpers.test.ts). The handler
 * injects the side-effecting bits (the S3 copy function, the sql connection).
 */

/**
 * Canonical raw-file S3 key (V2 layout):
 *   courses/{course_id}/{module_id}/{file_id}.{file_type}
 * This must match generatePreSignedURL so a copied object lands on the
 * `courses/` prefix and re-triggers the ingestion pipeline for the new file_id.
 */
function buildFileKey(courseId, moduleId, fileId, fileType) {
  return `courses/${courseId}/${moduleId}/${fileId}.${fileType}`;
}

/**
 * Resolve the source object key for a Module_Files row. Prefer the persisted
 * `filepath` (the canonical key written on upload); fall back to reconstructing
 * it from the source course/module/file ids when a legacy row has no filepath.
 */
function resolveSourceKey(row, sourceCourseId) {
  if (row.filepath) return row.filepath;
  return buildFileKey(sourceCourseId, row.module_id, row.file_id, row.filetype);
}

/** Sleep helper (overridable in tests to avoid real timers). */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` up to `attempts` times, returning its resolved value on the first
 * success. Re-throws the last error once all attempts are exhausted. A linear
 * backoff (attempt * baseDelayMs) is applied between tries. `sleep` is injected
 * so tests run without real delays.
 */
async function copyWithRetry(fn, { attempts = 3, baseDelayMs = 200, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * baseDelayMs);
    }
  }
  throw lastErr;
}

/**
 * Run `worker(item)` over `items` with at most `limit` in flight at once.
 * Resolves once every item has settled; individual worker rejections are the
 * worker's responsibility to catch (the file worker records failures rather
 * than throwing, so one bad file never aborts the batch).
 */
async function runWithConcurrency(items, worker, limit = 10) {
  const size = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * Remap Module_File_References rows onto the duplicated course.
 *
 * A reference is (source_module_id -> referenced_file_id). Both endpoints are
 * remapped through the maps built earlier in duplication:
 *   - source_module_id via moduleMap (source module -> new module)
 *   - referenced_file_id via fileMap (source file -> newly copied file)
 *
 * A reference is only carried over when BOTH endpoints were duplicated into the
 * new course. References whose target file was not copied — it points outside
 * the duplicated course, or its copy failed — are skipped (and returned so the
 * caller can log them): we can neither point a new-course module at a foreign
 * course's file nor at a copy that does not exist.
 *
 * @param {Array<{source_module_id: string, referenced_file_id: string}>} rows
 * @param {Map<string,string>} moduleMap source module_id -> new module_id
 * @param {Map<string,string>} fileMap   source file_id   -> new file_id
 * @returns {{ mapped: Array<{source_module_id: string, referenced_file_id: string}>,
 *             skipped: Array<{source_module_id: string, referenced_file_id: string}> }}
 */
function remapReferences(rows, moduleMap, fileMap) {
  const mapped = [];
  const skipped = [];
  for (const row of rows) {
    const newSource = moduleMap.get(row.source_module_id);
    const newRef = fileMap.get(row.referenced_file_id);
    if (newSource && newRef) {
      mapped.push({ source_module_id: newSource, referenced_file_id: newRef });
    } else {
      skipped.push({
        source_module_id: row.source_module_id,
        referenced_file_id: row.referenced_file_id,
      });
    }
  }
  return { mapped, skipped };
}

module.exports = {
  buildFileKey,
  resolveSourceKey,
  copyWithRetry,
  runWithConcurrency,
  remapReferences,
};
