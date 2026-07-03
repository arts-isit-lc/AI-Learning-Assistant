---
inclusion: manual
---

# Engineering Log

Durable operational memory for this repo: decisions, deploy scars, workarounds, and
environment facts that are expensive to rediscover and are not already captured in code.

## How to use
- Load before: deploys, incident triage, architecture decisions, Bedrock/model changes, DB/schema changes.
- Inclusion test before adding an entry: *"Would future-me waste time or repeat a mistake without this?"* If it already lives in code or steering, link to it — do not copy it here.
- Knowledge ownership: **steering** = rules to follow · **engineering-log** = decisions & scars · **specs** = current work.
- Conventions: ISO dates; newest-first within each section; decisions get stable IDs `ADR-NNN`; status tags `[Active]` / `[Resolved YYYY-MM-DD]` / `[Superseded by ADR-NNN]`.
- Security: never store secrets, credentials, connection strings, or raw account numbers. Reference secrets by their Secrets Manager path. Keep entries 2-6 lines; link to code/PRs/commits instead of pasting.
- Maintenance: supersede rather than delete; move resolved/superseded items to `## Archive`; keep the file skimmable (~400 lines).

## Architecture Decisions (ADR-lite)
Format: `ADR-NNN · date · status · context -> decision -> consequences`
- ADR-001 · 2026-07-01 · Accepted · `figma-to-code.md` hardcoded design tokens that had drifted from the real theme (listed primary `#2563eb`; actual `#5536DA`) -> made code (`index.css` / `tailwind.config.js` / `Theme.jsx`) the single source of truth for token values; steering now points to it. Consequence: no token values duplicated in steering.

- ADR-002 · 2026-07-01 · Accepted · Recurring multimodal/chatbot bugs are all the same shape — "two paths that should agree, don't" (display vs persist vs grounding; canonical vs projection; ranker score vs display gate) — and the ~841 tests are unit/mocked, so they pass while the seams break -> future work must add a handler-level integration-test layer (real chatbot handler + retrieval→display→persist→reload, AWS/Bedrock mocked) and fix at the seam, not the symptom. Full audit: `.kiro/specs/multimodal-chatbot-audit/findings.md`. **Update 2026-07-01: implemented** — `chatbot_v2/src/test_handler_integration.py` (real `main.handler()`, only AWS/Bedrock/DB IO stubbed) + `test_persist_turn.py`; all audit findings resolved or deferred-with-rationale (see findings.md "Resolution Status").

- ADR-003 · 2026-07-01 · Accepted · Render `message_blocks` (figures/tables/formulas) live in RDS (`Messages.message_blocks`) + the transient SQS projection payload, but the DynamoDB canonical log is text-only (audit M13) -> declare **RDS the authoritative store for message_blocks**; DynamoDB stays the canonical text/history log used for model replay. Consequences: a dropped RDS projection loses blocks (not text); history reload reads blocks from `Messages.message_blocks`; do NOT add a DynamoDB→RDS block rebuild that could resurrect stale blocks.

- ADR-004 · 2026-07-02 · Accepted (pending production validation) · runtime per-query vision ("escalation") added ~5.5s/figure-turn and duplicated ingestion-time perception -> **move perception to ingestion (rich, verbatim-faithful, structured), retrieve+interpret at runtime, keep live vision as a rare feature-flagged fallback**. Offline v2 + Track B eval: stored perception matches/beats live across question categories, and transcription closes the label gap (the weakness was representational, not architectural). Consequences: ENRICHMENT_VERSION bump + corpus backfill, richer stored schema, simpler/faster runtime (~5s off figure turns), flagged fallback. Gate: **Track A production-validation study before implementation.** Full ADR + evidence + design: `.kiro/specs/chatbot-latency-optimization/` (`ADR-perception-at-ingestion.md`, `findings.md`, `production-design.md`).

## Deploy History & Gotchas
- Docker must be running before any deploy/synth: the `predeploy` hook runs `npm test`, which builds 5 container images. No Docker -> immediate failure. Never bypass `predeploy`. [Active]
- `npm run deploy` = test + `cdk deploy --all`; `--all` respects the stack dependency order. Targeted single-stack redeploys must honor that order (graph in `project-overview.md`). [Active]

## Known Bugs & Workarounds
Full audit (2026-07-01): `.kiro/specs/multimodal-chatbot-audit/findings.md` (ranked list + per-finding "Resolution Status").
- [AUDIT][Resolved 2026-07-01] All 6 HIGH + most MEDIUM/LOW findings fixed at the seam, with tests: chatbot orchestration (H1 loop, persistence, streaming, response-shape parity), retrieval/grounding (figures+tables+formulas, score-scale, figure-ref exactness), enrichment data-loss (TEXT cache, embedding-wipe guard, caption over-match), IDOR ×3 (`get_messages`, `figure_url`, `deleteLastMessage`), display (TableBlock, FigureImage). Handler-level seam tests added (see ADR-002). Verified: 885 py + 3 (deleteLastMessage) + 6 jest + ESLint + py_compile.
- [AUDIT M15][Active] `retrieval_id` is uuid4 (non-deterministic): re-ingesting a file changes all ids, so persisted `message_blocks` figure ids + `figure_url` resolution go stale after re-ingestion. DEFERRED (risky multi-site change); mitigated by the wipe-and-restart workflow. Revisit if incremental re-ingestion becomes routine.
- [AUDIT deferrals][Active] Intentionally NOT changed (rationale in findings.md): L9 IR dedup stays content-only (provenance-aware would keep header/footer noise); L10 no version-scoped GC (needs migration/backfill design); L3/L4/L5 enrichment perf (share conn/secret, parallel embeds, dedup Haiku topic-extraction) — cold-path perf not worth the added risk; L8 query-analyzer keyword lists are curated on purpose (not a bug).
- `grep_search` is unreliable in this workspace (returned "no matches" for `interactions`, `CREATE TABLE`, `githubRepoName` that demonstrably exist) — verify with read_code / read_file, not grep. [Active]
- psycopg2 import fails in Lambda when the layer was built on Apple Silicon -> psycopg2 is platform-specific and Lambda runs x86_64 -> rebuild from `cdk/`: `./build_layer_x86.sh` (Docker `--platform linux/amd64`, py3.11 -> `layers/psycopg2-py311.zip`). Re-run on Python-runtime or dependency change. [Active]
- `retrieval_units.file_id` must be TEXT, not UUID: the retrieval scope filter binds `file_id = ANY(%s)` as a text[] with no cast, and Postgres has no `uuid = text` operator, so a UUID column makes every scoped vector/BM25 query raise UndefinedFunction and retrieval silently returns nothing. `initializer.py` keeps it TEXT and repairs legacy UUID columns in place. See the `cross-module-file-referencing` spec §4.4. [Active]
- Bumping `IR_VERSION` / `ENRICHMENT_VERSION` / `EMBEDDING_VERSION` in `multimodal_rag_v2` invalidates the corresponding DynamoDB caches -> expect reprocessing cost/latency on next ingestion. [Active]

## AWS Accounts & Environments
- StackPrefix: `AILA`. Environments: `dev` | `prod` — selected via CDK context (`-c StackPrefix=... -c environment=dev|prod`).
- Account + region are env-derived at deploy time (`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`, see `bin/cdk.ts`), not pinned in code.
- Region: `ca-central-1`. Accounts (last-4; full IDs in `cdk.context.json`): dev = `…0264` (SSO profile `vincent.adm-dev2`), prod = `…4162` (SSO profile `vincent.adm.prod2`).
- Bedrock access is per-account (Anthropic first-time-use approval, once per account) — track which accounts have model access enabled.

## Bedrock Configuration
- Models in use: **Llama 3 70B Instruct** (Meta, default) + **Claude 3 Sonnet** (Anthropic). Version-pinned IDs are owned by `text_generation/src/constants/llm_models.py` (`DEFAULT_LLM_MODEL_ID` = Llama 3 70B) and `frontend/src/constants/llmModels.js` — keep the two in sync. `Courses.llm_model_id` defaults to the Llama 3 70B id.
- Adding a model: follow "Adding a Bedrock Model" in `cdk-conventions.md`. Third-party models (Anthropic/Cohere/AI21) need Marketplace subscribe perms; Amazon/Meta models do not.
- Record observed quotas/throttling and any provisioned-vs-on-demand choices here.
- Chatbot response latency (measured via CloudWatch 2026-07-02): breakdown is (1) **image escalation** (vision) inside retrieval's reason step and (2) **generation TTFT**. Escalation now runs its ≤2 vision calls in PARALLEL (`ESCALATION_MAX_IMAGES`, default 2, `image_escalation._analyze_images`) → figure-query escalation ~5–7s → ~2–4s. Generation TTFT is 4.4–9.5s even on the first turn — and the injected RAG context measured only **~250–640 tokens** (`Context build complete.total_token_count`), so TTFT is NOT prefill/context-size bound (an earlier "trim the context" hypothesis was wrong — do not chase it). **TTFT root cause CONFIRMED = the synchronous streaming Bedrock Guardrail** (not prefill, not base model latency). A/B via the `STREAM_GUARDRAIL_DISABLED` diagnostic (2026-07-02, dev): TTFT **guardrail ON avg ~8.1s / median 7.8s (n=12) vs OFF avg ~1.3s / median 1.1s (n=3)** — a ~6.8s / ~6× gap — and ON-TTFT does NOT track `input_tokens` (728→11.5s, 1175→12.0s, 911→4.2s). Mechanism: Bedrock guardrails default to SYNCHRONOUS stream mode (buffer+scan chunks before the first token); ASYNCHRONOUS streams immediately and scans in the background ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-streaming.html)). **Fix path (keep the guardrail): switch to async stream mode** — but `invoke_model_with_response_stream` has no top-level stream-mode param and Claude's Messages API rejects the `amazon-bedrock-guardrailConfig` body key (see `streaming.py` comment), so async requires migrating the streaming call to **`converse_stream`** (`guardrailConfig.streamProcessingMode` enum `sync|async`, confirmed via botocore 1.43.34). Repeatable A/B now wired: `cdk deploy -c streamGuardrailDisabled=true` (DEV-only, prod-gated — `multimodal-rag-stack.ts` + `test/stream-guardrail-toggle.test.ts`). Retrieval-side optimization flags (`RAG_RETURN_PASSAGES` etc.) + `PARALLEL_EVAL_RETRIEVAL` + `CACHE_MODULE_METADATA` are already on. Model swap is not an option (ca-central-1 grants only Claude 3 Sonnet + Haiku). [Active]
- [Enhancement][Active] True "compare figure 4.1 vs figure 4.2" doesn't analyze both figures: `query_analyzer` extracts only the FIRST reference (`_FIGURE_LOOKUP_PATTERN.search`) and `QueryIntent.figure_reference` is single-valued, so escalation looks up one figure. Generic "compare the two diagrams" (no numbers) DOES analyze two (Strategy 2 top-2). Fixing specific-figure comparison needs multi-figure extraction + a list-valued figure_reference + multi-lookup — deferred (out of scope for the latency pass).

## Database Schema Notes
- Engine: RDS Postgres via RDS Proxy (`sslmode=require`). Extensions: `uuid-ossp`, `vector` (pgvector).
- Authoritative schema + migrations: `cdk/lambda/initializer/initializer.py` (SQL embedded in `sqlTableCreation`), run **once at deploy** by the DBFlowStack `TriggerFunction` (`initializer.handler`). Idempotent (`CREATE ... IF NOT EXISTS`, guarded `ALTER` / `DO $$` blocks). No `.sql` files or ORM migrations — this file is the single source of truth.
- Roles created by the initializer: `readwrite` (app CRUD) and `tablecreator`; credentials are generated at init and written to Secrets Manager (user + tablecreator secrets; admin secret used once). Never store those values here.
- Core tables: Users, Courses, Course_Concepts, Course_Modules, Enrolments, Module_Files, Student_Modules, Sessions, Messages, User_Engagement_Log, chatlogs_notifications, Module_File_References.
- Vector table `retrieval_units`: `embedding vector(1024)` (matches EMBEDDING_VERSION `titan-v2-1024`), HNSW cosine index (`vector_cosine_ops`; degrades to exact KNN on pgvector < 0.5.0), BM25 `ts_vector` gin index, `file_id`/`module_id` TEXT scope columns (see the file_id scar above).
- Caches: DynamoDB (embedding + enrichment caches, `multimodal_rag_v2`).

## Operational Runbooks
- Deploy (dev) -> from `cdk/`, after `aws sso login --profile vincent.adm-dev2` (only when the SSO session expired): `AWS_PROFILE=vincent.adm-dev2 npm run deploy`. Runs `npm test` (predeploy) then `cdk deploy --all -c environment=dev --parameters AILA-AmplifyStack:githubRepoName=AI-Learning-Assistant`; `StackPrefix=AILA` comes from `cdk.json`. The profile must have `region=ca-central-1`.
- Deploy (prod) -> from `cdk/`, after `aws sso login --profile vincent.adm.prod2`: `AWS_PROFILE=vincent.adm.prod2 npm run deploy:prod` (gated by `npm test`; `-c environment=prod`, same `StackPrefix=AILA` + repo param). Legacy manual flow (unset + `aws configure export-credentials` + manual `CDK_DEFAULT_*`) is superseded by `AWS_PROFILE` + these npm scripts.
- Tail / query CloudWatch logs (debug) -> ensure a live session first (`aws sso login --profile <profile>`); always pass `--profile` + `--region ca-central-1` (a non-interactive shell won't inherit an exported `AWS_PROFILE`). Profiles: dev `vincent.adm-dev2`, prod `vincent.adm.prod2`. PowerUserAccess covers logs read.
  - List groups: `aws --profile vincent.adm-dev2 --region ca-central-1 logs describe-log-groups --query 'logGroups[].logGroupName' --output text`
  - Live tail: `aws --profile vincent.adm-dev2 --region ca-central-1 logs tail /aws/lambda/AILA-ApiGatewayStack-studentFunction --follow`
  - Recent + filter: `... logs tail <group> --since 2h --filter-pattern '{ $.level = "ERROR" }'` (Powertools logs are JSON; plain `--filter-pattern ERROR` also works). For aggregations use Logs Insights (`logs start-query` / `get-query-results`).
  - Prod: identical commands with `--profile vincent.adm.prod2`.
  - Access is contingent on a live SSO session (can't self-re-auth). Pull scoped windows/filters; never bulk-dump — log contents may hold PII/secrets.
- Rebuild psycopg2 layer -> from `cdk/`: `./build_layer_x86.sh`.
- Add a Bedrock model -> follow `cdk-conventions.md` steps, then log the account/region enabled here.
- Recover from failed predeploy -> ensure Docker is running, then re-run `npm test` in `cdk/`.
- Apply a DB schema change -> edit `initializer.py` (idempotent SQL) and redeploy DBFlowStack; its `TriggerFunction` re-runs the initializer on deploy.
- Safely redeploy a single stack -> honor the dependency order (project-overview); deploy upstream stacks first if their outputs changed.

## Glossary
- AILA — StackPrefix / project shorthand (AI Learning Assistant).
- Roles — Admin, Instructor, Student.
- `multimodal_rag_v2` — 4-layer RAG pipeline (ingestion -> enrichment -> retrieval -> reasoning).
- `chatbot_v2` — structured-learning chatbot. `math_compute` — SymPy compute Lambda. `text_generation` — LangChain generation Lambda.
- DBFlow — DBFlowStack; deploys after ApiGatewayStack, before AmplifyStack; runs the DB initializer.

## Archive
<!-- move [Resolved] / [Superseded] entries here to keep the sections above skimmable -->
