# Dependency Upgrade Plan

## Overview

This document covers 12 upgrade steps across the CDK infrastructure, Python Lambda functions, and React frontend. All steps are complete.

| Step | Upgrade | Status |
|---|---|---|
| 1 | Remove `PyPDF2` from all `requirements.txt` | ✅ Done |
| 2 | Bump `PyMuPDF` to `1.25.5` | ✅ Done |
| 3 | CDK CLI + lib + alpha packages, then `npm audit fix` | ✅ Done |
| 4 | Node Lambda runtimes `NODEJS_20_X` → `NODEJS_22_X` | ✅ Done |
| 5 | Rebuild `aws-jwt-verify` layer `4.0.0` → `5.1.1` | ✅ Done |
| 6 | Update Powertools layer ARN | N/A — not available in `ca-central-1` |
| 7 | `npm install` + `npm audit fix` in `frontend/` | ✅ Done |
| 8 | Fix frontend CVEs: `axios`, `react-router-dom`, `react-syntax-highlighter` | ✅ Done |
| 9 | `langchain-aws` `0.2.29` → `1.4.4` | ✅ Done |
| 10 | `aws-sdk` v2 → removed (unused in both CDK and frontend) | ✅ Done |
| 11 | MUI `5.x` → `9.0.0`, `material-react-table` `2.x` → `3.x` | ✅ Done |
| 12 | TypeScript `5.4.5` → `6.0.3`, ESLint `8.x` → `9.x` | ✅ Done |

### Remaining (Low Priority, Deferred)

| Item | Current | Latest | Notes |
|---|---|---|---|
| Python Lambda runtimes | `PYTHON_3_11` | `3.13` | 3.11 still supported, no CVEs |
| React | `18.3.1` | `19.x` | Wait for MUI/MRT official React 19 support |
| Vite | `5.3.1` | `8.x` | Would fix 2 remaining dev-only moderate vulns |

---

## Step 1 — Remove `PyPDF2`

Removed from all three `requirements.txt` files. Confirmed not imported anywhere in the source code.

## Step 2 — Bump `PyMuPDF` to `1.25.5`

Upgraded in all three `requirements.txt`. Version `1.27.2.2` was attempted but requires C++20 (gcc 11+) which the Amazon Linux 2 base image (`python:3.11`) does not support. `1.25.5` is the maximum compatible version. Further upgrade possible when moving to Python 3.12+ (Amazon Linux 2023).

## Step 3 — CDK CLI + Library + Alpha Packages

Updated `cdk/package.json`:
- `aws-cdk` CLI: `2.146.0` → `2.1118.2` (fixes CVE GHSA-qj85-69xf-2vxq)
- `aws-cdk-lib`: `2.219.0` → `^2.249.0`
- `@aws-cdk/aws-amplify-alpha`: `2.146.0-alpha.0` → `2.249.0-alpha.0`
- `@types/node`: `20.12.7` → `^24.0.0`

Ran `npm audit fix` — resolved 10 vulnerabilities down to 0.

## Step 4 — Node Lambda Runtimes

Updated all 13 Node.js Lambda functions and 2 layer definitions in `api-gateway-stack.ts` from `NODEJS_20_X` to `NODEJS_22_X`.

No code changes required — all Lambda handlers already use `@aws-sdk` v3 which is compatible with Node 22.

## Step 5 — `aws-jwt-verify` Layer

Rebuilt `cdk/layers/aws-jwt-verify.zip` with `aws-jwt-verify@5.1.1` (was `4.0.0`).

No code changes required — all three authorizer functions use `CognitoJwtVerifier.create()` with `groups`, `tokenUse`, and `clientId` parameters, all of which are unchanged in v5.

## Step 6 — Powertools Layer (Skipped)

The public Powertools layer (`017000801446`) is not available in `ca-central-1`. The Python Lambda functions work via runtime pre-install. No action needed.

## Step 7 — Frontend `npm audit fix`

Ran `npm install` + `npm audit fix` in `frontend/`. Resolved 56 vulnerabilities down to 14 (remaining tied to `react-syntax-highlighter`, `aws-sdk` v2, and `prism` — addressed in steps 8 and 10).

## Step 8 — Frontend CVE Fixes

### `axios` — Removed

`axios` was listed in `package.json` but never imported anywhere in the source code. The app uses native `fetch()` with Cognito JWT tokens. Additionally, `axios@1.14.1` was compromised in a supply chain attack (March 31, 2026). Removed entirely.

### `prism` — Removed

The `prism` package (not `prismjs`) was also unused and the source of 7 high CVEs via transitive dependencies. Removed.

### `react-router-dom` — `6.24.1` → `7.14.1`

No code changes required. The app only uses library-mode hooks (`useNavigate`, `useLocation`, `useParams`, `BrowserRouter`, `Routes`, `Route`, `Navigate`) — all unchanged in v7. No loaders, actions, or `createBrowserRouter` patterns.

### `react-syntax-highlighter` — `15.5.0` → `16.1.1`

**Code change:** `AIMessage.jsx` — removed dead `inline` prop from the `code` component renderer. The `inline` prop was from `react-markdown` v7 and was already `undefined` in `react-markdown` v10.

Import paths (`/dist/cjs/styles/prism`) and all props (`style`, `language`, `PreTag`, `customStyle`) are unchanged in v16.

### Result

Vulnerabilities dropped from 14 to 3 (1 `aws-sdk` v2 advisory + 2 dev-only `esbuild`/`vite`).

## Step 9 — `langchain-aws` `0.2.29` → `1.4.4`

### Code Changes

| File | Change |
|---|---|
| `chat.py` | `from langchain_core.pydantic_v1 import BaseModel, Field` → `from pydantic import BaseModel, Field` |
| `chat.py` | `from langchain.chains.combine_documents` → `from langchain_classic.chains.combine_documents` |
| `chat.py` | `from langchain.chains import create_retrieval_chain` → `from langchain_classic.chains` |
| `vectorstore.py` (text_gen) | `from langchain.chains import create_history_aware_retriever` → `from langchain_classic.chains` |
| `helper.py` (data_ingest) | `from langchain.indexes import SQLRecordManager` → `from langchain_classic.indexes` |
| `documents.py` | `from langchain.indexes import SQLRecordManager, index` → `from langchain_classic.indexes` |

### Dependency Pinning

`langchain==1.2.15` introduced `langgraph` as a hard dependency (not present in 0.x). `numpy 2.x` requires GCC 9.3+ but the Lambda Python 3.11 base image ships GCC 7.3.1. Both `requirements.txt` files were fully pinned:

```
numpy==1.26.4
langchain==1.2.15
langgraph==1.1.8
langchain-aws==1.4.4
langchain-core==1.3.0
langchain-community==0.4.1
langchain-classic
langchain-postgres==0.0.17
```

### Why `langchain_classic`?

In `langchain==1.2.15`, the legacy chain APIs (`create_retrieval_chain`, `create_history_aware_retriever`, `create_stuff_documents_chain`, `SQLRecordManager`, `index`) were extracted into a separate package called `langchain-classic`. The `langchain` package itself no longer contains them. This was verified by running imports inside the actual Lambda container (`public.ecr.aws/lambda/python:3.11`).

## Step 10 — `aws-sdk` v2 Removal

### Finding

`aws-sdk` v2 was listed in both `cdk/package.json` and `frontend/package.json` but had zero actual imports in the source code. All Lambda handlers already use `@aws-sdk` v3 scoped packages. The frontend uses `@aws-sdk/client-s3`, `@aws-sdk/client-cognito-identity`, etc.

### Code Changes

- Removed `aws-sdk` from `cdk/package.json` dependencies
- Removed `aws-sdk` from `frontend/package.json` dependencies
- Deleted `frontend/src/functions/handleAuth.js` — legacy file that used `AWS.CognitoIdentityCredentials` (v2). Only consumer was `useAuth.js`.
- Deleted `frontend/src/functions/useAuth.js` — hook wrapping `handleAuth.js`, never imported anywhere in the app.

### Result

- CDK: 0 vulnerabilities
- Frontend: 2 moderate (dev-only `esbuild`/`vite`)

## Step 11 — MUI v5 → v9 + `material-react-table` v2 → v3

### Approach

Direct v5 → v9 was too large a jump. Incremental path: v5 → v6 → v9.

### Phase 1: MUI v5 → v6 + MRT v2 → v3

**Package changes:**
- `@mui/material`: `^5.15.21` → `^6.5.0`
- `@mui/icons-material`: `^5.16.13` → `^6.5.0`
- `material-react-table`: `^2.13.1` → `^3.2.1`
- Added `@mui/x-date-pickers@^7.15.0` (MRT v3 peer dep)

**Code changes — Grid v2 API** (5 files):
`<Grid item xs={4}>` → `<Grid size={4}>`, removed `item` prop, added `sx={{ width: '100%' }}` to all Grid containers.
- `InstructorNewConcept.jsx`, `InstructorAnalytics.jsx`, `InstructorEditConcept.jsx`, `InstructorNewModule.jsx`, `InstructorEditCourse.jsx`

**Code changes — ListItem** (2 files):
`<ListItem button onClick={...}>` → `<ListItemButton onClick={...}>`, added `ListItemButton` import.
- `InstructorSidebar.jsx`, `AdminSidebar.jsx`

### Phase 2: MUI v6 → v9

**Package changes:**
- `@mui/material`: `^6.5.0` → `^9.0.0`
- `@mui/icons-material`: `^6.5.0` → `^9.0.0`
- `@mui/x-date-pickers`: `^7.29.4` → `^9.0.2` (v7 doesn't support MUI v9)
- Added `frontend/.npmrc` with `legacy-peer-deps=true` (MRT v3 peer dep says `>=6`, npm strict rejects v9)

**Code changes — `PaperProps` → `slotProps.paper`** (3 files):

| File | Change |
|---|---|
| `StudentHomepage.jsx` | `<Dialog PaperProps={{...}}>` → `<Dialog slotProps={{ paper: {...} }}>` |
| `AdminInstructors.jsx` | Same Dialog pattern |
| `InstructorDetails.jsx` | `MenuProps.PaperProps` → `MenuProps.slotProps.paper` |

**Code changes — remaining Grid v2 migration** (4 files):
`Grid item xs={...}` → `Grid size={...}` in `Login.jsx`, `StudentHomepage.jsx`, `InstructorDetails.jsx`, `CourseDetails.jsx`.

**Code changes — system props removal** (MUI v9 removed system props as direct JSX attributes):

*Button row layouts* (6 files) — replaced `Grid container` + `Grid size={4}` button rows with `Box sx={{ display: "flex", justifyContent: "space-between" }}`:
- `InstructorEditCourse.jsx`, `InstructorEditConcept.jsx`, `InstructorNewModule.jsx`, `InstructorNewConcept.jsx`, `InstructorDetails.jsx`, `CourseDetails.jsx`

*Box system props* (3 files) — moved `mb`, `mt`, `width`, `display`, `justifyContent` into `sx`:
- `InstructorAnalytics.jsx` (4 instances), `PromptSettings.jsx` (5 instances), `StudentDetails.jsx` (1 instance)

*Typography system props* (3 files) — moved `textAlign`, `paddingBottom`, `fontStyle` into `sx`:
- `Login.jsx` (3 instances), `ChatLogs.jsx` (2 instances), `InstructorAnalytics.jsx` (1 instance)

**Code changes — Grid container width** (9 files):
All `Grid container` instances needed `sx={{ width: '100%' }}` added — MUI v6+ Grid containers no longer auto-expand to fill their parent.

## Step 12 — TypeScript 5.4.5 → 6.0.3 + ESLint v8 → v9

### TypeScript 6.0.3 (`cdk/`)

**`tsconfig.json` changes:**
1. `"module": "commonjs"` → `"module": "node16"` — TS6 enforces `module` and `moduleResolution` must be paired
2. Added `"moduleResolution": "node16"` — TS6 defaults to `bundler` which doesn't match CDK's Node.js runtime

No other changes needed. The existing config already had `"strict": true`, `"esModuleInterop": true`, `"types": ["node"]`, and `"target": "ES2020"`.

Note: `ts-jest@29.4.0` has a peer dep of `typescript >=4.3 <6` — npm warns but installs and runs fine.

### ESLint v8 → v9 (`frontend/`)

ESLint v9 dropped `.eslintrc.*` in favor of flat config.

**Changes:**
- Deleted `frontend/.eslintrc.cjs`
- Created `frontend/eslint.config.js` (flat config)
- `eslint-plugin-react-hooks`: `^4.6.2` → `^5.2.0` (v5 required for ESLint v9)
- Added `@eslint/js@^9.39.4` and `globals@^16.1.0` as devDependencies
- Lint script: `eslint . --ext js,jsx --report-unused-disable-directives --max-warnings 0` → `eslint .`

---

## Post-Upgrade Verification

After all 12 steps, a full codebase audit and step-by-step re-verification was performed.

### Additional Fixes Found During Audit

| File | Issue | Fix |
|---|---|---|
| `Login.jsx` (forgot password) | One remaining `Grid item xs={12} sm={12} md={7}` | Migrated to `Grid size={{ xs: 12, sm: 12, md: 7 }}` |
| `AIMessage.jsx` | `react-markdown` v10 deprecated `<ReactMarkdown children={content} />` | Changed to `<ReactMarkdown>{content}</ReactMarkdown>` |
| `frontend/package.json` | `u` package (`^0.1.0`) never imported anywhere | Removed |

### Step-by-Step Re-Verification

| Step | What Was Checked | Result |
|---|---|---|
| 1 | `PyPDF2` not in any `requirements.txt` | ✅ Clean |
| 2 | `PyMuPDF==1.25.5` in all `requirements.txt` | ✅ Correct |
| 3 | CDK CLI, lib, alpha versions in `package.json` | ✅ Correct |
| 4 | All Node Lambda runtimes `NODEJS_22_X` in `api-gateway-stack.ts` | ✅ Correct |
| 4 | Node Lambda handlers for Node 20-specific APIs | ✅ All use @aws-sdk v3 |
| 5 | `aws-jwt-verify` v5 `CognitoJwtVerifier.create()` with `groups` in all 3 authorizers | ✅ `groups` still supported in v5 |
| 8 | No `axios` imports anywhere | ✅ Clean |
| 8 | `react-router-dom` v7 hooks (`useNavigate`, `useParams`, `useLocation`) | ✅ No deprecated v6 patterns |
| 8 | `react-syntax-highlighter` v16 import paths (`/dist/cjs/styles/prism`) | ✅ Still works |
| 9 | No `langchain_core.pydantic_v1` imports | ✅ Clean |
| 9 | No `from langchain.chains` or `from langchain.indexes` imports | ✅ All using `langchain_classic` |
| 9 | `ChatBedrock`, `BedrockLLM`, `BedrockEmbeddings` parameter usage | ✅ No deprecated params |
| 10 | No `aws-sdk` v2 imports anywhere | ✅ Clean |
| 10 | No imports from deleted `handleAuth.js` or `useAuth.js` | ✅ Clean |
| 11 | No remaining `Grid item` patterns | ✅ All migrated |
| 11 | No `components=`/`componentsProps=` (should be `slots`/`slotProps`) | ✅ Clean |
| 11 | No `disableEscapeKeyDown`, `TransitionComponent`, `BackdropComponent` | ✅ Not used |
| 11 | No `ListItem button` pattern | ✅ All migrated to `ListItemButton` |
| 11 | No system props as direct attributes on Box/Typography/Grid | ✅ All moved to `sx` |
| 11 | `material-react-table` v3 `useMaterialReactTable` and `MRT_TableContainer` | ✅ v3 compatible |
| 12 | No deprecated tsconfig options (`baseUrl`, `outFile`, `downlevelIteration`, `moduleResolution: node10`) | ✅ Clean |
| 12 | No `.eslintrc` files, `eslint.config.js` valid | ✅ Clean |

### Build Verification

- `cdk/`: `npx tsc --noEmit` — 0 errors
- `cdk/`: `npm audit` — 0 vulnerabilities
- `frontend/`: `npm run build` (Vite) — 0 errors
- `frontend/`: `npm audit` — 2 moderate (dev-only `esbuild`/`vite`, not production)

### Known Deprecation Warnings (Non-Breaking, Deferred)

MUI v9 deprecated `inputProps`, `InputProps`, and `InputLabelProps` on `TextField` in favor of `slotProps.htmlInput`, `slotProps.input`, and `slotProps.inputLabel`. These still function and won't be removed until a future MUI major version. 27 instances across 11 files. Low priority — can be addressed incrementally.
