import os
import json
import boto3
import psycopg2
import httpx
from langchain_aws import BedrockEmbeddings
from aws_lambda_powertools import Logger

from helpers.vectorstore import get_vectorstore_retriever
from helpers.chat import get_bedrock_llm, get_initial_student_query, get_student_query, create_dynamodb_history_table, get_response_streaming
from constants.llm_models import DEFAULT_LLM_MODEL_ID, is_valid_model_id

# Structured logging via Powertools
logger = Logger(service="text-generation")

# X-Ray SDK: patch boto3 and httpx for distributed tracing
try:
    from aws_xray_sdk.core import xray_recorder, patch_all
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except ImportError:
    logger.warning("aws-xray-sdk not available, skipping X-Ray patching")
except Exception as exc:
    logger.warning(f"X-Ray SDK patching failed: {exc}")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
EMBEDDING_MODEL_PARAM = os.environ["EMBEDDING_MODEL_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
APPSYNC_API_URL = os.environ.get("APPSYNC_API_URL", "")

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)

# Cached resources
connection = None
db_secret = None
BEDROCK_LLM_ID = None
EMBEDDING_MODEL_ID = None
TABLE_NAME = None

# Cached embeddings instance
embeddings = None

# ARCH-4: Cache ChatBedrock instances per model ID
_llm_cache = {}

# P-5: Guard to avoid redundant DynamoDB list_tables call on warm invocations
_dynamodb_table_checked = False

def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret: {e}")
            raise ValueError(f"Secret is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret: {e}")
            raise
    return db_secret

def get_parameter(param_name, cached_var):
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    if cached_var is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var

def initialize_constants():
    global BEDROCK_LLM_ID, EMBEDDING_MODEL_ID, TABLE_NAME, embeddings, _dynamodb_table_checked
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    EMBEDDING_MODEL_ID = get_parameter(EMBEDDING_MODEL_PARAM, EMBEDDING_MODEL_ID)
    TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)

    if embeddings is None:
        embeddings = BedrockEmbeddings(
            model_id=EMBEDDING_MODEL_ID,
            client=bedrock_runtime,
            region_name=REGION,
        )
    
    # P-5: Only check/create DynamoDB table once per container lifetime
    if not _dynamodb_table_checked:
        create_dynamodb_history_table(TABLE_NAME)
        _dynamodb_table_checked = True

def send_chat_chunk(session_id, chunk, done=False):
    """ARCH-1: Send a streaming chunk to AppSync for real-time delivery to the frontend."""
    if not APPSYNC_API_URL:
        return
    try:
        query = """
        mutation SendChatChunk($session_id: String!, $chunk: String!, $done: Boolean!) {
            sendChatChunk(session_id: $session_id, chunk: $chunk, done: $done) {
                session_id
                chunk
                done
            }
        }
        """
        payload = {
            "query": query,
            "variables": {
                "session_id": session_id,
                "chunk": chunk,
                "done": done,
            }
        }
        headers = {"Content-Type": "application/json", "Authorization": "API_KEY"}
        with httpx.Client(timeout=10.0) as client:
            client.post(APPSYNC_API_URL, headers=headers, json=payload)
    except Exception as e:
        logger.warning(f"Failed to send chat chunk to AppSync: {e}")

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

def get_module_context(course_id, module_id):
    """
    P-2: Fetch course and module context in a single query instead of 4 separate ones.
    Returns dict with system_prompt, llm_model_id, module_name, module_prompt
    or None if the course/module combination is not found.
    """
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return None

    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT
                c.system_prompt,
                c.llm_model_id,
                cm.module_name,
                cm.module_prompt
            FROM "Courses" c
            JOIN "Course_Concepts" cc ON cc.course_id = c.course_id
            JOIN "Course_Modules" cm ON cm.concept_id = cc.concept_id
            WHERE c.course_id = %s AND cm.module_id = %s;
        """, (course_id, module_id))

        result = cur.fetchone()
        cur.close()

        if result is None:
            logger.warning(f"No context found for course_id={course_id}, module_id={module_id}")
            return None

        context = {
            'system_prompt': result[0],
            'llm_model_id': result[1] if result[1] else None,
            'module_name': result[2],
            'module_prompt': result[3] if result[3] else "",
        }
        logger.info(f"Module context fetched: module_name={context['module_name']}, "
                     f"has_system_prompt={context['system_prompt'] is not None}, "
                     f"llm_model_id={context['llm_model_id']}")
        return context

    except Exception as e:
        logger.error(f"Error fetching module context: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return None

def get_allowed_file_ids(module_id):
    """
    P-2: Fetch all allowed file IDs for a module in a single query using UNION.
    Also returns the set of collection names (module IDs) that own those files,
    so cross-module referenced files can be found in their respective collections.
    """
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT file_id, module_id FROM "Module_Files"
            WHERE module_id = %s
            UNION
            SELECT mfr.referenced_file_id, mf.module_id
            FROM "Module_File_References" mfr
            JOIN "Module_Files" mf ON mf.file_id = mfr.referenced_file_id
            WHERE mfr.source_module_id = %s;
        """, (module_id, module_id))
        rows = cur.fetchall()
        cur.close()
        file_ids = [str(row[0]) for row in rows]
        collection_names = list(set(str(row[1]) for row in rows))
        # Ensure the current module's collection is always included
        if str(module_id) not in collection_names:
            collection_names.append(str(module_id))
        return file_ids, collection_names
    except Exception as e:
        logger.error(f"Error fetching allowed_file_ids: {e}")
        return [], [module_id]

@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    import time
    t_start = time.time()
    logger.info("Text Generation Lambda function is called!")
    initialize_constants()
    logger.info(f"TIMING: initialize_constants took {(time.time() - t_start)*1000:.0f}ms")

    query_params = event.get("queryStringParameters", {})

    course_id = query_params.get("course_id", "")
    session_id = query_params.get("session_id", "")
    module_id = query_params.get("module_id", "")
    session_name = query_params.get("session_name", "New Chat")

    # Append request-scoped correlation keys
    logger.append_keys(session_id=session_id, course_id=course_id)

    if not course_id:
        logger.error("Missing required parameter: course_id")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameter: course_id')
        }

    if not session_id:
        logger.error("Missing required parameter: session_id")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameter: session_id')
        }

    if not module_id:
        logger.error("Missing required parameter: module_id")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameter: module_id')
        }
    
    # P-2: Single combined query for course + module context
    t0 = time.time()
    module_context = get_module_context(course_id, module_id)
    logger.info(f"TIMING: get_module_context took {(time.time() - t0)*1000:.0f}ms")

    if module_context is None:
        logger.error(f"Error fetching context for course_id={course_id}, module_id={module_id}")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error fetching course/module context')
        }

    system_prompt = module_context['system_prompt']
    if system_prompt is None:
        logger.error(f"No system prompt found for course_id: {course_id}")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error fetching system prompt')
        }

    # Get course-specific LLM model ID, fallback to default if not set
    course_llm_model_id = module_context['llm_model_id']
    
    # Validate the model ID and fallback to default if invalid
    if course_llm_model_id and is_valid_model_id(course_llm_model_id):
        effective_llm_model_id = course_llm_model_id
    else:
        effective_llm_model_id = BEDROCK_LLM_ID  # Fallback to system default
        if course_llm_model_id:
            logger.warning(f"Invalid LLM model ID '{course_llm_model_id}' for course {course_id}, using system default")
    
    logger.info(f"Using LLM model ID: {effective_llm_model_id} for course {course_id}")
    
    module_prompt = module_context['module_prompt']
    
    topic = module_context['module_name']

    if topic is None:
        logger.error(f"Invalid module_id: {module_id}")
        return {
            'statusCode': 400,
            'body': json.dumps('Invalid module_id')
        }
    
    body = {} if event.get("body") is None else json.loads(event.get("body"))
    question = body.get("message_content", "")
    
    if not question:
        logger.info(f"Start of conversation. Creating conversation history table in DynamoDB.")
        student_query = get_initial_student_query(topic)
    else:
        logger.info(f"Processing student question: {question}")
        student_query = get_student_query(question)
    
    try:
        logger.info("Creating Bedrock LLM instance.")
        # ARCH-4: Pass global bedrock_runtime client for caching
        llm = get_bedrock_llm(effective_llm_model_id, client=bedrock_runtime)
    except Exception as e:
        logger.error(f"Error getting LLM from Bedrock: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error getting LLM from Bedrock')
        }
    
    try:
        logger.info("Retrieving vectorstore config.")
        db_secret = get_secret(DB_SECRET_NAME)
        vectorstore_config_dict = {
            'collection_name': module_id,
            'dbname': db_secret["dbname"],
            'user': db_secret["username"],
            'password': db_secret["password"],
            'host': RDS_PROXY_ENDPOINT,
            'port': db_secret["port"]
        }
    except Exception as e:
        logger.error(f"Error retrieving vectorstore config: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error retrieving vectorstore config')
        }
    
    try:
        logger.info("Creating history-aware retriever.")

        t0 = time.time()
        allowed_file_ids, collection_names = get_allowed_file_ids(module_id)
        logger.info(f"TIMING: get_allowed_file_ids took {(time.time() - t0)*1000:.0f}ms")
        logger.info(f"Searching {len(collection_names)} collection(s) with {len(allowed_file_ids)} allowed file(s)")

        # P-6: Pass the global connection to avoid creating new connections in hybrid_search
        t0 = time.time()
        history_aware_retriever = get_vectorstore_retriever(
            llm=llm,
            vectorstore_config_dict=vectorstore_config_dict,
            embeddings=embeddings,
            allowed_file_ids=allowed_file_ids,
            collection_names=collection_names,
            connection=connect_to_db()
        )
        logger.info(f"TIMING: get_vectorstore_retriever took {(time.time() - t0)*1000:.0f}ms")
    except Exception as e:
        logger.error(f"Error creating history-aware retriever: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error creating history-aware retriever')
        }
    
    try:
        logger.info("Generating response from the LLM.")
        connection = connect_to_db()
        if connection is None:
            logger.error("No database connection available.")
            raise Exception("No database connection available.")

        # ARCH-1: Stream response via AppSync, then return final result
        t0 = time.time()
        response = get_response_streaming(
            query=student_query,
            topic=topic,
            llm=llm,
            history_aware_retriever=history_aware_retriever,
            table_name=TABLE_NAME,
            session_id=session_id,
            course_system_prompt=system_prompt,
            module_prompt=module_prompt,
            course_id=course_id,
            module_id=module_id,
            connection=connection,
            chunk_callback=lambda chunk: send_chat_chunk(session_id, chunk),
            done_callback=lambda: send_chat_chunk(session_id, "", done=True),
        )
        logger.info(f"TIMING: get_response_streaming took {(time.time() - t0)*1000:.0f}ms")
        logger.info(f"TIMING: total handler time {(time.time() - t_start)*1000:.0f}ms")
    except Exception as e:
        logger.error(f"Error getting response: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error getting response')
        }
    
    # ARCH-3: Session naming removed from critical path.
    # The frontend generates a name client-side (Option 1a).
    logger.info("Returning the generated response.")
    return {
        "statusCode": 200,
        "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
        "body": json.dumps({
            "session_name": session_name,
            "llm_output": response.get("llm_output", "LLM failed to create response"),
            "llm_verdict": response.get("llm_verdict", "LLM failed to create verdict")
        })
    }