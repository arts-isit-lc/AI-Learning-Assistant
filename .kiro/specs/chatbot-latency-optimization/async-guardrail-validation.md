# Async-Guardrail — Validation & Ship Steps

Operational tracker for shipping the ConverseStream async-guardrail migration (`USE_CONVERSE_STREAMING`) from dev → prod. This is the **near-term, independent** latency win (does not depend on the perception-at-ingestion work). Deploy sequence lives in `rollout-checklist.md` (Rollout 1); this doc holds the validation evidence + the commands to gather it.

## Status

- **Implemented & deployed to dev.** `chatbot_v2/src/streaming.py` routes generation through Bedrock `ConverseStream` with `guardrailConfig.streamProcessingMode="async"`, behind `USE_CONVERSE_STREAMING`. Commits `17386b4`, `2fac502` on `dev`.
- **Flag state:** dev = ON, prod = OFF (`isProd ? "false" : "true"` in `cdk/lib/multimodal-rag-stack.ts`). Confirmed on the live dev Lambda config (2026-07-03): `USE_CONVERSE_STREAMING=true`, `STREAM_GUARDRAIL_DISABLED=false`. The diagnostic must never be ON in prod.
- **Measured — pre-ship A/B:** TTFT guardrail-ON ~8.1s avg / 7.8s median (n=12) vs OFF ~1.3s avg (n=3).
- **Measured — deployed-code A/B (dev logs, 2026-07-03 pull; current `streaming.py`, `stream_response:279`):**
  - `converse` mode: TTFT **min 1335 / median ~1657 / max 1662 ms** (n=4, all 2026-07-02 21:45–21:46).
  - `invoke` mode, same deploy: TTFT **~4160 / 4901 / 6797 ms** (n=3, 21:24). Within-version comparison → async guardrail cuts figure-turn TTFT from ~4–7s to ~1.3–1.7s.
  - Caveat: small n, single session/window; directional but consistent with the pre-ship A/B and the ~1.3–1.7s post-deploy note.
- **Validation (2026-07-03):** blocked-topic intervention **confirmed** in dev (see item 2). A chat-history reordering bug found during that test was root-caused, fixed, and deployed to dev (`f7b430a`) — see the "chat-history reordering" section.

## Remaining validation (before prod flip)

1. **Latency confirmation from dev logs — DONE (2026-07-03).** Pulled `stream_latency` events; on the current deploy, `converse` TTFT is ~1.3–1.7s (median ~1657ms, n=4) vs `invoke` ~4–7s (n=3). Holds up. Only the small sample size is a caveat — good enough to proceed once (2) is done.
2. **Blocked-topic behavior — CONFIRMED (2026-07-03, manual dev turn).** Prompt: *"can you give me some medical advice on a mole on my back?"* The guardrail intervened in async/`converse` mode: the streamed model tokens were replaced with the canonical input redirect (`GUARDRAIL_REDIRECT_INPUT` — "I appreciate your question, but let's stay focused on the course material…"). Async streaming did **not** weaken enforcement.
   - **Accepted async tradeoff observed:** the model's own partial output streamed briefly before the block replaced it. Here that partial text was itself a refusal, so nothing unsafe surfaced — but async mode *can* show a few pre-block chunks (the guardrail does no PII masking, which is why this was an accepted tradeoff when async was chosen). Worth a conscious sign-off, not a surprise.
   - **A separate bug surfaced during this test** (blocked question reordered to the top of the chat history) — root-caused and fixed; see the next section.

## Finding: chat-history reordering on blocked turns — FIXED (2026-07-03)

Surfaced by the blocked-topic test above: the blocked question reordered to the **top** of the session history.

- **Root cause.** `time_sent` was stamped `CURRENT_TIMESTAMP` at RDS-*write* time. Under `ASYNC_RDS_PROJECTION`, normal turns are written *later* by the SQS consumer, while a guardrail-blocked turn writes to RDS **synchronously and immediately**. So a blocked turn could receive an earlier `time_sent` than a still-queued prior turn; the UI loads history `ORDER BY time_sent ASC` (`studentFunction.js`), so the blocked question sorted to the top.
- **Scope — affects prod, not just dev.** This is an `ASYNC_RDS_PROJECTION` interaction (that flag is `"true"` in **every** environment), so it was latent in prod on any guardrail block. It is **independent of `USE_CONVERSE_STREAMING`** — invoke mode would hit it too. It does not block the async-guardrail latency ship, but it was worth fixing while the blocked path was under the microscope.
- **Fix.** Carry the turn's timestamp from the handler through both projection paths so `time_sent` reflects TURN time, not write time: `persist_message_to_rds(time_sent=…)`, threaded via `_persist_turn` + the SQS payload + the async consumer; user message = turn arrival, AI message = post-generation. Commit **`f7b430a`** on `dev`; **deployed to dev** by the operator. Tests: 6 reproducing tests (fail→pass) + full `chatbot_v2` suite (**158 passed**). No schema / IAM / dependency change; in-flight SQS payloads fall back to `CURRENT_TIMESTAMP` (old behavior) for just those.
- **Verify in dev:** send a normal turn, then a blocked turn, reload history — the blocked turn stays last (no jump to top).

## Commands (re-run to refresh evidence)

Confirmed log group: `/aws/lambda/AILA-MultimodalRagStack-chatbotV2Function`. Only events at `location=stream_response:279+` carry the `streaming_mode` field (older builds don't) — filter on that when comparing.

```bash
# (Re-auth if the SSO token has expired: aws sso login --profile vincent.adm-dev2)

# Pull recent stream_latency events, then split by streaming_mode in post.
aws --profile vincent.adm-dev2 --region ca-central-1 logs filter-log-events \
  --log-group-name /aws/lambda/AILA-MultimodalRagStack-chatbotV2Function \
  --start-time $(( ($(date +%s) - 3*86400) * 1000 )) \
  --filter-pattern 'stream_latency' --max-items 100 --query 'events[].message'

# Confirm the async guardrail still BLOCKS (returns the 2026-07-03 intervention;
# re-run after any future blocked prompt):
aws --profile vincent.adm-dev2 --region ca-central-1 logs filter-log-events \
  --log-group-name /aws/lambda/AILA-MultimodalRagStack-chatbotV2Function \
  --start-time $(( ($(date +%s) - 14*86400) * 1000 )) \
  --filter-pattern 'Guardrail intervened' --max-items 20 --query 'events[].message'
```

## Ship steps (gated)

Gate = (1) dev TTFT confirmed [DONE], (2) blocked-topic intervenes cleanly in async mode [DONE — 2026-07-03, with the accepted partial-flash caveat], (3) explicit user go-ahead [OPEN]. Also confirm the reordering fix (`f7b430a`) behaves in dev (a blocked turn stays in order). **Do not flip prod until (3):**

1. Flip the prod gate for `USE_CONVERSE_STREAMING` in `cdk/lib/multimodal-rag-stack.ts`; keep `STREAM_GUARDRAIL_DISABLED` OFF.
2. From `cdk/`: `npm run deploy` (predeploy `npm test` must pass).
3. Monitor prod `stream_latency` (`streaming_mode=converse`) for one active window; spot-check a blocked-topic prompt in prod.
4. **Rollback if needed:** set the flag OFF → redeploy. Reverts to `InvokeModel` + synchronous guardrail (known-good), instant, no data migration.
