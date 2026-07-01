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

## Deploy History & Gotchas
- Docker must be running before any deploy/synth: the `predeploy` hook runs `npm test`, which builds 5 container images. No Docker -> immediate failure. Never bypass `predeploy`. [Active]
- `npm run deploy` = test + `cdk deploy --all`; `--all` respects the stack dependency order. Targeted single-stack redeploys must honor that order (graph in `project-overview.md`). [Active]

## Known Bugs & Workarounds
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
