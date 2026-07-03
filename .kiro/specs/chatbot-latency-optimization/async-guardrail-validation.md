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

## Remaining validation (before prod flip)

1. **Latency confirmation from dev logs — DONE (2026-07-03).** Pulled `stream_latency` events; on the current deploy, `converse` TTFT is ~1.3–1.7s (median ~1657ms, n=4) vs `invoke` ~4–7s (n=3). Holds up. Only the small sample size is a caveat — good enough to proceed once (2) is done.
2. **Blocked-topic behavior — STILL OPEN (the ship gate).** Send a prompt that should trip the guardrail and confirm it still intervenes in async mode (`stopReason="guardrail_intervened"` → the `"Guardrail intervened (stream signal)"` warning), i.e. async streaming did not weaken enforcement. **Zero** intervention events found in the last 14 days of dev logs, so this is genuinely untested on the async path — it must be exercised manually before the prod flip. *(Manual dev chatbot turn.)*

## Commands (re-run to refresh evidence)

Confirmed log group: `/aws/lambda/AILA-MultimodalRagStack-chatbotV2Function`. Only events at `location=stream_response:279+` carry the `streaming_mode` field (older builds don't) — filter on that when comparing.

```bash
# (Re-auth if the SSO token has expired: aws sso login --profile vincent.adm-dev2)

# Pull recent stream_latency events, then split by streaming_mode in post.
aws --profile vincent.adm-dev2 --region ca-central-1 logs filter-log-events \
  --log-group-name /aws/lambda/AILA-MultimodalRagStack-chatbotV2Function \
  --start-time $(( ($(date +%s) - 3*86400) * 1000 )) \
  --filter-pattern 'stream_latency' --max-items 100 --query 'events[].message'

# Confirm the async guardrail still BLOCKS (should return rows once a blocked
# prompt is tried in dev):
aws --profile vincent.adm-dev2 --region ca-central-1 logs filter-log-events \
  --log-group-name /aws/lambda/AILA-MultimodalRagStack-chatbotV2Function \
  --start-time $(( ($(date +%s) - 14*86400) * 1000 )) \
  --filter-pattern 'Guardrail intervened' --max-items 20 --query 'events[].message'
```

## Ship steps (gated)

Gate = (1) dev TTFT confirmed [DONE], (2) blocked-topic prompt intervenes cleanly in async mode [OPEN], (3) explicit user go-ahead. **Do not flip prod until (2) and (3) are also satisfied:**

1. Flip the prod gate for `USE_CONVERSE_STREAMING` in `cdk/lib/multimodal-rag-stack.ts`; keep `STREAM_GUARDRAIL_DISABLED` OFF.
2. From `cdk/`: `npm run deploy` (predeploy `npm test` must pass).
3. Monitor prod `stream_latency` (`streaming_mode=converse`) for one active window; spot-check a blocked-topic prompt in prod.
4. **Rollback if needed:** set the flag OFF → redeploy. Reverts to `InvokeModel` + synchronous guardrail (known-good), instant, no data migration.
