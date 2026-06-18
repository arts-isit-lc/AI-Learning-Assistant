import os
import json
import time
import boto3
import psycopg2
from datetime import datetime, timezone
from aws_lambda_powertools import Logger

from langchain_aws import BedrockEmbeddings
from langchain_postgres import PGVector
from topic_extraction import (
    should_extract_topics,
    call_haiku_for_topics,
    update_file_metadata,
)
from indexing.deduplication import compute_content_hash, should_reprocess_file, update_content_hash
from indexing.incremental import acquire_module_lock, release_module_lock, incremental_index
from indexing.deletion import handle_file_deletion
from processing.in_memory import process_file_in_memory
from metrics.recorder import ProcessingMetrics, record_processing_metrics

# Structured logging via Powertools
logger = Logger(service="data-ingestion")

# X-Ray SDK: patch boto3 for distributed tracing
try:
    from aws_xray_sdk.core import xray_recorder, patch_all
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except ImportError:
    print("X-Ray initialization failed (non-critical): aws-xray-sdk not available")
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
AILA_DATA_INGESTION_BUCKET = os.environ["BUCKET"]
EMBEDDING_BUCKET_NAME = os.environ["EMBEDDING_BUCKET_NAME"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
EMBEDDING_MODEL_PARAM = os.environ["EMBEDDING_MODEL_PARAM"]

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm")
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
s3_client = boto3.client("s3")

# Cached resources
connection = None
db_secret = None
EMBEDDING_MODEL_ID = None


def get_secret():
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
            db_secret = json.loads(response)
        except Exception as e:
            logger.exception("Error fetching secret")
            raise
    return db_secret


def get_parameter():
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    global EMBEDDING_MODEL_ID
    if EMBEDDING_MODEL_ID is None:
        try:
            response = ssm_client.get_parameter(Name=EMBEDDING_MODEL_PARAM, WithDecryption=True)
            EMBEDDING_MODEL_ID = response["Parameter"]["Value"]
        except Exception as e:
            logger.exception("Error fetching parameter", extra={"param_name": EMBEDDING_MODEL_PARAM})
            raise
    return EMBEDDING_MODEL_ID


def connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
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
            connection = psycopg2.connect(connection_string)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.exception("Failed to connect to database")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection


def parse_s3_file_path(file_key):
    # Assuming the file path is of the format: {course_id}/{module_id}/{documents}/{file_name}.{file_type}
    logger.info("Parsing S3 file path", extra={"file_key": file_key})
    try:
        course_id, module_id, file_category, filename_with_ext = file_key.split('/')
        file_name, file_type = filename_with_ext.rsplit('.', 1)
        return course_id, module_id, file_category, file_name, file_type
    except Exception as e:
        logger.exception("Error parsing S3 file path", extra={"file_key": file_key})
        return {
                    "statusCode": 400,
                    "body": json.dumps("Error parsing S3 file path.")
                }


def insert_file_into_db(module_id, file_name, file_type, file_path, bucket_name):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {
            "statusCode": 500,
            "body": json.dumps("Database connection failed.")
        }

    try:
        cur = connection.cursor()

        # Check if a record already exists
        select_query = """
        SELECT * FROM "Module_Files"
        WHERE module_id = %s
        AND filename = %s
        AND filetype = %s;
        """
        cur.execute(select_query, (module_id, file_name, file_type))

        existing_file = cur.fetchone()

        if existing_file:
            # Update the existing record
            update_query = """
                UPDATE "Module_Files"
                SET s3_bucket_reference = %s,
                filepath = %s,
                time_uploaded = %s
                WHERE module_id = %s
                AND filename = %s
                AND filetype = %s;
            """
            timestamp = datetime.now(timezone.utc)
            cur.execute(update_query, (
                bucket_name,  # s3_bucket_reference
                file_path,  # filepath
                timestamp,  # time_uploaded
                module_id,  # module_id
                file_name,  # filename
                file_type  # filetype
            ))
            logger.info("Successfully updated file in database", extra={"file_name": file_name, "file_type": file_type, "module_id": module_id})
        else:
            # Insert a new record
            insert_query = """
                INSERT INTO "Module_Files"
                (module_id, filetype, s3_bucket_reference, filepath, filename, time_uploaded, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s);
            """
            timestamp = datetime.now(timezone.utc)
            cur.execute(insert_query, (
                module_id,  # module_id
                file_type,  # filetype
                bucket_name,  # s3_bucket_reference
                file_path,  # filepath
                file_name,  # filename
                timestamp,  # time_uploaded
                None  # metadata (JSONB NULL)
        ))
        logger.info("Successfully inserted file into database", extra={"file_name": file_name, "file_type": file_type, "module_id": module_id})

        connection.commit()
        cur.close()
    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.exception("Error inserting file into database", extra={"file_name": file_name, "file_type": file_type})
        raise


def get_file_id_from_db(module_id, file_name, file_type):
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT file_id FROM "Module_Files"
            WHERE module_id = %s AND filename = %s AND filetype = %s;
        """, (module_id, file_name, file_type))
        result = cur.fetchone()
        cur.close()
        return str(result[0]) if result else None
    except Exception as e:
        logger.exception("Error fetching file_id", extra={"module_id": module_id, "file_name": file_name})
        return None


def download_file_from_s3(bucket: str, key: str) -> bytes:
    """Download a file from S3 and return its raw bytes.

    Args:
        bucket: S3 bucket name.
        key: S3 object key.

    Returns:
        Raw bytes of the file content.
    """
    response = s3_client.get_object(Bucket=bucket, Key=key)
    return response['Body'].read()


def update_processing_status(file_id: str, status: str, connection) -> None:
    """Update the processing_status column in Module_Files.

    Also updates last_processed_at when status is 'complete'.

    Args:
        file_id: The UUID primary key from Module_Files.
        status: The new processing status ('processing', 'complete', 'failed', 'deleted').
        connection: An active psycopg2 connection.
    """
    try:
        with connection.cursor() as cur:
            if status == 'complete':
                cur.execute(
                    'UPDATE "Module_Files" SET processing_status = %s, last_processed_at = %s WHERE file_id = %s',
                    (status, datetime.now(timezone.utc), file_id),
                )
            else:
                cur.execute(
                    'UPDATE "Module_Files" SET processing_status = %s WHERE file_id = %s',
                    (status, file_id),
                )
        connection.commit()
        logger.info("Processing status updated", extra={"file_id": file_id, "status": status})
    except Exception:
        logger.exception("Failed to update processing status", extra={"file_id": file_id, "status": status})
        connection.rollback()
        raise


def update_chunk_count(file_id: str, chunk_count: int, connection) -> None:
    """Update the chunk_count column in Module_Files after successful processing.

    Args:
        file_id: The UUID primary key from Module_Files.
        chunk_count: Number of chunks indexed for this file.
        connection: An active psycopg2 connection.
    """
    try:
        with connection.cursor() as cur:
            cur.execute(
                'UPDATE "Module_Files" SET chunk_count = %s WHERE file_id = %s',
                (chunk_count, file_id),
            )
        connection.commit()
    except Exception:
        logger.exception("Failed to update chunk_count", extra={"file_id": file_id})
        connection.rollback()
        raise


def get_vectorstore(module_id: str, embeddings: BedrockEmbeddings) -> PGVector:
    """Initialize a PGVector instance for the given module.

    Args:
        module_id: Used as the collection name.
        embeddings: BedrockEmbeddings instance.

    Returns:
        Configured PGVector instance.
    """
    secret = get_secret()
    connection_string = (
        f"postgresql+psycopg://{secret['username']}:{secret['password']}"
        f"@{RDS_PROXY_ENDPOINT}:{secret['port']}/{secret['dbname']}?sslmode=require"
    )
    vectorstore = PGVector(
        embeddings=embeddings,
        collection_name=module_id,
        connection=connection_string,
        use_jsonb=True,
    )
    return vectorstore


def get_module_status(module_id: str, connection) -> str:
    """Query the Course_Modules table to get the current module status.

    Used to skip processing for modules that are being deleted or don't exist.

    Args:
        module_id: The UUID of the module.
        connection: An active psycopg2 connection.

    Returns:
        The status string ('draft', 'active', 'deleting') or None if not found.
    """
    try:
        with connection.cursor() as cur:
            cur.execute(
                'SELECT status FROM "Course_Modules" WHERE module_id = %s',
                (module_id,),
            )
            result = cur.fetchone()
            return result[0] if result else None
    except Exception:
        logger.exception("Error checking module status", extra={"module_id": module_id})
        # On error, default to allowing processing (fail-open to avoid losing data)
        return 'active'


@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    records = event.get('Records', [])
    if not records:
        return {
            "statusCode": 400,
            "body": json.dumps("No valid S3 event found.")
        }

    for record in records:
        event_name = record['eventName']
        bucket_name = record['s3']['bucket']['name']

        # Only process files from the AILA_DATA_INGESTION_BUCKET
        if bucket_name != AILA_DATA_INGESTION_BUCKET:
            logger.info("Ignoring event from non-target bucket", extra={"bucket_name": bucket_name})
            continue

        file_key = record['s3']['object']['key']
        s3_etag = record['s3']['object'].get('eTag', '')

        # Parse the file path
        course_id, module_id, file_category, file_name, file_type = parse_s3_file_path(file_key)
        if not course_id or not module_id or not file_name or not file_type:
            return {
                "statusCode": 400,
                "body": json.dumps("Error parsing S3 file path.")
            }

        logger.append_keys(course_id=course_id, module_id=module_id)

        # --- ObjectRemoved: file deletion ---
        if event_name.startswith('ObjectRemoved:'):
            conn = connect_to_db()
            result = handle_file_deletion(module_id, file_name, file_type, conn)
            logger.info("File deletion handled", extra=result)
            continue

        # --- ObjectCreated: file upload — incremental processing ---
        if event_name.startswith('ObjectCreated:'):
            # Check module status — skip if deleting or not found
            conn = connect_to_db()
            module_status = get_module_status(module_id, conn)
            if module_status in ('deleting', None):
                logger.warning(
                    "Module is deleting or not found, skipping file processing",
                    extra={"module_id": module_id, "module_status": module_status}
                )
                continue  # skip to next record

            # Step 1: Insert/update file record in DB
            insert_file_into_db(
                module_id=module_id,
                file_name=file_name,
                file_type=file_type,
                file_path=file_key,
                bucket_name=bucket_name,
            )
            file_id = get_file_id_from_db(module_id, file_name, file_type)
            if not file_id:
                logger.error("Could not resolve file_id after insert", extra={"file_name": file_name})
                return {
                    "statusCode": 500,
                    "body": json.dumps("Failed to resolve file_id."),
                }

            # Step 2: Download file once (reused for hash, topics, and chunking)
            file_bytes = download_file_from_s3(bucket_name, file_key)

            # Step 3: Content hash deduplication check
            content_hash = compute_content_hash(file_bytes)
            conn = connect_to_db()
            if not should_reprocess_file(file_id, content_hash, conn):
                logger.info("File unchanged, skipping processing", extra={"file_id": file_id})
                return {"statusCode": 200, "body": "File unchanged, skipping"}

            # Step 4: Set processing status
            update_processing_status(file_id, 'processing', conn)

            # Step 5: Acquire advisory lock for module
            if not acquire_module_lock(module_id, conn):
                raise RuntimeError(f"Could not acquire advisory lock for module {module_id}")

            processing_start = time.time()

            try:
                # Step 6: Process file in memory — get chunks AND full_text
                embeddings = BedrockEmbeddings(
                    model_id=get_parameter(),
                    client=bedrock_runtime,
                    region_name=REGION,
                )
                vectorstore = get_vectorstore(module_id, embeddings)

                chunks, full_text = process_file_in_memory(
                    file_bytes=file_bytes,
                    file_id=file_id,
                    filename=f"{file_name}.{file_type}",
                    embeddings=embeddings,
                    bucket=bucket_name,
                )

                # Step 7: Topic extraction using full_text (no re-download)
                try:
                    if should_extract_topics(file_id, s3_etag, conn):
                        if full_text:
                            topics = call_haiku_for_topics(full_text, bedrock_runtime, "full_document", len(full_text))
                            update_file_metadata(file_id, topics, s3_etag, conn)
                            logger.info("Topic extraction completed", extra={"file_id": file_id, "extraction_method": "full_document"})
                        else:
                            logger.info("No text extracted from file, skipping topic extraction")
                except Exception as e:
                    logger.warning("Topic extraction failed (non-blocking)", extra={"file_id": file_id, "error": str(e)})

                # Step 8: Incremental index — direct SQL delete + insert
                index_result = incremental_index(
                    file_id=file_id,
                    chunks=chunks,
                    vectorstore=vectorstore,
                    connection=conn,
                    collection_name=module_id,
                )
                logger.info("Incremental index complete", extra={
                    "file_id": file_id,
                    "deleted": index_result["deleted"],
                    "inserted": index_result["inserted"],
                })

                # Step 9: Update metadata after success
                update_content_hash(file_id, content_hash, conn)
                update_chunk_count(file_id, index_result["inserted"], conn)
                update_processing_status(file_id, 'complete', conn)

                # Step 10: Record processing metrics
                processing_duration_ms = int((time.time() - processing_start) * 1000)
                record_processing_metrics(
                    file_id=file_id,
                    metrics=ProcessingMetrics(
                        processing_duration_ms=processing_duration_ms,
                        chunk_count=index_result["inserted"],
                        embedding_count=index_result["inserted"],
                    ),
                    connection=conn,
                )

            except Exception as e:
                logger.exception("Processing failed", extra={"file_id": file_id})
                # Record failure metrics
                try:
                    processing_duration_ms = int((time.time() - processing_start) * 1000)
                    record_processing_metrics(
                        file_id=file_id,
                        metrics=ProcessingMetrics(
                            processing_duration_ms=processing_duration_ms,
                            chunk_count=0,
                            embedding_count=0,
                            last_error=str(e),
                        ),
                        connection=conn,
                    )
                except Exception:
                    logger.exception("Failed to record failure metrics", extra={"file_id": file_id})
                try:
                    update_processing_status(file_id, 'failed', conn)
                except Exception:
                    logger.exception("Failed to set status to 'failed'", extra={"file_id": file_id})
                raise
            finally:
                release_module_lock(module_id, conn)

            return {
                "statusCode": 200,
                "body": json.dumps({
                    "message": "File processed successfully.",
                    "location": f"s3://{bucket_name}/{file_key}",
                    "chunks_indexed": index_result["inserted"],
                }),
            }

    return {
        "statusCode": 400,
        "body": json.dumps("No new file upload or deletion event found.")
    }
