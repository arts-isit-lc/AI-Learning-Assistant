"""Handler-level integration tests for the chatbot V2 Lambda (Phase 5).

The audit's #1 systemic finding: the large unit-test suite mocks individual
units, so the WIRING between units (the seams) went untested — which is where
the recurring bugs lived (double persistence, grounding vs display disagreeing,
response-shape drift, the inert adaptive loop). These tests call the REAL
main.handler() with only the external IO boundaries stubbed (Bedrock, the
retrieval Lambda, DynamoDB, RDS, AppSync), so the real orchestration, state
machine, block selection, grounding, and response assembly all run end to end.

psycopg2 isn't installed locally, so a fake is injected before importing main
(same pattern as test_eval_parallel.py).
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402
from state_machine import create_default_state  # noqa: E402
from evaluation import EvaluationResult  # noqa: E402

_SESSION_STATE_KEYS = {
    "stage", "module_complete", "engagement_score", "concepts_demonstrated", "tutor_active",
}
_TOP_LEVEL_KEYS = {"session_name", "llm_output", "blocks", "llm_verdict", "session_state"}


class _Ctx:
    """Minimal Lambda context for the powertools inject decorator."""
    function_name = "chatbot-v2"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:0:function:chatbot-v2"
    memory_limit_in_mb = 512
    aws_request_id = "test-req-id"

    def get_remaining_time_in_millis(self):
        return 30000


def _event(message_content="What is recursion?"):
    return {
        "queryStringParameters": {
            "course_id": "c1", "session_id": "s1", "module_id": "m1", "session_name": "Chat",
        },
        "requestContext": {"authorizer": {"email": "student@ubc.ca"}},
        "body": json.dumps({"message_content": message_content}),
    }


def _retrieval(**kw):
    base = dict(
        answer="RAG context about recursion.",
        image_results=[], table_results=[], formula_results=[],
        escalation_used=False, image_analyses=[],
    )
    base.update(kw)
    return SimpleNamespace(**base)


@pytest.fixture
def wire(monkeypatch):
    """Stub only the external IO boundaries; real orchestration runs.

    Returns a control object so a test can tweak the loaded state, the retrieval
    result, and the stream output, and inspect the persistence calls.
    """
    ctl = SimpleNamespace(
        state=create_default_state("s1"),
        retrieval=_retrieval(),
        stream=MagicMock(return_value="LLM answer about recursion."),
        persist_turn=MagicMock(),
        persist_state=MagicMock(),
        evaluate=MagicMock(return_value=EvaluationResult(correct=True, partial=False, confidence=0.9)),
    )
    ctl.state.module_concepts = ["Recursion", "Trees"]
    ctl.state.module_name = "Data Structures"
    ctl.state.allowed_file_ids = ["f1"]

    monkeypatch.setattr(main, "_get_guardrail_config", lambda: ("gid", "DRAFT"))
    monkeypatch.setattr(main, "_get_appsync_url", lambda: "")
    monkeypatch.setattr(main, "_load_session_state", lambda sid: ctl.state)
    monkeypatch.setattr(main, "_load_module_concepts", lambda c, m: (["Recursion", "Trees"], "Data Structures"))
    monkeypatch.setattr(main, "load_chat_history", lambda *a, **k: [])
    monkeypatch.setattr(main, "_get_allowed_file_ids", lambda m: ["f1"])
    monkeypatch.setattr(main, "evaluate_answer", ctl.evaluate)
    monkeypatch.setattr(main, "invoke_retrieval", lambda *a, **k: ctl.retrieval)
    monkeypatch.setattr(main, "_stream_with_guardrail_retry", lambda **k: ctl.stream(**k))
    monkeypatch.setattr(main, "_persist_turn", ctl.persist_turn)
    monkeypatch.setattr(main, "_persist_session_state", ctl.persist_state)
    monkeypatch.setattr(main, "_get_db_connection", lambda: MagicMock())
    monkeypatch.setattr(main, "persist_message_to_rds", MagicMock())
    monkeypatch.setattr(main, "log_engagement", MagicMock())
    monkeypatch.setattr(
        main, "classify_math_intent",
        lambda msg: SimpleNamespace(needs_compute_lambda=lambda: False, is_discourse_reference=False, compute=False),
    )
    return ctl


# ---------------------------------------------------------------------------
# H1: the adaptive-learning loop must bootstrap (interactions per-turn counter)
# ---------------------------------------------------------------------------


def test_eval_skipped_on_first_interaction(wire):
    # interactions == 0 -> eval gate is closed this turn.
    wire.state.interactions = 0
    resp = main.handler(_event(), _Ctx())
    assert resp["statusCode"] == 200
    wire.evaluate.assert_not_called()


def test_eval_runs_once_interactions_bootstrapped(wire):
    # interactions > 0 -> eval runs. This is the seam H1 broke: interactions used
    # to only increment inside update_state (which only ran if eval ran).
    wire.state.interactions = 1
    main.handler(_event(), _Ctx())
    wire.evaluate.assert_called_once()


def test_interactions_increments_and_is_persisted_each_turn(wire):
    wire.state.interactions = 3
    main.handler(_event(), _Ctx())
    saved = wire.persist_state.call_args.args[0]
    assert saved.interactions == 4  # incremented once for this processed turn


# ---------------------------------------------------------------------------
# Response-shape parity across exits (M6)
# ---------------------------------------------------------------------------


def test_normal_response_shape(wire):
    resp = main.handler(_event(), _Ctx())
    body = json.loads(resp["body"])
    assert _TOP_LEVEL_KEYS <= set(body)
    assert set(body["session_state"]) == _SESSION_STATE_KEYS
    assert body["llm_output"] == "LLM answer about recursion."
    assert body["blocks"][0] == {"type": "text", "content": "LLM answer about recursion."}


def test_guardrail_block_shape_matches_normal(wire):
    # A blocked turn must return the SAME schema as a normal turn (M6). This
    # failed before _session_state_view unified the exits: the normal/guardrail
    # paths omitted tutor_active while the tutor paths included it.
    wire.stream.return_value = {"message": "[blocked]", "blocked": True, "type": "intervention"}
    resp = main.handler(_event(), _Ctx())
    body = json.loads(resp["body"])
    assert _TOP_LEVEL_KEYS <= set(body)
    assert set(body["session_state"]) == _SESSION_STATE_KEYS
    assert body["llm_output"] == "[blocked]"
    assert body["blocks"] == [{"type": "text", "content": "[blocked]"}]


# ---------------------------------------------------------------------------
# Retrieval -> grounding -> display seam (H6/M1): a shown figure is grounded
# ---------------------------------------------------------------------------


def test_figure_is_both_grounded_and_displayed(wire):
    wire.retrieval = _retrieval(image_results=[
        {"retrieval_id": "img-1", "score": 0.9, "page_num": 41,
         "description": "Figure 4.1: a bar chart of exam scores"},
    ])
    resp = main.handler(_event(message_content="explain figure 4.1"), _Ctx())
    body = json.loads(resp["body"])

    # Display seam: the figure block is attached to the response.
    assert {"type": "figure", "id": "img-1"} in body["blocks"]

    # Grounding seam: the figure's description reached the generation prompt, so
    # the model won't disclaim a figure it is simultaneously showing.
    system_prompt = wire.stream.call_args.kwargs["system_prompt"]
    assert "Figures shown to the student" in system_prompt
    assert "Figure 4.1: a bar chart of exam scores" in system_prompt


def test_no_figure_reference_attaches_no_figure(wire):
    # An unreferenced figure with a (meaningless) RRF-scale score is NOT shown.
    wire.retrieval = _retrieval(image_results=[
        {"retrieval_id": "img-9", "score": 0.03, "page_num": 5, "description": "unrelated"},
    ])
    resp = main.handler(_event(message_content="what is recursion?"), _Ctx())
    body = json.loads(resp["body"])
    assert all(b.get("type") != "figure" for b in body["blocks"])


# ---------------------------------------------------------------------------
# Tutor path persists blocks + keeps schema parity (M5/M6)
# ---------------------------------------------------------------------------


def test_tutor_turn_persists_text_blocks_and_matches_schema(wire, monkeypatch):
    wire.state.tutor_state = {"active": True, "completed": False, "step_list": []}
    # Tutor runtime yields a prompt (its internals aren't under test here).
    monkeypatch.setattr(main, "process_tutor_turn", lambda ts, msg: (ts, "tutor system prompt"))

    resp = main.handler(_event(message_content="next step"), _Ctx())
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    # Tutor reply persisted as a single text block via the shared helper (M5),
    # so tutor turns reconstruct on history reload like normal turns.
    wire.persist_turn.assert_called_once()
    persisted_blocks = wire.persist_turn.call_args.args[3]
    assert persisted_blocks == [{"type": "text", "content": "LLM answer about recursion."}]
    assert body["blocks"] == [{"type": "text", "content": "LLM answer about recursion."}]
    # Schema parity + tutor_active reflected.
    assert set(body["session_state"]) == _SESSION_STATE_KEYS
    assert body["session_state"]["tutor_active"] is True


# ---------------------------------------------------------------------------
# Latency instrumentation is wired (diagnostic breakdown log)
# ---------------------------------------------------------------------------


def test_latency_breakdown_is_emitted_with_phase_keys(wire, monkeypatch):
    wire.state.interactions = 1  # so eval runs and eval_ms is present too
    calls = []
    monkeypatch.setattr(main.logger, "info", lambda msg, **kw: calls.append(kw.get("extra", {})))

    main.handler(_event(), _Ctx())

    breakdowns = [e for e in calls if e.get("event") == "latency_breakdown"]
    assert len(breakdowns) == 1
    b = breakdowns[0]
    for key in (
        "total_ms", "time_to_generation_ms", "generation_ms",
        "retrieval_ms", "eval_ms", "persist_ms",
        "state_load_ms", "history_load_ms",
    ):
        assert key in b, f"latency breakdown missing {key}"
        assert isinstance(b[key], (int, float))


# ---------------------------------------------------------------------------
# Ordering-bug fix: time_sent must reflect TURN time on every persist path
# ---------------------------------------------------------------------------


def test_normal_turn_threads_turn_timestamps_to_persist(wire):
    main.handler(_event(), _Ctx())
    kwargs = wire.persist_turn.call_args.kwargs
    # The handler passes the turn's timestamps so RDS ordering reflects when the
    # turn happened, not when the (possibly async/delayed) projection is written.
    assert kwargs.get("user_time_sent") is not None
    assert kwargs.get("ai_time_sent") is not None
    assert kwargs["user_time_sent"] <= kwargs["ai_time_sent"]


def test_guardrail_block_persists_with_turn_timestamps(wire):
    # A blocked turn writes RDS synchronously; it must still carry turn-time
    # timestamps so it can't jump ahead of a still-queued prior turn.
    wire.stream.return_value = {"message": "[blocked]", "blocked": True, "type": "intervention"}
    main.handler(_event(), _Ctx())

    calls = main.persist_message_to_rds.call_args_list
    student_call = [c for c in calls if c.kwargs.get("student_sent") is True][0]
    ai_call = [c for c in calls if c.kwargs.get("student_sent") is False][0]
    assert student_call.kwargs.get("time_sent") is not None
    assert ai_call.kwargs.get("time_sent") is not None
    assert student_call.kwargs.get("time_sent") <= ai_call.kwargs.get("time_sent")


# ---------------------------------------------------------------------------
# Option B: the AppSync stream is authoritative, so EVERY handler exit path that
# streamed text must emit exactly ONE terminal message via _stream_final — the
# final blocks/metadata on a shown turn, or error=True on failure. A missing
# terminal message hangs the client until its 130s watchdog and then shows the
# retry banner even though the answer streamed. These pin that seam.
# ---------------------------------------------------------------------------


def test_normal_turn_emits_one_terminal_stream_message(wire, monkeypatch):
    sf = MagicMock()
    monkeypatch.setattr(main, "_stream_final", sf)
    main.handler(_event(), _Ctx())
    sf.assert_called_once()
    kwargs = sf.call_args.kwargs
    assert kwargs.get("llm_output") == "LLM answer about recursion."
    assert kwargs.get("blocks") == [{"type": "text", "content": "LLM answer about recursion."}]
    assert not kwargs.get("error")  # a shown answer is not an error


def test_guardrail_block_emits_one_terminal_stream_message(wire, monkeypatch):
    # A guardrail redirect is a SHOWN message (no error flag) — delivered over
    # the stream so the client renders it even if the POST already timed out.
    wire.stream.return_value = {"message": "[blocked]", "blocked": True, "type": "intervention"}
    sf = MagicMock()
    monkeypatch.setattr(main, "_stream_final", sf)
    main.handler(_event(), _Ctx())
    sf.assert_called_once()
    kwargs = sf.call_args.kwargs
    assert kwargs.get("llm_output") == "[blocked]"
    assert kwargs.get("blocks") == [{"type": "text", "content": "[blocked]"}]
    assert not kwargs.get("error")


def test_tutor_turn_emits_one_terminal_stream_message(wire, monkeypatch):
    # The tutor path streams text via _stream_with_guardrail_retry, so it must
    # emit the terminal message too (this was the gap: it returned HTTP 200 but
    # never terminated the stream, so a slow tutor turn hung the watchdog).
    wire.state.tutor_state = {"active": True, "completed": False, "step_list": []}
    monkeypatch.setattr(main, "process_tutor_turn", lambda ts, msg: (ts, "tutor system prompt"))
    sf = MagicMock()
    monkeypatch.setattr(main, "_stream_final", sf)
    main.handler(_event(message_content="next step"), _Ctx())
    sf.assert_called_once()
    kwargs = sf.call_args.kwargs
    assert kwargs.get("llm_output") == "LLM answer about recursion."
    assert kwargs.get("blocks") == [{"type": "text", "content": "LLM answer about recursion."}]
    assert not kwargs.get("error")


def test_tutor_guardrail_block_emits_one_terminal_stream_message(wire, monkeypatch):
    wire.state.tutor_state = {"active": True, "completed": False, "step_list": []}
    monkeypatch.setattr(main, "process_tutor_turn", lambda ts, msg: (ts, "tutor system prompt"))
    wire.stream.return_value = {"message": "[blocked]", "blocked": True, "type": "intervention"}
    sf = MagicMock()
    monkeypatch.setattr(main, "_stream_final", sf)
    resp = main.handler(_event(message_content="next step"), _Ctx())
    assert json.loads(resp["body"])["llm_output"] == "[blocked]"
    sf.assert_called_once()
    kwargs = sf.call_args.kwargs
    assert kwargs.get("llm_output") == "[blocked]"
    assert not kwargs.get("error")


def test_state_load_failure_emits_error_terminal_message(wire, monkeypatch):
    # A failed exit must terminate the stream with error=True so the client
    # surfaces the retry banner immediately instead of waiting out the watchdog.
    import botocore.exceptions

    def _boom(sid):
        raise botocore.exceptions.ClientError(
            {"Error": {"Code": "InternalServerError", "Message": "boom"}}, "GetItem"
        )

    monkeypatch.setattr(main, "_load_session_state", _boom)
    sf = MagicMock()
    monkeypatch.setattr(main, "_stream_final", sf)
    resp = main.handler(_event(), _Ctx())
    assert resp["statusCode"] == 503
    sf.assert_called_once()
    assert sf.call_args.kwargs.get("error") is True
