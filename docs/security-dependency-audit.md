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

### aws-cdk CLI bumped to match aws-cdk-lib (deploy-blocking follow-up)

The `aws-cdk-lib` 2.263.0 bump made the app emit **cloud-assembly schema v54**, which the pinned CLI (`aws-cdk` 2.1118.2, max schema v53) could not read — `cdk deploy` failed with *"CDK CLI is not compatible with the CDK library... You need at least CLI version 2.1135.0"*. Bumped the `aws-cdk` devDependency **2.1118.2 → 2.1135.0**. Verified with `npx cdk ls -c environment=dev` (synths + lists all 7 stacks, no schema error). Takeaway: keep the `aws-cdk` CLI and `aws-cdk-lib` versions in step.

### ts-jest / TypeScript 6 peer conflict resolved

- Bumped `ts-jest` `^29.1.2 → ^29.4.7` (29.4.7+ declares `peerDependencies.typescript: ">=4.3 <7"`, i.e. supports the repo's TypeScript 6). Within the existing `^29` range — patch-level, no behavior change.
- **`npm install` in `cdk/` no longer needs `--legacy-peer-deps`.**

### Verification (part 2)
- **CDK:** `npx tsc --noEmit` passes; `npm test` — **305/305** pass (298 prior + 7 new CORS tests), Docker.
- **CDK install:** `npm install` succeeds with no peer-dependency flags.
- **Frontend:** `npm run build` still passes (no frontend changes).

### Now fully addressed
Findings **#1–#5, #7–#12** and the pre-existing `ts-jest` peer conflict are resolved. Remaining/deferred: **#6** (esbuild/vite major), **frontend react-router** advisory (likely N/A — RSC-mode), bundled `brace-expansion` in `aws-cdk-lib` (upstream), **#13** (aws-jwt-verify usage check), and the optional major-version upgrades.

---

## Remediation applied — 2026-08-06 (part 3): logRetention → explicit LogGroups

Follow-up to the `aws-cdk-lib` 2.263.0 bump, which surfaced a deprecation warning: `aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated`.

### What changed
All **27** application Lambdas (21 in `ApiGatewayStack`, 6 in `MultimodalRagStack`) were migrated off the deprecated `logRetention` prop to an explicit `logs.LogGroup` passed via `logGroup:`. Each stack got a local `makeLogGroup(functionName)` helper that creates:

- `logGroupName: /aws/lambda/<functionName>` — **must** match Lambda's default name so the existing IAM log-group scoping and the ObservabilityStack alarms/metric filters keep resolving.
- `retention: logRetention` — unchanged values (dev 30 days, prod 90 days).
- `removalPolicy: DESTROY` — matches prior ephemeral-in-dev behavior.

This also removes the CDK `Custom::LogRetention` custom resource (and its helper Lambda) from the synthesized templates.

### Verification
- `npx tsc --noEmit` clean; `npm test` — **306/306** pass (rewrote `test/log-retention.test.ts` to assert explicit `/aws/lambda/*` LogGroups with the right retention and **zero** `Custom::LogRetention` resources).
- `npx cdk ls -c environment=dev` — **0** `logRetention is deprecated` warnings (was ~20+).

### ⚠️ Required one-time step before the next deploy (deploy-blocking)

The log groups `/aws/lambda/AILA-*Stack-*` already exist in the account (created at runtime by the old custom resource). CloudFormation will now try to **create** them as managed resources and fail with `ResourceAlreadyExists` unless they're removed first.

**Dev (Option A — brief log loss, acceptable):** after `aws sso login`, before `npm run deploy`:

```bash
REGION=ca-central-1
for prefix in AILA-ApiGatewayStack AILA-MultimodalRagStack; do
  aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/$prefix-" --region "$REGION" \
    --query 'logGroups[].logGroupName' --output text \
  | tr '\t' '\n' | while read -r lg; do
    [ -n "$lg" ] && aws logs delete-log-group --log-group-name "$lg" --region "$REGION" \
      && echo "deleted $lg"
  done
done
```

Then `npm run deploy`. After this deploy CloudFormation owns the groups, so subsequent deploys need no cleanup.

**Prod (no log loss):** do **not** run the delete. Instead bring the existing groups under management via **CloudFormation resource import** during a maintenance window (or accept a one-off deletion). Track separately before promoting to prod.

---

## Remediation applied — 2026-08-06 (part 4): CLI bump + deprecated-API cleanup

Follow-ups discovered while deploying the `aws-cdk-lib` 2.263.0 upgrade.

### aws-cdk CLI schema mismatch (deploy-blocking)
`aws-cdk-lib` 2.263.0 emits cloud-assembly **schema v54**, which the pinned CLI (`aws-cdk` 2.1118.2, max v53) couldn't read (`cdk deploy` failed: *"You need at least CLI version 2.1135.0"*). Fixes:
- Bumped the `aws-cdk` devDependency **2.1118.2 → 2.1135.0** (project-local CLI, used by `npm run deploy`).
- Upgraded the developer's **npm-global** CLI the same way (`npm install -g aws-cdk@2.1135.0`) — it turned out to be an npm-global package symlinked under `/opt/homebrew/bin`, not a Homebrew formula. Global and project-local now match.
- **Takeaway:** keep the `aws-cdk` CLI and `aws-cdk-lib` versions in step, and prefer `npm run deploy` (uses the git-pinned CLI) over a bare `cdk deploy` (uses whatever is global).

### Cross-stack reference strength warning
2.263.0 introduced the `@aws-cdk/core:defaultCrossStackReferences` feature flag. Set it explicitly to `"strong"` in `cdk.json` to lock in current producer-protecting behavior (zero functional change) and silence the warning.

### Deprecated `addDependency` APIs
Renamed to their non-deprecated equivalents (confirmed drop-in renames in the aws-cdk-lib type defs — identical behavior):
- `bin/cdk.ts` — 3× `Stack#addDependency` → `addStackDependency` (multimodalRag→db, api→multimodalRag, observability→api).
- `api-gateway-stack.ts` — 1× `CfnResource#addDependency` → `addResourceDependency` (guardrail version → guardrail).

### Verification
- `npx tsc --noEmit` clean; `npm test` — **306/306** pass.
- `npx cdk ls -c environment=dev` — **0** `logRetention is deprecated`, **0** `addDependency is deprecated`, and **0** cross-stack-reference warnings. (The remaining "Deploying with new VPC…" line is an informational `console.log` in the VPC stack, not a deprecation.)
- Deploy to dev succeeded after the one-time log-group cleanup (part 3).

---

## Remediation applied — 2026-08-06 (part 5): frontend vulns fully cleared (React 19 + Router 8)

Closes the last open frontend findings (#6, react-router chain, #13). **Frontend `npm audit` is now `found 0 vulnerabilities`.**

### aws-jwt-verify removed (#13)
Confirmed imported nowhere in `frontend/` (JWT verification is server-side, CDK layer 5.1.1) — removed the dead dependency.

### esbuild (moderate, #6) — vite 5 → 8
Bumped `vite` 5 → 8.2.1 and `@vitejs/plugin-react` 4 → 6 (vitest 4 already supports vite 8; config is data-mode SPA, no SSR). Also modernized `vite.config.js` (`__dirname` → `import.meta.url`) to clear a vite-8 native-configLoader warning.

### react-router chain (2 high, RSC-mode CSRF) — the "proper" fix required React 19
`react-router-dom` topped out at 7.18.2 (→ vulnerable `react-router@7.18.2`); the fix only exists forward in `react-router@8.2.1+`, which **removed `react-router-dom`** and **hard-requires React 19.2.7+ / Node 22.22+**. Per decision (Option B) we did the full migration rather than risk-accept or downgrade:

- **React 18.3.1 → 19.2.8** (`react`, `react-dom`, `@types/react`, `@types/react-dom`). No code changes needed — swept for every React 19 removal (`defaultProps`/`findDOMNode`/`ReactDOM.render`/legacy context/string refs/`react-dom/test-utils`): none present. The only `propTypes` use is the `ErrorBoundary` **class** component (React 19's removal is function-components-only) — harmless, left as-is.
- **recharts 2.12.7 → 2.15.4** — React 19 support landed in recharts 2.15.0, so a *minor* bump avoided the recharts 3.x breaking API. Radix UI already peered React 19 (no churn).
- **react-router 7 → 8.3.0**, `react-router-dom` uninstalled. Imports rewritten across ~68 files: everything from `react-router`, except `RouterProvider` which moves to `react-router/dom` (`AppV2.jsx` + `UnsavedChangesPrompt.test.jsx`). Data-mode APIs (`createBrowserRouter`, `createRoutesFromElements`, `useBlocker`, hooks) all carry over; no `meta`/`loaderData` usage, so that breaking change doesn't apply.
- **Amplify build Node pin** — `amplify-stack.ts` buildSpec `preBuild` now runs `nvm install 22 && nvm use 22` (+ `frontend/.nvmrc` = 22) so the cloud build satisfies vite 8 / RR8's Node ≥ 22.22. **Requires an `AmplifyStack` redeploy.**

### Verification
- **Frontend:** `npm run build` ✓, `npm run test` **608/608** ✓, `npm run lint` **0 errors**, `npm audit` **0 vulnerabilities**, Playwright style-guide render smoke ✓ (the 3 auth-gated smokes skip without Cognito test creds — environment limitation).
- **CDK:** `npx tsc --noEmit` ✓, `npm test` **306/306** ✓ (amplify-stack buildSpec change).

### Final audit state
- **Frontend: 0 vulnerabilities.**
- **CDK: 1 high remaining** — `brace-expansion` **bundled inside the `aws-cdk-lib` 2.263.0 tarball** (build/synth-time only, never deployed). Not reachable by `npm audit fix`/`overrides`; already on latest `aws-cdk-lib`. Genuinely upstream-only — clears when AWS re-bundles. This is the sole remaining item and is **not actionable from this repo**.

---

## Hygiene sweep — 2026-08-06 (part 6): in-range updates + dead-dep cleanup

Post-migration "are we current, secure, and clean" pass. No new vulnerabilities; routine currency + cleanup only.

### Security state (re-confirmed)
- **Frontend: `npm audit` = 0 vulnerabilities.**
- **CDK: 1 high** — `brace-expansion` bundled in the `aws-cdk-lib@2.263.0` tarball (build/synth-time only, upstream-fix-only, not reachable via `npm audit fix`/overrides). Unchanged; the sole non-actionable item.

### In-range dependency updates (`npm update`, no major crossings)
- **Frontend:** Radix UI → 1.1.23 / 2.x latest, `@tanstack/react-query`(+devtools) → 5.101.4, `aws-amplify` → 6.20.0, `react-hook-form` → 7.84.0, `@hookform/resolvers` → 5.7.1, `@playwright/test` → 1.62.1, `@testing-library/user-event` → 14.6.3, eslint plugins (`react`, `react-refresh`), `autoprefixer`, `katex`, `ldrs`, `postcss`. `package.json` caret ranges unchanged; only resolved (lockfile) versions bumped.
- **CDK:** `constructs` → 10.8.1, `yaml` → 2.9.0, `@types/node` (in-range). `aws-cdk-lib` intentionally held at 2.263.0 (a bump would re-raise the cloud-assembly schema and require another CLI bump).

### Dead-dependency cleanup
- Removed **`prop-types`** — after the React 19 upgrade its `propTypes` validation no longer runs, and its only use was `ErrorBoundary.jsx` (a class component). Converted the per-prop notes to a JSDoc `Props:` block on the class (matches the repo's "JSDoc for typed models" convention) and uninstalled the package. 0 residual references.

### Migration cleanliness (verified)
Repo-wide: **zero** lingering `react-router-dom` or `aws-jwt-verify` references (src, e2e, config); the `RouterProvider`-from-`react-router/dom` split is correct in the two files that need it.

### Verification
- **Frontend:** build ✓, **608/608** tests ✓, lint **0 errors** (warnings 43 → 23 after the eslint-plugin updates), audit 0.
- **CDK:** `tsc --noEmit` ✓, **306/306** tests ✓.

### Deferred (optional majors — no CVE, each needs its own testing pass)
`tailwindcss` 3→4 · `@tanstack/react-table` 8→9 · `react-icons` 4→5 · `recharts` 2→3 · `eslint` 9→10 · `jest` 29→30 · `typescript` 6→7 · `katex` 0.16→0.18 · `@types/*` majors.

---

## Optional major upgrades — 2026-08-06 (part 7): batched, risk-ordered

Tackled the deferred optional majors in risk-ordered batches (each gated by build/test/lint). No CVEs involved — pure currency. Several were **deferred with cause** where the ecosystem isn't ready or the payoff didn't justify a breaking rewrite.

### Applied
| Package | From → To | Notes |
|---|---|---|
| `@types/node` (frontend + cdk) | 22/24 → 26 | type-only; cdk `tsc` clean |
| `katex` (frontend) | 0.16 → 0.18.1 | markdown/KaTeX render tests pass |
| `jest` + `@types/jest` (cdk) | 29 → 30 | `ts-jest@29.4.12` supports jest `^30` |
| `react-icons` (frontend) | 4 → 5.7.0 | `/md` subpath stable; all icons resolve |
| `recharts` (frontend) | 2 → 3.10.1 | only `AnalyticsChart` consumes it; core components stable |

### Deferred (with reason)
- **`eslint` 9 → 10** — `eslint-plugin-react@7.37.5` peers only eslint `^9.7` and `eslint-plugin-jsx-a11y@6.10.2` peers `^9`; neither declares eslint 10 support. Forcing it would break `npm run lint`. Revisit when those plugins ship eslint-10 support.
- **`typescript` 6 → 7** — `ts-jest` peers `typescript <7` (would break the CDK test transform), and TS 7 is the native ("tsgo") rewrite = high ecosystem-compat risk. Revisit when `ts-jest`/`ts-node`/`aws-cdk` declare TS 7 support.
- **`@tanstack/react-table` 8 → 9** — attempted; v9 is a ground-up **feature-composition rewrite** (`useReactTable`→`useTable`, `getCoreRowModel`→`createCoreRowModel` + `tableFeatures`). It broke the build (`MISSING_EXPORT`) and `DataTable`. Reverted to 8.21.3 — a full `DataTable` rewrite against a brand-new API for zero security/functional gain isn't warranted (v8 is fully supported, not vulnerable).
- **`tailwindcss` 3 → 4** — not attempted here; the CSS-first engine + config-format + PostCSS-pipeline change is coupled to the design-system tokens (`ui-design-system.md`) and warrants its own planning pass.

### Verification (post-batches)
- **Frontend:** build ✓, **608/608** tests ✓, lint **0 errors**, `npm audit` **0 vulnerabilities**.
- **CDK:** `tsc --noEmit` ✓, **306/306** tests ✓, audit unchanged (1 high = bundled `brace-expansion`, upstream-only). Note: jest 30 prints a benign "worker failed to exit gracefully" teardown warning (leaked timer/handle in a synth test) — non-fatal, suite passes.

### Net dependency posture
Everything is on its latest **compatible** major. The only versions not on latest-major are the four deferred above, each blocked by a concrete peer/ecosystem constraint or a cost/benefit call — not by neglect.
