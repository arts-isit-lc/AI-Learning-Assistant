# Module Progress Button (student chat page) — Spec

**Status:** Proposed — awaiting go-ahead before implementation. Small, additive feature. Reuses shipped seams end-to-end: the student REST handler (`cdk/lambda/lib/studentFunction.js` switch-router), the OpenAPI-driven `SpecRestApi`, the frontend `apiClient` auth wrapper, and the existing "button → hook → `apiClient.get` → popover" pattern already used by **View Materials** (`useFileViewer`).
**Area:** `frontend` (StudentChat page: one button + popover; new `useModuleProgress` hook; a small status helper), `cdk/OpenAPI_Swagger_Definition.yaml` (one new `/student/*` route), `cdk/lambda/lib/studentFunction.js` (one new read-only `case`), `cdk/test` (two Jest `.test.ts`). **No** CDK stack, IAM, Bedrock, or DB-schema change.
**Refined via** `planning-refinement.md` (2 internal passes + 2 reviewer rounds). Key refinements: removed response caching (freshness is the whole motivation — a cached badge reproduces the stale-progress bug), scoped the query to the course and folded enrolment into a single join, and corrected the "shared helper" framing. Residual items in §13.

---

## 1. Problem Statement

On the student chat page (`frontend/src/pages/student/StudentChat.jsx`) a student is working inside a single module, but there is no way to see their **current progress** on that module while chatting. The `module` object the page holds already contains `module_score` and `last_accessed`, but it is **stale**: it is captured from the course-page fetch when the student *enters* the module (written to `sessionStorage`), and the score changes *during* the chat as the LLM mastery check updates it (`POST /student/update_module_score` sets `module_score` to `100`/`0`). Re-reading the in-memory copy would show pre-chat state, not the truth.

The user request: a button on the chatbot page that makes an API call to fetch the student's progress on the current module. A fresh server read is genuinely warranted (not just re-rendering memory), because the authoritative score lives in Postgres and moves while the student chats.

### Load-bearing facts (verified in code)
- **The chat page already has the module + course in hand.** `StudentChat({ course, module, ... })`; `module` = `{module_id, module_name, module_number, module_score, last_accessed, concept_id, concept_name, student_module_id, enrolment_id}`, restored from `sessionStorage` (`CourseView.enterModule` writes it). `course.course_id` is available.
- **There is a canonical "button fetches module data" pattern.** `useFileViewer.js` owns state + a loading flag + `handleFetchFiles()` → `apiClient.get("student/files", {course_id, module_id})`, rendered by a popover in the top-right actions bar of `StudentChat.jsx` (next to **View Materials** / **Sign Out**). This feature mirrors it exactly.
- **Auth is automatic.** `frontend/src/services/api.js` (`apiClient.get(path, queryParams)`) attaches the Cognito `idToken` as the `Authorization` header and reads `email` from the token payload (`apiClient.getAuth()`); base URL from `VITE_API_ENDPOINT`. `CourseView` already calls `student/course_page` with `{email, course_id}` this way.
- **Progress semantics are established.** `Student_Modules.module_score` (integer; `0` on enrolment, `100` on mastery) + `Student_Modules.last_accessed` (NULL until first access). Existing display logic in `CourseView.jsx`: `module_score === 100` → **Complete**; else `last_accessed` set → **In Progress**; else → **Incomplete**.
- **The handler is a switch-router with the right precedent.** `studentFunction.js` switches on `"${httpMethod} ${resource}"`. `GET /student/course_page` already runs the exact join we need (`Enrolments` → `Course_Modules`/`Course_Concepts` ⟕ `Student_Modules`) — but for the **whole course**, it returns the heavy `module_context_embedding` column, and it **writes a `'course access'` row to `User_Engagement_Log` on every call**. There is **no** single-module progress endpoint today.
- **No IAM/CDK change is needed for a new `/student/*` route.** `StudentPolicy` grants `execute-api:Invoke` on `.../student/*` and the Lambda invoke permission uses a `.../student*` source ARN — both wildcards already cover a new student route. (Verified in `api-gateway-stack.ts`.)
- **The API definition is an `AWS::Include` macro.** `SpecRestApi` is built from `Fn.transform("AWS::Include", { Location: <S3 asset> })`, so route strings are **not** present in the synthesized CloudFormation template — a `Template.fromStack()` assertion cannot see the new path (§11 picks the correct substitute).

---

## 2. Principles

**2.1 Mirror the shipped pattern, don't invent one.** The endpoint copies the `/student/course_page` route/handler shape; the UI copies the `useFileViewer` hook + top-right popover. Same auth, same error contract, same styling. Lowest-risk, most reviewable path.

**2.2 Read-only and side-effect-free.** The endpoint only reads progress. It deliberately does **not** reuse `course_page`, whose per-call `User_Engagement_Log` write would record false `'course access'` events every time the button is clicked (§6). No writes in v1.

**2.3 Fetch fresh on every click, keep it small.** The whole motivation is that progress changes *during* the chat, so every click performs a fresh GET — **no client-side caching**. A stale cached badge would reproduce the exact problem this feature exists to fix. Return only the fields the UI needs for one module; never the `module_context_embedding` float array. The query is a single indexed row, so freshness is worth more than saving one tiny request.

**2.4 A reusable status helper for new code.** The Complete / In Progress / Incomplete thresholds are put in one small helper the new UI uses. `CourseView` keeps its existing inline logic for now and may migrate later. So this introduces a *reusable helper*, not yet a single enforced source of truth (§13).

---

## 3. Goals / Non-Goals

**Goals**
- A **Progress** button in the StudentChat top-right actions bar that, on click, fetches the student's current progress for the **current module** and shows it in a popover (status badge + score + last-accessed).
- A new read-only REST endpoint `GET /student/module_progress` returning fresh per-module progress, scoped and authorized like the sibling student routes.
- Reuse resolution/auth/display patterns; graceful empty/error states.

**Non-Goals (v1)**
- No progress **history**, charts, or per-concept rollups (that already exists on the course page); this is a single-module snapshot.
- No change to `CourseView` (it keeps its inlined logic; it *may* adopt the shared helper later — not required here).
- No engagement-log write, no new metrics pipeline, no schema change, no GraphQL (the AppSync schema is notifications/streaming only — REST is the correct layer).
- No CDK/IAM/Bedrock change.

---

## 4. Design

### 4.1 New route — `GET /student/module_progress` (`cdk/OpenAPI_Swagger_Definition.yaml`)

Add a path block copied from `/student/course_page` / `/student/module`: an `options` CORS mock **plus** a `get` with query params `email`, `course_id`, `module_id` (all `required`), `security: [studentAuthorizer]`, standard `200/400/401/429/500` responses, and the `aws_proxy` integration `uri` → `${studentFunction.Arn}`.

```text
/student/module_progress:
  options: { ...CORS mock, identical to sibling routes... }
  get:
    operationId: student_get_module_progress_GET
    parameters: [ email (query, required), course_id (query, required), module_id (query, required) ]
    security: [ studentAuthorizer: [] ]
    x-amazon-apigateway-integration:
      uri: arn:aws:apigateway:${AWS::Region}:lambda:path/.../functions/${studentFunction.Arn}/invocations
      httpMethod: POST
      type: aws_proxy
```

### 4.2 Handler case (`cdk/lambda/lib/studentFunction.js`)

Add `case "GET /student/module_progress":` following the `course_page` shape, and add the route to the route-index comment header at the top of the file.

- **Guard:** require `email`, `course_id`, `module_id` in `queryStringParameters` → else `400`. (The top-level `email !== authorizer.email` check already returns `401` for cross-user access.)
- **Resolve user:** `SELECT user_id FROM "Users" WHERE user_email = ${email}` → `404` if absent (matches the sibling routes, which all resolve `user_id` first).
- **One course-scoped query (read-only, no embedding column)** — enrolment is enforced *inside* the query by an `INNER JOIN "Enrolments"`, so there is no separate enrolment roundtrip; not-enrolled, wrong-course, and inactive-module all collapse to an empty result → `404`:

```text
SELECT
  "Course_Modules".module_id,
  "Course_Modules".module_name,
  "Course_Modules".module_number,
  "Course_Concepts".concept_id,
  "Course_Concepts".concept_name,
  "Student_Modules".student_module_id,
  "Student_Modules".module_score,      -- integer; 100 = mastered
  "Student_Modules".last_accessed      -- NULL until first access
FROM "Course_Modules"
JOIN "Course_Concepts" ON "Course_Modules".concept_id = "Course_Concepts".concept_id
JOIN "Enrolments"
  ON "Enrolments".course_id = "Course_Concepts".course_id
 AND "Enrolments".user_id  = ${userId}          -- enrolment enforced here (no separate query)
LEFT JOIN "Student_Modules"
  ON "Student_Modules".course_module_id = "Course_Modules".module_id
 AND "Student_Modules".enrolment_id     = "Enrolments".enrolment_id
WHERE "Course_Modules".module_id = ${moduleId}
  AND "Course_Concepts".course_id = ${courseId}   -- module must belong to THIS course
  AND "Course_Modules".status = 'active';
```

> **Schema note (corrects the review's `Course_Modules.course_id`):** `Course_Modules` has no `course_id` column — a module's course is reached via `concept_id → Course_Concepts.course_id` (the exact linkage `course_page` uses). So both the course guard (`Course_Concepts.course_id = ${courseId}`) and the enrolment join key are on `Course_Concepts.course_id`. A `module_id` from a *different* course than `course_id` returns `404`, never a mismatched row.

- **Not found:** empty result — not enrolled, module not in this course, or inactive → `404 {error}`. (The `LEFT JOIN` on `Student_Modules` means an enrolled student with no progress row yet still gets the module row, with null progress.)

> **404 consistency (review point 2):** both *unknown user* and *not enrolled* return `404`. For a single-object endpoint that is the natural "nothing to return" response and is consistent with the sibling routes' user-first resolution; we deliberately do not distinguish the two to the client.
- **Success:** `200` with a single object `{module_id, module_name, module_number, concept_id, concept_name, student_module_id, module_score, last_accessed}`. (`student_module_id`/`module_score`/`last_accessed` may be null if the student is enrolled but has no `Student_Modules` row yet — the UI renders that as *Incomplete*.)
- **Failure:** `500 {error}` in the catch, with `console.error(err)` (the existing Node-handler logging convention; Powertools is Python-only per `lambda-coding-standards`).
- Queries use the `sql` tagged template (auto-parameterized — no string interpolation, no injection surface).

### 4.3 Frontend hook — `useModuleProgress(course, module)` (`frontend/src/pages/student/useModuleProgress.js`, new)

Mirrors `useFileViewer`'s shape, but **always re-fetches on click** (no cache-once) because progress changes during the chat (§2.3):

```text
state: progress (null), progressLoading (false), progressPopoverOpen (false), progressError (null)
handleFetchProgress():
  if progressLoading → return            // in-flight guard: ignore rapid double-clicks
  set loading + clear progressError + open popover   // show skeleton on EVERY open, even if loaded before
  const { email } = await apiClient.getAuth()
  data = await apiClient.get("student/module_progress",
                             { email, course_id: course.course_id, module_id: module.module_id })
  setProgress(data)
  // on error: console.error; setProgress(null);
  //   setProgressError(err.status === 404 ? "Progress not found." : "Unable to load progress.")
  // finally: clear loading
return { progress, progressLoading, progressPopoverOpen, setProgressPopoverOpen, progressError, handleFetchProgress }
```

> Deliberate divergence from `useFileViewer` (which caches the file list after the first fetch): module *files* are static for the session, module *progress* is not. Every open triggers a fresh GET; the `if progressLoading → return` guard prevents overlapping requests from rapid clicks. `apiClient` throws with `err.status` on a non-2xx response (network failures carry no `status`), so the popover distinguishes *"Progress not found."* (`404`) from *"Unable to load progress."* (`500`/network).

### 4.4 Button + popover (`frontend/src/pages/student/StudentChat.jsx`)

- Instantiate the hook: `const progress = useModuleProgress(course, module);`
- Add a **Progress** button in the existing top-right actions `<div>` (next to **View Materials**), same button styling (`bg-gray-800 … rounded`), a `lucide-react` icon (`TrendingUp`), `onClick={progress.handleFetchProgress}`.
- Add a popover mirroring the file-list popover (same container/skeleton classes): a title row + close button; while `progressLoading`, show the pulse skeleton; otherwise render:
  - **status badge** via the shared helper (§4.5) — green **Complete** / amber **In Progress** / red **Incomplete**, reusing `CourseView`'s color meaning;
  - **score** (`module_score ?? 0`) and **Last accessed** (`last_accessed` formatted, or "Not started");
  - error state: render `progress.progressError` when set (*"Progress not found."* for `404`, *"Unable to load progress."* otherwise); a neutral empty state otherwise.

> Styling note: this matches the **actual current** StudentChat markup (Tailwind + `lucide-react` + the gray action buttons and popover that are really on the page). The `chat-ux-patterns` steering describes a more idealized structure the file hasn't fully adopted; matching real code is the correct integration path and is called out here intentionally.

### 4.5 Shared status helper (`frontend/src/utils/moduleStatus.js`, new small util)

```text
getModuleStatus({ module_score, last_accessed }) ->
  module_score === 100 ? "complete"
  : last_accessed      ? "in_progress"
  : "incomplete"
```

A reusable helper for the thresholds (§2.4). The new popover uses it; `CourseView` keeps its own inline copy for now and may migrate later (out of scope). So today this is a helper *for new code*, not yet an enforced single source of truth across the app (§13). (Location `utils/` follows the steering's "formatters live in `src/utils/`"; it could equally sit under `pages/student/` since the semantics are student-specific — either is fine.)

### 4.6 Edge cases

| Case | Behavior |
|---|---|
| Enrolled, no `Student_Modules` row yet | `module_score`/`last_accessed` null → badge shows **Incomplete**, score 0. |
| Not enrolled in the course | `404` (INNER JOIN Enrolments yields no row); popover shows *"Progress not found."* |
| Module not active / not in this course | `404` (course-scoped `WHERE`); popover shows *"Progress not found."* |
| Missing query param | `400` (guarded). |
| Cross-user `email` param | `401` (existing top-level authorizer-email check). |
| Network / 500 | Popover shows *"Unable to load progress."*; no crash (mirrors `useFileViewer` catch). |
| Button clicked repeatedly | Each click performs a **fresh GET**; a click while a request is in flight is ignored until it resolves (no caching). |

### 4.7 CDK / infra
None. No new stack, Lambda, IAM statement, env var, or model. The route is served by the existing `studentFunction` and is already covered by the `/student/*` IAM grant and the `/student*` Lambda invoke permission (§1). Therefore `iam-policies.test.ts` is unchanged.

---

## 5. Data Flow (after change)

```
Student on /student_chat clicks "Progress"
  → useModuleProgress.handleFetchProgress():
        email = apiClient.getAuth()  (Cognito idToken)
        apiClient.get("student/module_progress", {email, course_id, module_id})
  → API Gateway (studentAuthorizer) → studentFunction.handler
        case "GET /student/module_progress":
          resolve user_id (404 if unknown)
          → ONE course-scoped query: Course_Modules ⋈ Course_Concepts ⋈ Enrolments ⟕ Student_Modules
            (enrolment enforced by the join; WHERE Course_Concepts.course_id = course_id; empty → 404)
          → 200 { module_name, module_number, concept_name, module_score, last_accessed, ... }   (no embedding, no writes)
  → hook stores progress
  → popover: getModuleStatus(progress) → Complete / In Progress / Incomplete badge + score + last accessed
```

---

## 6. Explicitly rejected alternatives

1. **Reuse `GET /student/course_page` and filter client-side.** Rejected: it over-fetches the entire course, returns the heavy `module_context_embedding` float array, and — decisively — **writes a `'course access'` row to `User_Engagement_Log` on every call**, which would pollute engagement analytics with false access events from a chat-page button.
2. **Just display the in-memory `module` object (no API call).** Rejected: it is stale (captured at module entry) and the score changes during the chat; also it does not satisfy the explicit request for a fresh server read.
3. **A GraphQL query.** Rejected: the AppSync schema is notifications/chat-streaming only; student data is served over REST. Adding a GraphQL type here would be a new, inconsistent surface.
4. **Server-derived `status` string.** Rejected: status is **presentation logic that already lives client-side** in `CourseView`. Deriving it in the handler would split one business rule across client and server and duplicate what `CourseView` already does. Return raw `module_score`/`last_accessed` and derive the label client-side via the helper (§4.5). (The status thresholds are UI concerns; the API stays a thin data read.)

---

## 7. Tasks (single phase — no new infra)

- [ ] **T1.** `OpenAPI_Swagger_Definition.yaml`: add `/student/module_progress` (`options` CORS mock + `get` with `email`/`course_id`/`module_id`, `studentAuthorizer`, `aws_proxy` → `studentFunction.Arn`). *Test: T6 YAML contract test.*
- [ ] **T2.** `studentFunction.js`: add `case "GET /student/module_progress"` (guard → resolve user → scoped read-only join excluding the embedding → 200/400/404/500); update the route-index header comment. *Test: T6 handler unit test.*
- [ ] **T3.** `frontend/src/pages/student/useModuleProgress.js` (new): hook mirroring `useFileViewer` (`progress`, `progressLoading`, `progressPopoverOpen`, `handleFetchProgress`). *Gate: ESLint (frontend exempt from unit tests).*
- [ ] **T4.** `StudentChat.jsx`: **Progress** button (lucide `TrendingUp`) in the top-right actions bar + progress popover mirroring the files popover (skeleton + badge + score + last-accessed + empty state). *Gate: ESLint.*
- [ ] **T5.** `frontend/src/utils/moduleStatus.js` (new): `getModuleStatus()` shared helper; used by the popover. *Gate: ESLint.*
- [ ] **T6.** `cdk/test/student-module-progress.test.ts` (new, Jest — existing runner/dir): **(a)** parse `OpenAPI_Swagger_Definition.yaml` (the `yaml` dep is already present) and assert the `/student/module_progress` path exists with a GET, the three required params, and `studentAuthorizer`; **(b)** unit-test the handler by `require()`-ing `../lambda/lib/studentFunction.js` with `jest.mock` on `./lib.js` (fake `sql` tagged-template + no-op `initializeConnection`) and `./accessControl.js`, asserting **happy path** (200 + expected shape), **missing param** (400), **unknown user** (404, user lookup empty), and **not enrolled / no module row** (404, main query empty). The fake `sql` queues per-call results, so both 404 branches are exercised independently.

---

## 8. Security / Trust Boundary
Authorization is unchanged and enforced by `studentAuthorizer` + the handler's existing `email === authorizer.email` check (`401` on mismatch). The new query is `scope_filter`-equivalent: it is bound to the caller's own `user_id`/`enrolment_id` and the requested `course_id`/`module_id`, so a student can only read their own progress. Enrolment is enforced by an `INNER JOIN "Enrolments"` on the caller's `user_id`, and the `Course_Concepts.course_id = ${courseId}` predicate ensures the requested module actually belongs to the requested course — so a mismatched or cross-course `module_id` returns `404`, never another student's or another course's data. Inputs flow only into the auto-parameterized `sql` tagged template (no string interpolation, no `eval`). The endpoint is read-only (no writes, no side effects). No new IAM surface — the route is covered by the existing `/student/*` grant + `/student*` invoke permission, so there is nothing to add to `iam-policies.test.ts`.

## 9. Observability
No custom metrics in v1. The route inherits the existing operational surface: API Gateway per-method CloudWatch metrics, `studentFunction` logs (`console.error` on failure), and X-Ray (the function has `tracing: ACTIVE`). *Optional (deferred, §13):* a `User_Engagement_Log` `'progress view'` row per click if product wants engagement analytics — omitted from v1 to keep the endpoint side-effect-free.

## 10. Acceptance Criteria
- **AC-1:** `GET /student/module_progress?email&course_id&module_id` returns `200` with `{module_name, module_number, concept_name, module_score, last_accessed, ...}` and **not** `module_context_embedding`, for an enrolled student.
- **AC-2:** Missing any required param → `400`; unknown user → `404`; **not enrolled** → `404`; **module inactive or not part of the given course** → `404`; cross-user `email` → `401`.
- **AC-3:** The endpoint performs **no writes** (no `User_Engagement_Log` insert, no `UPDATE`).
- **AC-4:** Clicking **Progress** on the chat page opens a popover that fetches from the endpoint and shows a Complete/In Progress/Incomplete badge (matching `CourseView`'s thresholds) plus score and last-accessed; a null/missing `Student_Modules` row renders as **Incomplete**.
- **AC-5:** Error/empty responses render the "Progress unavailable" state without crashing; **every click performs a fresh GET (no caching)** so the badge reflects score changes made during the chat, and a click while a request is in flight is ignored.
- **AC-6:** The OpenAPI contract test asserts the route + three params + `studentAuthorizer`; the handler unit test covers 200/400/404. `npm test` (Jest) and `npm run lint` (frontend) pass.

## 11. Test Strategy
`cd cdk && npm test` (Jest 29 + ts-jest; `roots: test/`, `testMatch: **/*.test.ts`). Two deterministic tests in one new `cdk/test/student-module-progress.test.ts`:
- **OpenAPI contract test** — because the API definition is inlined via an `AWS::Include` macro (§1), a `Template.fromStack()` assertion cannot see the path. Instead, parse the YAML file directly and assert the path/verb/params/security. No Docker, no network.
- **Handler unit test** — the first test to exercise a Node Lambda handler, but it uses the **existing Jest runner** (not a new framework): a `.test.ts` `require()`s the CommonJS handler (only `.tsx?` is transformed, so JS runs as-is) and mocks `./lib.js` (a `jest.fn()` acting as the `sql` tagged template, returning queued rows) and `./accessControl.js`. Deterministic — no DB, no AWS creds, no network — per testing-policy.

Frontend (hook, button, helper) is exempt from unit tests per policy; the gate is `cd frontend && npm run lint`. Note: running the *full* `npm test` suite still requires Docker for the synth-based CDK tests, but these two tests do not (can be run in isolation via `npx jest student-module-progress`).

**Frontend manual verification** (acceptance checklist — not automated; the frontend has no test framework):
- [ ] Click **Progress** → loading skeleton appears in the popover.
- [ ] Success → correct status badge (Complete / In Progress / Incomplete) + score + last-accessed.
- [ ] `404` / network error → "Progress unavailable" state, no crash.
- [ ] Reopen after a score change (e.g. after the LLM marks the module complete mid-chat) → a **fresh** fetch runs and the badge updates (verifies no stale cache).
- [ ] Keyboard: the popover is reachable and dismissable via keyboard; focus is not trapped.

## 12. Refinement history
- **Initial draft:** read-only endpoint + button/hook/popover mirroring `useFileViewer`; originally proposed a CDK `Template.fromStack()` route assertion.
- **Internal pass — testing:** found the API definition is an `AWS::Include` macro (route absent from the synth template) → replaced the template assertion with a **YAML contract test**, and confirmed the existing Jest runner can drive a **Node handler unit test** (a `.test.ts` requiring the JS handler with mocked `lib.js`) for real 200/400/404 coverage — no new framework.
- **Internal pass — production readiness:** pinned explicit status codes + `console.error` (Node-handler convention; Powertools is Python-only), excluded the embedding column, and kept the endpoint read-only (no engagement-log write) to avoid `course_page`'s side-effect.
- **Reviewer round 1:** removed response caching → every click re-fetches (a cached badge reproduces the stale-progress bug); added course scoping (corrected to `Course_Concepts.course_id`, since `Course_Modules` has none); reframed the status helper as *reusable for new code*; strengthened the server-derived-status rejection; added the frontend manual-verification checklist.
- **Reviewer round 2 (this revision):** folded the separate enrolment query into the main query's `INNER JOIN` (one fewer roundtrip); distinguished the popover's `404` (*"Progress not found."*) vs `500`/network (*"Unable to load progress."*) messages; noted the helper's location is flexible; removed self-scoring from the doc.

## 13. Residual Risks / Open Items (honest notes)
- **First Node-handler test in the repo.** It reuses the existing Jest runner/dir (not a new framework), but mocking the `sql` tagged template is a new pattern here; if the team prefers, the fallback is manual/integration verification of the handler with only the YAML contract test kept. **Decision needed.**
- **Payload richness (open decision from planning).** v1 returns the module progress snapshot only. Optionally include the module's **chat session count** as an extra engagement signal (cheap join) — deferred to avoid scope creep. **Decision needed.**
- **Engagement logging (open decision).** v1 is deliberately side-effect-free. A `'progress view'` `User_Engagement_Log` row could be added if analytics want it (§9) — would make the endpoint no longer read-only. **Decision needed.**
- **Status logic is not yet a single source of truth.** `CourseView` keeps its inline Complete/In-Progress/Incomplete logic; `getModuleStatus` is used only by the new UI in v1. So the helper is *reusable for new code*, but the rule still lives in two places until `CourseView` migrates — an optional, later cleanup (not done here to avoid touching a working MUI page).
