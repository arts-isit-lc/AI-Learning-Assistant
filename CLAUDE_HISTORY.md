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

## 2026-10-27 — Finding: prod rollout of the 2026-10-26 release, including the conversation table import

The `--import-existing-resources` approach from the previous entry worked in prod. `ConversationTable` went `IMPORT_COMPLETE`, then CloudFormation applied the stack tags. Drift is `IN_SYNC`, the item count is unchanged (748), and a follow-up `cdk diff` shows 0 differences across all 7 stacks.

**Order that worked:** back up the table → verify its properties and tag it → `cdk deploy AILA-DBFlowStack --exclusively` (drops DBFlow's import of ApiGatewayStack's psycopg2 layer export) → `npm run deploy:prod -- --import-existing-resources` → rebuild the Amplify `main` branch so it builds on the Node 24 build spec.

**Findings for future prod deploys:**
- `cdk diff <stack> --import-existing-resources` builds the same import change set as the deploy, without executing it. It shows `[←] … import`, so an import can be checked against prod before deploying. A plain `cdk diff` fails CloudFormation early validation with `NAME_CONFLICT` ("already exists") for the same template.
- The pinned CDK CLI (2.1145.0) doesn't resolve the account from `AWS_PROFILE` with the SSO profile ("Unable to resolve AWS account"). Use `eval "$(aws configure export-credentials --profile <p> --format env)"` and unset `AWS_PROFILE`.
- `cdk diff` no longer accepts `--all` (it warns and diffs every stack anyway); `cdk deploy --all` still works.
- In prod, `AILA-DatabaseStack` had been in `UPDATE_ROLLBACK_COMPLETE` since 2026-09-02 (blocked export in use by ObservabilityStack). This release's DatabaseStack change (proxy target group tags) deployed cleanly.
- Test files without an `import`/`export` are global scripts, and ts-jest fails with duplicate identifiers when two of them run in the same worker. This is intermittent, depending on how Jest assigns files to workers. Fixed by adding `export {};` to `access-control`, `student-course` and `user-provisioning-triggers`; `cdk/test` has other script-style files without shared names.

## 2026-11-18 — Finding: database timestamps are UTC (prod verified)

Most timestamp columns are `timestamp` without a time zone (`time_sent`, `last_accessed`, `last_sign_in`, `time_enroled`, `time_uploaded`, `time_account_created`, `User_Engagement_Log.timestamp`). Only `Course_Modules.created_at`/`updated_at` and `Module_Files.last_processed_at` are `timestamptz`. The naive columns hold UTC because the server clock is UTC and nothing changes it: no app code sets a session time zone, and the chatbot's own `time_sent` uses `_utc_now_iso()`.

**Verified in prod:** the parameter group's `timezone` is `UTC` with source `system` (never modified). `pg_db_role_setting` has no time zone override for any app role (only the AWS-internal `rdsadmin`). The latest `Messages.time_sent` matched `now() AT TIME ZONE 'UTC'`, not Pacific time. Dev not checked.

**Implications:** UTC holds only by convention. Setting `timezone` in the parameter group or on a role would silently mix zones in the naive columns. `postgres.js` reads naive values in the process's local zone, which is correct on Lambda (UTC) but shifts them when run on a laptop. Treat naive values as UTC in exports and ad-hoc queries. Migrating to `timestamptz` (`USING col AT TIME ZONE 'UTC'`) would make this enforced rather than assumed.

## 2026-11-19 — Finding: AWS cost structure, dev DB drift, and Secrets Manager call source

From Cost Explorer (usage types, October 2026) and read-only checks in both accounts. Full plan: `AWS_COST_OPTIMIZATION_PLAN.md`.

**Cost structure:**
- **RDS Proxy is billed at a 2-vCPU minimum per proxy** (4,464 vCPU-h, $71.42 a month for the three proxies), whatever the instance size or load. That's the same in dev (`t3.micro`) as in prod. One proxy can hold all three secrets.
- **The "Amazon Virtual Private Cloud" line includes UBC's idle ca-west-1 Transit Gateway attachment** ($44.64), in both accounts. OCELIA's own VPC cost is the endpoints ($32.74) and the NAT IPv4 address ($3.72).
- **The NAT Gateway bills under "EC2 – Other"** ($37.20 an hour, data under $0.05).
- **CloudWatch's cost is mostly alarms** (86 alarms, $8.57) plus one dashboard beyond the free 3 ($3). API Gateway detailed metrics and flow logs cost almost nothing.

**Dev DB drift (template vs live):** `MultiAZ` false → **true**, AZ 1a → 1b (failed over), `EnableIAMDatabaseAuthentication` true → false, plus an extra 5432 ingress rule from the leftover `temp-pg-dump-sg` (from the data-export procedure, now unattached). No CloudTrail record in the 90-day window, so this predates 2026-08-21. **Prod `AILA-DatabaseStack` has no drift.** Because the template already says `MultiAZ: false`, a CDK deploy won't revert it. Use `modify-db-instance --no-multi-az`. Don't change `AvailabilityZone` in CDK to match, because that replaces the instance. Drift detection always fails on the three proxy target groups (`dBProxyName` null, from the `TargetGroupName` override), so it reports `DETECTION_FAILED` even when the rest is clean.

**Secrets Manager calls come from RDS Proxy, not the app:** `GetSecretValue` by `rds.amazonaws.com` is 100% of calls in dev and 91% in prod (each proxy polls about every 35 s, ~230k calls a month). Caching secrets in Lambdas helps latency, not cost.

## 2026-11-19 — Decision: single-AZ prod database, database rebuild allowed, dev same infrastructure at smaller sizes

Team decisions for `AWS_COST_OPTIMIZATION_PLAN.md`:
- **Prod runs single-AZ.** The team accepts ~5–10 min of downtime for patching (in a Sunday 10:00 UTC maintenance window), and ~30–60 min plus up to ~5 min of data loss if a whole AZ fails. Performance doesn't change. Saves ~$72/mo on the current instance. Multi-AZ can be turned back on online if this changes.
- **The database may be dropped and recreated to resize it.** RDS can't shrink allocated storage (100 GB, for a database expected to be a few GB), and the 2025 attempt (CO-7) failed on cross-stack exports. The plan replaces only the instance and copies the data with `pg_dump`/`pg_restore` in a write freeze. Data loss isn't part of it. What makes this possible is a **standalone** `rds.DatabaseProxy`: `dbInstance.addProxy` makes proxies children of the instance, so replacing the instance would change their exported endpoints. Other references to repoint (with old exports pinned via `exportValue`): `instanceIdentifier` (ObservabilityStack), `instanceResourceId` (MultimodalRagStack IAM, proxy role), and the admin secret name (owned by the instance construct, so it needs a new name).
- **Dev keeps the same infrastructure as prod, only smaller** (DB class, NAT instance size, warning-tier alarms). This rejects dev-only removals of WAF, monitoring or the proxy, because dev is where prod changes are rehearsed. Sizes go in one per-environment profile so that a size difference can't become a missing resource.

**Alternatives considered:** RDS Blue/Green to shrink storage (its interaction with RDS Proxy and CloudFormation is untested); full stack teardown (would destroy the Cognito user pool and buckets); removing WAF and alarms from dev (rejected by the "same infrastructure" decision).

## 2026-11-19 — Finding: PostgreSQL version pin, Extended Support enrollment, storage use, and the cost of RDS Proxy polling

- **The CDK pin `PostgresEngineVersion.VER_16_10` is no longer offered** in ca-central-1 (the oldest is 16.11). The live instances run 16.13 through `autoMinorVersionUpgrade`, so nothing is broken today, but **creating any new instance from this code fails**. That affects a new environment and the planned rebuild. Keep the pin on an offered version.
- **Prod is enrolled in RDS Extended Support** (`EngineLifecycleSupport: open-source-rds-extended-support`, the RDS default when it isn't set). Dev has it **disabled**, set outside CDK; drift detection doesn't flag it because the template doesn't set the property. PostgreSQL 16's standard support on RDS ends **2029-02-28**. After that, prod would pay Extended Support per vCPU-hour, roughly $150–160/mo for 2 vCPUs in years 1–2 and twice that in year 3. With it disabled, RDS upgrades the major version automatically at end of support instead. If that upgrade's pre-checks fail, it does charge. CDK 2.273 supports `engineLifecycleSupport` on `DatabaseInstance`. Standard support ends 2030-02-28 for 17 and 2031-02-28 for 18. RDS Proxy supports RDS for PostgreSQL 17; for RDS PG 18 it was unconfirmed (documented only for Aurora PG 18.3+).
- **The database is small, and most of the used disk is fixed overhead:** `FreeStorageSpace` shows ~5.9 GB used in prod and ~5.7 GB in dev, out of 100 GiB (~107.4 GB). **2.33 GB of it is WAL in both** (`TransactionLogsDiskUsage`). That comes from RDS defaults: `wal_keep_size` = 2 GB, and `archive_timeout` = 300 s forces a WAL file every 5 min even when idle. Log files are under 1 MB and there are no replication slots. The remaining ~3.3–3.5 GB is data, system databases and filesystem overhead. Prod is only ~0.2 GB larger than dev, so app data is likely a few hundred MB, not confirmed by SQL. October had no `ChargedBackupUsage`. The backup-storage CloudWatch metrics (`TotalBackupStorageBilled` etc.) are Aurora-only, so use Cost Explorer for backup charges.
- **RDS Proxy secret polling makes up about half of dev's CloudTrail events.** A 30-min sample had 343 of 718 events from it (`GetSecretValue` + KMS `Decrypt` by `rds.amazonaws.com`, about every 35 s per proxy). GuardDuty's CloudTrail analysis costs about the same in dev ($2.69) as prod ($2.56). Estimated full cost of the polling: ~$3/mo per account (Secrets Manager + GuardDuty + Security Lake), so a proxy costs about $27/mo rather than its $23.81 line.
- The prod maintenance window is `sat:09:38-sat:10:08` UTC. RDS assigned it, and it isn't set in CDK.

## 2026-11-19 — Decision: engineering choices for the cost plan

Details and alternatives are in `AWS_COST_OPTIMIZATION_PLAN.md`, sections 0 and 10.
- **The rebuild targets PostgreSQL 17**, with `engineLifecycleSupport` disabled. Standard support runs to Feb 2030, and RDS Proxy has supported RDS PG 17 since Nov 2024. PG 18 was set aside because RDS Proxy support for *RDS* PG 18 isn't documented (only Aurora 18.3+). Staying on 16 would have needed a separate upgrade before Feb 2029.
- **Self-managed NAT instance** in both accounts (`NatProvider.instanceV2`: `t4g.micro` prod, `t4g.nano` dev), replacing the NAT Gateway. Patching and minutes-long recovery are accepted. Removing the Secrets Manager and Bedrock interface endpoints follows.
- **Critical-tier alarms only**, in both accounts: all 43 warning-tier alarms are dropped. Problems are noticed only once they cross the critical threshold. The `SystemHealthCritical` composite must reference only critical alarms. **The dashboard is trimmed to ≤50 metrics** so it falls within CloudWatch's free tier.
- **Dev database stops outside working hours** (EventBridge Scheduler). A weekend test first checks whether RDS Proxy billing pauses while its target is stopped.
- **Dropped:** caching DB secrets in Lambdas ($0 saving; RDS Proxy makes 91–100% of the calls), and turning off API Gateway X-Ray (it would raise Security Hub APIGateway.3).

## 2026-11-19 — Decision: cost plan rollout is dev-first, and the dev hibernate switch is deferred

- **Dev first, then prod.** Every Phase 1 and Phase 2 change runs in dev first (Stage A). Prod follows only after a dev validation gate (Stage B): a full smoke suite, 5 working days without critical alarms, DLQ messages or Lambda errors, clean drift and diff, and the expected daily cost drops. Dev has no real load, so the gate is **functional only**. Performance is confirmed in prod against the guardrails, with in-place fallbacks (class change, Multi-AZ back on, NAT Gateway revert). Prod savings start a few weeks later as a result (Phase 1 is ~$128/mo); that's accepted. **Testing is manual**, using the plan's section 15 checklist: tester UI flows, each mapped to the Lambda and database user it exercises, plus engineer CLI checks. A full run happens before any change, so pre-existing dev failures aren't blamed on the plan. Dev has no other traffic, so the 5-day soak is bracketed by full runs. One thing testers must know: a chat answer that ignores the course material means retrieval failed silently.
- **The dev hibernate switch is deferred** to Phase 4 (Stage C), after both environments are stable. It's a `devPower=off|on` CDK flag that snapshots and removes dev's hourly resources (database, proxy, NAT, WAF, alarms) and restores them: ~$5/mo while off, an estimated ~25–40 min to turn on. **Full teardown was rejected as a switch:** the Amplify app ID is pinned in `constants/domains.ts` for the `ocelia-dev.arts.ubc.ca` redirect, the Cognito user pool is retained (redeploy means new users), and retained buckets and tables collide on redeploy. To keep the option cheap, P2.1 gives the new instance a fixed identifier and a standalone admin secret, and drops the `instanceResourceId` grants. Adding a fixed identifier later would force another instance replacement.

## 2026-11-19 — Decision: the idle Transit Gateway attachments stay

It's confirmed that the idle ca-west-1 Transit Gateway attachments can't be removed, in either prod (`arts-isit-prod-services`) or dev. They cost $44.64/mo each, and 0 bytes were carried. Track B items B1 and B3 in `AWS_COST_OPTIMIZATION_PLAN.md` are closed, and the plan's totals no longer assume removing them. That's ~$385/mo for both accounts after Phases 1–2, instead of ~$295. The attachments stay in the account baseline (~$104 prod, ~$68 dev); only the baseline split (B2) remains open. `AWS_BASELINE_COST_FINDINGS.md` now carries dated update notes; its original recommendation to delete the attachment is kept for the record.

## 2026-11-19 — Finding: Stage A prep (baselines, drift, API Gateway logging quirk)

- **Prod performance baselines** (30 days to 2026-11-19) are recorded in `AWS_COST_OPTIMIZATION_PLAN.md`, section 1. Chatbot p90 is 12.7 s, retrieval p90 2.05 s, and RDS ReadLatency 0 (all reads served from cache).
- **Dev matches the code:** `npm test` 42/42 suites (409 tests), and `cdk diff -c environment=dev` shows 0 differences across 7 stacks. For `cdk diff`, export SSO credentials (`aws configure export-credentials`) and unset `AWS_PROFILE`.
- **API Gateway stage quirk (prod and dev):** the template defines two `*/*` method settings: one from `deployOptions` (`metricsEnabled`, `loggingLevel: ERROR`) and one with the throttling limits. API Gateway merges them into a single entry, so throttling (100/s, burst 200) applies, but **execution-error logging and detailed metrics are off.** Drift detection reports this as drift on the stage. It's pre-existing and unrelated to the cost plan; fix it by merging the settings into one entry if the logs are wanted.
- **Alarm emails reach nobody, in prod or dev:** neither account's critical SNS topic has a subscription. The template's `EmailSubscription` ([observability-stack.ts:71]) was never confirmed, and SNS deleted it. Dev was re-subscribed with `aws sns subscribe` on 2026-11-19 and confirmed; prod hasn't been yet. The live subscription is created outside CloudFormation's view, so this needs re-checking whenever the topic is replaced.
- **The Amplify branch setup lives outside CDK:** dev's Amplify app has a hand-made `dev` branch (auto-build on), and the `ocelia-dev.arts.ubc.ca` domain association points at it. Prod builds `main`, and `ocelia.arts.ubc.ca` points at `main`. CDK defines only `addBranch("main")`, which in dev has auto-build turned off by hand. Neither the domain associations nor dev's `dev` branch are in CDK, and `AMPLIFY_DEFAULT_ORIGIN.dev` still names `main.<appId>`.
- **Other pre-existing dev drift:**
  - the dashboard tags are missing
  - Amplify `main` branch auto-build is off
  - the Amplify repository URL differs only in letter case, and the custom headers are a formatting false positive

## 2026-11-19 — Decision: include fixes F1–F3 in the cost plan rollout

These have no cost impact but were found during Stage A prep. All go dev first (`AWS_COST_OPTIMIZATION_PLAN.md`, section 5):
- **F1:** bring the hand-made Amplify setup into CDK (dev builds `dev`, prod builds `main`). Import dev's existing `dev` branch with `--import-existing-resources` if CloudFormation supports importing Amplify branches; otherwise leave it unmanaged. Never recreate it, because the custom domain is mapped to it. Also remove dev's unused `main` branch and point `AMPLIFY_DEFAULT_ORIGIN.dev` and the CORS list at `dev.<appId>`. The domain associations stay outside CDK.
- **F2:** restore the critical-topic email subscriptions. Dev was done 2026-11-19 (pending confirmation); prod is in Stage B.
- **F3:** merge the stage method settings into a single `/*/*` entry with throttling, `loggingLevel: ERROR` and an explicit `metricsEnabled: false` (detailed metrics have always been off and would add paid metrics). Create the execution log group in CDK with retention. Security Hub APIGateway.1 is FAILED on the stage in both accounts today.

## 2026-11-19 — Finding: orphaned S3 buckets in dev

Dev holds 24 orphaned `aila-apigatewaystack-*` buckets (8 sets each of chat logs, data ingestion and embeddings) and 6 `aila2-*` buckets. They're left behind by earlier deployments under `RemovalPolicy.RETAIN`. The current stack uses one of each (`describe-stack-resources` gives the physical names). Uploaded course documents end up in `aila-multimodalragstack-ir-bucket`, not the ingestion bucket, which is empty. The cost is negligible, but the leftovers may hold old chat logs and documents, so they're a data-retention question. Prod hasn't been checked. Not part of the cost plan.

## 2026-11-19 — Finding: retrieval tries to write to a cache it can only read

`ragRetrievalFunction` logs `EmbeddingCache put failed, continuing without cache store` (`AccessDeniedException` on `dynamodb:PutItem`) on every query, in prod (1,934 times in 30 days) and dev. The IAM is intentionally read-only for retrieval (`multimodal-rag-stack.ts`, "GetItem on EmbeddingCache table (read-only for retrieval)"), but `cache/embedding_cache.py` still calls `put`. It's harmless, because retrieval continues without caching, but it's noise in every log review. The fix is in the code (skip `put` in retrieval), not the IAM: query embeddings rarely repeat, so caching them would only grow the table. Not part of the cost plan.

## 2026-11-19 — Decision: drop P1.4 (budgets) and skip the step 0 baseline run

To simplify the rollout, the cost plan no longer creates its own AWS Budgets or Cost Anomaly Detection. Both accounts already have a $200/mo budget set up by others (prod's, "Arts ISIT Systems…", is permanently in alarm), and prod has someone else's per-service anomaly monitor. The `app` tag isn't an active cost allocation tag (linked accounts can't activate it), so a monitor limited to OCELIA's resources wasn't possible anyway. The step 0 full checklist run was also skipped, so the dev gate can no longer excuse a failure as "the same as before": every failure has to be fixed or explained.

## 2026-11-19 — Finding: Amplify branches can't be adopted with `--import-existing-resources`

`AWS::Amplify::Branch` supports CloudFormation import, but its only identifier is the read-only `Arn`. `--import-existing-resources` matches resources by name, so the change set shows the branch as **Add**, and deploying would fail because the branch already exists. What worked for dev's hand-made `dev` branch (Stage A step 1, F1):
1. Tag the live branch with the stack tags (`aws amplify tag-resource`), because an import doesn't apply tags.
2. Build an import template from the **deployed** template (`get-template --template-stage Original`) plus the synthesized branch resource, with `DeletionPolicy: Retain`.
3. `create-change-set --change-set-type IMPORT --resources-to-import` with `ResourceIdentifier: {Arn: ...}`, passing every stack parameter as `UsePreviousValue=true`. Check that it contains only the Import, then execute it.
4. Run the normal deploy for the remaining changes (here, deleting the unused `main` branch and changing the redirect source).

**Also found:**
- `cdk diff` (CLI 2.1145.0) rejects `--parameters`, so it can't build a change set for `AILA-AmplifyStack`, whose `githubRepoName` parameter has no default. It falls back to a template diff without saying why. Use `create-change-set` with `UsePreviousValue=true` to see the real change set, then delete it.
- **Branches are now `RemovalPolicy.RETAIN`.** The custom domains (outside CDK) are mapped to them, so taking a branch out of code must not delete it.
- **An API Gateway execution log group must use a literal stage name.** Referencing `deploymentStage.stageName` creates a cycle with the stage's dependency on the log group.
- **Change sets list a `SpecRestApi` with an `AWS::Include` body as modified** whenever the stack has other changes, even when the include location is unchanged.
