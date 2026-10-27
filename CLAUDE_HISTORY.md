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

## 2026-10-26 — Decision: remove TextGenLambdaDockerFunc (V1 chatbot)

**Decision:** Delete `TextGenLambdaDockerFunc` and `cdk/text_generation/`. It had no API route, and CloudWatch showed no invocations in dev or prod. Its image carried 25 known vulnerabilities (langchain, aiohttp, …). Removing it was preferred over patching dead code.

**Kept on purpose:**
- `TextGenGuardrail` / `TextGenGuardrailVersion` and the `/AILA/<env>/Guardrail*` SSM parameters. Chatbot V2 uses them. Renaming the guardrail would replace the resource, so the legacy name stays.
- The SSM parameters `TableName`, `BedrockLLM` and `EmbeddingModel`. Other Lambdas read them by name at runtime.

**Observability moved to the live chatbot.** TextGen held the only email-paging Lambda alarm and the guardrail-failure metric filter, so the real chatbot had neither. Both now target `chatbotV2Function`, and its filter matches the messages `chatbot_v2/src/guardrails.py` actually logs. `ObservabilityStack` now throws at synth time if chatbotV2 is missing, instead of falling back to `containerLambdaNames[0]`. The tests had been passing through that fallback, against SQSTrigger's log group.

**Known gap (follow-up):** `DynamoDB-Conversation-Table` (chat history for chatbotV2 and DeleteLastMessage) was created at runtime by TextGen's code (`create_table`) and is not managed by CloudFormation. Existing environments already have it, but a brand-new environment would not. Bringing it under CDK needs a CloudFormation resource import in each existing environment.

**Also noted:** the other `MultimodalRagStack` functions (ingestion, enrichment, retrieval, math, rdsProjection) are still not covered by ObservabilityStack.

## 2026-10-26 — Decision: monitor the RAG pipeline in ObservabilityStack

Closes the gap noted in the TextGen removal entry. `ApiGatewayStack.lambdaFunctionInfos` now lists every `MultimodalRagStack` container function by its deterministic name (`<rag stack id>-<fn>`), which avoids cross-stack exports. A test (`rag-observability.test.ts`) fails if a new RAG image function is not listed.
- **Tier 1 (error rate, duration, throttle):** `ragRetrievalFunction`. The chatbot swallows retrieval failures (`retrieval_client.py` returns `None`) and answers without course material, so its errors are otherwise invisible.
- **Tier 2 (error rate only):** ingestion, enrichment, mathCompute, rdsProjectionConsumer.
- **Email:** only chatbotV2's critical error rate pages directly. RAG critical alarms go to the Warning topic, but they count toward the `SystemHealthCritical` composite (2 of 3 subsystems), whose rule resolves to about 5.4k of the 10,240-character limit.
- **DLQs:** `enrichmentDlq` and `rdsProjectionDlq` get critical, emailing depth alarms (`extraDlqNames` prop), matching the existing messages DLQ.

## 2026-10-26 — Decision: migrate all Python Lambdas to Python 3.12 (Amazon Linux 2023)

**Decision:** 9 zip Lambdas (`Runtime.PYTHON_3_12`) and the four container images (`public.ecr.aws/lambda/python:3.12`) move off Python 3.11 / AL2. AL2 reached EOL on 2026-06-30 and Lambda deprecates `python3.11` on 2027-06-30; `python3.12` is supported until 2028-10-31.

**Why 3.12 and not 3.13:** the `AWSLambdaPowertoolsPythonV2:78` layer used by the zip Lambdas supports runtimes only up to `python3.12`. 3.13 would also require migrating to Powertools V3. The numpy 1.26.4 pin (matched with math_compute) also has no cp313 wheels.

**What changed with it:**
- The `psycopg2` layer must match the runtime. It contains a CPython-specific extension (`_psycopg.cpython-3XX-…so`) under `python/lib/python3.X/site-packages`, so a 3.11 layer fails `import psycopg2` on 3.12. It was rebuilt as `layers/psycopg2-py312.zip` (psycopg2-binary 2.9.11, pinned in `build_layer_x86.sh`). Rebuild it whenever the Python runtime changes.
- The container images no longer install `gcc`/`*-devel` packages. On glibc 2.34 every dependency installs from a manylinux wheel, so the Pillow source build and its headers are gone. Images shrank from about 550–610 MB to about 200–260 MB.
- The numpy 1.26.4 pin no longer has an AL2 reason. It stays, matched with math_compute, until both are raised together.

**Note:** `cdk/lambda/getPresignedURL/` is not deployed by any stack; `generatePreSignedURL` is the live one. CDK's own `BucketNotificationsHandler` runs on a runtime CDK chooses (`python3.13` in 2.273).

**Verification:** every zip handler imports in the real `lambda/python:3.12` image with the new layer at `/opt`; all four images build and pass `pip-audit` (0 vulnerabilities); all 7 container handlers were invoked via the RIE; the Python suites pass on 3.12.

## 2026-10-26 — Decision: bring DynamoDB-Conversation-Table under CloudFormation via import

Resolves the gap from the TextGen removal. `ApiGatewayStack` defines the table (logical ID `ConversationTable`, `RemovalPolicy.RETAIN`) with properties matching the live table exactly (SessionId string key, PAY_PER_REQUEST, AWS-owned encryption, no PITR/streams/TTL). Existing environments run `cdk import` per `docs/guides/conversation-table-import.md`; new environments create it.

**Constraints that shaped it:**
- `cdk import` only runs when the import is the stack's *only* change. The change therefore lives on its own branch (`feat/conversation-table-import`) until every existing environment is imported. Deploying it unimported makes CloudFormation try to *create* the table and fail ("already exists"). The table name, SSM parameter and IAM ARNs stay literal so the import diff is just the table.
- An import doesn't apply tags, and the app-wide `app` tag would otherwise show as permanent drift. The runbook tags the live table before importing.
- **Possible follow-ups:** enable PITR on the chat history table (a template change once imported); `CHAT_HISTORY_TABLE` in `multimodal-rag-stack.ts` still hard-codes the name.

## 2026-10-26 — Decision: import the conversation table with `cdk deploy --import-existing-resources`

Changes how the previous entry imports the table. The table definition is already on `dev` alongside other changes, so `cdk import` (which requires the import to be the stack's only change) would have needed a temporary branch with the table reverted, a deploy of that, then the import. Instead, existing environments tag the table and run a normal deploy with `--import-existing-resources` (supported by the pinned CLI, 2.1145.0). CloudFormation adopts the existing named table in the same change set as the other updates. See `docs/guides/conversation-table-import.md`.

**Caveats:** not yet exercised on this stack (dev was imported with `cdk import`). The flag applies to every stack in `--all`, so any other unmanaged resource with a matching fixed name is adopted as well. A failure rolls back; the table is `Retain` and an import never touches its data. `cdk import` remains documented as the alternative.
