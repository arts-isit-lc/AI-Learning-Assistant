"""Offline eval harness (Phase 0b).

Gates the behavioral optimization flags (#1 RAG_RETURN_PASSAGES, #9
STRICT_IMAGE_ESCALATION) before they are enabled in production.

Methodology:
1. Run a fixed golden set of representative queries through the pipeline with
   the flag OFF (baseline) and ON (candidate), capturing answer text, source
   retrieval_ids, latency, and token usage.
2. Compare each pair with ``comparator.compare_outputs`` — a deterministic,
   pure function that checks the candidate didn't regress (source overlap stays
   high, answer length stays in a sane band, no empty answers).
3. The flag is only flipped on in prod when the comparison passes for the whole
   golden set AND a human spot-checks a sample.

The comparator and golden set are unit-tested and deterministic (no Bedrock).
A live runner (capturing real outputs against a dev stack) is intentionally a
thin wrapper around ``compare_outputs`` and is run manually, not in CI.
"""
