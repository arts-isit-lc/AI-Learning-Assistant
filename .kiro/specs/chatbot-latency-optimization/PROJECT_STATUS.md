# Project Status — Chatbot Latency Optimization

**Current phase: split.** The async-guardrail latency fix is validated in dev and ready to ship (pending go-ahead). The perception-at-ingestion architecture is design-complete, but its production-validation study (Track A) is **deferred** until real course material + a domain reviewer are available — so that track is parked, not active. Nothing is lost: the frozen Track A packages wait as immutable artifacts to run against real content later.

## Completed

- ✓ Root-cause analysis — synchronous-guardrail TTFT (~8s); runtime vision "escalation" as the residual figure-turn bottleneck
- ✓ Async-guardrail implementation — ConverseStream async mode, shipped to dev (flag `USE_CONVERSE_STREAMING`)
- ✓ Evaluation framework — offline harness, 69 tests, frozen as Track A v1.0
- ✓ Architecture selection — perception at ingestion (leading design; runtime vision becomes a rare fallback)
- ✓ Production design — success criteria + migration/backfill + feature-flagged fallback
- ✓ Rollback plan — flag-off paths for both rollouts
- ✓ Review packages — 80 SME questions + 40 calibration rows, ready for reviewers

## Waiting on (operational gates)

- ✓ **Release Blocker #1 — async-guardrail intervention verified in dev (2026-07-03).** A blocked prompt intervened correctly in async mode (canonical redirect shown). One accepted caveat: async mode can flash a few pre-block model chunks (benign in the test). A chat-history reordering bug found during the test was fixed + deployed (`f7b430a`). Remaining for the prod flip is only the go-ahead. See `async-guardrail-validation.md`.
- ⏸ **SME review — DEFERRED (2026-07-03): no real course material or instructor to review yet.** Track A question curation (accept/edit/reject + edit rate). The `track-a-questions.json` package is frozen and ready; re-activate when real course content + a domain reviewer exist.
- ⏸ **Judge calibration — DEFERRED (same reason).** Human scoring of the 40-row `track-a-calibration.json` sample → judge-vs-human agreement. Re-activate alongside the SME review.

## Next decision

**Perception-at-ingestion rollout is PARKED** pending Track A, which is deferred until real course material + a domain reviewer exist (see above). The architecture stays **design-only** — it must not go to production on the current *directional* evidence (auto-generated questions, model-bootstrapped references, uncalibrated Haiku judge); Track A is precisely what would replace that with human-validated evidence.

The **async-guardrail latency fix is unaffected** and remains shippable now — it does not depend on Track A. Only your explicit go-ahead gates its prod flip.

## Suggested ownership (parallel, without crossing the validation gate)

- **Async-guardrail rollout** — intervention validated + reorder bug fixed; only the prod flip (on go-ahead) remains.
- **Track A** — coordinate SMEs, collect calibration, produce the final report.
- **Production implementation** — refine code behind flags; no merge until Track A signs off.

## Read-first index

- `findings.md` — evidence + the frozen Track A v1.0 spec
- `production-design.md` — target architecture + production success criteria
- `ADR-perception-at-ingestion.md` — the decision, alternatives, consequences
- `rollout-checklist.md` — pre-deploy / deploy / rollback for both rollouts
- `async-guardrail-validation.md` — async-guardrail measured evidence + the open ship gate
- `track-a-review-instructions.md` — how to use the two review packages
