# Cross-Module File Referencing — Spec

**Status:** Implemented — deployed, with post-rollout fixes (see §11). Core tasks T1, T3–T7 are done in code; T8 is unverified and T9 (E2E) is pending.
**Area:** `generatePreSignedURL`, `multimodal_rag_v2` (ingestion/enrichment/retrieval), `chatbot_v2`
**Related:** supersedes the unimplemented intent in `rag_module_system_spec`
**Assumptions:** The database will be **wiped and all S3 files deleted before rollout** — clean slate, single deploy, no migration, no backfill, no re-ingest of legacy data. Schema changes are unconstrained.
**Refined via** `planning-refinement.md` (3 iterations, final score 9.3/10).

---

## 1. Problem Statement

V2 retrieval scopes results by `module_id` only (`metadata_filter = {"module_id": module_id} if module_id else None`). Two defects follow:

1. **`allowed_file_ids` is dead** — `chatbot_v2` sends it (hardcoded `[]`), the handler logs its count, but it never filters.
2. **Cross-module referencing does not work** — a module can reference other modules' files via `Module_File_References` (`source_module_id → referenced_file_id`), but those units carry a different `module_id` and are never retrieved.

### Root cause — `file_id` identity mismatch

| Source | `file_id` value | Where set |
|---|---|---|
| `Module_Files.file_id` | DB-generated **UUID** | `generatePreSignedURL.upsert_file_record()` (`INSERT ... RETURNING file_id`) |
| `retrieval_units.metadata.file_id` | **filename stem** (`Lecture_7`) | `ingestion/_parse_s3_key()` → `os.path.splitext(filename)[0]` |

The S3 key is `courses/{course_id}/{module_id}/{file_name}.{file_type}` — it carries the filename, not the UUID. `Module_File_References.referenced_file_id` holds UUIDs, so retrieval can never match them against filename-stem `file_id`s on the units.

---

## 2. Goals / Non-Goals

**Goals:** make the canonical UUID `file_id` the single file identifier across S3 → IR → enrichment → `retrieval_units`; scope retrieval to a module's own + referenced files; make `allowed_file_ids` authoritative; keep `module_id` scoping as the fallback; preserve the High-1 isolation guarantee.

**Non-Goals:** general boolean filter-expression engine; frontend changes (the UUID is already returned to the client today); changing the per-file *authorization* model (see §7 trust boundary).

---

## 3. Requirements

- **R1.** The S3 upload key MUST encode the canonical UUID `file_id` as the object identifier, so it propagates unchanged through ingestion → IR → enrichment → `retrieval_units`.
- **R2.** `retrieval_units` MUST carry the canonical UUID `file_id` and `module_id` as first-class indexed columns (§4.4).
- **R3.** `chatbot_v2` MUST compute `allowed_file_ids` = union of the module's own `file_id`s and its `Module_File_References.referenced_file_id`s, derived **server-side** from `module_id`.
- **R4.** Retrieval MUST scope by `file_id ∈ allowed_file_ids` when non-empty; otherwise fall back to `module_id` scoping.
- **R5.** The vector and BM25 stores MUST support list-membership (`= ANY`) filters.
- **R6.** The zero-result fallback MUST preserve the external scope filter (High-1, already implemented).

---

## 4. Design

### 4.1 UUID as the file identifier in the S3 key (recommended)

`generatePreSignedURL` already obtains the UUID before building the key. Use it as the object name and persist the canonical key:

```python
file_id = upsert_file_record(module_id, file_name, file_type)   # UUID (already happens)
key = f"courses/{course_id}/{module_id}/{file_id}.{file_type}"  # was {file_name}
update_file_record_filepath(file_id, key)                       # NEW helper: writes Module_Files.filepath
```

- **`ingestion/_parse_s3_key` needs no change** — the "filename stem" it extracts now *is* the UUID, which flows into `FileMetadata.file_id` → `DocumentIR` → enrichment → `retrieval_units`.
- The original filename stays in `Module_Files.filename` for display.
- IR path (`{course}/{module}/{file_id}/ir_v.../`) stays internally consistent; image paths (`images/{course}/{module}/{element_id}.png`) use `element_id` and are unaffected.

**Alternatives (rejected):** resolve filename→UUID in enrichment (extra per-file query, keeps two identifier conventions); pass UUID via S3 object metadata (needs frontend header + object-metadata read).

### 4.2 Read paths

- **`student/file_url`** already prefers `Module_Files.filepath` (`fileRecord.filepath || <constructed>`). Once R1 persists `filepath`, reads use the canonical key. **T8 removes the stale legacy fallback** so a missing `filepath` fails loudly instead of silently 404-ing on a wrong key.
- **`student/figure_url`** is **unaffected** — it resolves by `retrieval_id` / `metadata->>'figure_id'` / `metadata->>'image_s3_key'` (element-id based), none of which change. No work required. *(Corrects an earlier draft error that claimed it used `filepath`.)*

### 4.3 List-membership filter in the stores

```python
for key, value in scope_filter.items():
    if isinstance(value, (list, tuple)):
        where_clauses.append(f"{col(key)} = ANY(%s)")
        params.append([str(v) for v in value])   # psycopg2 adapts list → array
    else:
        where_clauses.append(f"{col(key)} = %s")
        params.append(str(value))
```

### 4.4 First-class columns on `retrieval_units` (schema change)

```sql
ALTER TABLE retrieval_units ADD COLUMN file_id TEXT;
ALTER TABLE retrieval_units ADD COLUMN module_id TEXT;
CREATE INDEX idx_retrieval_units_file_id ON retrieval_units (file_id);
CREATE INDEX idx_retrieval_units_module_id ON retrieval_units (module_id);
```

> **`file_id` is `TEXT`, not `UUID`.** The scope filter in §4.3 binds `file_id = ANY(%s)` as a `text[]` (`[str(v) for v in value]`) with no cast. A `UUID` column has no `uuid = text` operator, so every scoped query fails at runtime with `operator does not exist: uuid = text`. Storing the canonical `Module_Files.file_id` UUID as text keeps the membership filter cast-free and consistent with `module_id`. Note this surfaces only at query time: INSERTs into a `UUID` column succeed via the text→uuid assignment cast, so ingestion looks healthy while retrieval returns nothing.

Enrichment `_store_in_pgvector` writes `file_id` and `module_id` as columns (it already has both from the SQS message context). Keep them in `metadata` too for backward-compatible reads (e.g. `figure_url` is untouched). Filters become indexed column predicates instead of `metadata->>'...'` JSON extraction.

### 4.5 Scope selection in the retrieval handler

```python
if allowed_file_ids:
    scope_filter = {"file_id": allowed_file_ids}   # authoritative set (incl. cross-module refs)
elif module_id:
    scope_filter = {"module_id": module_id}         # backward-compatible fallback
else:
    scope_filter = None
```

High-1 unchanged: whichever scope filter is chosen is preserved on the zero-result retry; only the intent filter is dropped. Log the chosen scope kind, `len(allowed_file_ids)`, and whether the fallback fired (§ observability).

### 4.6 Compute `allowed_file_ids` in `chatbot_v2`

Add a helper that **reuses the existing module-level `_get_db_connection()`** (no new connection per message):

```sql
SELECT file_id FROM "Module_Files" WHERE module_id = %s
UNION
SELECT referenced_file_id FROM "Module_File_References" WHERE source_module_id = %s;
```

Parameterized (`module_id` is server-derived, never user-supplied). Pass the result to `invoke_retrieval()`. On query failure or empty result, pass `[]` → retrieval falls back to `module_id` scoping. Cost: one extra indexed query on a warm connection (~ms), once per student turn.

---

## 5. Rollout

Single big-bang deploy against a clean slate. The database will be wiped and all S3 files deleted beforehand, so there is no existing data to preserve — no re-ingest of legacy content, no in-flight-upload window, and no backward-compatibility shim.

1. **Wipe:** drop/recreate the application database (all tables, so `Module_Files` UUIDs and everything else start fresh) and delete all objects under the `courses/` and `images/` prefixes in the IR bucket. Ensure the `retrieval_units` schema is recreated with the new `file_id`/`module_id` columns + indexes (R2).
2. **Deploy everything together:** R1 (UUID key + `filepath`), R2 (columns + indexes), R3 (`chatbot_v2` populates `allowed_file_ids`), R4/R5 (scope selection + list filter), R6.
3. **Re-populate:** upload course files through the normal flow; they ingest under the UUID-keyed convention from the first upload.

The `module_id` fallback (R4) and the optional `chatbot_v2` env flag remain in the code as defensive runtime switches, not as rollout phases.

---

## 6. Tasks

- [x] **T1.** `generatePreSignedURL`: build key from UUID `file_id`; add `update_file_record_filepath` and persist `Module_Files.filepath`. Unit test key + filepath write. — **done** (key `courses/{course}/{module}/{file_id}.{ext}`, filepath persisted).
- [x] **T2.** Add a test asserting `_parse_s3_key` on a UUID-keyed path yields `file_id` = the UUID (no code change expected). — **done** (no code change needed; `ingestion/test_handler.py` exercises `_parse_s3_key`).
- [x] **T3.** Schema: add `file_id` (UUID) + `module_id` columns and indexes to `retrieval_units`. — **done** (DBFlow initializer; idempotent `CREATE TABLE` + `ALTER ... ADD COLUMN IF NOT EXISTS` + indexes). *Was missed on first rollout — see §11.*
- [x] **T4.** Enrichment `_store_in_pgvector`: write `file_id`/`module_id` as columns (retain in metadata). Update tests. — **done**.
- [x] **T5.** Retrieval stores: list-membership (`= ANY`) filters on the new columns. Unit test SQL construction for scalar and list values. — **done** (`_append_metadata_filter`).
- [x] **T6.** Retrieval handler: `file_id` scope when `allowed_file_ids` non-empty, else `module_id`; add scope/fallback logging. Extend `test_module_scoped_retrieval.py` (incl. High-1 preservation with a file_id list). — **done**.
- [x] **T7.** `chatbot_v2`: union query via `_get_db_connection()`; pass `allowed_file_ids` (optional env flag as a runtime kill switch). Unit test union + empty/failure fallback to `[]`. — **done** (`_get_allowed_file_ids`).
- [ ] **T8.** `student/file_url`: rely on persisted `filepath`; remove the legacy key fallback. (`figure_url`: no change — confirm via a regression test.) — **unverified** (handler not confirmed this pass).
- [ ] **T9.** After wipe + deploy, upload fresh course files; end-to-end verify cross-module retrieval (upload to module A, reference from B, confirm a B query retrieves the A file). — **pending** (manual).

---

## 7. Security / Trust Boundary

- **`allowed_file_ids` is server-derived, never user-supplied.** `chatbot_v2` computes it from `module_id` via the authoritative DB query (R3), so a student cannot inject arbitrary file_ids to widen scope.
- **Retrieval scoping is a relevance boundary, not the authorization boundary.** Authorization remains module enrollment, verified upstream (Cognito authorizer → `chatbot_v2` must confirm the authenticated student is enrolled in the requested `course_id`/`module_id`). This spec assumes that check exists or is added separately; it does not weaken it.
- All new SQL is parameterized (no string interpolation of identifiers).

---

## 8. Observability

Log at retrieval: scope kind (`file_id` vs `module_id` vs none), `len(allowed_file_ids)`, and `used_fallback`. A rising fallback rate signals either missing re-ingest coverage or a scoping bug. `chatbot_v2`: log the computed `allowed_file_ids` count and whether the union query failed (fell back to `[]`).

---

## 9. Acceptance Criteria

- **AC-R1:** Uploading a file results in an S3 object at `courses/{course}/{module}/{uuid}.{ext}` and `Module_Files.filepath` equals that key.
- **AC-R2:** After enrichment, every `retrieval_units` row for that file has `file_id` = the `Module_Files` UUID (column, not just metadata) and the correct `module_id`.
- **AC-R3:** For a module with N own files and M referenced files, `chatbot_v2` produces an `allowed_file_ids` of exactly those N+M UUIDs; on DB error it produces `[]`.
- **AC-R4:** A query in module B retrieves units from a module-A file referenced by B; with `allowed_file_ids=[]` the result is identical to today's `module_id`-scoped behavior.
- **AC-R5:** A list-valued scope filter produces a `= ANY` predicate; a scalar produces `=`.
- **AC-R6:** A zero-result query with a `file_id` list scope + summary intent retries with the **same** `file_id` list (intent dropped, scope preserved) — no cross-scope leak.

---

## 10. Test Strategy

pytest unit tests for T1–T8 (colocated, factories, monkeypatch; no live DB — mock stores/queries). Extend `retrieval/test_module_scoped_retrieval.py` for `file_id`-list scope and AC-R6. CDK assertion test if T3 provisions columns/indexes via the DBFlow initializer. Manual E2E for AC-R4 (T9): upload to module A, reference from B, confirm a B query retrieves the A file.


---

## 11. Post-Rollout Fixes (found during deployment)

The write/read/delete paths were implemented, but the original task list (§6) missed
several downstream consumers that still assumed the pre-change identity
(`file_id` == filename stem, filename-keyed S3 objects). Found and fixed while
deploying:

- **Schema (T3) was never applied** — `retrieval_units` had no `file_id`/`module_id`
  columns, so the enrichment `INSERT` failed at ingest with `psycopg2.UndefinedColumn`.
  Added the columns + scope indexes to the DBFlow initializer, idempotently
  (`CREATE TABLE` columns **and** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for
  already-deployed databases). Tests in `lambda/initializer/test_initializer_schema.py`.

- **Enrichment `Module_Files` writers** — `_update_processing_status` and
  `_extract_and_store_topics` matched `WHERE module_id = %s AND filename = %s`, bound with
  the (now UUID) `file_id`. They matched **zero rows**: the UI spinner never cleared
  (`processing_status` stuck on `pending`, `chunk_count`/`last_processed_at` null) and topic
  metadata was never written. Now match on the `file_id` UUID PK; `_update_processing_status`
  logs a warning on a zero-row update instead of a false "complete". Tests in
  `multimodal_rag_v2/enrichment/test_module_files_writers.py`.

- **`getFilesFunction`** — listed UUID-named S3 objects but matched metadata by the human
  filename, so the instructor file list showed UUID names with null metadata. Now maps the
  S3 object's UUID stem back to the human `{filename}.{filetype}` + metadata via `file_id`
  (and surfaces `file_id` inside the returned metadata). Removed the dead, filename-matching
  `get_file_metadata_from_db`. Tests in `lambda/getFilesFunction/test_get_files.py`.

- **`deleteFile`** — built a stale pre-V2 S3 key (`{course}/{module}/documents/{filename}.{ext}`)
  and never removed `retrieval_units`, orphaning the real object and its vectors. Now resolves
  `file_id`, deletes the `courses/{course}/{module}/{file_id}.{ext}` object and the file's
  `retrieval_units`, and drops the obsolete file-type gate (which had blocked deleting
  html/csv/json/image files). Tests in `lambda/deleteFile/test_delete_file.py`.

### Still outstanding

- **`orphanCleanup` is stale** (same root cause, not yet fixed): it deletes V1
  `langchain_pg_collection`/`langchain_pg_embedding` rows (not `retrieval_units`) and lists S3
  under `{course}/{module}/` (missing the `courses/` prefix), so it removes neither the V2
  vectors nor the actual V2 objects for orphaned modules.
- **IR artifacts + images are not cleaned on `deleteFile`** — only the raw object, the
  `retrieval_units`, and the `Module_Files` row are removed. Per-file IR
  (`{course}/{module}/{file_id}/ir_v.../`) and images (`images/...`) remain.
- **T8 / T9** — `student/file_url` legacy-fallback removal is unverified; the cross-module
  A→B end-to-end check is still pending.
