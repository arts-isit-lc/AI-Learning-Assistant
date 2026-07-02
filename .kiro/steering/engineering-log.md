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

- ADR-002 · 2026-07-01 · Accepted · Recurring multimodal/chatbot bugs are all the same shape — "two paths that should agree, don't" (display vs persist vs grounding; canonical vs projection; ranker score vs display gate) — and the ~841 tests are unit/mocked, so they pass while the seams break -> future work must add a handler-level integration-test layer (real chatbot handler + retrieval→display→persist→reload, AWS/Bedrock mocked) and fix at the seam, not the symptom. Full audit: `.kiro/specs/multimodal-chatbot-audit/findings.md`.

## Deploy History & Gotchas
- Docker must be running before any deploy/synth: the `predeploy` hook runs `npm test`, which builds 5 container images. No Docker -> immediate failure. Never bypass `predeploy`. [Active]
- `npm run deploy` = test + `cdk deploy --all`; `--all` respects the stack dependency order. Targeted single-stack redeploys must honor that order (graph in `project-overview.md`). [Active]

## Known Bugs & Workarounds
Full audit (2026-07-01): see `.kiro/specs/multimodal-chatbot-audit/findings.md` for the ranked list + fix order. HIGH items below.
- [AUDIT H1][Active] Adaptive-learning loop inert on normal sessions: `chatbot_v2/main.py` gates evaluation on `interactions > 0`, but `interactions` only increments inside `state_machine.update_state`, which only runs when evaluation ran → never bootstraps. Evaluation / stage-advancement / module-completion never happen on non-math chats. Fix: increment interactions once per turn before the eval gate. (verified by read)
- [AUDIT H2/H3][Active][Security] IDOR: `GET /student/get_messages` has no session-ownership check (any student can read any session by id); `GET /student/figure_url` Strategy 3 presigns arbitrary `courses/`/`images/` keys with no enrollment check. Fix: enforce ownership/enrollment on both.
- [AUDIT H4/H5][Active] Enrichment data loss: TEXT enrichment cache collapses multi-chunk elements (shared content_hash + version-only sort key → last chunk wins); embedding failures are skipped, then `_store_in_pgvector` DELETE+commits with possibly zero inserts and marks status "complete" (Titan throttling can wipe a file's index).
- [AUDIT H6][Active] Tables/formulas have the same display-vs-grounding gap fixed for figures today — selected after generation, not grounded → the LLM can disclaim a table/formula it displays.
- [AUDIT M15][Active] `retrieval_id` is uuid4 (non-deterministic): re-ingesting a file changes all ids, so persisted `message_blocks` figure ids + figure_url resolution go stale after re-ingestion (undermines the history-reload fix). Fix: deterministic retrieval_id.
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
