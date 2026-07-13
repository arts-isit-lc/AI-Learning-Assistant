import os
import json
import boto3
import psycopg2
import httpx
from langchain_aws import BedrockEmbeddings
from aws_lambda_powertools import Logger

from helpers.vectorstore import get_vectorstore_retriever
from helpers.chat import get_bedrock_llm, get_initial_student_query, get_student_query, create_dynamodb_history_table, get_response_streaming
from constants.llm_models import is_valid_model_id

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

# Guardrail SSM parameter names (from CDK environment variables)
GUARDRAIL_ID_PARAM = os.environ.get("GUARDRAIL_ID_PARAM", "")
GUARDRAIL_VERSION_PARAM = os.environ.get("GUARDRAIL_VERSION_PARAM", "")

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

# Cached guardrail config (None = not yet loaded, "" = load failed — skip guardrails)
_guardrail_id: str | None = None
_guardrail_version: str | None = None


def initialize_guardrail_config():
    """Retrieve guardrail ID and version from SSM. Cache for container lifetime.
    On failure, log WARNING and set empty strings to signal 'proceed without guardrails'."""
    global _guardrail_id, _guardrail_version
    if _guardrail_id is not None:
        return  # already cached
    if not GUARDRAIL_ID_PARAM or not GUARDRAIL_VERSION_PARAM:
        logger.warning("Guardrail SSM parameter env vars not set, proceeding without guardrails")
        _guardrail_id = ""
        _guardrail_version = ""
        return
    try:
        _guardrail_id = ssm_client.get_parameter(
            Name=GUARDRAIL_ID_PARAM, WithDecryption=True
        )["Parameter"]["Value"]
        _guardrail_version = ssm_client.get_parameter(
            Name=GUARDRAIL_VERSION_PARAM, WithDecryption=True
        )["Parameter"]["Value"]
        logger.info("Guardrail config loaded",
                    extra={"guardrail_id": _guardrail_id, "guardrail_version": _guardrail_version})
    except Exception as e:
        logger.warning("Failed to retrieve guardrail SSM parameters, proceeding without guardrails",
                       extra={"parameter_name": GUARDRAIL_ID_PARAM, "error": str(e)})
        _guardrail_id = ""
        _guardrail_version = ""

def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret: {e}")
            raise ValueError("Secret is not properly formatted as JSON.")
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
            logger.info("Connected to the database")
        except Exception:
            logger.exception("Failed to connect to database")
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
            logger.warning(
                "No context found for course/module",
                extra={"course_id": course_id, "module_id": module_id},
            )
            return None

        context = {
            'system_prompt': result[0],
            'llm_model_id': result[1] if result[1] else None,
            'module_name': result[2],
            'module_prompt': result[3] if result[3] else "",
        }
        logger.info(
            "Module context fetched",
            extra={
                "module_name": context['module_name'],
                "has_system_prompt": context['system_prompt'] is not None,
                "llm_model_id": context['llm_model_id'],
            },
        )
        return context

    except Exception:
        logger.exception(
            "Error fetching module context",
            extra={"course_id": course_id, "module_id": module_id},
        )
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
    except Exception:
        logger.exception(
            "Error fetching allowed_file_ids",
            extra={"module_id": module_id},
        )
        return [], [module_id]

@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    import time
    t_start = time.time()
    logger.info("Text Generation Lambda invoked")
    initialize_constants()
    initialize_guardrail_config()
    init_latency = time.time() - t_start
    logger.info(
        "Initialization complete",
        extra={"init_latency_ms": round(init_latency * 1000)},
    )

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
    logger.info(
        "Module context fetch complete",
        extra={"latency_ms": round((time.time() - t0) * 1000)},
    )

    if module_context is None:
        logger.error(
            "Error fetching context",
            extra={"course_id": course_id, "module_id": module_id},
        )
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
        logger.error("No system prompt found", extra={"course_id": course_id})
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
            logger.warning(
                "Invalid LLM model ID for course, using system default",
                extra={"invalid_model_id": course_llm_model_id, "course_id": course_id},
            )
    
    logger.info(
        "LLM model selected",
        extra={"effective_llm_model_id": effective_llm_model_id, "course_id": course_id},
    )
    
    module_prompt = module_context['module_prompt']
    
    topic = module_context['module_name']

    if topic is None:
        logger.error("Invalid module_id — no topic", extra={"module_id": module_id})
        return {
            'statusCode': 400,
            'body': json.dumps('Invalid module_id')
        }
    
    body = {} if event.get("body") is None else json.loads(event.get("body"))
    question = body.get("message_content", "")
    
    if not question:
        logger.info("Start of conversation — generating initial query")
        student_query = get_initial_student_query(topic)
    else:
        logger.info(
            "Processing student question",
            extra={"question_length": len(question)},
        )
        student_query = get_student_query(question)
    
    try:
        logger.info("Creating Bedrock LLM instance.")
        # ARCH-4: Pass global bedrock_runtime client for caching
        # Pass guardrail config — empty strings result in LLM without guardrails
        llm = get_bedrock_llm(
            effective_llm_model_id,
            client=bedrock_runtime,
            guardrail_id=_guardrail_id or "",
            guardrail_version=_guardrail_version or "",
        )
    except Exception:
        logger.exception("Error getting LLM from Bedrock")
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
    except Exception:
        logger.exception("Error retrieving vectorstore config")
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
        logger.info(
            "Allowed file IDs fetched",
            extra={
                "latency_ms": round((time.time() - t0) * 1000),
                "collection_count": len(collection_names),
                "allowed_file_count": len(allowed_file_ids),
            },
        )

        # P-6: Pass the global connection to avoid creating new connections in hybrid_search
        # Image results collector: populated during retrieval for figure selection
        image_results_collector = []
        t0 = time.time()
        history_aware_retriever = get_vectorstore_retriever(
            llm=llm,
            vectorstore_config_dict=vectorstore_config_dict,
            embeddings=embeddings,
            allowed_file_ids=allowed_file_ids,
            collection_names=collection_names,
            connection=connect_to_db(),
            image_results_collector=image_results_collector,
        )
        logger.info(
            "Retriever created",
            extra={"latency_ms": round((time.time() - t0) * 1000)},
        )
    except Exception:
        logger.exception("Error creating history-aware retriever")
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
        try:
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
        except Exception as guardrail_err:
            # Check if this is a guardrail intervention (input/output blocked)
            err_msg = str(guardrail_err)
            if "GUARDRAIL_INTERVENED" in err_msg or "GuardrailIntervention" in err_msg:
                # Guardrail blocked the content — return blocked message
                blocked_msg = (
                    "I'm not able to help with that topic. Let's focus on your course material."
                    if "input" in err_msg.lower()
                    else "I'm not able to provide that response. Let me redirect our discussion back to the course material."
                )
                logger.info("Guardrail intervention triggered",
                            extra={"intervention_type": "input" if "input" in err_msg.lower() else "output",
                                   "session_id": session_id, "course_id": course_id})
                response = {"llm_output": blocked_msg, "llm_verdict": False}
            elif _guardrail_id and _guardrail_version:
                # Guardrail service error — retry without guardrails
                logger.error("Bedrock Guardrails service error, retrying without guardrails",
                             extra={"session_id": session_id, "guardrail_id": _guardrail_id,
                                    "exception_type": type(guardrail_err).__name__, "error": str(guardrail_err)})
                try:
                    llm_no_guardrail = get_bedrock_llm(
                        effective_llm_model_id, client=bedrock_runtime,
                        guardrail_id="", guardrail_version=""
                    )
                    response = get_response_streaming(
                        query=student_query,
                        topic=topic,
                        llm=llm_no_guardrail,
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
                except Exception as fallback_err:
                    logger.error("Fallback invocation without guardrails also failed",
                                 extra={"session_id": session_id, "error": str(fallback_err)})
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
            else:
                # No guardrails were active, this is a regular error
                raise

        logger.info(
            "Response streaming complete",
            extra={"response_latency_ms": round((time.time() - t0) * 1000)},
        )
        logger.info(
            "Total handler time",
            extra={"total_handler_latency_ms": round((time.time() - t_start) * 1000)},
        )
    except Exception:
        logger.exception("Error getting response")
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

    # Figure selection: deterministic, runs on shared retrieval outputs
    # (image_results_collector was populated during retrieval)
    try:
        from helpers.figure_selection import get_eligible_figures, select_figures, assemble_blocks

        llm_output = response.get("llm_output", "LLM failed to create response")

        # Separate image and text results from the retrieval collector
        image_results = [doc for doc in image_results_collector
                         if doc.metadata.get("element_type") == "image"
                         and doc.metadata.get("image_s3_key")]
        text_results = [doc for doc in image_results_collector
                        if doc.metadata.get("element_type") != "image"
                        and doc.metadata.get("element_type") != "image_escalation"]

        # Check if escalation produced a figure
        escalation_figure_id = None
        for doc in image_results_collector:
            if doc.metadata.get("element_type") == "image_escalation":
                escalation_figure_id = doc.metadata.get("retrieval_id")
                break

        eligible = get_eligible_figures(
            image_results=image_results,
            text_results=text_results,
            query=student_query,
            escalation_figure_id=escalation_figure_id,
        )
        selected_figures = select_figures(eligible, query=student_query)
        blocks = assemble_blocks(llm_output, selected_figures)
    except Exception:
        logger.exception("Figure selection failed, returning text-only blocks")
        llm_output = response.get("llm_output", "LLM failed to create response")
        blocks = [{"type": "text", "content": llm_output}]

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
            "blocks": blocks,
            "llm_output": response.get("llm_output", "LLM failed to create response"),
            "llm_verdict": response.get("llm_verdict", "LLM failed to create verdict")
        })
    }