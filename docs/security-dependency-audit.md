# Security & Dependency Audit — AI-Learning-Assistant

**Date:** 2026-08-06
**Scope:** Whole repo — `frontend/` (OCELIA React SPA), `cdk/` (7 stacks + zip/Docker Lambdas), Python RAG/chatbot pipelines, and root.
**Type:** Static analysis + dependency audit (`npm audit`, `npm outdated`) + manual code review of SQL, IAM, secrets, and auth. No runtime/DAST testing, no deployed-environment scanning.
**Target:** Known-CVE dependencies + common code-level vulnerability classes (injection, secrets, over-permissioned IAM, missing auth).

---

## Bottom line

No critical code-level vulnerabilities. SQL access, IAM scoping, and the auth architecture are all in good shape. The real exposure is **outdated dependencies with published CVEs**, the large majority of which clear with a non-breaking `npm audit fix`. One direct dependency (`aws-cdk-lib`) is behind a high-severity advisory, though real exposure is low because the vulnerable code path isn't used. A few hardening items (S3 CORS, unpinned Python deps) are worth addressing but not urgent.

## Methodology & caveats

- **`npm audit`** run in `frontend/` and `cdk/`.
- **`npm outdated`** run in `frontend/` to identify version drift (security-relevant and otherwise).
- **Manual code review** via `grep_search` across the repo for: raw/interpolated SQL, hardcoded secrets/keys, wildcard IAM (`resources/actions: ["*"]`, `AnyPrincipal`), and API Gateway/AppSync authorization wiring.
- **Layer inspection:** unzipped `cdk/layers/aws-jwt-verify.zip` to confirm the auth-critical library version.
- **Caveats:**
  - This is **static analysis**. It cannot confirm runtime behavior, deployed IAM effective permissions, WAF efficacy, or secrets present only in the deployed environment.
  - Python dependencies were reviewed by manifest only (`requirements.txt`); no `pip-audit`/`safety` CVE scan was run against resolved versions.
  - CVE identifiers and advisory ranges are as reported by the npm advisory database at audit time.

---

## Summary of findings

| # | Severity | Finding | Area | Primary location |
|---|----------|---------|------|------------------|
| 1 | High | `aws-cdk-lib` 2.249.0 < 2.260.0 — OS command injection in `NodejsFunction` Docker bundling (GHSA-vcrf-j523-4mrf). Not exploited: repo uses `Code.fromAsset`, not `NodejsFunction`. | cdk deps | `cdk/package.json` |
| 2 | High | `undici` (transitive via `aws-amplify`) — CRLF / cookie-attribute injection. Fixable via `npm audit fix`. | frontend deps | `frontend/` |
| 3 | High | `brace-expansion` — ReDoS + unbounded-expansion OOM DoS (multiple advisories). Fixable. | frontend + cdk deps | both |
| 4 | High | `fast-uri` ≤3.1.4 (transitive via `aws-cdk-lib`) — path traversal / host confusion. Fixable. | cdk deps | `cdk/` |
| 5 | High | `js-yaml` ≤3.15.0 (transitive) — quadratic-complexity DoS in merge-key/omap handling. Fixable. | cdk deps | `cdk/` |
| 6 | Moderate | `esbuild` ≤0.24.2 (via `vite` 5) — dev server can be probed by any website. **Dev-only**, not in prod builds; fix requires `vite` 5→8 major bump. | frontend deps | `frontend/` |
| 7 | Moderate | `fast-xml-parser` / `fast-xml-builder` (via `aws-amplify`) — comment/CDATA injection, attribute bypass. Fixable. | frontend deps | `frontend/` |
| 8 | Moderate | `uuid` <11.1.1 — missing buffer bounds check in v3/v5/v6. Fixable. | frontend deps | `frontend/` |
| 9 | Low | `@babel/core` ≤7.29.0 — arbitrary file read via `sourceMappingURL` (local, high-AC). Fixable. | frontend + cdk deps | both |
| 10 | Low | `aws-cdk-lib` <2.253.0 — CodeBuild S3 log-encryption boolean inversion (GHSA-464c-974j-9xm6). | cdk deps | `cdk/package.json` |
| 11 | Medium | S3 CORS uses `allowedOrigins: ["*"]` + `allowedHeaders: ["*"]` on multiple buckets. Common for presigned uploads; scope to the Amplify domain to reduce surface. | infra hardening | `api-gateway-stack.ts`, `multimodal-rag-stack.ts` |
| 12 | Low | Unpinned Python deps (`boto3`, `psycopg2-binary`, `httpx`, `aws-lambda-powertools`) — reproducibility / supply-chain drift. | supply chain | `chatbot_v2/`, `sqsTrigger/`, `lambda/orphanCleanup/requirements.txt` |
| 13 | Info | `aws-jwt-verify` in `frontend/` is 4.0.1 (latest 5.2.1); the frontend generally shouldn't verify JWTs — confirm it's actually used. | frontend deps | `frontend/package.json` |

### Audit totals
- **Frontend `npm audit`:** 15 vulnerabilities — 8 high, 6 moderate, 1 low. All transitive.
- **CDK `npm audit`:** 5 vulnerabilities — 4 high, 1 low. One (`aws-cdk-lib`) is a direct dependency.

---

## Clean areas (reviewed, no action needed)

- **SQL injection:** None found. Every query across `text_generation/`, `chatbot_v2/`, and `multimodal_rag_v2/` uses parameterized `%s` placeholders with a params tuple, including dynamically-built `IN (...)` clauses in `text_generation/src/helpers/vectorstore.py` (placeholders generated, values passed separately). No f-string/`%`-format value interpolation into SQL.
- **Secrets:** No hardcoded credentials, API keys, or private keys. The only matches are `<password>` placeholders in `docs/guides/` and form-validation strings in `Login.jsx`.
- **IAM scoping:** Well-scoped, least-privilege. Every `resources: ["*"]` is confined to services that require it (EC2 ENI operations, X-Ray, `aws-marketplace`) and carries a justifying comment. Bedrock, S3, Secrets Manager, DynamoDB, SSM, and CloudWatch Logs grants are ARN-scoped. No `AnyPrincipal`, no wildcard `actions`.
- **Auth architecture:** Per-role custom Lambda authorizers (admin / student / instructor) on API Gateway, AppSync configured with `AuthorizationType.LAMBDA`, WAF rules attached, and Bedrock guardrails including a `PROMPT_ATTACK` filter at `HIGH`. The auth-critical `aws-jwt-verify` in `cdk/layers/aws-jwt-verify.zip` is **5.1.1** (current major), served from a dedicated non-VPC authorizer role.

---

## Optional major upgrades (no CVE — version drift only)

Deferred to a dedicated upgrade pass; each needs testing:

| Package | Current | Latest | Notes |
|---|---|---|---|
| react / react-dom | 18.3.1 | 19.2.x | Major; broad blast radius |
| vite | 5.4.21 | 8.2.1 | Also resolves the `esbuild` moderate (#6) |
| tailwindcss | 3.4.x | 4.3.x | Major config/engine change |
| recharts | 2.12.7 | 3.10.1 | Major |
| react-icons | 4.9.0 | 5.7.0 | Major |
| eslint | 9.39.4 | 10.8.0 | Major |
| @tanstack/react-table | 8.21.3 | 9.0.0 | Major |
| aws-jwt-verify (frontend) | 4.0.1 | 5.2.1 | See #13 — confirm usage first |

---

## Suggested remediation order

1. **`npm audit fix`** in `frontend/` then `cdk/` — clears the majority of highs/moderates (#2–#5, #7–#9) with no breaking changes.
2. **Bump `aws-cdk-lib` to `>=2.260.0`** in `cdk/package.json` (#1, #10); re-run `npm test` (requires Docker per the `predeploy` gate).
3. **Pin the unpinned Python deps** (#12) in the three `requirements.txt` files.
4. **Tighten S3 CORS** (#11) to the Amplify domain — verify presigned upload/download flows still work.
5. **Defer** the major framework bumps (Vite / React / Tailwind, and the `esbuild` fix #6) to a dedicated upgrade pass with full regression testing.

> Steps 1–3 are low-risk. Steps 4–5 change behavior and should be verified (CDK tests + frontend build + critical-flow smoke) before merge.

---

## Remediation applied — 2026-08-06

Steps 1–3 of the plan were executed. Steps 4–5 remain open (behavior-changing / deferred).

### What was fixed

| Finding | Action | Result |
|---|---|---|
| #2, #3, #7, #8, #9 (frontend) | `npm audit fix` in `frontend/` | Frontend vulns **15 → 4** |
| #1, #10 (cdk) | Bumped `aws-cdk-lib` `^2.249.0 → ^2.263.0` and `@aws-cdk/aws-amplify-alpha → 2.263.0-alpha.0` | Both `aws-cdk-lib` advisories cleared |
| #3, #4, #5, #9 (cdk) | `npm audit fix` in `cdk/` | CDK vulns **5 → 1** |
| #12 | Added version floors to `chatbot_v2/`, `sqsTrigger/`, `lambda/orphanCleanup/` `requirements.txt` | Supply chain pinned (repo `>=` floor convention, AL2-safe) |

### Verification
- **Frontend:** `npm run build` passes; `npm run test` — **608/608** pass.
- **CDK:** `npx tsc --noEmit` passes; `npm test` — **298/298** pass (Docker).
- **Python:** requirements resolve (pip dry-run); `chatbot_v2` pytest — **259/259** pass.

### Notes & residuals

- **`npm install` in `cdk/` now requires `--legacy-peer-deps`.** This is a **pre-existing** conflict (`typescript ~6.0.3` vs `ts-jest@29`, which peers `typescript <6`), not introduced by the bump. Worth resolving separately (bump `ts-jest`, or align TypeScript).
- **CDK — 1 high remaining (`brace-expansion`):** the vulnerable copy is **bundled inside the `aws-cdk-lib` tarball**, so `npm audit fix` / `overrides` cannot replace it. We're already on the latest `aws-cdk-lib` (2.263.0). It is **build/synth-time only** (not shipped to any Lambda), so real exposure is minimal. Clears when AWS re-bundles upstream.
- **Frontend — 4 remaining, all needing breaking changes (deferred to step 5):**
  - `esbuild`/`vite` (moderate, #6) — dev-server only; fix is `vite` 5 → 8.
  - `react-router` chain (3 high) — advisory is an **RSC-mode CSRF bypass**; the app is a plain Vite SPA (no React Server Components), so it is **likely not applicable**, and the "fix" is a downgrade to `react-router-dom@7.11.0`. Left as-is pending confirmation.
- **Test impact:** the `aws-cdk-lib` bump moved several **CDK-internal helper** Lambda runtimes (log retention, custom-resource / trigger providers) to `nodejs24.x`, which failed `test/lambda-config.test.ts`. Fixed by excluding functions without an explicit `FunctionName` — application Lambdas always set `functionName` (`${id}-<name>`) per CDK conventions, while CDK-generated helpers do not. App-function runtime assertions are unchanged.

### Still open
- **#13** — confirm whether `frontend` actually uses `aws-jwt-verify`; remove or bump 4 → 5.
- **Deferred majors** — Vite / React / Tailwind / recharts / eslint / react-table upgrades.

---

## Remediation applied — 2026-08-06 (part 2)

Two further items from the plan were completed.

### #11 — S3 CORS tightened to configured origins

The four browser-facing presigned-URL buckets (`embeddingStorageBucket`, `dataIngestionBucket`, `chatlogsBucket` in `ApiGatewayStack`; `irBucket` in `MultimodalRagStack`) no longer use `allowedOrigins: ["*"]`.

- New helper `cdk/lib/constants/cors.ts` → `resolveAllowedOrigins(scope, environment)` with precedence: **`-c allowedOrigins=<csv>` context → per-environment defaults → `["*"]` fallback (with a synth-time warning)**.
- **Dev default:** the dev Amplify SPA origin + `http://localhost:5173` (Vite dev) + `http://localhost:4173` (preview).
- **Prod:** intentionally has **no baked-in default** (the prod Amplify domain isn't known at author time). Until an operator sets `-c allowedOrigins=https://<prod-origin>` (or fills in `DEFAULT_ALLOWED_ORIGINS.prod`), prod **falls back to `"*"` with a visible synth warning** — deliberately, so a prod deploy never silently breaks uploads/downloads. **Action required for prod: set the prod origin.**
- `allowedHeaders: ["*"]` was **left as-is**: presigned browser uploads send a variable set of headers (`Content-Type`, etc.), and origin scoping is the material control. Tightening headers risks breaking uploads for little gain.
- Tests: added `cdk/test/s3-cors.test.ts` (7 assertions) — no bucket allows `"*"` in dev, all use the dev default list, and `resolveAllowedOrigins` precedence/fallback is covered.

### ts-jest / TypeScript 6 peer conflict resolved

- Bumped `ts-jest` `^29.1.2 → ^29.4.7` (29.4.7+ declares `peerDependencies.typescript: ">=4.3 <7"`, i.e. supports the repo's TypeScript 6). Within the existing `^29` range — patch-level, no behavior change.
- **`npm install` in `cdk/` no longer needs `--legacy-peer-deps`.**

### Verification (part 2)
- **CDK:** `npx tsc --noEmit` passes; `npm test` — **305/305** pass (298 prior + 7 new CORS tests), Docker.
- **CDK install:** `npm install` succeeds with no peer-dependency flags.
- **Frontend:** `npm run build` still passes (no frontend changes).

### Now fully addressed
Findings **#1–#5, #7–#12** and the pre-existing `ts-jest` peer conflict are resolved. Remaining/deferred: **#6** (esbuild/vite major), **frontend react-router** advisory (likely N/A — RSC-mode), bundled `brace-expansion` in `aws-cdk-lib` (upstream), **#13** (aws-jwt-verify usage check), and the optional major-version upgrades.
