# Project Status — Chatbot Latency Optimization

**Current phase: Production Validation.** The design phase is complete. What remains is operational validation, not architectural uncertainty. Two independent tracks ship on their own gates: the async-guardrail latency fix (near-term) and perception-at-ingestion (larger architecture).

## Completed

- ✓ Root-cause analysis — synchronous-guardrail TTFT (~8s); runtime vision "escalation" as the residual figure-turn bottleneck
- ✓ Async-guardrail implementation — ConverseStream async mode, shipped to dev (flag `USE_CONVERSE_STREAMING`)
- ✓ Evaluation framework — offline harness, 69 tests, frozen as Track A v1.0
- ✓ Architecture selection — perception at ingestion (leading design; runtime vision becomes a rare fallback)
- ✓ Production design — success criteria + migration/backfill + feature-flagged fallback
- ✓ Rollback plan — flag-off paths for both rollouts
- ✓ Review packages — 80 SME questions + 40 calibration rows, ready for reviewers

## Waiting on (operational gates)

- ☐ **Release Blocker #1 — async-guardrail intervention verified in dev.** Submit a known-blocked prompt in the dev chatbot and confirm: streaming stops, the intervention message displays, no unsafe partial output leaks, and the log records `stopReason="guardrail_intervened"`. ~10-minute QA task. Blocks the async-guardrail prod flip and nothing else.
- ☐ SME review complete — Track A question curation (accept/edit/reject + edit rate)
- ☐ Judge calibration complete — judge-vs-human agreement on the 40-row sample

## Next decision

**Go / No-Go for the perception-at-ingestion rollout**, decided against the `production-design.md` success criteria once SME review + judge calibration land. The async-guardrail fix ships independently and ahead of this — it does not depend on the perception work.

## Suggested ownership (parallel, without crossing the validation gate)

- **Async-guardrail rollout** — finish intervention validation, flip prod, done.
- **Track A** — coordinate SMEs, collect calibration, produce the final report.
- **Production implementation** — refine code behind flags; no merge until Track A signs off.

## Read-first index

- `findings.md` — evidence + the frozen Track A v1.0 spec
- `production-design.md` — target architecture + production success criteria
- `ADR-perception-at-ingestion.md` — the decision, alternatives, consequences
- `rollout-checklist.md` — pre-deploy / deploy / rollback for both rollouts
- `async-guardrail-validation.md` — async-guardrail measured evidence + the open ship gate
- `track-a-review-instructions.md` — how to use the two review packages
