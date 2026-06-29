import os
import json
import boto3
import psycopg2
from psycopg2.extensions import AsIs
import secrets

DB_SECRET_NAME = os.environ["DB_SECRET_NAME"]
DB_USER_SECRET_NAME = os.environ["DB_USER_SECRET_NAME"]
DB_PROXY = os.environ["DB_PROXY"]
print(psycopg2.__version__)


def getDbSecret():
    # secretsmanager client to get db credentials
    sm_client = boto3.client("secretsmanager")
    response = sm_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
    secret = json.loads(response)
    return secret

def createConnection():

    connection = psycopg2.connect(
        user=dbSecret["username"],
        password=dbSecret["password"],
        host=dbSecret["host"],
        dbname=dbSecret["dbname"],
        sslmode="require",
    )
    return connection


dbSecret = getDbSecret()
connection = createConnection()


def handler(event, context):
    global connection
    print(connection)
    if connection.closed:
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
                "system_prompt" text,
                "llm_model_id" varchar DEFAULT 'meta.llama3-70b-instruct-v1:0',
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
                ts_vector tsvector
            );

            -- ─── Foreign Keys ─────────────────────────────────────────────────────

            DO $$ BEGIN
                ALTER TABLE "Course_Concepts" ADD FOREIGN KEY ("course_id")
                    REFERENCES "Courses" ("course_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Course_Modules" ADD FOREIGN KEY ("concept_id")
                    REFERENCES "Course_Concepts" ("concept_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Enrolments" ADD FOREIGN KEY ("course_id")
                    REFERENCES "Courses" ("course_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Enrolments" ADD FOREIGN KEY ("user_id")
                    REFERENCES "Users" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Module_Files" ADD FOREIGN KEY ("module_id")
                    REFERENCES "Course_Modules" ("module_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Module_File_References" ADD FOREIGN KEY (source_module_id)
                    REFERENCES "Course_Modules" (module_id) ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Module_File_References" ADD FOREIGN KEY (referenced_file_id)
                    REFERENCES "Module_Files" (file_id) ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Student_Modules" ADD FOREIGN KEY ("course_module_id")
                    REFERENCES "Course_Modules" ("module_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Student_Modules" ADD FOREIGN KEY ("enrolment_id")
                    REFERENCES "Enrolments" ("enrolment_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Sessions" ADD FOREIGN KEY ("student_module_id")
                    REFERENCES "Student_Modules" ("student_module_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "Messages" ADD FOREIGN KEY ("session_id")
                    REFERENCES "Sessions" ("session_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD FOREIGN KEY ("enrolment_id")
                    REFERENCES "Enrolments" ("enrolment_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD FOREIGN KEY ("user_id")
                    REFERENCES "Users" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD FOREIGN KEY ("course_id")
                    REFERENCES "Courses" ("course_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "User_Engagement_Log" ADD FOREIGN KEY ("module_id")
                    REFERENCES "Course_Modules" ("module_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "chatlogs_notifications" ADD FOREIGN KEY ("course_id")
                    REFERENCES "Courses" ("course_id") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            DO $$ BEGIN
                ALTER TABLE "chatlogs_notifications" ADD FOREIGN KEY ("instructor_email")
                    REFERENCES "Users" ("user_email") ON DELETE CASCADE ON UPDATE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;

            -- ─── Indexes ──────────────────────────────────────────────────────────

            CREATE INDEX IF NOT EXISTS idx_retrieval_units_ts_vector
            ON retrieval_units USING gin (ts_vector);

            CREATE INDEX IF NOT EXISTS idx_retrieval_units_embedding_version
            ON retrieval_units (embedding_version);

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
        """

        #
        ## Create user with limited permission on RDS
        ##

        # Execute table creation
        cursor.execute(sqlTableCreation)
        connection.commit()

        # Generate 16 bytes username and password randomly
        username = secrets.token_hex(8)
        password = secrets.token_hex(16)
        usernameTableCreator = secrets.token_hex(8)
        passwordTableCreator = secrets.token_hex(16)

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

            CREATE USER "%s" WITH PASSWORD '%s';
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

            CREATE USER "%s" WITH PASSWORD '%s';
            GRANT tablecreator TO "%s";
        """


        # Execute user creation
        cursor.execute(
            sqlCreateUser,
            (
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
            ),
        )
        connection.commit()

        # Store table creator credentials in Secrets Manager
        authInfoTableCreator = {"username": usernameTableCreator, "password": passwordTableCreator}
        dbSecret.update(authInfoTableCreator)
        sm_client = boto3.client("secretsmanager")
        sm_client.put_secret_value(
            SecretId=DB_PROXY, SecretString=json.dumps(dbSecret)
        )

        # Store read/write user credentials in Secrets Manager
        authInfo = {"username": username, "password": password}
        dbSecret.update(authInfo)
        sm_client = boto3.client("secretsmanager")
        sm_client.put_secret_value(
            SecretId=DB_USER_SECRET_NAME, SecretString=json.dumps(dbSecret)
        )

        # Close cursor and connection
        cursor.close()
        connection.close()

        print("Initialization completed successfully")
    except Exception as e:
        print(f"Initialization error: {e}")
        raise
