-- Cross-Module File Referencing — schema change for retrieval_units (spec T3).
--
-- Promotes file_id and module_id from the metadata JSON to first-class indexed
-- columns so retrieval can scope by an authoritative, indexed file_id set
-- (a module's own files + its Module_File_References) instead of a
-- metadata->>'...' functional scan.
--
-- Columns are TEXT (not UUID) so the `= ANY(%s)` list-membership filter compares
-- cleanly against the string ids that flow from the SQS message / JSON without
-- requiring per-query ::uuid[] casts. file_id holds the canonical
-- Module_Files.file_id (a UUID, stored as text).
--
-- Idempotent: safe to run whether retrieval_units was just created or already exists.

ALTER TABLE retrieval_units ADD COLUMN IF NOT EXISTS file_id TEXT;
ALTER TABLE retrieval_units ADD COLUMN IF NOT EXISTS module_id TEXT;

CREATE INDEX IF NOT EXISTS idx_retrieval_units_file_id ON retrieval_units (file_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_units_module_id ON retrieval_units (module_id);
