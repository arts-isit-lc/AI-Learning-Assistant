import os, json
import boto3
import psycopg2
from botocore.config import Config
from aws_lambda_powertools import Logger

BUCKET = os.environ["BUCKET"]
REGION = os.environ["REGION"]
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)
logger = Logger(service="generate-presigned-url")

# Cached DB resources
secrets_manager_client = boto3.client("secretsmanager")
connection = None
db_secret = None


def get_secret():
    global db_secret
    if not db_secret:
        response = secrets_manager_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
        db_secret = json.loads(response)
    return db_secret


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


def upsert_file_record(module_id, file_name, file_type):
    """Create or update a Module_Files record and return the file_id.

    Sets processing_status to 'pending' and resets content_hash/chunk_count/last_processed_at
    on re-upload so the ingestion pipeline treats it as a fresh file.
    """
    conn = connect_to_db()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "Module_Files" (module_id, filename, filetype, processing_status, time_uploaded)
                VALUES (%s, %s, %s, 'pending', NOW())
                ON CONFLICT (module_id, filename, filetype)
                DO UPDATE SET processing_status = 'pending', time_uploaded = NOW(),
                             content_hash = NULL, chunk_count = NULL, last_processed_at = NULL
                RETURNING file_id;
            """, (module_id, file_name, file_type))
            result = cur.fetchone()
            conn.commit()
            return str(result[0])
    except Exception:
        conn.rollback()
        logger.exception("Failed to upsert file record")
        raise


@logger.inject_lambda_context(log_event=True)
def lambda_handler(event, context):
    # Use .get() to safely extract query string parameters
    query_params = event.get("queryStringParameters", {})

    if not query_params:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing queries to generate pre-signed URL')
        }

    course_id = query_params.get("course_id", "")
    module_id = query_params.get("module_id", "")
    file_type = query_params.get("file_type", "")
    file_name = query_params.get("file_name", "")

    if not course_id:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: course_id')
        }

    if not module_id:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: module_id')
        }

    if not file_name:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: file_name')
        }

    # Allowed file types for documents with their corresponding MIME types
    allowed_document_types = {
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt": "text/plain",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xps": "application/oxps",
        "mobi": "application/x-mobipocket-ebook",
        "cbz": "application/vnd.comicbook+zip",
        # V2 multimodal pipeline additions
        "html": "text/html",
        "htm": "text/html",
        "tex": "application/x-tex",
        "latex": "application/x-latex",
        "csv": "text/csv",
        "json": "application/json",
        # V2 image adapter support
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "tiff": "image/tiff",
        "tif": "image/tiff",
        "bmp": "image/bmp",
        "webp": "image/webp",
    }

    if file_type in allowed_document_types:
        # V2 key format: courses/{course_id}/{module_id}/{filename}
        # Triggers V2 ragIngestionFunction via S3 event on irBucket courses/ prefix
        key = f"courses/{course_id}/{module_id}/{file_name}.{file_type}"
        content_type = allowed_document_types[file_type]
    else:
        return {
            'statusCode': 400,
            'body': json.dumps('Unsupported file type')
        }

    logger.info("Generating presigned URL", extra={
        "course_id": course_id,
        "module_id": module_id,
        "file_type": file_type,
        "file_name": file_name,
    })

    try:
        # Upsert file record in DB to get file_id (graceful degradation if DB not configured)
        file_id = None
        if DB_SECRET_NAME and RDS_PROXY_ENDPOINT:
            try:
                file_id = upsert_file_record(module_id, file_name, file_type)
                logger.info("File record upserted", extra={"file_id": file_id})
            except Exception:
                logger.exception("DB upsert failed, continuing without file_id")

        presigned_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": BUCKET,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=300,
            HttpMethod="PUT",
        )

        response_body = {"presignedurl": presigned_url, "content_type": content_type}
        if file_id:
            response_body["file_id"] = file_id

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            "body": json.dumps(response_body),
        }

    except Exception as e:
        logger.exception("Error generating presigned URL")
        return {
            'statusCode': 500,
            'body': json.dumps('Internal server error')
        }
