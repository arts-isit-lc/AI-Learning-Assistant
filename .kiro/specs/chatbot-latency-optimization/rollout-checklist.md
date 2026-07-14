# Rollout Checklist — chatbot-latency-optimization

One-page operational checklist for the two independent rollouts from this effort. Print/tick during the actual deploy. Flag names and success criteria are authoritative in `flags.py` / `production-design.md`; this is the sequence.

Dev: profile `vincent.adm-dev2`, region `ca-central-1`. Deploy from `cdk/` via `npm run deploy` (runs `npm test` predeploy — never bypass). Flags default OFF = pre-optimization behavior, so deploying is a no-op until a flag is flipped.

---

## Rollout 1 — Async guardrail (`USE_CONVERSE_STREAMING`) — NEAR-TERM, INDEPENDENT

Shippable now; does not depend on the perception work. Measured TTFT ~8s → ~1.5s. Code now ON in all envs (prod gate flipped 2026-07-13); prod deploy pending.

**Pre-deployment (dev validation)**
- [ ] Run several dev chatbot turns in `converse` mode; confirm TTFT ~1.3–1.7s (see `async-guardrail-validation.md`).
- [ ] Run a **blocked-topic** prompt; confirm the guardrail still intervenes (`stopReason="guardrail_intervened"`) in async mode.
- [ ] Confirm no output-block regression is user-visible beyond the accepted async tradeoff (a few chunks may precede an output-side block; guardrail does no PII masking).
- [x] Explicit user go-ahead to enable in prod. (2026-07-13)

**Deployment**
- [x] Set `USE_CONVERSE_STREAMING` ON for prod in `cdk/lib/multimodal-rag-stack.ts` (now `"true"` in all envs, `isProd` gate removed); `STREAM_GUARDRAIL_DISABLED` stays OFF in prod (still `!isProd`-gated). Test updated. (2026-07-13)
- [ ] `npm run deploy` (predeploy tests pass).
- [ ] Monitor prod `stream_latency` (`streaming_mode=converse`) TTFT for one active window.
- [ ] Spot-check a blocked-topic prompt in prod.

**Rollback**
- [ ] Set `USE_CONVERSE_STREAMING` OFF for prod → redeploy. Reverts to `InvokeModel` + synchronous guardrail (known-good). Instant, no data migration.

---

## Rollout 2 — Perception at ingestion (`PERCEPTION_FROM_INGESTION` + `RUNTIME_VISION_FALLBACK`) — GATED ON TRACK A

Do **not** start until Track A validates and the design is approved. Design + criteria: `production-design.md`. Both flags default OFF.

**Pre-deployment**
- [ ] Track A evaluation approved (v1.0 spec, frozen).
- [ ] SME question review complete (edit rate recorded; `track-a-questions.json`).
- [ ] Judge calibration complete (judge-vs-human agreement acceptable; `track-a-calibration.json`).
- [ ] Success criteria met (`production-design.md`): P95 figure-turn TTFT reduced ≥ X s; correctness not worse + hallucination not increased; projected fallback rate < 5–10%.
- [ ] Rollback path (flag-off → live escalation) verified in dev.

**Deployment**
- [ ] Bump `ENRICHMENT_VERSION` (`haiku-v5-…` → `haiku-v6-…`) — invalidates the enrichment cache.
- [ ] Run corpus **backfill** (re-enrich image elements); confirm it completes. Reads must degrade gracefully for not-yet-backfilled images.
- [ ] Enable `PERCEPTION_FROM_INGESTION` in **dev**; keep `RUNTIME_VISION_FALLBACK` available.
- [ ] Monitor: figure-turn latency (retrieval + TTFT), runtime-vision **fallback frequency** (< 5–10%), **hallucination** rate (esp. label questions).
- [ ] Promote to prod only after dev canary meets criteria + explicit user go-ahead.

**Rollback**
- [ ] Disable `PERCEPTION_FROM_INGESTION` (→ live escalation path).
- [ ] Restore previous `ENRICHMENT_VERSION` if the backfill caused a regression.
- [ ] Verify the runtime-vision path serves figure turns correctly.

---

**Reminders:** ship Rollout 1 independently of Rollout 2. Never flip a prod flag without dev validation + explicit go-ahead. Every flag flip is a config/redeploy, fully reversible.
