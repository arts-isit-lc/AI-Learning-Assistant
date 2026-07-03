# ADR: Move image perception to ingestion; runtime does retrieval + interpretation

- ID: ADR-004 (registered in `.kiro/steering/engineering-log.md`)
- Date: 2026-07-02
- Status: **Accepted (architecture) — pending production validation** (Track A) before implementation.
- Related: `findings.md` (evidence), `production-design.md` (implementation design).

## Decision

Treat **perception as an ingestion concern and interpretation as a runtime concern.** Compute a rich, structured, verbatim-faithful description of each figure **once at ingestion**, store it, and at query time retrieve that stored perception and let Sonnet interpret it. Keep runtime (live) vision only as a **rare, feature-flagged fallback**, not part of the normal request path.

## Context

The chatbot answered figure questions by running a **live Claude 3 Haiku vision call per query** ("escalation") inside retrieval. Measured cost: ~4–7 s per figure turn (median ~5.5 s), the dominant pre-first-token wait after the guardrail TTFT fix. This duplicated work already done at ingestion (enrichment already vision-analyzes each image once), and it scaled per-query rather than per-image even though images change rarely.

## Evidence (offline A/B/C/D/E studies; directional, dev)

- **v2 pilot (6 figs × 5 question categories):** rich stored perception + a good prompt (D) and the hybrid (E) reached ~0.92–0.93 correctness vs live escalation (A) 0.97, and **won** on comparison/chart/relationship. The current short ingestion description (B, 0.55) is clearly inadequate. Hybrid escalated only ~7 %.
- **Apparent exception — label lookup** (v2 aggregate had stored perception ~0.73). A **focused Track B study (40 dedicated label Q+A)** showed transcription-forced stored perception matched live (0.95–0.975) and drove label **hallucination to 0.00**. The weakness was **representational, not architectural** — stored perception simply hadn't preserved enough verbatim text; a better ingestion prompt closes it.
- Latency/cost: stored perception amortizes to ingestion (per-query tokens ~250–740 vs ~2200 for live), so retrieval on figure turns drops from ~5.5 s to a DB read.

Caveats (why "pending validation"): small n, auto-generated/unreviewed questions, model-bootstrapped references, uncalibrated Haiku judge, offline proxy (no production retrieval). Track A addresses these.

## Alternatives considered

- **Keep live runtime perception (status quo):** slow (~5.5 s/turn), duplicated work, scales per query. Rejected as the default.
- **Runtime cache of the escalation output:** treats the symptom; adds warm-up + invalidation for what is a pure function of the image — which belongs at ingestion. Rejected as a dependency (kept only as a possible targeted optimization).
- **Reuse the current short ingestion description:** insufficient (0.55; fails relationships/comparisons/charts). Rejected.
- **Switch escalation to Sonnet vision:** slower (~9–14 s est), not a latency lever. Rejected.
- **Richer perception at ingestion (chosen):** matches/exceeds live across categories once transcription is forced; simplest runtime.
- **Hybrid (stored + defensive fallback):** retained as the safety net, not the core path.

## Consequences

- **Positive:** ~5 s off figure turns and far fewer runtime Bedrock calls; one fewer model call on the hot path; lower label hallucination; simpler runtime (retrieval + interpretation).
- **Cost:** a one-time `ENRICHMENT_VERSION` bump + corpus backfill; a richer stored schema; reads must degrade gracefully during migration.
- **Retained risk:** runtime vision stays behind a feature flag as a rare fallback; routing is trivial initially (a semantic/question-type router is a later, separate effort only if evidence demands it).
- **Reusable asset:** the offline multimodal evaluation harness (`eval_harness/`) remains for future changes.
