# Async-Guardrail — Validation & Ship Steps

Operational tracker for shipping the ConverseStream async-guardrail migration (`USE_CONVERSE_STREAMING`) from dev → prod. This is the **near-term, independent** latency win (does not depend on the perception-at-ingestion work). Deploy sequence lives in `rollout-checklist.md` (Rollout 1); this doc holds the validation evidence + the commands to gather it.

## Status

- **Implemented & deployed to dev.** `chatbot_v2/src/streaming.py` routes generation through Bedrock `ConverseStream` with `guardrailConfig.streamProcessingMode="async"`, behind `USE_CONVERSE_STREAMING`. Commits `17386b4`, `2fac502` on `dev`.
- **Flag state:** dev = ON, prod = OFF (`isProd ? "false" : "true"` in `cdk/lib/multimodal-rag-stack.ts`). Diagnostic `STREAM_GUARDRAIL_DISABLED` = OFF everywhere (dev-only aid; must never be ON in prod).
- **Measured so far (dev):** A/B before ship — TTFT guardrail-ON ~8.1s avg / 7.8s median (n=12) vs OFF ~1.3s avg (n=3). Post-deploy in `converse` mode: TTFT ~1.3–1.7s.

## Remaining validation (before prod flip)

1. **Latency confirmation from recent dev logs** — pull `stream_latency` events in `streaming_mode=converse` and confirm TTFT holds at ~1.3–1.7s across a fresh sample of real turns. *(BLOCKED: AWS SSO token expired — run the commands below after `aws sso login --profile vincent.adm-dev2`.)*
2. **Blocked-topic behavior** — send a prompt that should trip the guardrail and confirm it still intervenes in async mode (`stopReason="guardrail_intervened"`), i.e. async streaming did not weaken enforcement. This is the key correctness check for async mode. *(Manual dev chatbot turn.)*

## Commands (run after SSO refresh)

```bash
aws sso login --profile vincent.adm-dev2

# Confirm creds are live
aws sts get-caller-identity --profile vincent.adm-dev2 --region ca-central-1

# Pull recent converse-mode TTFT samples (adjust the log group if the function
# name differs — confirm via: aws lambda list-functions --profile vincent.adm-dev2
# --region ca-central-1 | grep -i chatbot)
aws --profile vincent.adm-dev2 --region ca-central-1 logs filter-log-events \
  --log-group-name /aws/lambda/AILA-MultimodalRagStack-chatbotV2Function \
  --start-time $(( ($(date +%s) - 86400) * 1000 )) \
  --filter-pattern '"stream_latency" "converse"' \
  --max-items 50
```

Record: TTFT median/p95 across the sample, and the blocked-topic result (intervened yes/no). Paste them into the "Measured" line above so the ship decision has fresh evidence.

## Ship steps (gated)

Only after (1) fresh dev TTFT looks good AND (2) the blocked-topic prompt intervenes cleanly AND (3) explicit user go-ahead — **do not flip prod without all three**:

1. Flip the prod gate for `USE_CONVERSE_STREAMING` in `cdk/lib/multimodal-rag-stack.ts`; keep `STREAM_GUARDRAIL_DISABLED` OFF.
2. From `cdk/`: `npm run deploy` (predeploy `npm test` must pass).
3. Monitor prod `stream_latency` (`streaming_mode=converse`) for one active window; spot-check a blocked-topic prompt in prod.
4. **Rollback if needed:** set the flag OFF → redeploy. Reverts to `InvokeModel` + synchronous guardrail (known-good), instant, no data migration.
