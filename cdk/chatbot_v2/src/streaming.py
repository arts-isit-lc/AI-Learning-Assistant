import json
import time
from typing import Iterator
import httpx
from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

CHUNK_SIZE = 80
FALLBACK_MESSAGE = "I'm sorry, I wasn't able to generate a response. Please try again."


def buffer_chunks(token_stream: Iterator[str], chunk_size: int = CHUNK_SIZE) -> Iterator[str]:
    """Buffer tokens into chunks of at least chunk_size characters.
    Every chunk except the last has length >= chunk_size.
    Concatenation of all emitted chunks = concatenation of input tokens.
    """
    buffer = ""
    for token in token_stream:
        buffer += token
        while len(buffer) >= chunk_size:
            yield buffer[:chunk_size]
            buffer = buffer[chunk_size:]
    if buffer:
        yield buffer


def send_chunk(appsync_url: str, session_id: str, chunk: str, done: bool = False) -> None:
    """Send a chat chunk via AppSync sendChatChunk mutation.
    Failures are logged but do not interrupt response generation."""
    if not appsync_url:
        return
    try:
        query = '''
        mutation SendChatChunk($session_id: String!, $chunk: String!, $done: Boolean!) {
            sendChatChunk(session_id: $session_id, chunk: $chunk, done: $done) {
                session_id
                chunk
                done
            }
        }
        '''
        payload = {
            "query": query,
            "variables": {"session_id": session_id, "chunk": chunk, "done": done}
        }
        headers = {"Content-Type": "application/json", "Authorization": "API_KEY"}
        with httpx.Client(timeout=10.0) as client:
            client.post(appsync_url, headers=headers, json=payload)
    except Exception:
        logger.exception("Failed to send chat chunk to AppSync", extra={"session_id": session_id, "done": done})


def stream_response(
    bedrock_client,
    model_id: str,
    system_prompt: str,
    user_message: str,
    chat_history: list[dict],
    appsync_url: str,
    session_id: str,
    model_kwargs: dict | None = None,
) -> str:
    """Stream LLM response via Bedrock InvokeModelWithResponseStream.
    Buffers tokens, sends via AppSync, returns full assembled response.
    On complete failure returns FALLBACK_MESSAGE."""
    try:
        messages = []
        for turn in chat_history:
            role = turn.get("role", "user")
            content = turn.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": user_message})

        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": (model_kwargs or {}).get("max_tokens", 4000),
            "system": system_prompt,
            "messages": messages,
        }

        invoke_kwargs = {
            "modelId": model_id,
            "contentType": "application/json",
            "accept": "application/json",
            "body": json.dumps(body),
        }

        # Guardrails are top-level InvokeModelWithResponseStream parameters (sent
        # as X-Amzn-Bedrock-Guardrail* headers), NOT fields inside the model body.
        # Putting them in the body trips the model's own request schema, e.g.
        # Claude's Messages API rejects unknown keys with a ValidationException
        # ("extraneous key [amazon-bedrock-guardrailConfig] is not permitted").
        if model_kwargs and model_kwargs.get("guardrail_id"):
            invoke_kwargs["guardrailIdentifier"] = model_kwargs["guardrail_id"]
            invoke_kwargs["guardrailVersion"] = model_kwargs.get("guardrail_version", "DRAFT")

        _stream_start = time.perf_counter()
        response = bedrock_client.invoke_model_with_response_stream(**invoke_kwargs)

        full_response = ""
        chunk_buffer = ""
        ttft_ms = None  # time to first token — the key perceived-latency metric

        for event in response.get("body", []):
            chunk_data = json.loads(event["chunk"]["bytes"])
            if chunk_data.get("type") == "content_block_delta":
                text = chunk_data.get("delta", {}).get("text", "")
                if text:
                    if ttft_ms is None:
                        ttft_ms = round((time.perf_counter() - _stream_start) * 1000, 2)
                    full_response += text
                    chunk_buffer += text
                    while len(chunk_buffer) >= CHUNK_SIZE:
                        send_chunk(appsync_url, session_id, chunk_buffer[:CHUNK_SIZE])
                        chunk_buffer = chunk_buffer[CHUNK_SIZE:]

        # Send remaining buffer
        if chunk_buffer:
            send_chunk(appsync_url, session_id, chunk_buffer)

        # Signal done
        send_chunk(appsync_url, session_id, "", done=True)

        # Stream latency (diagnostic): ttft_ms isolates model start-up (prefill —
        # driven by input/context size) from stream_total_ms (driven by output
        # length). A large gap between them points at generation length; a large
        # ttft_ms points upstream (prompt size / cold start).
        logger.info(
            "Stream latency",
            extra={
                "event": "stream_latency",
                "ttft_ms": ttft_ms,
                "stream_total_ms": round((time.perf_counter() - _stream_start) * 1000, 2),
                "output_chars": len(full_response),
                "model_id": model_id,
            },
        )

        if not full_response:
            return FALLBACK_MESSAGE

        return full_response

    except Exception as e:
        # Re-raise guardrail-related errors so the caller can classify and retry
        err_msg = str(e)
        if "GUARDRAIL_INTERVENED" in err_msg or "GuardrailIntervention" in err_msg or "guardrail" in err_msg.lower():
            # Close the stream so a stream-consuming client doesn't hang waiting
            # for a terminal chunk (M4); the caller returns the blocked/redirect
            # message over HTTP. Do NOT emit fallback text — this is a guardrail
            # decision, not a generation failure.
            send_chunk(appsync_url, session_id, "", done=True)
            raise
        logger.exception("Streaming response failed")
        send_chunk(appsync_url, session_id, FALLBACK_MESSAGE)
        send_chunk(appsync_url, session_id, "", done=True)
        return FALLBACK_MESSAGE
