"""Schema-migration guard tests for the DB initializer (Phase 1 #2).

The initializer's DDL lives as an inline SQL string inside the handler, so this
verifies it at the source level: the ANN (HNSW) index must be present, use the
opclass that matches the retrieval query's distance operator, and degrade
gracefully on older pgvector. The credential-resolution tests additionally import
the module and exercise its pure helper; that is import-safe (lazy DB connection +
os.environ.get, so no env vars, AWS creds, or DB socket are needed). Deterministic
— no network, no DB.
"""
from __future__ import annotations

import os
import sys

import pytest

_INIT_PATH = os.path.join(os.path.dirname(__file__), "initializer.py")

# Behavioral tests below import the initializer module to call _resolve_credentials
# directly. The module is import-safe (see the module docstring), so this stays
# deterministic and offline.
sys.path.insert(0, os.path.dirname(_INIT_PATH))
import initializer  # noqa: E402


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


class TestFeatureColumnBackfillMigrations:
    """Long-lived databases (prod) miss every column added to a CREATE TABLE after
    they were first provisioned, because CREATE TABLE IF NOT EXISTS never alters an
    existing table. Each such column needs an explicit idempotent
    ALTER ... ADD COLUMN IF NOT EXISTS. These were confirmed missing on the prod
    schema dump (2026-07-13); the guards keep the backfill from regressing.
    """

    def test_courses_validation_columns_migrated(self):
        src = _source()
        assert 'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "conflict_metadata"' in src
        assert 'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "validation_hash"' in src
        assert 'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "validation_cached_report"' in src

    def test_courses_term_column_migrated(self):
        # Academic term (e.g. "2026 Winter Term 2"). Declared on the CREATE TABLE
        # AND backfilled idempotently so existing/prod databases gain the column.
        src = _source()
        assert '"term" varchar' in src
        assert 'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "term" varchar' in src

    def test_courses_section_column_migrated(self):
        # Optional course section label (e.g. "001"). Nullable; declared on the
        # CREATE TABLE AND backfilled idempotently like term so existing/prod
        # databases gain the column.
        src = _source()
        assert '"section" varchar' in src
        assert 'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "section" varchar' in src

    def test_course_modules_feature_columns_migrated(self):
        src = _source()
        for col in (
            "conflict_metadata",
            "generated_topics",
            "validation_hash",
            "validation_cached_report",
            "key_topics",
        ):
            assert (
                f'ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "{col}"' in src
            ), f"missing idempotent migration for Course_Modules.{col}"

    def test_module_files_processing_columns_migrated(self):
        src = _source()
        for col in ("content_hash", "processing_status", "last_processed_at", "chunk_count"):
            assert (
                f'ALTER TABLE "Module_Files" ADD COLUMN IF NOT EXISTS "{col}"' in src
            ), f"missing idempotent migration for Module_Files.{col}"

    def test_backfilled_columns_are_nullable_or_defaulted(self):
        # Adding a NOT NULL column without a default to a populated table fails, so
        # every backfilled column must be nullable or carry a DEFAULT. Guard the
        # only defaulted one explicitly; the rest are declared without NOT NULL.
        src = _source()
        assert (
            'ALTER TABLE "Module_Files" ADD COLUMN IF NOT EXISTS "processing_status" text DEFAULT \'pending\''
            in src
        )
        # None of the backfilled ADD COLUMN statements may be NOT NULL.
        for line in src.splitlines():
            if "ADD COLUMN IF NOT EXISTS" in line and (
                '"conflict_metadata"' in line
                or '"validation_hash"' in line
                or '"validation_cached_report"' in line
                or '"generated_topics"' in line
                or '"key_topics"' in line
                or '"content_hash"' in line
                or '"last_processed_at"' in line
                or '"chunk_count"' in line
                or '"term"' in line
            ):
                assert "NOT NULL" not in line, f"backfilled column must be nullable: {line.strip()}"


class TestForeignKeysAreNamed:
    """FKs must be added with EXPLICIT constraint names. An unnamed
    `ADD FOREIGN KEY` gets a fresh server-generated name on every run, so the
    `EXCEPTION WHEN duplicate_object` guard never catches it and the FK is
    re-added on each deploy (prod had grown ~7 copies of each). Naming the
    constraint makes the guard idempotent; the paired DROP of the old auto-name
    keeps pre-existing databases at exactly one FK per relationship.
    """

    _EXPECTED_FKS = (
        "fk_course_concepts_course_id",
        "fk_course_modules_concept_id",
        "fk_enrolments_course_id",
        "fk_enrolments_user_id",
        "fk_module_files_module_id",
        "fk_module_file_references_source_module_id",
        "fk_module_file_references_referenced_file_id",
        "fk_student_modules_course_module_id",
        "fk_student_modules_enrolment_id",
        "fk_sessions_student_module_id",
        "fk_messages_session_id",
        "fk_user_engagement_log_enrolment_id",
        "fk_user_engagement_log_user_id",
        "fk_user_engagement_log_course_id",
        "fk_user_engagement_log_module_id",
        "fk_chatlogs_notifications_course_id",
        "fk_chatlogs_notifications_instructor_email",
    )

    def test_no_unnamed_foreign_keys(self):
        # The bug: bare "ADD FOREIGN KEY" (no constraint name). Strip SQL comment
        # lines first — the explanatory comment above the FKs names the anti-pattern.
        sql = "\n".join(
            line for line in _source().splitlines() if not line.strip().startswith("--")
        )
        assert "ADD FOREIGN KEY" not in sql, (
            "unnamed ADD FOREIGN KEY re-duplicates on every deploy — use "
            "ADD CONSTRAINT <name> FOREIGN KEY"
        )

    def test_every_fk_is_named_and_guarded(self):
        src = _source()
        for name in self._EXPECTED_FKS:
            # "<name>" and "FOREIGN KEY" may wrap across lines, so assert the named add.
            assert f"ADD CONSTRAINT {name}" in src, f"missing named FK {name}"
        # Each named add stays wrapped so re-running is a no-op once the FK exists.
        assert src.count("EXCEPTION WHEN duplicate_object THEN NULL") >= len(self._EXPECTED_FKS)

    def test_legacy_autonamed_fks_are_dropped(self):
        # Pre-existing DBs carry the old server-generated "<Table>_<col>_fkey"
        # names; drop them so the relationship ends with only the named FK.
        src = _source()
        for auto in (
            '"Course_Concepts_course_id_fkey"',
            '"Module_File_References_referenced_file_id_fkey"',
            '"User_Engagement_Log_module_id_fkey"',
            '"chatlogs_notifications_instructor_email_fkey"',
        ):
            assert f"DROP CONSTRAINT IF EXISTS {auto}" in src, f"missing legacy drop for {auto}"


class TestCourseIdentityUniqueIndex:
    """Courses must enforce identity uniqueness on the combination
    (course_name, course_department, course_number, term, section). A functional
    UNIQUE INDEX normalizes the text fields (lower + btrim) and coalesces the
    nullable term/section to '' so "no term/section" collapses to a single
    identity — a plain unique index treats NULLs as DISTINCT and would let such
    duplicates through. course_number is integer, compared exactly. The
    create_course/duplicate_course handlers enforce the same rule at the app layer
    (pre-check + 23505->409); this index is the race-safe backstop.
    """

    def test_unique_index_present_and_idempotent(self):
        src = _source()
        assert "CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_identity" in src
        assert 'ON "Courses" (' in src

    def test_text_fields_normalized_and_number_exact(self):
        src = _source()
        assert "lower(btrim(course_name))" in src
        assert "lower(btrim(course_department))" in src
        # course_number is integer — included in the index and matched exactly,
        # NOT wrapped in lower/btrim (which would fail on a non-text type anyway).
        assert "course_number," in src
        assert "lower(btrim(course_number))" not in src

    def test_nullable_term_and_section_coalesced(self):
        src = _source()
        assert "lower(btrim(coalesce(term, '')))" in src
        assert "lower(btrim(coalesce(section, '')))" in src

    def test_index_built_after_term_and_section_backfills(self):
        # The functional index references term & section, so their
        # ADD COLUMN IF NOT EXISTS migrations must run first (schema-drift rule),
        # or the index build fails on a pre-existing table missing the columns.
        src = _source()
        term_pos = src.index('ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "term" varchar')
        section_pos = src.index('ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "section" varchar')
        index_pos = src.index("CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_identity")
        assert index_pos > term_pos
        assert index_pos > section_pos


class TestCredentialResolution:
    """The initializer must treat Secrets Manager as the source of truth for the
    app DB credentials: REUSE stored credentials on re-run and generate new ones
    ONLY on first init (secret at the bootstrap placeholder) or teardown (secret
    empty). Regenerating on every run rotated the username/password and desynced
    the secret, the RDS Proxy's cached copy, and each Lambda's cached connection —
    the direct cause of "This RDS proxy has no credentials for the role <username>"
    (adminFunction.js:243). Pure logic, exercised directly.
    """

    def test_reuses_existing_real_credentials(self):
        # Real stored creds -> reuse verbatim, is_new False, generator never called.
        def _must_not_generate(_nbytes):
            pytest.fail("must not generate credentials when reusing existing ones")

        result = initializer._resolve_credentials(
            {"username": "2ba85710a3a7e6c7", "password": "deadbeefcafe", "host": "h"},
            generate=_must_not_generate,
        )
        assert result == ("2ba85710a3a7e6c7", "deadbeefcafe", False)

    def test_generates_when_placeholder_present(self):
        # First init: secret still holds the database-stack.ts placeholder username.
        result = initializer._resolve_credentials(
            {
                "username": initializer.PLACEHOLDER_USERNAME,
                "password": "applicationPassword",
            },
            generate=lambda nbytes: f"gen{nbytes}",
        )
        assert result == ("gen8", "gen16", True)

    @pytest.mark.parametrize(
        "secret",
        [
            {},
            None,
            {"username": "only_user"},          # missing password
            {"password": "only_pass"},          # missing username
            {"username": "", "password": ""},   # empty strings
        ],
    )
    def test_generates_when_credentials_absent(self, secret):
        _, _, is_new = initializer._resolve_credentials(secret, generate=lambda n: "x")
        assert is_new is True

    def test_generated_values_are_hex_with_token_hex_lengths(self):
        # Real generator (secrets.token_hex): username = token_hex(8) = 16 hex chars,
        # password = token_hex(16) = 32 hex chars. Locks generated-vs-reused shape.
        username, password, is_new = initializer._resolve_credentials({})
        assert is_new is True
        assert len(username) == 16
        assert len(password) == 32
        int(username, 16)  # raises ValueError if non-hex
        int(password, 16)

    def test_reuse_ignores_extra_secret_keys(self):
        # host/port/dbname etc. must not affect the reuse decision.
        username, password, is_new = initializer._resolve_credentials(
            {
                "username": "u1",
                "password": "p1",
                "host": "db.internal",
                "port": 5432,
                "dbname": "aila",
            },
            generate=lambda n: "SHOULD_NOT_BE_USED",
        )
        assert (username, password, is_new) == ("u1", "p1", False)


class TestCredentialsStableAcrossRuns:
    """Source-level guards so the credential-rotation regression cannot silently
    return: no unconditional regeneration, both app secrets are read for reuse,
    CREATE USER is idempotent, and secrets are (re)written only when newly minted.
    """

    def test_no_unconditional_random_generation(self):
        # The removed 4-line block assigned secrets.token_hex to username/password
        # on EVERY run — the root cause. It must not come back.
        src = _source()
        assert "username = secrets.token_hex(8)" not in src
        assert "password = secrets.token_hex(16)" not in src
        assert "usernameTableCreator = secrets.token_hex(8)" not in src

    def test_resolve_credentials_used_for_both_app_users(self):
        # Once for the readwrite user secret, once for the tablecreator secret.
        assert _source().count("_resolve_credentials(") >= 2

    def test_reads_current_app_secrets_for_reuse(self):
        src = _source()
        assert "_get_secret_dict(sm_client, DB_USER_SECRET_NAME)" in src
        assert "_get_secret_dict(sm_client, DB_PROXY)" in src

    def test_create_user_is_idempotent(self):
        # A pre-existing user (re-run) must re-assert its password via ALTER USER,
        # not fail or mint a brand-new random user. Two role blocks + two user
        # blocks => four duplicate_object guards.
        src = _source()
        assert src.count("ALTER USER") >= 2
        assert src.count("WHEN duplicate_object THEN") >= 4

    def test_secret_writes_conditional_on_new_credentials(self):
        src = _source()
        assert "if user_is_new:" in src
        assert "if tablecreator_is_new:" in src

    def test_placeholder_matches_database_stack_seed(self):
        # The reuse gate keys off this exact placeholder; it must equal the value
        # database-stack.ts seeds into the secrets (SecretValue "applicationUsername").
        assert initializer.PLACEHOLDER_USERNAME == "applicationUsername"

    def test_connection_is_lazy_not_module_level(self):
        # Module-level connect at import would (a) break these imports and (b) mean
        # a warm re-run never re-reads the secret. Init must be inside the handler.
        src = _source()
        assert "dbSecret = None" in src
        assert "connection = None" in src
        assert "dbSecret = getDbSecret()\nconnection = createConnection()" not in src
