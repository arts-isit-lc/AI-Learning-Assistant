"""
Orphan Cleanup Lambda

Identifies and removes orphaned draft modules:
- Draft modules older than 24 hours (abandoned without saving)
- Deleting modules older than 1 hour (cleanup process crashed mid-way)

For each orphan: performs the full cleanup sequence:
1. Set status = 'deleting'
2. Delete vector embeddings from pgvector
3. Delete Module_Files records
4. Delete S3 objects under the module prefix
5. Delete Course_Modules record

Requirements: 6.1, 6.2, 6.3
"""

import os
import json
import boto3
import psycopg2
from aws_lambda_powertools import Logger

# X-Ray SDK bootstrap
try:
    from aws_xray_sdk.core import patch_all, xray_recorder
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")

logger = Logger(service="orphan-cleanup")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
DATA_INGESTION_BUCKET = os.environ.get("DATA_INGESTION_BUCKET", "")
REGION = os.environ.get("REGION", "ca-central-1")

# AWS clients
secrets_manager_client = boto3.client("secretsmanager")
s3_client = boto3.client("s3")

# Cached DB credentials
_db_secret = None


def get_secret():
    global _db_secret
    if _db_secret is None:
        response = secrets_manager_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
        _db_secret = json.loads(response)
    return _db_secret


def connect_to_db():
    secret = get_secret()
    connection_params = {
        'dbname': secret["dbname"],
        'user': secret["username"],
        'password': secret["password"],
        'host': RDS_PROXY_ENDPOINT,
        'port': secret["port"],
        'sslmode': 'require'
    }
    connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
    return psycopg2.connect(connection_string)


def find_orphans(conn):
    """Find all orphaned draft and stuck-deleting modules."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT module_id, status,
                   (SELECT course_id FROM "Course_Concepts" cc WHERE cc.concept_id = cm.concept_id LIMIT 1) as course_id
            FROM "Course_Modules" cm
            WHERE (status = 'draft' AND created_at < NOW() - INTERVAL '24 hours')
               OR (status = 'deleting' AND updated_at < NOW() - INTERVAL '1 hour')
        """)
        return cur.fetchall()


def cleanup_module(conn, module_id, course_id):
    """
    Perform full cleanup of a single orphaned module.
    Steps: set deleting → delete embeddings → delete files → delete S3 → delete record.
    All steps are idempotent — missing resources are treated as already deleted.
    """
    logger.info("Cleaning up orphaned module", extra={"module_id": module_id, "course_id": course_id})

    # Step 1: Set status to 'deleting' to prevent new processing work
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE \"Course_Modules\" SET status = 'deleting', updated_at = NOW() WHERE module_id = %s",
            (module_id,)
        )
    conn.commit()

    # Step 2: Delete vector embeddings (idempotent)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT uuid FROM langchain_pg_collection WHERE name = %s::text",
                (module_id,)
            )
            collection = cur.fetchone()
            if collection:
                cur.execute(
                    "DELETE FROM langchain_pg_embedding WHERE collection_id = %s",
                    (collection[0],)
                )
                cur.execute(
                    "DELETE FROM langchain_pg_collection WHERE name = %s::text",
                    (module_id,)
                )
        conn.commit()
    except Exception:
        logger.exception("Error deleting embeddings (continuing)", extra={"module_id": module_id})
        conn.rollback()

    # Step 3: Delete Module_Files records
    with conn.cursor() as cur:
        cur.execute('DELETE FROM "Module_Files" WHERE module_id = %s', (module_id,))
    conn.commit()

    # Step 4: Delete S3 objects under the module prefix
    if DATA_INGESTION_BUCKET and course_id:
        try:
            prefix = f"{course_id}/{module_id}/"
            continuation_token = None
            while True:
                params = {"Bucket": DATA_INGESTION_BUCKET, "Prefix": prefix}
                if continuation_token:
                    params["ContinuationToken"] = continuation_token
                response = s3_client.list_objects_v2(**params)
                objects = response.get("Contents", [])
                if objects:
                    s3_client.delete_objects(
                        Bucket=DATA_INGESTION_BUCKET,
                        Delete={"Objects": [{"Key": obj["Key"]} for obj in objects], "Quiet": True}
                    )
                if not response.get("IsTruncated"):
                    break
                continuation_token = response.get("NextContinuationToken")
        except Exception:
            logger.exception("Error deleting S3 objects (continuing)", extra={"module_id": module_id})

    # Step 5: Delete the Course_Modules record
    with conn.cursor() as cur:
        cur.execute('DELETE FROM "Course_Modules" WHERE module_id = %s', (module_id,))
    conn.commit()

    logger.info("Orphaned module cleaned up", extra={"module_id": module_id})


@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    logger.info("Orphan cleanup Lambda starting")

    conn = None
    processed = 0
    failed = 0
    errors = []

    try:
        conn = connect_to_db()
        orphans = find_orphans(conn)
        logger.info(f"Found {len(orphans)} orphaned modules")

        for module_id, status, course_id in orphans:
            module_id_str = str(module_id)
            try:
                cleanup_module(conn, module_id_str, str(course_id) if course_id else None)
                processed += 1
            except Exception as e:
                failed += 1
                error_msg = f"module_id={module_id_str}: {str(e)}"
                errors.append(error_msg)
                logger.exception("Failed to clean up orphaned module", extra={"module_id": module_id_str})
                # Continue with the next module (Requirement 6.3)
                try:
                    conn.rollback()
                except Exception:
                    pass

    except Exception:
        logger.exception("Orphan cleanup Lambda encountered a fatal error")
    finally:
        if conn and not conn.closed:
            conn.close()

    summary = {"processed": processed, "failed": failed, "errors": errors}
    logger.info("Orphan cleanup complete", extra=summary)
    return {"statusCode": 200, "body": json.dumps(summary)}
