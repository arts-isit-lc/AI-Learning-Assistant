"""Chatbot V2 Lambda handler — orchestrates the structured learning pipeline."""

import os
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import boto3
import botocore.exceptions
import psycopg2
from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

# X-Ray bootstrap
try:
    from aws_xray_sdk.core import patch_all, xray_recorder
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")

from state_machine import (create_default_state, serialize_state, deserialize_state,
    update_state, check_stage_advancement, check_module_completion,
    calculate_mastery_profile, calculate_coverage,
    required_concepts_discussed, completion_missing_requirements)
from evaluation import evaluate_answer
from concept_tracker import introduce_concepts, discuss_concepts, demonstrate_concepts, record_misunderstandings
from mode_selector import select_mode
from prompt_builder import build_system_prompt, build_tutor_system_prompt
from retrieval_client import invoke_retrieval, get_bounded_history as get_retrieval_history
from streaming import stream_response, send_final
from guardrails import load_guardrail_config, wrap_user_message, handle_guardrail_error, GUARDRAIL_SERVICE_ERROR_MESSAGE
from flags import GUARDRAIL_FAIL_CLOSED, CACHE_MODULE_METADATA, PARALLEL_EVAL_RETRIEVAL, ASYNC_RDS_PROJECTION, USE_CONVERSE_STREAMING
from history import load_chat_history, get_bounded_history, persist_message_pair, MAX_PROMPT_TURNS
from rds_projection import persist_message_to_rds, log_engagement
from constants.models import RESPONSE_MODEL_ID, RESPONSE_MAX_TOKENS
from math_classifier import classify_math_intent
from math_compute_client import invoke_math_compute
from tutor_integration import (
    is_tutor_active, should_enter_tutoring, create_tutor_state,
    process_tutor_turn, get_initial_tutor_prompt,
)

# Environment variables
REGION = os.environ.get("REGION", "ca-central-1")
RAG_RETRIEVAL_FUNCTION_ARN = os.environ.get("RAG_RETRIEVAL_FUNCTION_ARN", "")
SESSION_STATE_TABLE = os.environ.get("SESSION_STATE_TABLE", "")
CHAT_HISTORY_TABLE = os.environ.get("CHAT_HISTORY_TABLE", "")
DB_SECRET_ARN = os.environ.get("DB_SECRET_ARN", "")
DB_PROXY_ENDPOINT = os.environ.get("DB_PROXY_ENDPOINT", "")
APPSYNC_API_URL = os.environ.get("APPSYNC_API_URL", "")
APPSYNC_API_URL_PARAM = os.environ.get("APPSYNC_API_URL_PARAM", "")
GUARDRAIL_ID_PARAM = os.environ.get("GUARDRAIL_ID_PARAM", "")
GUARDRAIL_VERSION_PARAM = os.environ.get("GUARDRAIL_VERSION_PARAM", "")
MATH_COMPUTE_FUNCTION_ARN = os.environ.get("MATH_COMPUTE_FUNCTION_ARN", "")
RDS_PROJECTION_QUEUE_URL = os.environ.get("RDS_PROJECTION_QUEUE_URL", "")
# Runtime kill switch for cross-module file referencing. Defaults on; set to
# "false" to revert to module_id-only retrieval scoping without a redeploy.
ENABLE_CROSS_MODULE_REFERENCING = os.environ.get("ENABLE_CROSS_MODULE_REFERENCING", "true").lower() != "false"
# Module-level singletons (initialized once per container)
_lambda_client = boto3.client("lambda", region_name=REGION)
_bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)
_ssm_client = boto3.client("ssm", region_name=REGION)
_dynamodb_resource = boto3.resource("dynamodb", region_name=REGION)
_secrets_client = boto3.client("secretsmanager", region_name=REGION)
_sqs_client = boto3.client("sqs", region_name=REGION)

_guardrail_id: str | None = None
_guardrail_version: str | None = None
_appsync_url: str | None = None
_db_connection = None

CORS_HEADERS = {"Content-Type": "application/json", "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*"}


def _get_guardrail_config() -> tuple[str, str]:
    global _guardrail_id, _guardrail_version
    if _guardrail_id is None:
        _guardrail_id, _guardrail_version = load_guardrail_config(_ssm_client, GUARDRAIL_ID_PARAM, GUARDRAIL_VERSION_PARAM)
    return _guardrail_id, _guardrail_version


def _get_appsync_url() -> str:
    """Resolve the AppSync GraphQL URL, cached per container.

    Prefers the direct APPSYNC_API_URL env var; otherwise reads it once from the
    SSM parameter named by APPSYNC_API_URL_PARAM. The AppSync API is created in
    ApiGatewayStack (which depends on this function's stack), so the URL is passed
    indirectly via SSM to avoid a circular cross-stack dependency. Best-effort:
    on failure returns "" and streaming is silently skipped (see streaming.send_chunk).
    """
    global _appsync_url
    if _appsync_url is not None:
        return _appsync_url
    if APPSYNC_API_URL:
        _appsync_url = APPSYNC_API_URL
    elif APPSYNC_API_URL_PARAM:
        try:
            _appsync_url = _ssm_client.get_parameter(Name=APPSYNC_API_URL_PARAM)["Parameter"]["Value"]
        except Exception:
            logger.warning(
                "Failed to resolve AppSync URL from SSM; token streaming disabled",
                extra={"param": APPSYNC_API_URL_PARAM},
            )
            _appsync_url = ""
    else:
        _appsync_url = ""
    return _appsync_url


def _stream_final(session_id: str, *, llm_output: str | None = None, blocks=None,
                  session_name: str | None = None, llm_verdict: bool | None = None,
                  error: bool = False) -> None:
    """Emit the SINGLE terminal stream message for a turn (best-effort).

    The AppSync stream is the authoritative delivery channel — the HTTP POST is a
    fire-and-forget trigger that can hit API Gateway's 29s timeout on a slow
    (multi-image) turn — so EVERY handler exit path emits exactly one of these:
    the final blocks + metadata on success, or error=True on failure. No-ops
    without a session_id (the client's watchdog is the backstop)."""
    if not session_id:
        return
    try:
        send_final(_get_appsync_url(), session_id, llm_output=llm_output, blocks=blocks,
                   session_name=session_name, llm_verdict=llm_verdict, error=error)
    except Exception:
        logger.exception("Failed to emit terminal stream message (best-effort)")


def _get_db_connection():
    global _db_connection
    if _db_connection is None or _db_connection.closed:
        secret = json.loads(_secrets_client.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"])
        _db_connection = psycopg2.connect(
            f"dbname={secret['dbname']} user={secret['username']} password={secret['password']} "
            f"host={DB_PROXY_ENDPOINT} port={secret['port']} sslmode=require"
        )
    return _db_connection


def _get_allowed_file_ids(module_id: str) -> list[str]:
    """Return the file_ids a module can retrieve: its own files + cross-module
    references (Module_File_References). Reuses the warm module-level connection.

    Best-effort: on any error returns [] so retrieval falls back to module_id
    scoping (safe default — never broadens scope on failure).
    """
    if not ENABLE_CROSS_MODULE_REFERENCING or not module_id:
        return []
    if not DB_SECRET_ARN or not DB_PROXY_ENDPOINT:
        return []
    try:
        conn = _get_db_connection()
        cur = conn.cursor()
        cur.execute(
            '''SELECT file_id FROM "Module_Files" WHERE module_id = %s
               UNION
               SELECT referenced_file_id FROM "Module_File_References" WHERE source_module_id = %s''',
            (module_id, module_id),
        )
        rows = cur.fetchall()
        cur.close()
        return [str(r[0]) for r in rows if r[0] is not None]
    except Exception:
        logger.exception("Failed to compute allowed_file_ids; falling back to module scope")
        try:
            _get_db_connection().rollback()
        except Exception:
            pass
        return []


def _load_module_concepts(course_id: str, module_id: str) -> tuple[list[str], str]:
    """Load module concepts and module name from Course_Modules.
    
    Returns:
        Tuple of (concepts list, module_name string).
    """
    conn = _get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute('SELECT generated_topics, module_name FROM "Course_Modules" WHERE module_id = %s', (module_id,))
        row = cur.fetchone()
        cur.close()
        if row:
            topics_raw = row[0]
            module_name = row[1] or ""
            if topics_raw:
                topics = topics_raw if isinstance(topics_raw, list) else json.loads(topics_raw)
                # Handle double-encoded JSON (string containing a JSON string)
                if isinstance(topics, str):
                    topics = json.loads(topics)
                return (topics if isinstance(topics, list) else [], module_name)
            return ([], module_name)
        return ([], "")
    except Exception:
        logger.exception("Failed to load module_concepts from DB")
        conn.rollback()
        raise


def _load_other_module_names(course_id: str, current_module_id: str) -> list[str]:
    conn = _get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""SELECT cm.module_name FROM "Course_Modules" cm
            JOIN "Course_Concepts" cc ON cc.concept_id = cm.concept_id
            WHERE cc.course_id = %s AND cm.module_id != %s""", (course_id, current_module_id))
        rows = cur.fetchall()
        cur.close()
        return [r[0] for r in rows if r[0]]
    except Exception:
        logger.exception("Failed to load other module names")
        conn.rollback()
        return []


def _load_session_state(session_id: str):
    """Load session state from DynamoDB. Raises ClientError on table access failure."""
    table = _dynamodb_resource.Table(SESSION_STATE_TABLE)
    item = table.get_item(Key={"session_id": session_id}).get("Item")
    return deserialize_state(item) if item else None


def _persist_session_state(state) -> None:
    table = _dynamodb_resource.Table(SESSION_STATE_TABLE)
    expected_version = state.state_version
    state.state_version = expected_version + 1
    item = serialize_state(state)
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(state_version) OR state_version = :v",
            ExpressionAttributeValues={":v": expected_version},
        )
    except _dynamodb_resource.meta.client.exceptions.ConditionalCheckFailedException:
        logger.warning("State write conflict, retrying once", extra={"session_id": state.session_id})
        reloaded = _load_session_state(state.session_id)
        if reloaded is None:
            logger.exception("State write conflict and reload failed (best-effort)")
            return
        # Retry with a CONDITION against the reloaded version so a concurrent
        # writer is never blindly clobbered (M3). If it still conflicts, give up
        # rather than overwrite — losing this turn's state update is safer than
        # corrupting a newer one. (Full delta-merge intentionally deferred.)
        expected_version = reloaded.state_version
        state.state_version = expected_version + 1
        item = serialize_state(state)
        try:
            table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(state_version) OR state_version = :v",
                ExpressionAttributeValues={":v": expected_version},
            )
        except Exception:
            logger.exception("State write retry also conflicted; skipping (best-effort)")


def _get_last_ai_question(chat_history: list[dict]) -> str:
    for msg in reversed(chat_history):
        if msg.get("role") == "assistant":
            return msg.get("content", "")
    return ""


def _eval_and_retrieve(run_evaluation, run_retrieval, parallel: bool):
    """Coordinate the evaluation and retrieval calls for a turn (#7).

    Args:
        run_evaluation: zero-arg callable returning the EvaluationResult or None.
        run_retrieval: callable taking a misunderstood-concepts list, returning
            the RetrievalResult or None.
        parallel: when True, run both concurrently (retrieval gets an empty
            misunderstood list = pre-evaluation learning state) and mark
            retrieval done; when False, run only the evaluation and leave
            retrieval to the caller (so it can use the post-evaluation context).

    Returns:
        (evaluation, retrieval_result_or_None, retrieval_done) tuple.
    """
    if parallel:
        with ThreadPoolExecutor(max_workers=2) as ex:
            eval_future = ex.submit(run_evaluation)
            retrieval_future = ex.submit(run_retrieval, [])
            return eval_future.result(), retrieval_future.result(), True
    return run_evaluation(), None, False


def _stream_with_guardrail_retry(
    system_prompt: str,
    user_message: str,
    prompt_history: list[dict],
    session_id: str,
    model_kwargs: dict,
    guardrail_id: str,
) -> str | dict:
    """Stream response with guardrail error retry logic.

    If a guardrail intervention occurs (content blocked), returns the redirect dict.
    If a guardrail service error occurs, retries once without guardrails.
    If retry also fails, raises to let the outer handler return 500.
    Returns the LLM output string on success.
    """
    try:
        return stream_response(
            _bedrock_client, model_id=RESPONSE_MODEL_ID, system_prompt=system_prompt,
            user_message=user_message, chat_history=prompt_history,
            appsync_url=_get_appsync_url(), session_id=session_id, model_kwargs=model_kwargs,
        )
    except Exception as e:
        # Check if this is a guardrail-related error
        guardrail_result = handle_guardrail_error(e, guardrail_id)
        if guardrail_result is not None:
            # Guardrail intervention (input or output blocked) — return redirect message
            return guardrail_result
        # Guardrail SERVICE error (not a content intervention).
        if GUARDRAIL_FAIL_CLOSED:
            # Fail closed (#11): do NOT regenerate without guardrails (that would
            # emit ungated content). Return a safe blocked-style message that the
            # handler already surfaces to the student.
            logger.warning("Guardrail service error; failing closed (no ungated retry)")
            return {
                "message": GUARDRAIL_SERVICE_ERROR_MESSAGE,
                "blocked": True,
                "type": "service_error",
            }
        # Default behavior: retry once without guardrails.
        logger.warning("Guardrail service error, retrying without guardrails")
        model_kwargs_no_guardrail = {k: v for k, v in model_kwargs.items() if k not in ("guardrail_id", "guardrail_version")}
        try:
            return stream_response(
                _bedrock_client, model_id=RESPONSE_MODEL_ID, system_prompt=system_prompt,
                user_message=user_message, chat_history=prompt_history,
                appsync_url=_get_appsync_url(), session_id=session_id, model_kwargs=model_kwargs_no_guardrail,
            )
        except Exception:
            logger.exception("Retry without guardrails also failed")
            raise


def _utc_now_iso() -> str:
    """Wall-clock UTC as a naive ISO-8601 string for the RDS ``time_sent``
    (``timestamp`` without tz) column.

    Captured in-app so message ordering reflects TURN time, not RDS-write time.
    Under ASYNC_RDS_PROJECTION the RDS projection is written LATER by the SQS
    consumer, so stamping the write time lets a synchronous guardrail-block turn
    (written immediately) sort ahead of a still-queued prior turn — the UI loads
    history ORDER BY time_sent, so that reordered the chat. UTC keeps it aligned
    with the DB's CURRENT_TIMESTAMP (RDS runs in UTC).
    """
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(sep=" ")


def _persist_turn(session_id, message_content, llm_output, blocks, user_email, course_id, module_id,
                  user_time_sent=None, ai_time_sent=None) -> None:
    """Persist one completed turn consistently for every path (M5).

    DynamoDB (canonical text log) is written FIRST so a delayed/failed RDS
    projection never loses a message; the RDS projection (blocks-aware, for UI
    history) is written async via SQS when ASYNC_RDS_PROJECTION is on, else
    synchronously with engagement logging. Best-effort throughout.

    ``user_time_sent`` / ``ai_time_sent`` are the turn's timestamps (ISO
    strings). They are threaded through BOTH projection modes so RDS ``time_sent``
    reflects TURN time rather than write time (see _utc_now_iso). None falls back
    to the server clock inside persist_message_to_rds.
    """
    # DynamoDB = canonical source of truth (text log)
    try:
        persist_message_pair(CHAT_HISTORY_TABLE, session_id, message_content or "[Initial greeting]", llm_output, _dynamodb_resource)
    except Exception:
        logger.exception("Chat history persistence failed (best-effort)")

    # RDS = projection for UI session history (carries render blocks)
    if ASYNC_RDS_PROJECTION and RDS_PROJECTION_QUEUE_URL:
        try:
            _sqs_client.send_message(
                QueueUrl=RDS_PROJECTION_QUEUE_URL,
                MessageBody=json.dumps({
                    "session_id": session_id,
                    "message_content": message_content,
                    "llm_output": llm_output,
                    "blocks": blocks,
                    "user_email": user_email,
                    "course_id": course_id,
                    "module_id": module_id,
                    # Turn timestamps ride along so the (delayed) consumer stamps
                    # time_sent with TURN time, not its processing time.
                    "user_time_sent": user_time_sent,
                    "ai_time_sent": ai_time_sent,
                }),
            )
        except Exception:
            logger.exception("RDS projection enqueue failed (best-effort)")
    else:
        try:
            conn = _get_db_connection()
            if message_content:
                persist_message_to_rds(conn, session_id, message_content, student_sent=True, time_sent=user_time_sent)
                log_engagement(conn, user_email, course_id, module_id, "message creation")
            persist_message_to_rds(conn, session_id, llm_output, student_sent=False, blocks=blocks, time_sent=ai_time_sent)
            log_engagement(conn, user_email, course_id, module_id, "AI message creation")
        except Exception:
            logger.exception("RDS projection failed (best-effort)")


def _session_state_view(state) -> dict:
    """Canonical session_state view returned to the client on EVERY exit (M6).

    One shared shape guarantees the normal, guardrail-block, tutor, and
    tutor-block responses all expose the same keys, so the frontend can rely on
    a stable schema regardless of which path produced the turn.
    """
    return {
        "stage": state.stage,
        "module_complete": state.module_complete,
        "engagement_score": state.engagement_score,
        "concepts_demonstrated": state.concepts_demonstrated,
        "tutor_active": is_tutor_active(state),
    }


@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    """Chatbot V2 Lambda handler — full learning pipeline orchestration."""
    # Bound before the try so the outer except handlers can stream a terminal
    # error (the stream is authoritative; the client renders/aborts from it).
    session_id = ""
    try:
        # Parse request
        query_params = event.get("queryStringParameters", {}) or {}
        course_id = query_params.get("course_id", "")
        session_id = query_params.get("session_id", "")
        module_id = query_params.get("module_id", "")
        session_name = query_params.get("session_name", "New Chat")
        body = json.loads(event.get("body", "{}") or "{}")
        message_content = body.get("message_content", "")

        # Extract email from authorizer context (for RDS projection + engagement logging)
        request_context = event.get("requestContext", {})
        authorizer_ctx = request_context.get("authorizer", {})
        user_email = authorizer_ctx.get("email", "") or query_params.get("email", "")

        # Validate required params
        if not course_id:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps("Missing required parameter: course_id")}
        if not session_id:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps("Missing required parameter: session_id")}
        if not module_id:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps("Missing required parameter: module_id")}

        logger.append_keys(session_id=session_id, course_id=course_id)
        logger.info("Processing chatbot V2 request")

        # Latency instrumentation (diagnostic): time each major phase and emit a
        # single structured "latency_breakdown" log before returning, so
        # CloudWatch shows where a turn's wall time goes (retrieval round-trip vs
        # pre-generation prep vs the streamed generation). Paired with
        # streaming.py's per-stream ttft_ms (time to first token).
        _t0 = time.perf_counter()
        _timings: dict = {}
        # Wall-clock turn start = the user message's time_sent. Threaded into
        # every persist path so RDS history ordering reflects TURN time, not
        # (async) write time (see _utc_now_iso). The AI message's time_sent is
        # captured at persist time below, after generation.
        turn_started_at = _utc_now_iso()

        guardrail_id, guardrail_version = _get_guardrail_config()

        # Step 1: Load session state — DynamoDB failure → 503
        try:
            _t = time.perf_counter()
            state = _load_session_state(session_id)
            _timings["state_load_ms"] = round((time.perf_counter() - _t) * 1000, 2)
        except (botocore.exceptions.ClientError, botocore.exceptions.EndpointConnectionError) as e:
            logger.exception("Session_State_Table read failure")
            _stream_final(session_id, error=True)
            return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}

        is_new_session = state is None
        if is_new_session:
            state = create_default_state(session_id)

        # Step 2: Load module_concepts on new session — DB failure → 503
        if is_new_session:
            try:
                state.module_concepts, module_name = _load_module_concepts(course_id, module_id)
                if CACHE_MODULE_METADATA:
                    state.module_name = module_name
                logger.info("Loaded module_concepts", extra={"count": len(state.module_concepts), "module_name": module_name})
            except (psycopg2.OperationalError, psycopg2.InterfaceError, botocore.exceptions.ClientError) as e:
                logger.exception("DB connection failure during module context retrieval")
                _stream_final(session_id, error=True)
                return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}
        else:
            # For existing sessions, load module name for prompt context.
            if CACHE_MODULE_METADATA and state.module_name:
                module_name = state.module_name  # cached (#10) — skip the Postgres round-trip
            else:
                try:
                    _, module_name = _load_module_concepts(course_id, module_id)
                except Exception:
                    module_name = session_name
                if CACHE_MODULE_METADATA:
                    state.module_name = module_name

        # Use module_name as the topic (session_name is often just "New chat")
        topic = module_name or session_name

        # Load chat history
        _t = time.perf_counter()
        chat_history = load_chat_history(CHAT_HISTORY_TABLE, session_id, _dynamodb_resource)
        _timings["history_load_ms"] = round((time.perf_counter() - _t) * 1000, 2)

        # ─── V2 Math Tutoring: if tutor is active, route through tutor runtime ───
        if message_content and is_tutor_active(state):
            logger.info("Math tutor active — routing through tutor runtime")
            state.tutor_state, tutor_prompt = process_tutor_turn(state.tutor_state, message_content)

            if tutor_prompt:
                # Use tutor prompt as system prompt for LLM rendering.
                # The guardContent XML tags are InvokeModel input-tagging syntax;
                # on the ConverseStream path guardrailConfig assesses the whole
                # turn, so we skip the tags (they'd otherwise reach Claude as
                # literal text).
                guardrail_tags = "" if USE_CONVERSE_STREAMING else (wrap_user_message(message_content) if message_content else "")
                system_prompt = build_tutor_system_prompt(tutor_prompt, guardrail_tags)

                prompt_history = get_bounded_history(chat_history, MAX_PROMPT_TURNS)
                model_kwargs = {"max_tokens": RESPONSE_MAX_TOKENS, "guardrail_id": guardrail_id, "guardrail_version": guardrail_version}

                llm_output = _stream_with_guardrail_retry(
                    system_prompt=system_prompt,
                    user_message=message_content,
                    prompt_history=prompt_history,
                    session_id=session_id,
                    model_kwargs=model_kwargs,
                    guardrail_id=guardrail_id,
                )

                # Handle guardrail block
                if isinstance(llm_output, dict) and llm_output.get("blocked"):
                    try:
                        conn = _get_db_connection()
                        persist_message_to_rds(conn, session_id, message_content, student_sent=True, time_sent=turn_started_at)
                        persist_message_to_rds(conn, session_id, llm_output["message"], student_sent=False, time_sent=_utc_now_iso())
                    except Exception:
                        logger.exception("RDS projection failed on guardrail block (best-effort)")
                    blocked_blocks = [{"type": "text", "content": llm_output["message"]}]
                    # Authoritative delivery over the stream (mirrors the normal
                    # path): a guardrail redirect is a shown message, not a
                    # failure — no error flag. Without this terminal message the
                    # tutor turn streamed nothing final and the client hung until
                    # its watchdog fired.
                    _stream_final(session_id, llm_output=llm_output["message"], blocks=blocked_blocks,
                                  session_name=session_name, llm_verdict=state.module_complete)
                    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps({
                        "session_name": session_name,
                        "llm_output": llm_output["message"],
                        "blocks": blocked_blocks,
                        "llm_verdict": state.module_complete,
                        "session_state": _session_state_view(state),
                    })}

                # Persist one completed tutor turn via the shared helper
                # (canonical-first, engagement-logged, block-aware). Tutor
                # replies are text-only, so blocks is a single text block —
                # this makes tutor turns reconstruct correctly on history reload.
                tutor_blocks = [{"type": "text", "content": llm_output}]
                _persist_turn(session_id, message_content, llm_output, tutor_blocks, user_email, course_id, module_id,
                              user_time_sent=turn_started_at, ai_time_sent=_utc_now_iso())
                state.interactions += 1
                _persist_session_state(state)

                # Authoritative delivery: emit the single terminal stream message
                # so a slow tutor turn (past API Gateway's 29s cap) still renders
                # on the client instead of hanging until its watchdog fires.
                _stream_final(session_id, llm_output=llm_output, blocks=tutor_blocks,
                              session_name=session_name, llm_verdict=state.module_complete)

                return {
                    "statusCode": 200,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "session_name": session_name,
                        "llm_output": llm_output,
                        "blocks": tutor_blocks,
                        "llm_verdict": state.module_complete,
                        "session_state": _session_state_view(state),
                    }),
                }

        # Steps 3-10 (evaluation + eval-driven state updates + retrieval).
        #
        # Retrieval inputs that do NOT depend on this turn's evaluation are
        # computed up front, so retrieval can optionally run concurrently with
        # the evaluation LLM call (#7, PARALLEL_EVAL_RETRIEVAL).
        if message_content:
            retrieval_query = message_content
        elif state.module_concepts:
            retrieval_query = f"Overview of: {', '.join(state.module_concepts[:3])}"
        else:
            retrieval_query = f"Introduce the topic: {topic}"

        # Allowed file ids are static per module; cache in session state (#10)
        # when enabled to avoid the Module_Files UNION query every turn. Note the
        # staleness tradeoff (files added mid-session aren't seen until the
        # session resets) — acceptable for short learning sessions, hence flagged.
        if CACHE_MODULE_METADATA and state.allowed_file_ids:
            allowed_file_ids = state.allowed_file_ids
        else:
            allowed_file_ids = _get_allowed_file_ids(module_id)
            if CACHE_MODULE_METADATA and allowed_file_ids:
                state.allowed_file_ids = allowed_file_ids

        eval_should_run = bool(state.interactions > 0 and message_content)

        def _run_evaluation():
            if not eval_should_run:
                return None
            _et = time.perf_counter()
            last_ai_question = _get_last_ai_question(chat_history)
            concepts_str = ", ".join(state.concepts_exposed[-10:]) if state.concepts_exposed else ""
            result = evaluate_answer(
                _bedrock_client, topic=topic, stage=state.stage,
                last_ai_question=last_ai_question, student_answer=message_content,
                concepts=concepts_str, module_concepts=state.module_concepts,
            )
            _timings["eval_ms"] = round((time.perf_counter() - _et) * 1000, 2)
            return result

        def _run_retrieval(concepts_misunderstood):
            learning_context = {
                "stage": state.stage,
                "concepts_demonstrated": state.concepts_demonstrated,
                "concepts_misunderstood": concepts_misunderstood,
            }
            _rt = time.perf_counter()
            result = invoke_retrieval(
                _lambda_client, function_arn=RAG_RETRIEVAL_FUNCTION_ARN,
                query=retrieval_query,
                session_id=session_id, course_id=course_id,
                allowed_file_ids=allowed_file_ids,
                chat_history=get_retrieval_history(chat_history, 4),
                learning_context=learning_context,
                module_id=module_id,
            )
            _timings["retrieval_ms"] = round((time.perf_counter() - _rt) * 1000, 2)
            return result

        # Run evaluation and retrieval — concurrently when PARALLEL_EVAL_RETRIEVAL
        # is on AND an evaluation will happen this turn (#7). In parallel mode
        # retrieval uses the pre-evaluation learning state (minor staleness in the
        # retrieval hint only); the sequential path runs retrieval below with the
        # post-evaluation context. Helpers only READ state + call thread-safe boto3
        # clients, so there is no shared-mutable-state race.
        evaluation, retrieval_result, retrieval_done = _eval_and_retrieve(
            _run_evaluation,
            _run_retrieval,
            parallel=PARALLEL_EVAL_RETRIEVAL and eval_should_run,
        )

        if evaluation is not None:
            logger.info("Evaluation complete", extra={"correct": evaluation.correct, "partial": evaluation.partial})

        # Step 4: Update state
        if evaluation is not None:
            state = update_state(state, evaluation)

        # Step 5: Update concept progress
        if evaluation is not None:
            if evaluation.concepts_demonstrated:
                state = demonstrate_concepts(state, evaluation.concepts_demonstrated)
                state = discuss_concepts(state, evaluation.concepts_demonstrated)
            if evaluation.concepts_misunderstood:
                state = record_misunderstandings(state, evaluation.concepts_misunderstood)

        # Step 6: Check module completion
        if not state.module_complete:
            state.module_complete = check_module_completion(state)

        # Diagnostic probe (spec: module-completion-evidence, Phase 1). NON-behavioral.
        # Surfaces every completion-gate input plus the evaluator's RAW vs
        # canonical-filtered demonstrated concepts, so we can measure how much the
        # exact-string filter discards. `missing_requirements` names which gate
        # inputs aren't satisfied yet ([] == complete; mirrors the real gate).
        logger.info("module_completion_probe", extra={
            "module_concepts_count": len(state.module_concepts),
            "concepts_exposed": state.concepts_exposed,
            "concepts_discussed": state.concepts_discussed,
            "concepts_demonstrated": state.concepts_demonstrated,
            "eval_raw_demonstrated": evaluation.raw_concepts_demonstrated if evaluation is not None else [],
            "eval_kept_demonstrated": evaluation.concepts_demonstrated if evaluation is not None else [],
            "interactions": state.interactions,
            "engagement_score": state.engagement_score,
            "required_concepts": required_concepts_discussed(len(state.module_concepts)),
            "module_complete": state.module_complete,
            "missing_requirements": completion_missing_requirements(state),
        })

        # Step 7: Check stage advancement
        previous_stage = state.stage
        check_stage_advancement(state)
        advanced = state.stage != previous_stage

        # Step 8: Select mode
        mode = select_mode(state, evaluation, advanced)
        logger.info("Mode selected", extra={"mode": mode, "stage": state.stage})
        # Persist the selected mode so the course-progress debug view can surface
        # the (otherwise transient) Socratic hint escalation. Only set here on the
        # Socratic path — tutor turns return earlier and keep the prior value.
        state.last_mode = mode

        # Advance hint escalation when a hint mode is chosen (M7). Without this,
        # hint_level never rises, so `hint_scaffold` is unreachable and escalation
        # is dead. check_stage_advancement resets hint_level on stage advancement.
        if mode in ("hint_nudge", "hint_scaffold"):
            state.hint_level += 1
            state.hint_count += 1

        # Step 9: Handle completion mode
        other_modules: list[str] = []
        if mode == "complete":
            state.completion_message_sent = True
            other_modules = _load_other_module_names(course_id, module_id)

        # Step 10: Retrieval. The sequential path runs it now with the
        # post-evaluation learning context (unchanged behavior); the parallel
        # path already ran it above.
        if not retrieval_done:
            retrieval_result = _run_retrieval(
                evaluation.concepts_misunderstood if evaluation else []
            )
        rag_context = retrieval_result.answer if retrieval_result else ""
        logger.info("RAG context received", extra={"rag_context_length": len(rag_context), "rag_context_preview": rag_context[:500]})

        # Introduce concepts from RAG context
        if retrieval_result and state.module_concepts:
            mentioned = [c for c in state.module_concepts if c.lower() in rag_context.lower()]
            if mentioned:
                state = introduce_concepts(state, mentioned)

        # Select figures/tables/formulas up front so their descriptions can
        # ground the response text (H6/M1). Without this the response LLM only
        # sees the retrieval answer and disclaims ("couldn't find that in the
        # retrieved materials") a block the display path simultaneously shows.
        #
        # EXCEPTION — the auto-generated greeting (the "greet" turn with no
        # student message) has no query, so retrieval runs on a synthesized
        # topic-overview query. Attaching whatever figures/tables/formulas
        # surface for that query dumps PDF pages under the greeting (e.g. whenever
        # the retriever escalated on image hits, select_figures attaches the top
        # images even with no figure reference in the query). Keep that opening
        # message purely conversational: skip the visual blocks AND their
        # grounding, but keep rag_context so the opening question stays grounded
        # in text. A first turn that DOES carry a student message (so it could
        # reference a figure) is left on the normal path and still shows visuals.
        if mode == "greet" and not message_content:
            selected_figures, table_blocks, formula_blocks, grounding = [], [], [], ""
        else:
            try:
                from figure_selection import (
                    select_figures as select_figs, select_tables, select_formulas,
                    build_figure_grounding, build_table_grounding, build_formula_grounding,
                    build_comparison_grounding, build_formula_comparison_grounding,
                    build_cross_modal_reinforcement,
                )
                selected_figures = select_figs(retrieval_result, retrieval_query)
                table_blocks = select_tables(retrieval_result, retrieval_query)
                formula_blocks = select_formulas(retrieval_result, retrieval_query)
                grounding = "\n\n".join(g for g in (
                    build_figure_grounding(retrieval_result, selected_figures),
                    build_table_grounding(table_blocks),
                    build_comparison_grounding(table_blocks, retrieval_query),
                    build_cross_modal_reinforcement(table_blocks, selected_figures, retrieval_query),
                    build_formula_grounding(formula_blocks),
                    build_formula_comparison_grounding(formula_blocks, retrieval_query),
                ) if g)
            except Exception:
                logger.exception("Block selection/grounding failed (pre-generation)")
                selected_figures, table_blocks, formula_blocks, grounding = [], [], [], ""
        if grounding:
            rag_context = f"{rag_context}\n\n{grounding}" if rag_context else grounding

        # Step 10.5: Math compute (if query contains explicit math)
        math_compute_context = ""
        if message_content:
            math_class = classify_math_intent(message_content)
            if math_class.needs_compute_lambda():
                compute_result = invoke_math_compute(
                    _lambda_client,
                    function_arn=MATH_COMPUTE_FUNCTION_ARN,
                    classification=math_class,
                )
                if compute_result is not None:
                    # Check if we should enter tutoring mode (V2)
                    if should_enter_tutoring(math_class, compute_result):
                        # steps were already attached to answer["_steps"] by the
                        # math_compute_client; just record the operation for the tutor.
                        compute_result.answer["_operation"] = math_class.operation_hint

                        state.tutor_state = create_tutor_state(compute_result)
                        math_compute_context = get_initial_tutor_prompt(state.tutor_state)
                        logger.info(
                            "Entering math tutoring mode",
                            extra={
                                "operation": math_class.operation_hint,
                                "step_count": len(state.tutor_state.get("step_list", [])),
                            },
                        )
                    else:
                        # V1 behavior: inject verified result directly
                        math_compute_context = compute_result.get_prompt_injection()
                    logger.info(
                        "Math compute processed",
                        extra={
                            "status": compute_result.status,
                            "has_answer": compute_result.success,
                            "tutoring_mode": is_tutor_active(state),
                            "injection_length": len(math_compute_context),
                        },
                    )
            elif math_class.is_discourse_reference and math_class.compute:
                # V1: explicit rejection of discourse references for compute
                math_compute_context = (
                    "MATH COMPUTE: The student is referencing a previous mathematical object "
                    "(e.g., 'the matrix above', 'that one'). You cannot resolve this.\n"
                    "Ask the student to provide the matrix or equation directly so you can "
                    "compute it accurately. Be helpful and suggest a format like [[2,1],[1,2]]."
                )

        # Step 11: Build system prompt
        context_vars = {
            "difficulty": state.stage,
            "concept": state.concepts_exposed[-1] if state.concepts_exposed else topic,
            "missing_concept": (evaluation.concepts_misunderstood[0] if evaluation and evaluation.concepts_misunderstood else topic),
            "mastered_concept": (evaluation.concepts_demonstrated[0] if evaluation and evaluation.concepts_demonstrated else ""),
            "next_concept": (state.module_concepts[len(state.concepts_discussed) % len(state.module_concepts)] if state.module_concepts else topic),
            "concepts_discussed": ", ".join(state.concepts_discussed),
            "other_modules": ", ".join(other_modules) if other_modules else "explore related topics",
        }
        # On the ConverseStream path guardrailConfig assesses the full turn, so
        # skip the InvokeModel input-tagging XML wrapper (see tutor path above).
        guardrail_tags = "" if USE_CONVERSE_STREAMING else (wrap_user_message(message_content) if message_content else "")
        system_prompt = build_system_prompt(mode, topic, context_vars, rag_context, guardrail_tags)

        # Inject math compute results into system prompt (before guardrail tags, after RAG context)
        if math_compute_context:
            system_prompt = f"{system_prompt}\n\n{math_compute_context}"

        # Step 12: Stream response — with guardrail service error retry
        prompt_history = get_bounded_history(chat_history, MAX_PROMPT_TURNS)
        model_kwargs = {"max_tokens": RESPONSE_MAX_TOKENS, "guardrail_id": guardrail_id, "guardrail_version": guardrail_version}
        user_msg = message_content or f"Start the conversation about {topic}"

        _timings["time_to_generation_ms"] = round((time.perf_counter() - _t0) * 1000, 2)
        _gen_t = time.perf_counter()
        llm_output = _stream_with_guardrail_retry(
            system_prompt=system_prompt,
            user_message=user_msg,
            prompt_history=prompt_history,
            session_id=session_id,
            model_kwargs=model_kwargs,
            guardrail_id=guardrail_id,
        )
        _timings["generation_ms"] = round((time.perf_counter() - _gen_t) * 1000, 2)
        # If guardrail retry produced a blocked redirect, return it directly
        if isinstance(llm_output, dict) and llm_output.get("blocked"):
            # M16: a blocked turn is persisted to the RDS projection (so the UI
            # history still shows the exchange) but intentionally NOT to the
            # DynamoDB canonical log — blocked content must never be replayed to
            # the model as chat history on a later turn.
            try:
                conn = _get_db_connection()
                if message_content:
                    persist_message_to_rds(conn, session_id, message_content, student_sent=True, time_sent=turn_started_at)
                persist_message_to_rds(conn, session_id, llm_output["message"], student_sent=False, time_sent=_utc_now_iso())
            except Exception:
                logger.exception("RDS projection failed on guardrail block (best-effort)")
            blocked_blocks = [{"type": "text", "content": llm_output["message"]}]
            # Authoritative delivery over the stream. A guardrail redirect is a
            # shown message, not a failure — no error flag.
            _stream_final(session_id, llm_output=llm_output["message"], blocks=blocked_blocks,
                          session_name=session_name, llm_verdict=state.module_complete)
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "session_name": session_name,
                    "llm_output": llm_output["message"],
                    "blocks": blocked_blocks,
                    "llm_verdict": state.module_complete,
                    "session_state": _session_state_view(state),
                }),
            }

        # Discuss concepts that appear in the student's message
        if message_content and state.module_concepts:
            student_concepts = [c for c in state.module_concepts if c.lower() in message_content.lower()]
            if student_concepts:
                state = discuss_concepts(state, student_concepts)

        # Assemble render blocks BEFORE persistence so they're saved with the AI
        # message (history reload). Figures/tables/formulas were already selected
        # before generation (so their descriptions could ground the text); reuse
        # that selection here to keep display and grounding perfectly aligned.
        try:
            from figure_selection import assemble_blocks
            blocks = assemble_blocks(llm_output, selected_figures, table_blocks, formula_blocks)
        except Exception:
            logger.exception("Block assembly failed, returning text-only blocks")
            blocks = [{"type": "text", "content": llm_output}]

        # Step 13: Persist state + history (best-effort) via the shared helper
        # so the normal and tutor paths behave identically (canonical-first,
        # block-aware, engagement-logged, ASYNC_RDS_PROJECTION-aware).
        _persist_t = time.perf_counter()
        _persist_turn(session_id, message_content, llm_output, blocks, user_email, course_id, module_id,
                      user_time_sent=turn_started_at, ai_time_sent=_utc_now_iso())

        # Count this as one processed turn (H1). `interactions` is the per-turn
        # counter the eval gate reads on the NEXT turn; it must increment whether
        # or not evaluation ran this turn, otherwise the gate never bootstraps.
        state.interactions += 1
        try:
            _persist_session_state(state)
        except Exception:
            logger.exception("Session state persistence failed (best-effort)")
        _timings["persist_ms"] = round((time.perf_counter() - _persist_t) * 1000, 2)

        # Latency breakdown for this turn (diagnostic). time_to_generation_ms is
        # everything before the model call (state/history loads + eval||retrieval
        # + prompt build); pair it with streaming.py's ttft_ms for the true
        # time-to-first-visible-token, and generation_ms for output-length cost.
        _timings["total_ms"] = round((time.perf_counter() - _t0) * 1000, 2)
        logger.info("Chatbot latency breakdown", extra={"event": "latency_breakdown", **_timings})

        # Step 14: Analytics (post-response)
        logger.info("Analytics", extra={"coverage": calculate_coverage(state), "mastery_concepts": len(calculate_mastery_profile(state))})

        # Authoritative delivery: stream the final blocks + metadata. On a slow
        # multi-image turn the POST below has likely already 504'd at API
        # Gateway's 29s cap, so the client renders from THIS terminal message.
        _stream_final(session_id, llm_output=llm_output, blocks=blocks,
                      session_name=session_name, llm_verdict=state.module_complete)

        # Structured HTTP response — best-effort ack (used when the turn finished
        # within 29s; ignored by the client on a timed-out slow turn).
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "session_name": session_name,
                "llm_output": llm_output,
                "blocks": blocks,
                "llm_verdict": state.module_complete,
                "session_state": _session_state_view(state),
            }),
        }

    except (psycopg2.OperationalError, psycopg2.InterfaceError):
        logger.exception("Database connection failure")
        _stream_final(session_id, error=True)
        return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}
    except botocore.exceptions.ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        if error_code in ("ServiceUnavailable", "InternalServerError", "ProvisionedThroughputExceededException"):
            logger.exception("AWS service unavailable")
            _stream_final(session_id, error=True)
            return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}
        logger.exception("Unhandled AWS client error in chatbot V2 handler")
        _stream_final(session_id, error=True)
        return {"statusCode": 500, "headers": CORS_HEADERS, "body": json.dumps("Internal server error")}
    except Exception:
        logger.exception("Unhandled error in chatbot V2 handler")
        _stream_final(session_id, error=True)
        return {"statusCode": 500, "headers": CORS_HEADERS, "body": json.dumps("Internal server error")}
