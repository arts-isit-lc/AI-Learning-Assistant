import json
import time
from typing import Iterator
import httpx
from aws_lambda_powertools import Logger

from flags import STREAM_GUARDRAIL_DISABLED, USE_CONVERSE_STREAMING
from guardrails import build_intervention_result

logger = Logger(service="chatbot-v2")

CHUNK_SIZE = 80
FALLBACK_MESSAGE = "I'm sorry, I wasn't able to generate a response. Please try again."

# ConverseStream surfaces service/model failures as terminal events in the
# stream (not as raised exceptions). We re-raise them so the caller's
# guardrail-service-error handling (retry / fail-closed) behaves exactly as it
# does for InvokeModel, where boto raises during stream consumption.
_CONVERSE_ERROR_EVENTS = (
    "internalServerException", "modelStreamErrorException", "validationException",
    "throttlingException", "serviceUnavailableException",
)


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


_SEND_MUTATION = '''
mutation SendChatChunk($session_id: String!, $chunk: String!, $done: Boolean!, $llm_output: String, $blocks: AWSJSON, $session_name: String, $llm_verdict: Boolean, $error: Boolean) {
    sendChatChunk(session_id: $session_id, chunk: $chunk, done: $done, llm_output: $llm_output, blocks: $blocks, session_name: $session_name, llm_verdict: $llm_verdict, error: $error) {
        session_id
        chunk
        done
        llm_output
        blocks
        session_name
        llm_verdict
        error
    }
}
'''


def _send(appsync_url: str, session_id: str, chunk: str, done: bool,
          llm_output=None, blocks=None, session_name=None,
          llm_verdict=None, error=False) -> None:
    """POST a sendChatChunk mutation to AppSync. Best-effort: failures are logged
    but never interrupt the turn."""
    if not appsync_url:
        return
    try:
        payload = {
            "query": _SEND_MUTATION,
            "variables": {
                "session_id": session_id, "chunk": chunk, "done": done,
                "llm_output": llm_output, "blocks": blocks,
                "session_name": session_name, "llm_verdict": llm_verdict,
                "error": error,
            },
        }
        headers = {"Content-Type": "application/json", "Authorization": "API_KEY"}
        with httpx.Client(timeout=10.0) as client:
            client.post(appsync_url, headers=headers, json=payload)
    except Exception:
        logger.exception("Failed to send chat chunk to AppSync", extra={"session_id": session_id, "done": done})


def send_chunk(appsync_url: str, session_id: str, chunk: str, done: bool = False) -> None:
    """Send an incremental answer-text chunk (done=false). The terminal done
    message is emitted separately via send_final so it can carry the final blocks."""
    _send(appsync_url, session_id, chunk, done)


def send_final(appsync_url: str, session_id: str, *, llm_output: str | None = None,
               blocks: list | None = None, session_name: str | None = None,
               llm_verdict: bool | None = None, error: bool = False) -> None:
    """Emit the SINGLE terminal (done=true) stream message carrying the authoritative
    final payload — the render blocks + session metadata — or an error flag. This is
    what makes the WebSocket stream authoritative so the HTTP POST can be a
    fire-and-forget trigger (decoupled from API Gateway's 29s timeout)."""
    _send(
        appsync_url, session_id, chunk="", done=True,
        llm_output=llm_output,
        blocks=json.dumps(blocks) if blocks is not None else None,
        session_name=session_name, llm_verdict=llm_verdict, error=bool(error),
    )


def _guardrail_attached(model_kwargs: dict) -> bool:
    """True when a guardrail id is supplied AND the dev kill-switch is off.

    STREAM_GUARDRAIL_DISABLED (default OFF, DEV-ONLY) drops the guardrail from
    the streaming call to isolate its time-to-first-token cost. Output is
    UNFILTERED while enabled; never enable in prod.
    """
    return bool(model_kwargs.get("guardrail_id")) and not STREAM_GUARDRAIL_DISABLED


def _log_guardrail_disabled(api: str) -> None:
    logger.warning(
        f"STREAM_GUARDRAIL_DISABLED active: guardrail NOT attached to the {api} "
        "call (dev TTFT diagnostic — streamed output is unfiltered)"
    )


# ─── Normalized event iterators ───────────────────────────────────────────────
# Both API paths yield the same small event vocabulary so the driver in
# stream_response can consume either without branching:
#   ("delta", text)                              a response text fragment
#   ("usage", input_tokens|None, output_tokens|None)   token counts as they arrive
#   ("stop", stop_reason)                        terminal stop reason
#   ("block_type", "input"|"output")             guardrail block side (Converse only)


def _iter_invoke_events(bedrock_client, model_id, system_prompt, user_message, chat_history, model_kwargs):
    """InvokeModelWithResponseStream → normalized events.

    Guardrail identifiers are top-level parameters (sent as X-Amzn-Bedrock-
    Guardrail* headers), NOT fields inside the JSON model body — Claude's
    Messages API rejects unknown body keys (e.g. amazon-bedrock-guardrailConfig)
    with a ValidationException. This is also why async stream mode is not
    reachable here (it can only be set via that body key), and the ConverseStream
    path exists.
    """
    messages = []
    for turn in chat_history:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_message})

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": model_kwargs.get("max_tokens", 4000),
        "system": system_prompt,
        "messages": messages,
    }
    invoke_kwargs = {
        "modelId": model_id,
        "contentType": "application/json",
        "accept": "application/json",
        "body": json.dumps(body),
    }
    if _guardrail_attached(model_kwargs):
        invoke_kwargs["guardrailIdentifier"] = model_kwargs["guardrail_id"]
        invoke_kwargs["guardrailVersion"] = model_kwargs.get("guardrail_version", "DRAFT")
    elif STREAM_GUARDRAIL_DISABLED and model_kwargs.get("guardrail_id"):
        _log_guardrail_disabled("streaming")

    response = bedrock_client.invoke_model_with_response_stream(**invoke_kwargs)

    def _gen():
        for event in response.get("body", []):
            chunk_data = json.loads(event["chunk"]["bytes"])
            ctype = chunk_data.get("type")
            if ctype == "message_start":
                yield ("usage", chunk_data.get("message", {}).get("usage", {}).get("input_tokens"), None)
            elif ctype == "content_block_delta":
                yield ("delta", chunk_data.get("delta", {}).get("text", ""))
            elif ctype == "message_delta":
                yield ("usage", None, chunk_data.get("usage", {}).get("output_tokens"))
                sr = chunk_data.get("delta", {}).get("stop_reason")
                if sr:
                    yield ("stop", sr)

    return _gen()


def _iter_converse_events(bedrock_client, model_id, system_prompt, user_message, chat_history, model_kwargs):
    """ConverseStream (guardrail in ASYNCHRONOUS mode) → normalized events.

    Async mode releases the first token immediately and scans in the background,
    which removes the synchronous guardrail's buffer-before-first-token latency.
    A guardrail block is signalled by messageStop.stopReason='guardrail_intervened'
    (with the assessment in the trailing metadata event), NOT by a raised
    exception — the driver turns that signal into the standard blocked result.
    """
    messages = []
    for turn in chat_history:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": [{"text": content}]})
    messages.append({"role": "user", "content": [{"text": user_message}]})

    converse_kwargs = {
        "modelId": model_id,
        "messages": messages,
        "inferenceConfig": {"maxTokens": model_kwargs.get("max_tokens", 4000)},
    }
    if system_prompt:
        converse_kwargs["system"] = [{"text": system_prompt}]
    if _guardrail_attached(model_kwargs):
        converse_kwargs["guardrailConfig"] = {
            "guardrailIdentifier": model_kwargs["guardrail_id"],
            "guardrailVersion": model_kwargs.get("guardrail_version", "DRAFT"),
            "trace": "enabled",  # needed to classify input vs output blocks
            "streamProcessingMode": "async",
        }
    elif STREAM_GUARDRAIL_DISABLED and model_kwargs.get("guardrail_id"):
        _log_guardrail_disabled("ConverseStream")

    response = bedrock_client.converse_stream(**converse_kwargs)

    def _gen():
        for event in response.get("stream", []):
            if "contentBlockDelta" in event:
                yield ("delta", event["contentBlockDelta"].get("delta", {}).get("text", ""))
            elif "messageStop" in event:
                yield ("stop", event["messageStop"].get("stopReason"))
            elif "metadata" in event:
                meta = event["metadata"]
                usage = meta.get("usage", {}) or {}
                yield ("usage", usage.get("inputTokens"), usage.get("outputTokens"))
                guardrail_trace = (meta.get("trace", {}) or {}).get("guardrail", {}) or {}
                if guardrail_trace.get("inputAssessment"):
                    yield ("block_type", "input")
                elif guardrail_trace.get("outputAssessment"):
                    yield ("block_type", "output")
            else:
                for err in _CONVERSE_ERROR_EVENTS:
                    if err in event:
                        raise RuntimeError(f"ConverseStream error event: {err} {event.get(err)}")

    return _gen()


def stream_response(
    bedrock_client,
    model_id: str,
    system_prompt: str,
    user_message: str,
    chat_history: list[dict],
    appsync_url: str,
    session_id: str,
    model_kwargs: dict | None = None,
) -> str | dict:
    """Stream an LLM response and return the assembled text (str), OR a blocked
    result dict when a guardrail intervention is signalled via the stream.

    Path is chosen by USE_CONVERSE_STREAMING: ConverseStream with an async
    guardrail (low TTFT) when on, else InvokeModelWithResponseStream with the
    default synchronous guardrail. Both paths share the buffering, AppSync chunk
    delivery, latency instrumentation and return-contract logic below.

    Returns FALLBACK_MESSAGE on a non-guardrail failure. Guardrail-related
    exceptions (InvokeModel path, or a service error on either path) are
    re-raised so the caller can classify and retry / fail closed.
    """
    model_kwargs = model_kwargs or {}
    streaming_mode = "converse" if USE_CONVERSE_STREAMING else "invoke"
    try:
        _stream_start = time.perf_counter()
        if USE_CONVERSE_STREAMING:
            events = _iter_converse_events(
                bedrock_client, model_id, system_prompt, user_message, chat_history, model_kwargs)
        else:
            events = _iter_invoke_events(
                bedrock_client, model_id, system_prompt, user_message, chat_history, model_kwargs)

        full_response = ""
        chunk_buffer = ""
        ttft_ms = None  # time to first token — the key perceived-latency metric
        input_tokens = None
        output_tokens = None
        stop_reason = None
        block_type = "output"  # default block side if the trace doesn't say

        for ev in events:
            kind = ev[0]
            if kind == "delta":
                text = ev[1]
                if text:
                    if ttft_ms is None:
                        ttft_ms = round((time.perf_counter() - _stream_start) * 1000, 2)
                    full_response += text
                    chunk_buffer += text
                    while len(chunk_buffer) >= CHUNK_SIZE:
                        send_chunk(appsync_url, session_id, chunk_buffer[:CHUNK_SIZE])
                        chunk_buffer = chunk_buffer[CHUNK_SIZE:]
            elif kind == "usage":
                if ev[1] is not None:
                    input_tokens = ev[1]
                if ev[2] is not None:
                    output_tokens = ev[2]
            elif kind == "stop":
                stop_reason = ev[1]
            elif kind == "block_type":
                block_type = ev[1]

        # Flush remaining buffered text. The terminal done message (carrying the
        # authoritative blocks + metadata, or an error flag) is emitted ONCE by the
        # handler via send_final AFTER block assembly — never here — so the stream
        # has a single, payload-bearing terminator.
        if chunk_buffer:
            send_chunk(appsync_url, session_id, chunk_buffer)

        # Stream latency (diagnostic): ttft_ms isolates model start-up from
        # stream_total_ms; a large ttft_ms with small input_tokens points at
        # overhead (synchronous guardrail), not prefill. streaming_mode tells the
        # two API paths apart when comparing.
        logger.info(
            "Stream latency",
            extra={
                "event": "stream_latency",
                "ttft_ms": ttft_ms,
                "stream_total_ms": round((time.perf_counter() - _stream_start) * 1000, 2),
                "output_chars": len(full_response),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "stop_reason": stop_reason,
                "model_id": model_id,
                "streaming_mode": streaming_mode,
            },
        )

        # ConverseStream signals a guardrail block via stop_reason (no exception).
        # Discard any partial text that streamed before the block landed and
        # return the canonical blocked result the handler already understands.
        # (The InvokeModel path signals interventions by raising, handled below.)
        if streaming_mode == "converse" and stop_reason == "guardrail_intervened":
            logger.warning("Guardrail intervened (stream signal)", extra={"block_type": block_type})
            return build_intervention_result(block_type)

        if not full_response:
            return FALLBACK_MESSAGE

        return full_response

    except Exception as e:
        # Re-raise guardrail-related errors so the caller can classify and retry
        err_msg = str(e)
        if "GUARDRAIL_INTERVENED" in err_msg or "GuardrailIntervention" in err_msg or "guardrail" in err_msg.lower():
            # Guardrail decision, not a generation failure. Do NOT emit fallback
            # text or a terminal done here — the handler emits the single terminal
            # message (the redirect/blocked message) via send_final.
            raise
        logger.exception("Streaming response failed")
        send_chunk(appsync_url, session_id, FALLBACK_MESSAGE)
        return FALLBACK_MESSAGE
