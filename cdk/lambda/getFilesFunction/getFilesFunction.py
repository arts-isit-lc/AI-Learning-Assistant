import os
import json
import boto3
from botocore.config import Config
import psycopg2
from aws_lambda_powertools import Logger

logger = Logger()

# Environment variables
REGION = os.environ["REGION"]
BUCKET = os.environ["BUCKET"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]

# AWS Clients
secrets_manager_client = boto3.client('secretsmanager')

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)

# Global variables for caching
connection = None
db_secret = None

def get_secret(secret_name):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret: {e}")
            raise ValueError(f"Secret is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret: {e}")
            raise
    return db_secret

def connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            secret = get_secret(DB_SECRET_NAME)
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
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def list_files_in_s3_prefix(bucket, prefix):
    files = []
    continuation_token = None

    # Fetch all objects in the module directory, handling pagination
    while True:
        if continuation_token:
            result = s3.list_objects_v2(
                Bucket=bucket, 
                Prefix=prefix, 
                ContinuationToken=continuation_token
            )
        else:
            result = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)

        if 'Contents' in result:
            for obj in result['Contents']:
                files.append(obj['Key'].replace(prefix, ''))

        # Check if there's more data to fetch
        if result.get('IsTruncated'):
            continuation_token = result.get('NextContinuationToken')
        else:
            break

    return files

def generate_presigned_url(bucket, key):
    try:
        return s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=300,
            HttpMethod="GET",
        )
    except Exception as e:
        logger.exception(f"Error generating presigned URL for {key}: {e}")
        return None

@logger.inject_lambda_context
def lambda_handler(event, context):
    query_params = event.get("queryStringParameters", {})

    course_id = query_params.get("course_id", "")
    module_id = query_params.get("module_id", "")

    if not course_id or not module_id:
        logger.error("Missing required parameters", extra={
            "course_id": course_id,
            "module_id": module_id,
        })
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameters: course_id, or module_id')
        }

    try:
        document_prefix = f"courses/{course_id}/{module_id}/"

        # S3 objects are keyed by the canonical UUID file_id ("{file_id}.{ext}")
        # since the cross-module-file-referencing change. IR artifacts
        # ("{course}/{module}/{file_id}/...") and images ("images/...") live under
        # different prefixes, so this lists only the raw uploaded files.
        document_files = list_files_in_s3_prefix(BUCKET, document_prefix)

        # Batch-load file metadata keyed by the UUID file_id, so the UUID-named S3
        # objects can be mapped back to their human filename + metadata.
        connection = connect_to_db()
        cur = connection.cursor()
        cur.execute(
            'SELECT file_id, filename, filetype, metadata FROM "Module_Files" WHERE module_id = %s;',
            (module_id,)
        )
        by_file_id = {
            str(file_id): (filename, filetype, metadata)
            for file_id, filename, filetype, metadata in cur.fetchall()
        }
        cur.close()

        # Build the response keyed by the human "{filename}.{filetype}" (the UI
        # displays this key) with a presigned URL for the actual UUID-keyed object.
        document_files_urls = {}
        for object_name in document_files:
            presigned_url = generate_presigned_url(BUCKET, f"{document_prefix}{object_name}")
            file_id = object_name.rsplit(".", 1)[0]  # strip extension -> UUID stem
            row = by_file_id.get(file_id)
            if row:
                filename, filetype, metadata = row
                # Surface the canonical file_id inside metadata — the UI reads
                # fileData.metadata.file_id for delete + topic operations.
                if isinstance(metadata, dict):
                    metadata = {**metadata, "file_id": file_id}
                document_files_urls[f"{filename}.{filetype}"] = {
                    "url": presigned_url,
                    "metadata": metadata,
                }
            else:
                # S3 object with no matching Module_Files row (orphan): surface it
                # by its raw key so it stays visible, but without metadata.
                document_files_urls[object_name] = {"url": presigned_url, "metadata": None}

        logger.info("Presigned URLs and metadata generated successfully", extra={
            "file_count": len(document_files_urls),
        })

        return {
            'statusCode': 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps({
                'document_files': document_files_urls
            })
        }
    except Exception as e:
        logger.exception(f"Error generating presigned URLs or retrieving metadata: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Internal server error')
        }