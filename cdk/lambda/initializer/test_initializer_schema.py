"""Schema-migration guard tests for the DB initializer (Phase 1 #2).

The initializer's DDL lives as an inline SQL string inside the handler, so this
verifies it at the source level: the ANN (HNSW) index must be present, use the
opclass that matches the retrieval query's distance operator, and degrade
gracefully on older pgvector. Deterministic — no DB or import required.
"""
from __future__ import annotations

import os

_INIT_PATH = os.path.join(os.path.dirname(__file__), "initializer.py")


def _source() -> str:
    with open(_INIT_PATH, encoding="utf-8") as f:
        return f.read()


class TestHnswIndex:
    def test_hnsw_index_present_on_embedding(self):
        src = _source()
        assert "USING hnsw (embedding vector_cosine_ops)" in src, (
            "HNSW ANN index on retrieval_units.embedding is missing"
        )

    def test_index_name_and_table(self):
        src = _source()
        assert "idx_retrieval_units_embedding_hnsw" in src
        assert "ON retrieval_units" in src

    def test_uses_cosine_opclass_matching_query_operator(self):
        # The retrieval query orders by `embedding <=> %s::vector` (cosine
        # distance), so the index opclass must be vector_cosine_ops.
        assert "vector_cosine_ops" in _source()

    def test_wrapped_for_graceful_degradation(self):
        # Must not abort schema init if pgvector lacks HNSW support.
        src = _source()
        assert "EXCEPTION WHEN OTHERS THEN" in src
        assert "HNSW index skipped" in src

    def test_existing_indexes_preserved(self):
        src = _source()
        assert "idx_retrieval_units_ts_vector" in src
        assert "idx_retrieval_units_embedding_version" in src


class TestCrossModuleFileReferencingColumns:
    """retrieval_units must carry file_id (TEXT) + module_id as first-class,
    indexed columns. The enrichment writer (_store_in_pgvector) INSERTs into
    these columns and the retrieval scope filter (_COLUMN_SCOPE_KEYS) queries
    them; a missing migration here raised psycopg2 UndefinedColumn at ingest.

    file_id is TEXT, not UUID: the scope filter binds `file_id = ANY(%s)` as a
    text[] with no cast, and a UUID column makes that raise
    `operator does not exist: uuid = text`.
    See the cross-module-file-referencing spec §4.4 (task T3).
    """

    def test_columns_declared_in_create_table(self):
        src = _source()
        assert "file_id TEXT" in src, "retrieval_units.file_id column is missing"
        assert "module_id TEXT" in src, "retrieval_units.module_id column is missing"

    def test_idempotent_migration_for_existing_tables(self):
        # CREATE TABLE IF NOT EXISTS is a no-op on an already-provisioned table,
        # so the columns must also be added via ALTER ... ADD COLUMN IF NOT EXISTS
        # to migrate databases that predate the columns.
        src = _source()
        assert "ALTER TABLE retrieval_units ADD COLUMN IF NOT EXISTS file_id TEXT" in src
        assert "ALTER TABLE retrieval_units ADD COLUMN IF NOT EXISTS module_id TEXT" in src

    def test_uuid_to_text_repair_migration_present(self):
        # Databases first provisioned with file_id as UUID must be converted to
        # TEXT, otherwise the scope filter's `file_id = ANY(%s)` text[] binding
        # raises `operator does not exist: uuid = text`. The conversion must be
        # guarded on the current data_type so it stays a no-op once applied.
        src = _source()
        assert "ALTER COLUMN file_id TYPE text USING file_id::text" in src
        assert "data_type = 'uuid'" in src

    def test_scope_indexes_present(self):
        src = _source()
        assert "idx_retrieval_units_file_id" in src
        assert "idx_retrieval_units_module_id" in src

    def test_scope_indexes_are_idempotent(self):
        # Must not fail re-running on an existing database.
        src = _source()
        assert "CREATE INDEX IF NOT EXISTS idx_retrieval_units_file_id" in src
        assert "CREATE INDEX IF NOT EXISTS idx_retrieval_units_module_id" in src


class TestCourseModulesLifecycleColumns:
    """Course_Modules gained status/created_at/updated_at + a status CHECK, plus a
    partial index idx_course_modules_status_created ON (status, created_at) WHERE
    status IN ('draft', 'deleting'). Because CREATE TABLE IF NOT EXISTS is a no-op
    on a pre-existing table, the columns must ALSO be added via
    ALTER ... ADD COLUMN IF NOT EXISTS — otherwise the partial index fails on an
    already-provisioned database with `column "status" does not exist` (observed
    on the first prod deploy after the lifecycle feature landed).
    """

    def test_columns_declared_in_create_table(self):
        src = _source()
        assert "\"status\" varchar(10) NOT NULL DEFAULT 'active'" in src
        assert '"created_at" timestamptz NOT NULL DEFAULT NOW()' in src
        assert '"updated_at" timestamptz NOT NULL DEFAULT NOW()' in src

    def test_idempotent_migration_adds_lifecycle_columns(self):
        # CREATE TABLE IF NOT EXISTS won't touch an existing table, so each new
        # column needs an explicit idempotent ALTER to migrate old databases.
        src = _source()
        assert 'ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "status"' in src
        assert 'ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "created_at"' in src
        assert 'ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "updated_at"' in src

    def test_status_check_constraint_added_idempotently(self):
        # The CHECK is re-added via a guarded DO block so re-running on a table
        # that already has it (fresh DB) is a no-op instead of a hard failure.
        src = _source()
        assert "chk_course_modules_status" in src
        assert "CHECK (status IN ('draft', 'active', 'deleting'))" in src
        assert "EXCEPTION WHEN duplicate_object THEN NULL" in src

    def test_lifecycle_migration_runs_before_partial_index(self):
        # Root-cause guard: the ADD COLUMN migration MUST precede the partial index
        # that references status/created_at, or the index build fails on a
        # pre-existing table (the prod deploy failure this test locks out).
        src = _source()
        migration_pos = src.index('ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "status"')
        # Match the real statement, not the comment above the migration that also
        # names the index.
        index_pos = src.index("CREATE INDEX IF NOT EXISTS idx_course_modules_status_created")
        assert migration_pos < index_pos, (
            "status/created_at must be migrated before the partial index that uses them"
        )

    def test_partial_index_present_and_idempotent(self):
        src = _source()
        assert "CREATE INDEX IF NOT EXISTS idx_course_modules_status_created" in src
