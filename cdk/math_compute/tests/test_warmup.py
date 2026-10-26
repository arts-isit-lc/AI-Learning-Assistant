"""Daily keep-warm ping (cdk/lib/warmup.ts) returns before any computation."""

import handler as handler_mod


class _FakeContext:
    function_name = "math-compute"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:0:function:math-compute"
    memory_limit_in_mb = 256
    aws_request_id = "test-req"
    log_group_name = "/aws/lambda/math-compute"
    log_stream_name = "stream"

    def get_remaining_time_in_millis(self):
        return 30000


def test_warmup_ping_returns_before_compute(monkeypatch):
    def _fail(*a, **k):
        raise AssertionError("warm-up ping must not reach the compute pipeline")

    monkeypatch.setattr(handler_mod, "parse_math_input", _fail)
    monkeypatch.setattr(handler_mod, "_handle_compare_expressions", _fail)

    assert handler_mod.handler({"warmup": True}, _FakeContext()) == {"warmup": True}
