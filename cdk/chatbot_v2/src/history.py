import boto3
from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

MAX_PROMPT_TURNS = 10
MAX_RETRIEVAL_TURNS = 4


def load_chat_history(table_name: str, session_id: str, dynamodb_resource=None) -> list[dict]:
    """Load full chat history from DynamoDB.
    Returns list of message dicts [{"role": "user"|"assistant", "content": "..."}].
    Returns empty list on failure."""
    try:
        resource = dynamodb_resource or boto3.resource("dynamodb")
        table = resource.Table(table_name)
        response = table.get_item(Key={"SessionId": session_id})
        item = response.get("Item")
        if not item:
            return []
        # The existing text_generation uses DynamoDBChatMessageHistory which stores
        # messages in a "History" attribute as a list of message dicts
        history = item.get("History", [])
        if isinstance(history, list):
            return history
        return []
    except Exception:
        logger.exception("Failed to load chat history", extra={"session_id": session_id})
        return []


def get_bounded_history(history: list[dict], max_turns: int) -> list[dict]:
    """Return the last N turns from history. Each turn = one message dict.
    For pairs (user+assistant), max_turns refers to pairs, so we take last max_turns*2 messages."""
    if not history:
        return []
    # Take last max_turns*2 messages (each turn = user + assistant pair)
    bound = max_turns * 2
    return history[-bound:] if len(history) > bound else list(history)


def persist_message_pair(
    table_name: str,
    session_id: str,
    user_message: str,
    assistant_response: str,
    dynamodb_resource=None,
) -> None:
    """Persist a message pair to DynamoDB chat history table.
    Best-effort: logs errors but never raises."""
    try:
        resource = dynamodb_resource or boto3.resource("dynamodb")
        table = resource.Table(table_name)

        new_messages = [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": assistant_response},
        ]

        # Append to existing history or create new item
        table.update_item(
            Key={"SessionId": session_id},
            UpdateExpression="SET History = list_append(if_not_exists(History, :empty), :msgs)",
            ExpressionAttributeValues={
                ":msgs": new_messages,
                ":empty": [],
            },
        )
    except Exception:
        logger.exception("Failed to persist chat history", extra={"session_id": session_id})
