# Student Course-Wide Progress (console.log for now) — Spec

**Status:** Proposed — awaiting go-ahead before implementation. Extends the shipped **Module Progress Button** (`.kiro/specs/module-progress-button/spec.md`), which explicitly deferred per-topic mastery with the note *"that lives in the chatbot_v2 per-session SessionState (DynamoDB), not in this table."* This feature fills exactly that gap, at **course** scope.
**Area:** `cdk/lambda/lib/studentFunction.js` (new read-only `GET /student/course_progress` — Postgres join + DynamoDB batch-read + aggregation), `cdk/OpenAPI_Swagger_Definition.yaml` (one route), `cdk/lib/api-gateway-stack.ts` (**one env var + one IAM read statement** on `dbLambdaRole`), `cdk/test` (IAM assertion + handler unit test), `frontend` (a `useCourseProgress` hook that `console.log`s the payload — debug trigger, no new UI). **New for this repo:** the first Postgres→DynamoDB cross-store read in a zip Lambda.
**Refined via** `planning-refinement.md` (internal critique/revise passes + the same reviewer loop as the module spec). Residual items in §13.

---

## 1. Problem Statement

The Module Progress Button shows a single module's coarse score (`Student_Modules.module_score`, 0/100) plus the module's topic *names* (`Course_Modules.generated_topics`). It cannot show **how well a student is doing per topic**, and it is scoped to one module. The requester wants to see the **complete data structure of a student's progress across an entire course** — every module, every topic, and the student's mastery per topic — logged to the browser console for debugging.

That fine-grained data is real and already produced: the `chatbot_v2` structured-learning engine tracks per-concept mastery during chat. But it lives in a different store than the module-progress endpoint reads.

### Load-bearing facts (verified in code)
- **Per-topic mastery is in DynamoDB, per session.** `chatbot_v2/src/state_machine.py::SessionState` holds `concept_progress: {concept -> {level, exposures, demonstrations}}` (levels `introduced → discussed → demonstrated → mastery`, threshold `MASTERY_DEMONSTRATION_RATIO=0.6`), plus `concepts_discussed/demonstrated`, `module_concepts`, `stage`, `engagement_score`. It is persisted by `main.py::_persist_session_state` to the **`sessionStateTable`** DynamoDB table.
- **The table has no course/module index.** `multimodal-rag-stack.ts`: `sessionStateTable` — partition key `session_id` (STRING), **no sort key, no GSI**, `PAY_PER_REQUEST`. So course-wide assembly *must* resolve `session_id`s elsewhere (Postgres) and then read items by key. Exposed as `public readonly ragStack.sessionStateTable`.
- **`session_id` is the shared join key.** The same `session_id` keys the DynamoDB item (`Key={"session_id": ...}`) and the Postgres `Sessions` row (a uuid PK). Verified via `main.py` (DynamoDB key) + `rds_projection.py` (writes `Messages.session_id` FK to `Sessions`).
- **The Postgres join path is established.** From `email + course_id` to the student's `session_id`s: `Sessions → Student_Modules → Enrolments → Users` (verified in `deleteLastMessage.py`), plus `JOIN Course_Modules ON Student_Modules.course_module_id = Course_Modules.module_id` and `Course_Concepts` for module context (the 6-table join in `sqsTrigger/src/main.py`). `Student_Modules` rows exist for every module at enrolment (`studentFunction` `enroll_student`), so all active modules appear even with zero chat sessions.
- **`studentFunction` uses `dbLambdaRole` and has no DynamoDB grant.** Defined `api-gateway-stack.ts` (`${id}-dbLambdaRole`); currently SecretsManager/EC2/Logs/X-Ray/Bedrock/SSM only. `ApiGatewayStack` already receives `ragStack` (constructor arg; `bin/cdk.ts` `addDependency`), and `ragStack.*` is already consumed — so wiring `ragStack.sessionStateTable` in needs no new coupling.
- **The read/aggregate helpers are Python.** `deserialize_state`, `calculate_mastery_profile` (demonstrations/exposures), `calculate_coverage` (discussed/total) are in `state_machine.py`. `studentFunction` is Node.js and cannot call them — the mastery math must be re-implemented in JS **or** delegated to a Python Lambda (§6 weighs this).
- **The AWS SDK is ambient in the Node 22 runtime.** `studentFunction.js` already imports `@aws-sdk/client-s3` from the runtime (not bundled) and constructs a client with `region: REGION` where `REGION` is unset — the SDK falls back to the Lambda-provided `AWS_REGION`. DynamoDB SDK (`@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`) is available the same way.

---

## 2. Principles

**2.1 Resolve keys in Postgres, read values in DynamoDB.** The only safe, index-free way to assemble course state: the scoped Postgres join yields the exact `session_id`s owned by this student for this course; DynamoDB is then read strictly by those keys. This is also the security boundary (§8) — we never read a `session_id` the student doesn't own.

**2.2 Read-only, side-effect-free.** Like `module_progress`: no writes to Postgres or DynamoDB.

**2.3 Return raw state + a derived summary.** "Complete data structure" means the raw per-session state is the payload's core (no lossy summarization). A `derived_summary` (mastery ratio, coverage, stage) is computed *entirely from* those raw sessions and layered on top for readability — it is a convenience view, not a second source of truth. **The chatbot's mastery calculations remain authoritative in Python (`state_machine.py`); the Node.js endpoint computes a read-only mirror for presentation/debugging purposes only** (§13).

**2.4 Least privilege for the new store.** `studentFunction` gets only `dynamodb:GetItem`/`BatchGetItem` on the one table ARN — no writes, no wildcards, no management actions (it doesn't create/describe tables).

**2.5 Debug trigger, durable endpoint.** The frontend piece is a `console.log` (no UI), explicitly temporary. The endpoint itself is a proper, reusable, authorized route (it can later back a real UI without change).

---

## 3. Goals / Non-Goals

**Goals**
- A read-only `GET /student/course_progress?email&course_id` returning the student's **complete** progress structure for the course: every active module with its Postgres context (score, status, topic list) and, per module, the raw `SessionState`(s) from DynamoDB plus a per-topic mastery aggregate.
- A frontend hook that fetches it and `console.log`s the full structure (debug), triggered from the existing **Progress** button.
- Least-privilege DynamoDB read wiring for `studentFunction`.

**Non-Goals (v1)**
- No new UI rendering of course progress (console only; a real dashboard is a follow-on).
- No instructor/cross-student analytics (this is the caller's own progress only).
- No new DynamoDB GSI, no schema change, no moving progress into Postgres.
- No change to how `chatbot_v2` writes state.

---

## 4. Design

### 4.1 New route — `GET /student/course_progress` (`OpenAPI_Swagger_Definition.yaml`)

Mirror the `module_progress` block: OPTIONS CORS mock + GET with `email`, `course_id` (both required), `security: [studentAuthorizer]`, `aws_proxy` → `${studentFunction.Arn}`, responses `200/400/401/404/429/500`.

### 4.2 Handler — Postgres join → DynamoDB batch-read → aggregate (`studentFunction.js`)

New `case "GET /student/course_progress"`. Add the route to the header route-index comment. Add module-level DynamoDB client setup (mirroring the existing `s3Client`): `const { DynamoDBClient } = require("@aws-sdk/client-dynamodb"); const { DynamoDBDocumentClient, BatchGetCommand } = require("@aws-sdk/lib-dynamodb");` + `SESSION_STATE_TABLE` from `process.env`.

**Step 1 — guard + resolve user** (as `module_progress`): require `email` + `course_id` → else 400; `email` cross-checked against authorizer already (401). Resolve `user_id` → 404 if unknown.

**Step 2 — one course-scoped Postgres query** (read-only): every active module + its sessions.
```text
SELECT
  cm.module_id, cm.module_name, cm.module_number, cm.generated_topics,
  cc.concept_name,
  sm.student_module_id, sm.module_score, sm.last_accessed,
  s.session_id, s.session_name
FROM "Enrolments" e
JOIN "Student_Modules" sm ON sm.enrolment_id = e.enrolment_id
JOIN "Course_Modules"  cm ON cm.module_id    = sm.course_module_id
JOIN "Course_Concepts" cc ON cc.concept_id   = cm.concept_id
LEFT JOIN "Sessions"   s  ON s.student_module_id = sm.student_module_id
WHERE e.user_id = ${userId}
  AND e.course_id = ${courseId}
  AND cc.course_id = ${courseId}     -- module belongs to this course (course reached via concept)
  AND cm.status = 'active'
ORDER BY cm.module_number, s.last_accessed;
```
> **Why join `Course_Concepts`:** it supplies `concept_name` *and* the course guard — `Course_Modules` has **no** `course_id` column (a module's course is reached via `concept_id → Course_Concepts.course_id`), so this join cannot be eliminated.

Empty result (not enrolled / no active modules) → `404`. The `LEFT JOIN "Sessions"` keeps modules with zero chat sessions (null `session_id`).

**Step 3 — batch-read DynamoDB state** for the distinct non-null `session_id`s (cap at `MAX_SESSIONS = 200` for a bounded debug read; note truncation in the payload if exceeded). `BatchGetCommand` in chunks of ≤100 keys; retry `UnprocessedKeys` a bounded number of times; a missing item (a session that never produced state) is simply omitted — that is **normal, not an error**, and is surfaced as a count (`missing_sessions`), not a failure flag. Build `session_id -> stateItem` (DocumentClient returns plain JS objects). Only a **hard** `BatchGetCommand` failure (throttle/exception that exhausts retries) sets `summary.state_read_error: true` and degrades to the Postgres structure with empty `sessions` — never a 500 for a debug view.

**Step 4 — assemble + aggregate (JS)**, grouped by module:
```text
module = {
  module_id, module_name, module_number, concept_name,
  module_score, last_accessed,
  status: module_score===100 ? "complete" : last_accessed ? "in_progress" : "incomplete",
  topics: generated_topics,                 // module vocabulary (may be double-encoded; returned raw)
  session_count,                            // sessions for this module in Postgres
  missing_sessions,                         // session_count - sessions.length (state not yet persisted)
  sessions: [ rawStateItem, ... ],          // full per-session SessionState — the AUTHORITATIVE raw state
  derived_summary: {                        // PURELY derived from `sessions` — convenience view, NOT a 2nd source (§2.3/§13)
    stage_max,                              // furthest stage across sessions (prior_knowledge<comprehension<application<mastery)
    engagement_max,                         // max parseFloat(engagement_score) across sessions
    interactions_total,                     // sum
    coverage,                               // |union(concepts_discussed)| / |module_concepts|
    concepts_demonstrated: [union...],
    concept_mastery: {                      // per concept, SUMMED across the module's sessions (never overwritten)
      "<concept>": { exposures, demonstrations, mastery_ratio: demonstrations/exposures||0, level: highest across sessions }
    }
  }
}
```
Course-level `summary`:
```text
{ modules_total, modules_complete,          // module_score === 100
  average_module_score,
  requested_sessions, returned_sessions, missing_sessions,   // DynamoDB read accounting (debug visibility)
  state_read_error: bool }                  // true ONLY if the DynamoDB batch read hard-failed (not for absent items)
```

> The `stage_max`, `level`-max, `mastery_ratio`, and `coverage` calculations are a **read-only JS mirror** of `state_machine.py::calculate_mastery_profile`/`calculate_coverage` + the `LEVEL_ORDER`/`Stage` orderings — they exist **solely for presentation/debugging convenience; the Python implementation stays the single source of truth**. ~15 lines of obvious arithmetic; the handler test pins them, and §13 records the drift risk.

**Response 200** shape:
```text
{ course_id, email, generated_at, truncated: bool,
  summary: { ...as above (counts + state_read_error)... },
  modules: [ ...each with session_count, missing_sessions, sessions[], derived_summary... ] }
```

### 4.3 Frontend — `useCourseProgress(course)` + console.log (debug trigger)

New `frontend/src/pages/student/useCourseProgress.js`:
```text
handleLogCourseProgress():
  const { email } = await apiClient.getAuth()
  const data = await apiClient.get("student/course_progress", { email, course_id: course.course_id })
  console.log("[course_progress] full structure:", data)     // TEMP DEBUG — remove before shipping
  // errors: console.error only (debug aid; no UI)
```
Wire it to the **existing Progress button** on `StudentChat.jsx`: its `onClick` keeps opening the module popover (unchanged) **and** fires `courseProgress.handleLogCourseProgress()` (fire-and-forget). No new UI. (Alternative trigger: `CourseView.jsx` on mount — noted, not chosen, to keep one affordance.)

### 4.4 CDK / infra (`api-gateway-stack.ts`) — one env var + one IAM statement

- Add `SESSION_STATE_TABLE: ragStack.sessionStateTable.tableName` to `studentFunction`'s `environment` (region resolves from the ambient `AWS_REGION`, as the existing S3 client relies on).
- Add to `dbLambdaRole` (read-only, explicit ARN, no wildcard):
```text
{ actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem"], resources: [ragStack.sessionStateTable.tableArn] }
```
No management actions (no `ListTables`/`CreateTable`/`DescribeTable`) — the handler only reads by key. This grant is also inherited by `instructorFunction` (shares `dbLambdaRole`); acceptable (read-only, same table) and noted in §13.

### 4.5 Edge cases

| Case | Behavior |
|---|---|
| Not enrolled / no active modules | `404`. |
| Enrolled, module with no sessions | Module present; `sessions: []`, `session_count: 0`, empty aggregate. |
| Session row exists but no DynamoDB item | Omitted from `sessions` (state never persisted); reflected in `missing_sessions` (per module + `summary`). **Not an error.** |
| DynamoDB batch read hard-fails | Degrade: Postgres structure returned, `sessions: []`, `summary.state_read_error: true` (no 500). |
| > `MAX_SESSIONS` sessions | Read first 200 (by recency); `truncated: true`. |
| `engagement_score` stored as string | `parseFloat` in the aggregate. |
| Cross-user `email` | `401` (existing authorizer-email check). |

---

## 5. Data Flow (after change)

```
Progress button click (StudentChat)
  → useCourseProgress: apiClient.get("student/course_progress", {email, course_id})
  → studentFunction  case "GET /student/course_progress":
       resolve user_id (404 if unknown)
       Postgres: ONE join (Enrolments⋈Student_Modules⋈Course_Modules⋈Course_Concepts ⟕ Sessions)
                 → active modules + score/topics + session_ids   (empty → 404)
       DynamoDB: BatchGetItem(session_ids, ≤100/chunk) on ragStack.sessionStateTable  (read-only)
       JS: group by module; DERIVE concept_mastery/coverage/stage_max FROM the raw sessions (sum, don't overwrite)
       → 200 { summary{...,requested/returned/missing_sessions,state_read_error}, modules:[ {..., sessions:[raw SessionState], derived_summary} ] }
  → console.log("[course_progress] full structure:", data)
```

---

## 6. Explicitly rejected alternatives

1. **`studentFunction` invokes `chatbot_v2` (Python) to read/aggregate.** Reuses the Python helpers (no JS math duplication), but overloads a chat-focused Docker Lambda with an analytics route, adds a Lambda-to-Lambda hop (latency + a `lambda:InvokeFunction` grant) and a new request contract. Rejected for v1: the aggregation is ~15 trivial lines; a JS mirror is cheaper than the coupling, and the Python implementation stays the source of truth (the JS mirror is convenience-only). (Revisit if the mastery math grows.)
2. **A dedicated Python analytics Lambda** (Postgres + DynamoDB + reuse helpers). Cleanest separation and no duplication, but a whole new function/role/route/image for a debug read — disproportionate now. The endpoint is designed so this migration stays a drop-in later.
3. **Add a DynamoDB GSI on `module_id`/`course_id`.** Would let us query state without the Postgres join, but requires writing those attributes on every state put (a `chatbot_v2` write change) + backfill, and the Postgres join is already the authorization boundary. Rejected.
4. **Project concept progress into Postgres** (extend `rds_projection.py`). A durable analytics store, but a real write-path + schema change well beyond a debug read; the current projection is explicitly transitional. Rejected for v1.
5. **Return only a summary (no raw states).** Contradicts the explicit ask for the *complete* data structure. Rejected.

---

## 7. Tasks

- [ ] **T1.** `OpenAPI_Swagger_Definition.yaml`: add `/student/course_progress` (OPTIONS + GET `email`/`course_id`, `studentAuthorizer`, `aws_proxy`). *Test: T6 YAML contract.*
- [ ] **T2.** `studentFunction.js`: DynamoDB client setup + `SESSION_STATE_TABLE` env read; `case "GET /student/course_progress"` (resolve user → join → `BatchGetCommand` with chunking + `UnprocessedKeys` retry + `MAX_SESSIONS` cap → group/aggregate → 200/400/404; DynamoDB failure degrades with `state_error`). Update route-index comment. *Test: T6 handler unit test.*
- [ ] **T3.** `api-gateway-stack.ts`: add `SESSION_STATE_TABLE` env to `studentFunction`; add `dynamodb:GetItem`/`BatchGetItem` statement (scoped to `ragStack.sessionStateTable.tableArn`) to `dbLambdaRole`. *Test: T7 IAM assertion.*
- [ ] **T4.** `frontend/src/pages/student/useCourseProgress.js` (new): fetch + `console.log`; wire to the StudentChat Progress button `onClick`. *Gate: ESLint.*
- [ ] **T5.** `frontend`: none beyond T4 (no UI); verify build/lint.
- [ ] **T6.** `cdk/test/student-course-progress.test.ts`: **(a)** OpenAPI YAML contract (route/params/security); **(b)** handler unit test — mock `sql` (join rows across 2 modules, one with 2 sessions, one with 0) + virtual-mock `@aws-sdk/client-dynamodb`/`@aws-sdk/lib-dynamodb` (`BatchGetCommand` returns state items). Assert: **cross-session concept merge** — the same concept in two sessions (e.g. `{exposures:3,demonstrations:1}` + `{exposures:2,demonstrations:2}`) merges to summed `{exposures:5, demonstrations:3, mastery_ratio:0.6}` with the highest `level` (proves summing, not overwriting); the rest of `derived_summary` (coverage, stage_max, union); **only the joined session_ids are requested** (scoping); read-only (no Put/Update commands used); accounting counts (`requested/returned/missing_sessions`); `404` (not enrolled), `400` (missing param), `401` (cross-user); DynamoDB hard-failure degrade (`state_read_error`, no throw).
- [ ] **T7.** `cdk/test/iam-policies.test.ts`: assert `dbLambdaRole` grants `dynamodb:GetItem`+`BatchGetItem` scoped to the sessionStateTable ARN, with **no** `dynamodb:*` and **no** `Resource: "*"` (new pattern → new test, per `iam-security-policy`).
- [ ] **T8.** Manual: press Progress → inspect the logged structure (modules, per-session `concept_progress`, aggregate); a module with no sessions logs empty aggregate; DynamoDB-off path still logs Postgres structure with `state_error`.

---

## 8. Security / Trust Boundary
Authorization unchanged (`studentAuthorizer` + `email === authorizer.email` → 401). **The DynamoDB reads are confined to `session_id`s returned by the scoped Postgres join for this `user_id` + `course_id`** — the student can only ever read their own sessions' state (no IDOR; the DynamoDB table has no listing/scan in this path). Inputs flow only into the auto-parameterized `sql` tagged template and into `BatchGetCommand` keys (no expression injection). Read-only end to end. New IAM surface is a single least-privilege statement (read actions, explicit table ARN, no wildcard), asserted in `iam-policies.test.ts`; it is inherited by `instructorFunction` (shared role) — acceptable as read-only, flagged in §13. The `console.log` exposes the student's own progress in their own browser only.

## 9. Observability
`studentFunction` has X-Ray active; the new path adds a DynamoDB subsegment (batch reads) automatically. Log (server-side) counts only — sessions requested vs. items found, `truncated`, `state_error` — not student content. No new metric pipeline for v1 (debug feature).

## 10. Acceptance Criteria
- **AC-1:** `GET /student/course_progress?email&course_id` returns `200` with `{summary, modules:[...]}` where each module carries Postgres context (score, status, topics) and, when sessions exist, `sessions:[raw SessionState]` + a `derived_summary` (computed from `sessions`) with per-concept `mastery_ratio`, `coverage`, `stage_max`.
- **AC-2:** Only `session_id`s from the scoped join are read from DynamoDB (verified in the unit test); a student cannot obtain another student's or another course's session state.
- **AC-3:** Read-only — no DynamoDB write/Put/Update and no Postgres write.
- **AC-4:** `400` (missing param), `401` (cross-user), `404` (not enrolled / no active modules); a module with zero sessions is present with an empty aggregate.
- **AC-5:** A DynamoDB batch-read hard-failure degrades to the Postgres structure with `summary.state_read_error: true` (no 500); individually absent items are counted in `missing_sessions` (not an error); `> MAX_SESSIONS` sets `truncated: true`.
- **AC-6:** `dbLambdaRole` grants only `dynamodb:GetItem`/`BatchGetItem` on the sessionStateTable ARN (no wildcard) — asserted in `iam-policies.test.ts`.
- **AC-7:** Pressing Progress logs the full structure via `console.log`; ESLint passes.
- **AC-8:** When the same concept appears in multiple sessions of a module, `derived_summary.concept_mastery` **sums** exposures and demonstrations across those sessions (never overwrites) and reports the highest level — e.g. `{exp:3,dem:1}` + `{exp:2,dem:2}` → `{exposures:5, demonstrations:3, mastery_ratio:0.6}`.

## 11. Test Strategy
`cd cdk && npm test` (Jest). New `cdk/test/student-course-progress.test.ts`: OpenAPI YAML contract (no Docker) + handler unit test with a mocked `sql` tagged template and **virtual-mocked** `@aws-sdk/client-dynamodb`/`@aws-sdk/lib-dynamodb` (same virtual-mock approach the module spec used for `@aws-sdk/client-s3`) — deterministic, no DB/DynamoDB/network. The `BatchGetCommand` mock records the requested keys so the scoping assertion (AC-2) is real, and fixtures the same concept in two sessions to prove cross-session summing (AC-8). Extend `iam-policies.test.ts` for the grant (AC-6) — this assertion runs within the existing Docker-requiring synth suite. Frontend is ESLint-only + the T8 manual check. Full `npm test` needs Docker (unchanged constraint).

## 12. Refinement history
- **Initial draft:** course-wide endpoint that joins Postgres for session_ids, batch-reads DynamoDB state, aggregates per module/course; Progress button logs it.
- **Internal pass — data model:** confirmed the table has no course/module index (partition key `session_id` only), so the Postgres-join-then-key-read design is the only index-free path — and doubles as the authorization boundary.
- **Internal pass — cross-language:** the Python mastery helpers aren't reachable from the Node handler; chose a small JS mirror over a Lambda-to-Lambda hop, and pinned it with the handler test (drift risk recorded in §13).
- **Internal pass — resilience/least-privilege:** added `BatchGetItem` chunking + `UnprocessedKeys` retry + `MAX_SESSIONS` cap; degrade-on-DynamoDB-error instead of 500; scoped the IAM grant to read-only on the one table ARN + a dedicated `iam-policies.test.ts` assertion.
- **Reviewer round 1:** renamed `aggregate` → `derived_summary` (documented as purely derived from `sessions`, not a second source of truth); replaced the global `state_error` with granular accounting (`requested/returned/missing_sessions`) + a `state_read_error` reserved strictly for a hard DynamoDB failure; strengthened the "Python is the source of truth, JS is a convenience mirror" wording (§2.3/§6/§13); added a cross-session concept-merge test (AC-8); clarified the `Course_Concepts` join is required (`Course_Modules` has no `course_id`).

## 13. Residual Risks / Open Items (honest notes)
- **JS mirror of Python mastery math (drift).** `mastery_ratio`/`coverage`/`stage_max` are re-implemented in JS from `state_machine.py`. **The JS aggregation exists solely for presentation/debugging convenience; the Python implementation remains the single source of truth for mastery.** They're tiny and test-pinned, but a future change to the Python definitions won't auto-propagate. If this becomes load-bearing (real UI), migrate to the "invoke Python" or "dedicated analytics Lambda" option (§6). **Decision to confirm.**
- **DynamoDB item-shape coupling.** The Node handler reads attribute names produced by Python `serialize_state` (`concept_progress`, `concepts_discussed`, `engagement_score`-as-string, …). A serialization change in `chatbot_v2` could silently change the payload. Mitigated by the handler test fixture matching the serialized shape.
- **Shared-role grant.** The read grant lands on `dbLambdaRole`, so `instructorFunction` also gains `sessionStateTable` read. Read-only and same table, but if strict separation is wanted, split the role (larger change) — flagged. **Decision to confirm.**
- **Cost/latency for large courses.** A course with many sessions means multiple `BatchGetItem` calls on button press; bounded by `MAX_SESSIONS=200` and on-demand billing. Fine for debug; revisit caching if it backs a real UI.
- **Console.log is temporary.** Like the module-progress debug log, `useCourseProgress` logs to the console and must be removed (or replaced by a real view) before shipping.
- **`generated_topics` vs. `module_concepts`.** The Postgres `generated_topics` and the DynamoDB `module_concepts` should be the same vocabulary; if they diverge for a module, coverage uses the DynamoDB `module_concepts` (what the chatbot actually tracked). Noted so the log isn't misread.
