import os
import json
import boto3
import psycopg2
from aws_lambda_powertools import Logger

logger = Logger()

s3 = boto3.client('s3')
BUCKET = os.environ["BUCKET"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]

# AWS Clients
secrets_manager_client = boto3.client('secretsmanager')

# Global variables for caching
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
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def delete_file_from_db(module_id, file_name, file_type):
    """Delete a file's Module_Files row and its retrieval_units; return its file_id.

    Resolves the canonical UUID file_id first (needed both to delete the correct
    UUID-keyed S3 object and to remove the file's vector units), then deletes the
    retrieval_units and the Module_Files row in one transaction.

    Returns:
        The UUID file_id (str) if a matching row existed, else None.
    """
    connection = connect_to_db()
    cur = connection.cursor()
    try:
        cur.execute(
            'SELECT file_id FROM "Module_Files" WHERE module_id = %s AND filename = %s AND filetype = %s',
            (module_id, file_name, file_type),
        )
        row = cur.fetchone()
        if row is None:
            logger.warning(
                "No matching Module_Files row to delete",
                extra={"module_id": module_id, "file_name": file_name, "file_type": file_type},
            )
            cur.close()
            return None

        file_id = str(row[0])

        # Delete the file's vector units. retrieval_units is keyed by the canonical
        # UUID file_id (cross-module-file-referencing); without this they are
        # orphaned in pgvector after the Module_Files row is gone.
        cur.execute('DELETE FROM retrieval_units WHERE file_id = %s', (file_id,))
        units_deleted = cur.rowcount

        cur.execute('DELETE FROM "Module_Files" WHERE file_id = %s', (file_id,))

        connection.commit()
        cur.close()
        logger.info(
            "Deleted file from database",
            extra={"file_id": file_id, "retrieval_units_deleted": units_deleted},
        )
        return file_id
    except Exception:
        connection.rollback()
        try:
            cur.close()
        except Exception:
            pass
        logger.exception("Error deleting file from database")
        raise

@logger.inject_lambda_context
def lambda_handler(event, context):
    query_params = event.get("queryStringParameters", {})

    course_id = query_params.get("course_id", "")
    module_id = query_params.get("module_id", "")
    file_name = query_params.get("file_name", "")
    file_type = query_params.get("file_type", "")

    if not course_id or not module_id or not file_name or not file_type:
        logger.error("Missing required parameters", extra={
            "course_id": course_id,
            "module_id": module_id,
            "file_name": file_name,
            "file_type": file_type
        })
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameters: course_id, module_id, file_name, or file_type')
        }

    try:
        # Delete the DB row + the file's vector units first. This also resolves
        # the canonical UUID file_id, which is needed to address the S3 object.
        try:
            file_id = delete_file_from_db(module_id, file_name, file_type)
            logger.info(f"File {file_name}.{file_type} deleted from the database.")
        except Exception as e:
            logger.error(f"Error deleting file {file_name}.{file_type} from the database: {e}")
            return {
                'statusCode': 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps(f"Error deleting file {file_name}.{file_type} from the database")
            }

        # Delete the raw uploaded object at the canonical V2 key
        # courses/{course_id}/{module_id}/{file_id}.{file_type}. (The pre-V2 key
        # was {course}/{module}/documents/{filename}.{ext}, which no longer exists;
        # the object is now keyed by the UUID file_id, not the filename.)
        if file_id:
            object_key = f"courses/{course_id}/{module_id}/{file_id}.{file_type}"
            response = s3.delete_objects(
                Bucket=BUCKET,
                Delete={"Objects": [{"Key": object_key}], "Quiet": True},
            )
            logger.info(
                "Deleted file object from S3",
                extra={"file_id": file_id, "key": object_key, "s3_response": response},
            )
        else:
            # No matching DB row — nothing to address in S3. Idempotent success.
            logger.info(
                "No matching DB row; skipping S3 delete",
                extra={"file_name": file_name, "file_type": file_type},
            )

        return {
            'statusCode': 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('File deleted successfully')
        }
        
    except Exception as e:
        logger.exception(f"Error deleting file: {e}")
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