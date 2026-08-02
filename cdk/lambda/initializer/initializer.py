import os
import json
import boto3
import psycopg2
from psycopg2.extensions import AsIs
import secrets

# Read with .get so importing this module (e.g. in unit tests) does not require
# the Lambda env vars to be set; they are always present at runtime.
DB_SECRET_NAME = os.environ.get("DB_SECRET_NAME")
DB_USER_SECRET_NAME = os.environ.get("DB_USER_SECRET_NAME")
DB_PROXY = os.environ.get("DB_PROXY")

# Bootstrap placeholder that database-stack.ts seeds into the user/tablecreator
# secrets at stack-create time. Its presence means "no real credentials yet" so
# this run mints them; ANY other stored username means real credentials already
# exist and MUST be reused (see _resolve_credentials).
PLACEHOLDER_USERNAME = "applicationUsername"


def getDbSecret():
    # secretsmanager client to get db credentials
    sm_client = boto3.client("secretsmanager")
    response = sm_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
    secret = json.loads(response)
    return secret


def _get_secret_dict(sm_client, secret_id):
    """Fetch a Secrets Manager secret as a dict; {} when unset/unreadable.

    Used to read the CURRENT app-user secrets so their credentials can be reused
    instead of regenerated on every run.
    """
    try:
        raw = sm_client.get_secret_value(SecretId=secret_id)["SecretString"]
        return json.loads(raw)
    except Exception:
        return {}


def _resolve_credentials(existing_secret, generate=secrets.token_hex):
    """Return (username, password, is_new) for an app DB user.

    Secrets Manager is the source of truth: reuse the stored username/password
    when they are real, and generate fresh credentials ONLY on first init (the
    secret still holds PLACEHOLDER_USERNAME) or after a teardown (secret empty).
    Keeping credentials STABLE across deploys is what stops the secret, the RDS
    Proxy's cached copy of it, and each Lambda's cached connection from disagreeing
    about the current role — the disagreement that raises
    "This RDS proxy has no credentials for the role <username>". Pure: no AWS/DB.
    """
    existing = existing_secret or {}
    username = existing.get("username")
    password = existing.get("password")
    if username and password and username != PLACEHOLDER_USERNAME:
        return username, password, False
    # token_hex(8) -> 16 hex chars (username); token_hex(16) -> 32 (password).
    return generate(8), generate(16), True


def createConnection():

    connection = psycopg2.connect(
        user=dbSecret["username"],
        password=dbSecret["password"],
        host=dbSecret["host"],
        dbname=dbSecret["dbname"],
        sslmode="require",
    )
    return connection


# Connection state is initialized lazily in the handler (not at import) so this
# module can be imported by unit tests without AWS credentials or a live DB.
dbSecret = None
connection = None


def handler(event, context):
    global dbSecret, connection
    if dbSecret is None:
        dbSecret = getDbSecret()
    if connection is None or connection.closed:
        connection = createConnection()
    
    cursor = connection.cursor()
    try:

        #
        ## Create tables and schema
        ##

        # Create tables based on the schema — matches production as of v2 migration
        sqlTableCreation = """
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
            CREATE EXTENSION IF NOT EXISTS vector;

            -- ─── Users ────────────────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Users" (
                "user_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "user_email" varchar UNIQUE,
                "username" varchar,
                "first_name" varchar,
                "last_name" varchar,
                "preferred_name" varchar,
                "time_account_created" timestamp,
                "roles" varchar[],
                "last_sign_in" timestamp
            );

            -- ─── Courses ──────────────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Courses" (
                "course_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "course_name" varchar,
                "course_department" varchar,
                "course_number" integer,
                "course_access_code" varchar,
                "course_student_access" bool,
                "term" varchar,
                "section" varchar,
                "system_prompt" text,
                "llm_model_id" varchar DEFAULT 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                "conflict_metadata" jsonb DEFAULT NULL,
                "validation_hash" text,
                "validation_cached_report" jsonb
            );

            -- ─── Course_Concepts ──────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Course_Concepts" (
                "concept_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "course_id" uuid,
                "concept_name" varchar,
                "concept_number" integer
            );

            -- ─── Course_Modules ───────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Course_Modules" (
                "module_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "concept_id" uuid,
                "module_name" varchar,
                "module_number" integer,
                "module_prompt" text,
                "conflict_metadata" jsonb DEFAULT NULL,
                "generated_topics" jsonb DEFAULT NULL,
                "validation_hash" text,
                "validation_cached_report" jsonb,
                "key_topics" jsonb,
                "status" varchar(10) NOT NULL DEFAULT 'active',
                "created_at" timestamptz NOT NULL DEFAULT NOW(),
                "updated_at" timestamptz NOT NULL DEFAULT NOW(),
                CONSTRAINT chk_course_modules_status
                    CHECK (status IN ('draft', 'active', 'deleting'))
            );

            -- ─── Enrolments ───────────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Enrolments" (
                "enrolment_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "user_id" uuid,
                "course_id" uuid,
                "enrolment_type" varchar,
                "course_completion_percentage" integer,
                "time_spent" integer,
                "time_enroled" timestamp,
                "access_enabled" boolean NOT NULL DEFAULT true,
                CONSTRAINT unique_course_user UNIQUE (course_id, user_id)
            );

            -- ─── Module_Files ─────────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Module_Files" (
                "file_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "module_id" uuid,
                "filetype" varchar,
                "s3_bucket_reference" varchar,
                "filepath" varchar,
                "filename" varchar,
                "time_uploaded" timestamp,
                "metadata" jsonb,
                "content_hash" text,
                "processing_status" text DEFAULT 'pending',
                "last_processed_at" timestamptz,
                "chunk_count" integer
            );

            -- ─── Student_Modules ──────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Student_Modules" (
                "student_module_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "course_module_id" uuid,
                "enrolment_id" uuid,
                "module_score" integer,
                "last_accessed" timestamp,
                "module_context_embedding" float[]
            );

            -- ─── Sessions ─────────────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Sessions" (
                "session_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "student_module_id" uuid,
                "session_name" varchar,
                "session_context_embeddings" float[],
                "last_accessed" timestamp
            );

            -- ─── Messages ─────────────────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Messages" (
                "message_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "session_id" uuid,
                "student_sent" bool,
                "message_content" varchar,
                "message_blocks" jsonb,
                "time_sent" timestamp
            );

            -- ─── User_Engagement_Log ──────────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "User_Engagement_Log" (
                "log_id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "user_id" uuid,
                "course_id" uuid,
                "module_id" uuid,
                "enrolment_id" uuid,
                "timestamp" timestamp,
                "engagement_type" varchar,
                "engagement_details" text
            );

            -- ─── chatlogs_notifications ───────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "chatlogs_notifications" (
                "id" uuid PRIMARY KEY DEFAULT (uuid_generate_v4()),
                "course_id" uuid NOT NULL,
                "instructor_email" varchar NOT NULL,
                "request_id" uuid NOT NULL,
                "completion" boolean DEFAULT FALSE
            );

            -- ─── Module_File_References ───────────────────────────────────────────
            CREATE TABLE IF NOT EXISTS "Module_File_References" (
                source_module_id   uuid,
                referenced_file_id uuid,
                PRIMARY KEY (source_module_id, referenced_file_id)
            );

            -- ─── retrieval_units (multimodal-rag v2) ──────────────────────────────
            CREATE TABLE IF NOT EXISTS retrieval_units (
                retrieval_id TEXT PRIMARY KEY,
                parent_element_id TEXT NOT NULL,
                embedding_text TEXT NOT NULL,
                element_type TEXT NOT NULL,
                embedding vector(1024),
                embedding_version TEXT NOT NULL,
                metadata JSONB DEFAULT '{}',
                sibling_ids JSONB DEFAULT '[]',
                ts_vector tsvector,
                -- Cross-module file referencing: the canonical file_id and the
                -- module_id are promoted to first-class indexed columns so retrieval
                -- can scope by `file_id = ANY(allowed_file_ids)` (including cross-module
                -- references) without JSON extraction. They are also kept inside
                -- `metadata` for backward-compatible reads. The enrichment writer
                -- (_store_in_pgvector) and the retrieval scope filter both depend on
                -- these columns.
                --
                -- file_id is TEXT, not UUID: it stores the canonical Module_Files.file_id
                -- (a UUID) as text so the scope filter's `= ANY(%s)` text[] binding
                -- compares directly, with no per-query ::uuid[] cast. A UUID column
                -- makes the scoped query raise `operator does not exist: uuid = text`.
                -- See the cross-module-file-referencing spec §4.4.
                file_id TEXT,
                module_id TEXT
            );

            -- Idempotent migration for databases provisioned before the two columns
            -- above existed: `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
            -- table, so the columns must be added explicitly. `ADD COLUMN IF NOT
            -- EXISTS` is itself a no-op when they are already present (e.g. on a
            -- freshly created table), so this is safe to run on every invocation.
            ALTER TABLE retrieval_units ADD COLUMN IF NOT EXISTS file_id TEXT;
            ALTER TABLE retrieval_units ADD COLUMN IF NOT EXISTS module_id TEXT;

            -- Idempotent migration: persist AI message render blocks (figures/
            -- tables/formulas) so chat-history reload can reconstruct them.
            ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS message_blocks jsonb;

            -- Idempotent migration: the module-lifecycle columns (status /
            -- created_at / updated_at) and the status CHECK are declared in the
            -- CREATE TABLE for "Course_Modules" above, but `CREATE TABLE IF NOT
            -- EXISTS` is a no-op on a database provisioned before they were added,
            -- so they must be added explicitly here. Without this, the partial
            -- index idx_course_modules_status_created (ON status, created_at —
            -- further below) fails on a pre-existing table with
            -- `column "status" does not exist`. Existing rows backfill to the
            -- CREATE TABLE default 'active' (a live module) and NOW(); re-running
            -- is a no-op once applied. Add the column BEFORE the CHECK so the
            -- constraint validates against the backfilled 'active' rows.
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "status" varchar(10) NOT NULL DEFAULT 'active';
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT NOW();
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT NOW();
            DO $$ BEGIN
                ALTER TABLE "Course_Modules" ADD CONSTRAINT chk_course_modules_status
                    CHECK (status IN ('draft', 'active', 'deleting'));
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            -- Idempotent backfill for feature columns that were added to the
            -- CREATE TABLE definitions above AFTER the initial tables were
            -- provisioned. `CREATE TABLE IF NOT EXISTS` never alters an existing
            -- table, so a long-lived database (prod) is missing every column
            -- introduced since it was first created. Confirmed missing on the prod
            -- schema dump (2026-07-13). All columns are nullable or defaulted, so
            -- adding them is safe on populated tables and a no-op once present.
            -- (metadata's text->jsonb drift is intentionally NOT auto-converted
            -- here — an invalid-JSON row would fail the whole init; handle it
            -- manually after checking `metadata IS JSON`.)
            ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "conflict_metadata" jsonb DEFAULT NULL;
            ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "validation_hash" text;
            ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "validation_cached_report" jsonb;
            -- Academic term label (e.g. "2026 Winter Term 2"). Required at the
            -- create-course API/UI; kept nullable here so the backfill is safe on
            -- the populated prod table and on duplicates of pre-term courses.
            ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "term" varchar;
            -- Optional course section label (e.g. "001", "L1A"). Nullable and set
            -- only via the create-course API/UI; safe to backfill on populated rows.
            ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "section" varchar;
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "conflict_metadata" jsonb DEFAULT NULL;
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "generated_topics" jsonb DEFAULT NULL;
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "validation_hash" text;
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "validation_cached_report" jsonb;
            ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS "key_topics" jsonb;
            ALTER TABLE "Module_Files" ADD COLUMN IF NOT EXISTS "content_hash" text;
            ALTER TABLE "Module_Files" ADD COLUMN IF NOT EXISTS "processing_status" text DEFAULT 'pending';
            ALTER TABLE "Module_Files" ADD COLUMN IF NOT EXISTS "last_processed_at" timestamptz;
            ALTER TABLE "Module_Files" ADD COLUMN IF NOT EXISTS "chunk_count" integer;
            -- Per-instructor OCELIA access flag (backend track B4). Gates an
            -- instructor's access to a course independently of the course-wide
            -- course_student_access flag. Defaults TRUE so existing instructor
            -- enrolments keep access; NOT NULL is safe because the default
            -- backfills every existing row.
            ALTER TABLE "Enrolments" ADD COLUMN IF NOT EXISTS "access_enabled" boolean NOT NULL DEFAULT true;

            -- Idempotent migration (2026-07): retire Claude 3 Sonnet as the
            -- per-course model. Set the column default (used by new courses) to
            -- the Claude Sonnet 4.5 Geo-US inference profile, and remap existing
            -- rows still pinned to the old Sonnet 3 id. Both are no-ops once
            -- applied (SET DEFAULT is declarative; the UPDATE then matches no
            -- rows). Llama 3 70B rows are intentionally left unchanged pending a
            -- future replacement decision.
            ALTER TABLE "Courses"
                ALTER COLUMN "llm_model_id" SET DEFAULT 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
            UPDATE "Courses"
                SET "llm_model_id" = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
                WHERE "llm_model_id" = 'anthropic.claude-3-sonnet-20240229-v1:0';

            -- Repair databases provisioned when file_id was created as UUID. The
            -- retrieval scope filter binds `file_id = ANY(%s)` as a text[] with no
            -- cast, and Postgres has no `uuid = text` operator, so every scoped
            -- vector/BM25 query raised UndefinedFunction and retrieval returned
            -- nothing. Convert to TEXT (lossless: a UUID renders as its canonical
            -- text form). Guarded on the current data_type so it is a cheap no-op on
            -- freshly created or already-migrated tables; the ALTER also rebuilds the
            -- dependent idx_retrieval_units_file_id index automatically.
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'retrieval_units'
                      AND column_name = 'file_id'
                      AND data_type = 'uuid'
                ) THEN
                    ALTER TABLE retrieval_units
                        ALTER COLUMN file_id TYPE text USING file_id::text;
                END IF;
            END $$;

            -- ─── Foreign Keys ─────────────────────────────────────────────────────
            -- Each FK is added with an EXPLICIT constraint name so the
            -- `duplicate_object` guard actually catches a re-add. An UNNAMED
            -- `ADD FOREIGN KEY` gets a fresh server-generated name every run, so it
            -- never trips the guard and silently duplicated every FK on each deploy
            -- (prod had grown ~7 copies of each). The paired
            -- `DROP CONSTRAINT IF EXISTS "<Table>_<col>_fkey"` removes the old
            -- auto-named FK on databases provisioned before this change (a no-op on
            -- a fresh DB or once already migrated), so each relationship ends with
            -- exactly one named FK. The drop-then-add revalidates the FK once; cheap
            -- on these tables (and free on an empty DB).

            ALTER TABLE "Course_Concepts" DROP CONSTRAINT IF EXISTS "Course_Concepts_course_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Course_Concepts" ADD CONSTRAINT fk_course_concepts_course_id
                    FOREIGN KEY ("course_id") REFERENCES "Courses" ("course_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Course_Modules" DROP CONSTRAINT IF EXISTS "Course_Modules_concept_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Course_Modules" ADD CONSTRAINT fk_course_modules_concept_id
                    FOREIGN KEY ("concept_id") REFERENCES "Course_Concepts" ("concept_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Enrolments" DROP CONSTRAINT IF EXISTS "Enrolments_course_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Enrolments" ADD CONSTRAINT fk_enrolments_course_id
                    FOREIGN KEY ("course_id") REFERENCES "Courses" ("course_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Enrolments" DROP CONSTRAINT IF EXISTS "Enrolments_user_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Enrolments" ADD CONSTRAINT fk_enrolments_user_id
                    FOREIGN KEY ("user_id") REFERENCES "Users" ("user_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Module_Files" DROP CONSTRAINT IF EXISTS "Module_Files_module_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Module_Files" ADD CONSTRAINT fk_module_files_module_id
                    FOREIGN KEY ("module_id") REFERENCES "Course_Modules" ("module_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Module_File_References" DROP CONSTRAINT IF EXISTS "Module_File_References_source_module_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Module_File_References" ADD CONSTRAINT fk_module_file_references_source_module_id
                    FOREIGN KEY (source_module_id) REFERENCES "Course_Modules" (module_id)
                    ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Module_File_References" DROP CONSTRAINT IF EXISTS "Module_File_References_referenced_file_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Module_File_References" ADD CONSTRAINT fk_module_file_references_referenced_file_id
                    FOREIGN KEY (referenced_file_id) REFERENCES "Module_Files" (file_id)
                    ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Student_Modules" DROP CONSTRAINT IF EXISTS "Student_Modules_course_module_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Student_Modules" ADD CONSTRAINT fk_student_modules_course_module_id
                    FOREIGN KEY ("course_module_id") REFERENCES "Course_Modules" ("module_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Student_Modules" DROP CONSTRAINT IF EXISTS "Student_Modules_enrolment_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Student_Modules" ADD CONSTRAINT fk_student_modules_enrolment_id
                    FOREIGN KEY ("enrolment_id") REFERENCES "Enrolments" ("enrolment_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Sessions" DROP CONSTRAINT IF EXISTS "Sessions_student_module_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Sessions" ADD CONSTRAINT fk_sessions_student_module_id
                    FOREIGN KEY ("student_module_id") REFERENCES "Student_Modules" ("student_module_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "Messages" DROP CONSTRAINT IF EXISTS "Messages_session_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "Messages" ADD CONSTRAINT fk_messages_session_id
                    FOREIGN KEY ("session_id") REFERENCES "Sessions" ("session_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "User_Engagement_Log" DROP CONSTRAINT IF EXISTS "User_Engagement_Log_enrolment_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD CONSTRAINT fk_user_engagement_log_enrolment_id
                    FOREIGN KEY ("enrolment_id") REFERENCES "Enrolments" ("enrolment_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "User_Engagement_Log" DROP CONSTRAINT IF EXISTS "User_Engagement_Log_user_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD CONSTRAINT fk_user_engagement_log_user_id
                    FOREIGN KEY ("user_id") REFERENCES "Users" ("user_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "User_Engagement_Log" DROP CONSTRAINT IF EXISTS "User_Engagement_Log_course_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD CONSTRAINT fk_user_engagement_log_course_id
                    FOREIGN KEY ("course_id") REFERENCES "Courses" ("course_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "User_Engagement_Log" DROP CONSTRAINT IF EXISTS "User_Engagement_Log_module_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD CONSTRAINT fk_user_engagement_log_module_id
                    FOREIGN KEY ("module_id") REFERENCES "Course_Modules" ("module_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "chatlogs_notifications" DROP CONSTRAINT IF EXISTS "chatlogs_notifications_course_id_fkey";
            DO $$ BEGIN
                ALTER TABLE "chatlogs_notifications" ADD CONSTRAINT fk_chatlogs_notifications_course_id
                    FOREIGN KEY ("course_id") REFERENCES "Courses" ("course_id")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            ALTER TABLE "chatlogs_notifications" DROP CONSTRAINT IF EXISTS "chatlogs_notifications_instructor_email_fkey";
            DO $$ BEGIN
                ALTER TABLE "chatlogs_notifications" ADD CONSTRAINT fk_chatlogs_notifications_instructor_email
                    FOREIGN KEY ("instructor_email") REFERENCES "Users" ("user_email")
                    ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            -- ─── Indexes ──────────────────────────────────────────────────────────

            CREATE INDEX IF NOT EXISTS idx_retrieval_units_ts_vector
            ON retrieval_units USING gin (ts_vector);

            CREATE INDEX IF NOT EXISTS idx_retrieval_units_embedding_version
            ON retrieval_units (embedding_version);

            -- Cross-module file referencing: indexed scope predicates so retrieval
            -- filters on `file_id = ANY(%s)` (a module's own + referenced files) and
            -- the `module_id` fallback hit an index instead of scanning. See spec §4.4.
            CREATE INDEX IF NOT EXISTS idx_retrieval_units_file_id
            ON retrieval_units (file_id);

            CREATE INDEX IF NOT EXISTS idx_retrieval_units_module_id
            ON retrieval_units (module_id);

            -- Approximate-nearest-neighbour index for vector search (#2).
            -- Matches the cosine distance operator (<=>) used by the retrieval
            -- query. Wrapped so that on an older pgvector (< 0.5.0, no HNSW) the
            -- migration degrades gracefully to exact KNN instead of failing
            -- schema initialization. hnsw needs no training data, so it builds
            -- instantly on the empty table and grows incrementally on insert.
            DO $$ BEGIN
                EXECUTE 'CREATE INDEX IF NOT EXISTS idx_retrieval_units_embedding_hnsw '
                        'ON retrieval_units USING hnsw (embedding vector_cosine_ops)';
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'HNSW index skipped (pgvector may predate 0.5.0): %', SQLERRM;
            END $$;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_module_files_unique_file
            ON "Module_Files" (module_id, filename, filetype);

            CREATE INDEX IF NOT EXISTS idx_course_modules_status_created
            ON "Course_Modules" (status, created_at)
            WHERE status IN ('draft', 'deleting');

            -- Course identity uniqueness: no two courses may share the same
            -- name + department + number + term + section. Case-insensitive and
            -- trimmed (lower(btrim(...))) so "GEOG 210" == " geog  210 "; term and
            -- section are coalesced to '' so "no term/section" collapses to a
            -- single identity (a plain unique index treats NULLs as DISTINCT and
            -- would let such duplicates through). course_number is integer, matched
            -- exactly. Runs after the term/section ADD COLUMN backfills above (both
            -- columns must exist first). The create_course/duplicate_course handlers
            -- also enforce this at the app layer (pre-check + 23505->409); this index
            -- is the race-safe backstop.
            CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_identity
            ON "Courses" (
                lower(btrim(course_name)),
                lower(btrim(course_department)),
                course_number,
                lower(btrim(coalesce(term, ''))),
                lower(btrim(coalesce(section, '')))
            );
        """

        #
        ## Create user with limited permission on RDS
        ##

        # Execute table creation
        cursor.execute(sqlTableCreation)
        connection.commit()

        # Resolve app-user credentials from Secrets Manager (the source of truth):
        # reuse the stored credentials when present, and generate new ones ONLY on
        # first init / after a teardown (secret still at the bootstrap placeholder).
        # Regenerating every run rotated the credentials and desynced the secret,
        # the RDS Proxy's cached copy, and each Lambda's cached connection — the
        # cause of "This RDS proxy has no credentials for the role <username>".
        # See _resolve_credentials and engineering-log.md (ADR-017 / Deploy Gotchas).
        sm_client = boto3.client("secretsmanager")
        username, password, user_is_new = _resolve_credentials(
            _get_secret_dict(sm_client, DB_USER_SECRET_NAME)
        )
        usernameTableCreator, passwordTableCreator, tablecreator_is_new = _resolve_credentials(
            _get_secret_dict(sm_client, DB_PROXY)
        )

        # Create new user with the following permission:
        #   - SELECT, INSERT, UPDATE, DELETE

        sqlCreateUser = """
            DO $$
            BEGIN
                CREATE ROLE readwrite;
            EXCEPTION
                WHEN duplicate_object THEN
                    RAISE NOTICE 'Role already exists.';
            END
            $$;

            GRANT CONNECT ON DATABASE postgres TO readwrite;

            GRANT USAGE ON SCHEMA public TO readwrite;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO readwrite;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO readwrite;
            GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO readwrite;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO readwrite;

            DO $$
            BEGIN
                CREATE USER "%s" WITH PASSWORD '%s';
            EXCEPTION
                WHEN duplicate_object THEN
                    ALTER USER "%s" WITH PASSWORD '%s';
            END
            $$;
            GRANT readwrite TO "%s";
        """
        
        sqlCreateTableCreator = """
            DO $$
            BEGIN
                CREATE ROLE tablecreator;
            EXCEPTION
                WHEN duplicate_object THEN
                    RAISE NOTICE 'Role already exists.';
            END
            $$;

            GRANT CONNECT ON DATABASE postgres TO tablecreator;

            GRANT USAGE, CREATE ON SCHEMA public TO tablecreator;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tablecreator;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tablecreator;
            GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tablecreator;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO tablecreator;

            DO $$
            BEGIN
                CREATE USER "%s" WITH PASSWORD '%s';
            EXCEPTION
                WHEN duplicate_object THEN
                    ALTER USER "%s" WITH PASSWORD '%s';
            END
            $$;
            GRANT tablecreator TO "%s";
        """


        # Execute user creation. The %s placeholders feed the idempotent DO block:
        #   CREATE USER "<u>" WITH PASSWORD '<p>'  /  (on conflict) ALTER USER "<u>" WITH PASSWORD '<p>'
        # then GRANT <role> TO "<u>"  ->  (username, password, username, password, username).
        cursor.execute(
            sqlCreateUser,
            (
                AsIs(username),
                AsIs(password),
                AsIs(username),
                AsIs(password),
                AsIs(username),
            ),
        )
        connection.commit()
        cursor.execute(
            sqlCreateTableCreator,
            (
                AsIs(usernameTableCreator),
                AsIs(passwordTableCreator),
                AsIs(usernameTableCreator),
                AsIs(passwordTableCreator),
                AsIs(usernameTableCreator),
            ),
        )
        connection.commit()

        # Persist ONLY newly-minted credentials. On reuse the secret already holds
        # the correct values (it is the source of truth), so rewriting it would
        # spawn a new secret version and briefly desync the RDS Proxy for nothing.
        # Each write copies dbSecret (which carries host/port/dbname + other keys
        # from the admin secret) so the two app secrets never share a mutated dict.
        if tablecreator_is_new:
            tablecreator_secret = dict(dbSecret)
            tablecreator_secret.update(
                {"username": usernameTableCreator, "password": passwordTableCreator}
            )
            sm_client.put_secret_value(
                SecretId=DB_PROXY, SecretString=json.dumps(tablecreator_secret)
            )

        if user_is_new:
            user_secret = dict(dbSecret)
            user_secret.update({"username": username, "password": password})
            sm_client.put_secret_value(
                SecretId=DB_USER_SECRET_NAME, SecretString=json.dumps(user_secret)
            )

        # Close cursor and connection
        cursor.close()
        connection.close()

        print("Initialization completed successfully")
    except Exception as e:
        print(f"Initialization error: {e}")
        raise
