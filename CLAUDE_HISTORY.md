# Project History

Durable architectural decisions and technical findings. Append new entries; when a decision changes, add a new entry explaining why rather than editing the old one.

## 2026-10-26 — Node.js runtime upgraded from 22 to 24

**Decision:** All Node.js Lambda functions and the two Node layers (`aws-jwt-verify`, `postgres`) moved from `nodejs22.x` to `nodejs24.x`. The Amplify frontend build (`nvm install 24`) and `frontend/.nvmrc` moved to Node 24 as well. The `postgres` layer was rebuilt with `postgres@3.4.9` (previously 3.2.4, from 2022).

**Why:** Prompted by the Node.js October 21, 2026 security release (CVE-2026-111497, a Brotli decoder RCE, plus 9 others). The app was not directly exposed: no Lambda code uses `zlib`/Brotli, `dns`, `tls`, built-in `fetch`, or the permission model, and the Lambda runtime is AWS-managed (auto-patched). Node 22 (patched in 22.23.4) would have been sufficient for the CVE. The upgrade was done as hygiene ahead of Node 22's end of life (April 2027) and to align the cloud runtime with local development, which already ran Node 24.

**Compatibility checks done:**
- `nodejs24.x` on Lambda does not support callback-style handlers. All Node handlers are `async (event)`, and none use `context.done/succeed/fail`.
- No deprecated or removed APIs (`url.parse`, `new Buffer()`, etc.) are used. No npm dependency declares an engine range that excludes Node 24.
- `postgres` `ssl: 'require'` has the same semantics in 3.2.4 and 3.4.9 (TLS without certificate verification). The new `sslnegotiation` option defaults to the previous behaviour.

**Residual risk:** OpenSSL 3.5 in Node 24 has stricter TLS defaults. The RDS Proxy connection is the most likely place for a surprise, so verify DB-backed endpoints after deploying to dev.

**Rollback:** Revert the runtime constants in `cdk/lib/api-gateway-stack.ts` (and the Amplify `nvm` lines) and redeploy.

## 2026-10-26 — Finding: idle RAG Lambdas delay the first upload by about 15 minutes

**Symptom:** In dev, the first upload after a long idle period stuck at "Reading document" (`ingesting`) and the wizard then showed "Timed out". The upload completed about 15 minutes later without intervention. This was not caused by the Node 24 upgrade: `AILA-MultimodalRagStack` was not part of that deploy, and the pipeline is Python.

**Root cause (from CloudTrail, SQS and Lambda metrics):** The container-image functions `ragIngestionFunction` and `ragEnrichmentFunction` had not been invoked for 52 days, and Lambda had made them **Inactive**. On the next trigger, the Lambda service re-pulled the image from ECR to reactivate the function (CloudTrail: `ecr:BatchGetImage` / `GetDownloadUrlForLayer` by `lambda.amazonaws.com`), and that first invocation attempt failed.
- **Ingestion** (S3 → async invoke): Lambda's async retry absorbed the failure. It started 31 s after the upload (`AsyncEventAge` = 31,316 ms).
- **Enrichment** (SQS event source): the poller had already received the message (SQS `NumberOfMessagesReceived` at 17:40), so it stayed in flight until the queue's **900 s visibility timeout** expired. The retry at 17:55:49 succeeded in 22.7 s. There were no Invocations, and no log stream was written for the first attempt.

**Same cause, chatbot (18:03 UTC):** The first chat request after the idle period returned an API Gateway 5XX. `chatbotV2Function` had an Errors datapoint but no Invocations, and CloudTrail shows its image (`sha256:14f7482d766e…`) being re-pulled at 18:03:20. The Node 24 authorizer, `studentFunction` and AppSync `AuthHandler` all ran without errors. At that point Lambda reported `State: Inactive` for `ragRetrievalFunction`, `mathComputeFunction`, `rdsProjectionConsumerFunction`, `SQSTriggerDockerFunc` and `TextGenLambdaDockerFunc`. The chatbot calls retrieval and math synchronously, and `retrieval_client.py` returns `None` on any exception, so an Inactive retrieval function silently produces an answer without course material instead of an error. Every container-image Lambda is affected, not only the RAG pipeline. `aws lambda get-function-configuration --query State` shows the state directly.

**Constraints:** The enrichment queue's visibility timeout cannot be shorter than the function's 900 s timeout (an AWS requirement for SQS event sources). The wizard's 300 s polling limit (`POLLING_TIMEOUT_SECONDS`) is shorter than this worst case, so the UI reports "Timed out" while processing is still pending.

## 2026-10-26 — Decision: daily keep-warm ping for all container-image Lambdas

**Decision:** Each container-image Lambda gets its own EventBridge rule (`rate(1 day)`) that invokes it with `{"warmup": true}`: ingestion, enrichment, retrieval, chatbotV2, mathCompute, rdsProjectionConsumer and SQSTriggerDockerFunc. Each handler returns `{"warmup": True}` on that flag before any I/O. The helper is `addDailyWarmup` in `cdk/lib/warmup.ts`.

**Why:** It fixes the idle-Inactive failures described in the finding above, and covers both the asynchronous pipeline and the synchronous chatbot path.

**Choices:**
- *Daily rather than weekly:* AWS does not publish the idle threshold ("several weeks"), so daily leaves a wide margin. The cost is about 210 short invocations per month across the 7 functions.
- *One rule per function:* EventBridge allows at most 5 targets per rule, and separate rules let one schedule be disabled on its own.
- *Explicit flag rather than relying on empty-event behaviour:* `sqsTrigger` raises `ValueError` without `Records`, and ingestion logs a misleading warning.
- *TextGenLambdaDockerFunc excluded:* it has no route in the OpenAPI definition and has never been invoked. It is likely dead code, and `test/warmup-schedule.test.ts` documents the exclusion.

**Alternatives considered:**
- (A) Only make the wizard tolerate long waits: hides the problem and leaves the chatbot failing.
- (C) Shorten the enrichment timeout and visibility timeout to about 300 s: risks failing large documents and does nothing for synchronous callers.
- Provisioned concurrency: removes cold starts entirely, but costs continuously for a problem that only needs occasional invocations.

## 2026-10-26 — Finding: container images don't pick up dependency fixes unless forced

**Finding:** Auditing `requirements.txt` is not enough. The deployed images had 99 known vulnerabilities while the requirements files audited clean.
- **Docker layer cache:** the `pip install` layer is reused until `requirements.txt` changes, and `FROM public.ecr.aws/lambda/python:3.11` uses whatever base image is cached locally (it was six months old). Unpinned transitive dependencies (certifi, urllib3, pillow) therefore never update.
- **AL2 wheel ceiling:** the `python:3.11` image is Amazon Linux 2 (glibc 2.26). Packages that ship only `manylinux_2_28` wheels get resolved to their last compatible version, silently and with no error. Pillow stayed at 12.2.0 this way, the same issue as the numpy 1.26.4 pin.

**Decision:** Add explicit `>=` security floors for vulnerable transitive dependencies in each image's `requirements.txt`. This busts the pip cache and stops silent downgrades. Install `zlib-devel`/`libjpeg-turbo-devel` in the RAG image so Pillow ≥ 13 builds from source on AL2. Run `docker pull` on the base image before deploying.

**How to audit an image:** `docker run --entrypoint pip <image> freeze > f.txt` then `pip-audit -r f.txt --no-deps --disable-pip`.

**Long-term:** migrating to `python3.12`+ (AL2023, glibc 2.34) removes the wheel ceiling and AL2's end-of-life patch limits. Lambda deprecates `python3.11` on 2027-06-30. See `docs/security-dependency-audit.md` (2026-10-26).
