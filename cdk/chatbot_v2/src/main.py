"""Chatbot V2 Lambda handler — orchestrates the structured learning pipeline."""

import os
import json

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
    calculate_mastery_profile, calculate_coverage)
from evaluation import evaluate_answer
from concept_tracker import introduce_concepts, discuss_concepts, demonstrate_concepts, record_misunderstandings
from mode_selector import select_mode
from prompt_builder import build_system_prompt
from retrieval_client import invoke_retrieval, get_bounded_history as get_retrieval_history
from streaming import stream_response
from guardrails import load_guardrail_config, wrap_user_message, handle_guardrail_error
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
# Runtime kill switch for cross-module file referencing. Defaults on; set to
# "false" to revert to module_id-only retrieval scoping without a redeploy.
ENABLE_CROSS_MODULE_REFERENCING = os.environ.get("ENABLE_CROSS_MODULE_REFERENCING", "true").lower() != "false"
# Module-level singletons (initialized once per container)
_lambda_client = boto3.client("lambda", region_name=REGION)
_bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)
_ssm_client = boto3.client("ssm", region_name=REGION)
_dynamodb_resource = boto3.resource("dynamodb", region_name=REGION)
_secrets_client = boto3.client("secretsmanager", region_name=REGION)

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
        if reloaded:
            state.state_version = reloaded.state_version + 1
        item = serialize_state(state)
        try:
            table.put_item(Item=item)
        except Exception:
            logger.exception("State write retry also failed (best-effort)")


def _get_last_ai_question(chat_history: list[dict]) -> str:
    for msg in reversed(chat_history):
        if msg.get("role") == "assistant":
            return msg.get("content", "")
    return ""


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
        # Guardrail service error — retry without guardrails
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


@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    """Chatbot V2 Lambda handler — full learning pipeline orchestration."""
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

        guardrail_id, guardrail_version = _get_guardrail_config()

        # Step 1: Load session state — DynamoDB failure → 503
        try:
            state = _load_session_state(session_id)
        except (botocore.exceptions.ClientError, botocore.exceptions.EndpointConnectionError) as e:
            logger.exception("Session_State_Table read failure")
            return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}

        is_new_session = state is None
        if is_new_session:
            state = create_default_state(session_id)

        # Step 2: Load module_concepts on new session — DB failure → 503
        if is_new_session:
            try:
                state.module_concepts, module_name = _load_module_concepts(course_id, module_id)
                logger.info("Loaded module_concepts", extra={"count": len(state.module_concepts), "module_name": module_name})
            except (psycopg2.OperationalError, psycopg2.InterfaceError, botocore.exceptions.ClientError) as e:
                logger.exception("DB connection failure during module context retrieval")
                return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}
        else:
            # For existing sessions, load module name for prompt context
            try:
                _, module_name = _load_module_concepts(course_id, module_id)
            except Exception:
                module_name = session_name

        # Use module_name as the topic (session_name is often just "New chat")
        topic = module_name or session_name

        # Load chat history
        chat_history = load_chat_history(CHAT_HISTORY_TABLE, session_id, _dynamodb_resource)

        # ─── V2 Math Tutoring: if tutor is active, route through tutor runtime ───
        if message_content and is_tutor_active(state):
            logger.info("Math tutor active — routing through tutor runtime")
            state.tutor_state, tutor_prompt = process_tutor_turn(state.tutor_state, message_content)

            if tutor_prompt:
                # Use tutor prompt as system prompt for LLM rendering
                guardrail_tags = wrap_user_message(message_content) if message_content else ""
                system_prompt = f"{tutor_prompt}\n\n{guardrail_tags}"

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
                        persist_message_to_rds(conn, session_id, message_content, student_sent=True)
                        persist_message_to_rds(conn, session_id, llm_output["message"], student_sent=False)
                    except Exception:
                        logger.exception("RDS projection failed on guardrail block (best-effort)")
                    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps({"llm_output": llm_output["message"], "session_state": state.to_dict() if hasattr(state, 'to_dict') else {}})}

                # Persist messages
                try:
                    conn = _get_db_connection()
                    persist_message_to_rds(conn, session_id, message_content, student_sent=True)
                    persist_message_to_rds(conn, session_id, llm_output, student_sent=False)
                except Exception:
                    logger.exception("RDS projection failed (best-effort)")

                persist_message_pair(CHAT_HISTORY_TABLE, session_id, message_content, llm_output, _dynamodb_resource)
                state.interactions += 1
                _persist_session_state(state)

                return {
                    "statusCode": 200,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "llm_output": llm_output,
                        "session_state": {"tutor_active": is_tutor_active(state)},
                    }),
                }

        # Step 3: Evaluate answer (skip on first interaction)
        evaluation = None
        if state.interactions > 0 and message_content:
            last_ai_question = _get_last_ai_question(chat_history)
            concepts_str = ", ".join(state.concepts_exposed[-10:]) if state.concepts_exposed else ""
            evaluation = evaluate_answer(
                _bedrock_client, topic=topic, stage=state.stage,
                last_ai_question=last_ai_question, student_answer=message_content,
                concepts=concepts_str, module_concepts=state.module_concepts,
            )
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

        # Step 7: Check stage advancement
        previous_stage = state.stage
        check_stage_advancement(state)
        advanced = state.stage != previous_stage

        # Step 8: Select mode
        mode = select_mode(state, evaluation, advanced)
        logger.info("Mode selected", extra={"mode": mode, "stage": state.stage})

        # Step 9: Handle completion mode
        other_modules: list[str] = []
        if mode == "complete":
            state.completion_message_sent = True
            other_modules = _load_other_module_names(course_id, module_id)

        # Step 10: Invoke retrieval
        learning_context = {
            "stage": state.stage,
            "concepts_demonstrated": state.concepts_demonstrated,
            "concepts_misunderstood": evaluation.concepts_misunderstood if evaluation else [],
        }
        # For initial greeting, use generated topics for better retrieval context
        if message_content:
            retrieval_query = message_content
        elif state.module_concepts:
            retrieval_query = f"Overview of: {', '.join(state.module_concepts[:3])}"
        else:
            retrieval_query = f"Introduce the topic: {topic}"

        retrieval_result = invoke_retrieval(
            _lambda_client, function_arn=RAG_RETRIEVAL_FUNCTION_ARN,
            query=retrieval_query,
            session_id=session_id, course_id=course_id,
            allowed_file_ids=_get_allowed_file_ids(module_id),
            chat_history=get_retrieval_history(chat_history, 4),
            learning_context=learning_context,
            module_id=module_id,
        )
        rag_context = retrieval_result.answer if retrieval_result else ""
        logger.info("RAG context received", extra={"rag_context_length": len(rag_context), "rag_context_preview": rag_context[:500]})

        # Introduce concepts from RAG context
        if retrieval_result and state.module_concepts:
            mentioned = [c for c in state.module_concepts if c.lower() in rag_context.lower()]
            if mentioned:
                state = introduce_concepts(state, mentioned)

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
                        # Store steps in answer for tutor state creation
                        compute_result.answer["_steps"] = compute_result.answer.get("_steps", [])
                        # If steps came from Lambda response, use them
                        if hasattr(compute_result, '_raw_response'):
                            compute_result.answer["_steps"] = compute_result._raw_response.get("steps", [])
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
        guardrail_tags = wrap_user_message(message_content) if message_content else ""
        system_prompt = build_system_prompt(mode, topic, context_vars, rag_context, guardrail_tags)

        # Inject math compute results into system prompt (before guardrail tags, after RAG context)
        if math_compute_context:
            system_prompt = f"{system_prompt}\n\n{math_compute_context}"

        # Step 12: Stream response — with guardrail service error retry
        prompt_history = get_bounded_history(chat_history, MAX_PROMPT_TURNS)
        model_kwargs = {"max_tokens": RESPONSE_MAX_TOKENS, "guardrail_id": guardrail_id, "guardrail_version": guardrail_version}
        user_msg = message_content or f"Start the conversation about {topic}"

        llm_output = _stream_with_guardrail_retry(
            system_prompt=system_prompt,
            user_message=user_msg,
            prompt_history=prompt_history,
            session_id=session_id,
            model_kwargs=model_kwargs,
            guardrail_id=guardrail_id,
        )
        # If guardrail retry produced a blocked redirect, return it directly
        if isinstance(llm_output, dict) and llm_output.get("blocked"):
            # Still persist the student message to RDS (best-effort)
            try:
                conn = _get_db_connection()
                if message_content:
                    persist_message_to_rds(conn, session_id, message_content, student_sent=True)
                persist_message_to_rds(conn, session_id, llm_output["message"], student_sent=False)
            except Exception:
                logger.exception("RDS projection failed on guardrail block (best-effort)")
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "session_name": session_name,
                    "llm_output": llm_output["message"],
                    "llm_verdict": state.module_complete,
                    "session_state": {
                        "stage": state.stage,
                        "module_complete": state.module_complete,
                        "engagement_score": state.engagement_score,
                        "concepts_demonstrated": state.concepts_demonstrated,
                    },
                }),
            }

        # Discuss concepts that appear in the student's message
        if message_content and state.module_concepts:
            student_concepts = [c for c in state.module_concepts if c.lower() in message_content.lower()]
            if student_concepts:
                state = discuss_concepts(state, student_concepts)

        # Step 13: Persist state + history (best-effort)
        # DynamoDB = canonical message store
        try:
            persist_message_pair(CHAT_HISTORY_TABLE, session_id, message_content or f"[Initial greeting]", llm_output, _dynamodb_resource)
        except Exception:
            logger.exception("Chat history persistence failed (best-effort)")

        # RDS = synchronous projection for UI session history (transitional — Phase 2 moves to async)
        try:
            conn = _get_db_connection()
            if message_content:
                persist_message_to_rds(conn, session_id, message_content, student_sent=True)
                log_engagement(conn, user_email, course_id, module_id, "message creation")
            persist_message_to_rds(conn, session_id, llm_output, student_sent=False)
            log_engagement(conn, user_email, course_id, module_id, "AI message creation")
        except Exception:
            logger.exception("RDS projection failed (best-effort)")

        try:
            _persist_session_state(state)
        except Exception:
            logger.exception("Session state persistence failed (best-effort)")

        # Step 14: Analytics (post-response)
        logger.info("Analytics", extra={"coverage": calculate_coverage(state), "mastery_concepts": len(calculate_mastery_profile(state))})

        # Return structured response
        # Figure selection: deterministic, based on retrieval results
        try:
            from figure_selection import select_figures as select_figs, select_tables, select_formulas, assemble_blocks
            selected_figures = select_figs(retrieval_result, retrieval_query)
            table_blocks = select_tables(retrieval_result, retrieval_query)
            formula_blocks = select_formulas(retrieval_result, retrieval_query)
            blocks = assemble_blocks(llm_output, selected_figures, table_blocks, formula_blocks)
        except Exception:
            logger.exception("Figure selection failed, returning text-only blocks")
            blocks = [{"type": "text", "content": llm_output}]

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "session_name": session_name,
                "llm_output": llm_output,
                "blocks": blocks,
                "llm_verdict": state.module_complete,
                "session_state": {
                    "stage": state.stage,
                    "module_complete": state.module_complete,
                    "engagement_score": state.engagement_score,
                    "concepts_demonstrated": state.concepts_demonstrated,
                },
            }),
        }

    except (psycopg2.OperationalError, psycopg2.InterfaceError):
        logger.exception("Database connection failure")
        return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}
    except botocore.exceptions.ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        if error_code in ("ServiceUnavailable", "InternalServerError", "ProvisionedThroughputExceededException"):
            logger.exception("AWS service unavailable")
            return {"statusCode": 503, "headers": CORS_HEADERS, "body": json.dumps("Service temporarily unavailable")}
        logger.exception("Unhandled AWS client error in chatbot V2 handler")
        return {"statusCode": 500, "headers": CORS_HEADERS, "body": json.dumps("Internal server error")}
    except Exception:
        logger.exception("Unhandled error in chatbot V2 handler")
        return {"statusCode": 500, "headers": CORS_HEADERS, "body": json.dumps("Internal server error")}
