import json
from dataclasses import dataclass, field
from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

MAX_RETRIEVAL_TURNS = 4


@dataclass
class RetrievalResult:
    answer: str
    sources: list[str] = field(default_factory=list)
    escalation_used: bool = False
    image_analyses: list[dict] = field(default_factory=list)
    image_results: list[dict] = field(default_factory=list)
    table_results: list[dict] = field(default_factory=list)
    formula_results: list[dict] = field(default_factory=list)


def get_bounded_history(history: list[dict], max_turns: int) -> list[dict]:
    """Return the last N turns from history."""
    return history[-max_turns:] if len(history) > max_turns else history


def invoke_retrieval(
    lambda_client,
    function_arn: str,
    query: str,
    session_id: str,
    course_id: str,
    allowed_file_ids: list[str],
    chat_history: list[dict],
    learning_context: dict | None = None,
    module_id: str = "",
) -> RetrievalResult | None:
    """Invoke ragRetrievalFunction synchronously.

    Bounds chat_history to last 4 turns, includes learning_context.
    Returns RetrievalResult on success (200), None on failure.
    Logs errors but never raises.
    """
    try:
        bounded_history = get_bounded_history(chat_history, MAX_RETRIEVAL_TURNS)

        payload = {
            "query": query,
            "session_id": session_id,
            "course_id": course_id,
            "allowed_file_ids": allowed_file_ids,
            "chat_history": bounded_history,
        }
        if learning_context:
            payload["learning_context"] = learning_context
        if module_id:
            payload["module_id"] = module_id

        response = lambda_client.invoke(
            FunctionName=function_arn,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode(),
        )

        response_payload = json.loads(response["Payload"].read())

        status_code = response_payload.get("statusCode", 500)
        if status_code != 200:
            logger.warning("Retrieval function returned non-200", extra={"status_code": status_code})
            return None

        body = response_payload.get("body", {})
        if isinstance(body, str):
            body = json.loads(body)

        return RetrievalResult(
            answer=body.get("answer", ""),
            sources=body.get("sources", []),
            escalation_used=body.get("escalation_used", False),
            image_analyses=body.get("image_analyses", []),
            image_results=body.get("image_results", []),
            table_results=body.get("table_results", []),
            formula_results=body.get("formula_results", []),
        )
    except Exception:
        logger.exception("Retrieval invocation failed")
        return None
