# API & Database Optimization Analysis — Round 1

Post-implementation of P-1 through P-8 from `performance-improvements.md`. This analysis focuses on remaining optimization opportunities across API calls, DB queries, and AWS SDK calls.

## Summary of Current State

After P-1–P-8, the text generation pipeline is significantly improved. The remaining hotspots are:
- Redundant Cognito `AdminGetUser` calls on every API request (`studentFunction` and `instructorFunction`)
- N+1 query pattern in `student_modules_messages` (instructor endpoint)
- Sequential DB queries in `create_session`, `create_message`, `create_ai_message`, `delete_session`, and `module` endpoints (student chat flow)
- 4 sequential analytics queries that could be reduced to 3 parallel
- `course_page` engagement log silently never written (bug)
- Infinite retry loop in text generation on empty LLM response (reliability risk)

---

## OPT-1: Eliminate Redundant Cognito `AdminGetUser` on Every Request (High Impact)

### Current Behavior

Both `studentFunction.js` and `instructorFunction.js` call Cognito `AdminGetUser` at the top of every single handler invocation:

```javascript
// Runs on EVERY request — before any routing
const client = new CognitoIdentityProviderClient();
const userAttributesCommand = new AdminGetUserCommand({
  UserPoolId: USER_POOL,
  Username: cognito_id,
});
const userAttributesResponse = await client.send(userAttributesCommand);
const emailAttr = userAttributesResponse.UserAttributes.find(
  (attr) => attr.Name === "email"
);
```

This adds ~30-80ms per API request (Cognito API call through NAT Gateway). It's used solely to get the user's email for an authorization check — verifying the `email` query parameter matches the authenticated user.

### Deep Dive Verification

**Confirmed in both handlers**: `studentFunction.js` (line 12-24) and `instructorFunction.js` (line 11-23) have identical patterns. Both create a new `CognitoIdentityProviderClient` inside the handler (not at module level) and call `AdminGetUser` before any routing.

**Purpose**: The email is used for an authorization check that compares the query parameter email against the authenticated user's email. In `studentFunction.js`, it checks `email`, `student_email`, and `user_email` query params. In `instructorFunction.js`, it checks `email` and `instructor_email`. Almost every endpoint passes one of these — the Cognito call is exercised on virtually all requests.

**The JWT already has the email**: All three authorizers use `tokenUse: "id"` with `CognitoJwtVerifier`. Cognito ID tokens contain the `email` claim as a standard attribute. The user pool is configured with `signInAliases: { email: true }`, so email is always present. The `payload` object from `jwtVerifier.verify()` has `payload.email` available but only `payload.sub` is currently passed in the authorizer context.

**Authorizer context mechanism**: The authorizers set `responseStruct["context"] = { "userId": payload.sub }`. API Gateway passes this context to the backend Lambda via `event.requestContext.authorizer`. Context values must be strings/numbers/booleans, total limit 1600 bytes. An email address is well within limits.

**Authorizer caching**: No explicit `authorizerResultTtlInSeconds` is configured in the OpenAPI spec, so the default 300-second cache applies. The cached response includes the context. Adding `email` to the context is safe — it's from the same JWT and doesn't change during the cache window.

**`adminFunction.js` does NOT have this pattern** — confirmed. It doesn't import `CognitoIdentityProviderClient` or call `AdminGetUser`.

### Recommended Change

Modify all three authorizers to pass the email in the context:

```javascript
// In all three authorizer functions (admin, student, instructor):
responseStruct["context"] = {
  "userId": payload.sub,
  "email": payload.email,  // ← add this
};
```

Then in `studentFunction.js` and `instructorFunction.js`, replace the entire Cognito block:

```javascript
// BEFORE (lines 12-24 in both files):
const cognito_id = event.requestContext.authorizer.userId;
const client = new CognitoIdentityProviderClient();
const userAttributesCommand = new AdminGetUserCommand({
  UserPoolId: USER_POOL,
  Username: cognito_id,
});
const userAttributesResponse = await client.send(userAttributesCommand);
const emailAttr = userAttributesResponse.UserAttributes.find(
  (attr) => attr.Name === "email"
);
const userEmailAttribute = emailAttr ? emailAttr.Value : null;

// AFTER:
const userEmailAttribute = event.requestContext.authorizer.email;
```

Also remove from both files:
- The `CognitoIdentityProviderClient` and `AdminGetUserCommand` imports
- The `USER_POOL` environment variable reference (no longer needed)

And remove the `USER_POOL` environment variable from the CDK Lambda definitions for `studentFunction` and `instructorFunction` (in `api-gateway-stack.ts`).

### Impact

- Eliminates 1 Cognito API call (~30-80ms) per request for `studentFunction` and `instructorFunction`
- Eliminates `CognitoIdentityProviderClient` instantiation (~5-10ms) per request
- Removes the `@aws-sdk/client-cognito-identity-provider` dependency from both Lambda packages
- Every student chat interaction hits `studentFunction` multiple times (create_message, create_session, update_session_name, update_module_score, create_ai_message) — this saves 150-400ms across a single chat exchange

### Risk Assessment

- **Breaking changes**: None. The email comes from the same cryptographically verified JWT token. The authorizer context is a standard API Gateway mechanism already in use for `userId`.
- **Security**: No regression. The email claim in the ID token is verified by `aws-jwt-verify` the same way `sub` is.
- **Authorizer cache**: The email is part of the JWT and doesn't change during the 300-second cache window. No staleness risk.
- **Endpoints without email params**: A few endpoints (like `get_messages`, `enroll_student`) use different param names. The authorization check uses short-circuit evaluation — if no email param is present, `isUnauthorized` is `false` and the check passes. The Cognito call was wasted on these endpoints before; now it's simply not made.

---

## OPT-2: Fix N+1 Query in `student_modules_messages` (High Impact)

### Current Behavior

`GET /instructor/student_modules_messages` in `instructorFunction.js` runs:

```
Query 1: Get user_id from email
Query 2: Get all student modules for a course
For each module (N):
  Query: Get sessions for this module (with nested subqueries for enrolment)
  For each session (M):
    Query: Get messages for this session
```

For a student with 5 modules and 3 sessions each: 2 + 5 + 15 = **22 queries**.

### Deep Dive Verification

**Code confirmed** (`instructorFunction.js`, lines ~1100-1190): The N+1 pattern is exactly as described. Two nested `for` loops, each executing a separate SQL query per iteration.

**Frontend consumption** (`StudentDetails.jsx`):
- `setSessions(data)` — response set directly as state
- `Object.keys(data)` — module names become tab labels (order matters)
- `sessions[tabs[activeTab]]` — array of sessions for active tab
- Each session: `session.sessionName` (accordion header) + `session.messages` array
- Each message: `message.student_sent`, `message.message_content`, `message.time_sent`

Expected response structure:
```json
{
  "Module Name A": [
    { "sessionName": "Session 1", "messages": [{ "student_sent": true, "message_content": "...", "time_sent": "..." }] }
  ],
  "Module Name B": []
}
```

**FK relationships verified** (`initializer.py`):
- `Student_Modules.course_module_id` → `Course_Modules.module_id` ✓
- `Course_Modules.concept_id` → `Course_Concepts.concept_id` ✓
- `Student_Modules.enrolment_id` → `Enrolments.enrolment_id` ✓
- `Sessions.student_module_id` → `Student_Modules.student_module_id` ✓
- `Messages.session_id` → `Sessions.session_id` ✓

This is the same JOIN path the current N+1 queries use individually.

**Precedent**: The `view_student_messages` endpoint in the same file already does a single JOIN across `Messages → Sessions → Student_Modules → Enrolments` for the same student/course. It works correctly. The `student_modules_messages` endpoint just needs the same approach with module/session grouping.

### Recommended Change

Replace with 2 queries:

```javascript
// Query 1: Keep user_id lookup for 404 check
const userResult = await sqlConnection`
  SELECT user_id FROM "Users" WHERE user_email = ${studentEmail} LIMIT 1;
`;
const userId = userResult[0]?.user_id;
if (!userId) {
  response.statusCode = 404;
  response.body = JSON.stringify({ error: "Student not found" });
  break;
}

// Query 2: Single query for all modules, sessions, and messages
const rows = await sqlConnection`
  SELECT cm.module_name, cm.module_number, cc.concept_number,
         s.session_id, s.session_name,
         m.student_sent, m.message_content, m.time_sent
  FROM "Student_Modules" sm
  JOIN "Course_Modules" cm ON sm.course_module_id = cm.module_id
  JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
  JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
  LEFT JOIN "Sessions" s ON s.student_module_id = sm.student_module_id
  LEFT JOIN "Messages" m ON m.session_id = s.session_id
  WHERE e.user_id = ${userId} AND e.course_id = ${courseId}
  ORDER BY cc.concept_number, cm.module_number, s.session_id, m.time_sent;
`;

// Group flat rows into the nested structure the frontend expects
const result = {};
for (const row of rows) {
  // Initialize module key on first occurrence (preserves ORDER BY insertion order)
  if (!result[row.module_name]) {
    result[row.module_name] = [];
  }
  // Skip null sessions (module with no sessions)
  if (!row.session_id) continue;

  const moduleArr = result[row.module_name];
  let session = moduleArr.find(s => s._sid === row.session_id);
  if (!session) {
    session = { _sid: row.session_id, sessionName: row.session_name, messages: [] };
    moduleArr.push(session);
  }
  // Skip null messages (session with no messages)
  if (row.message_content !== null) {
    session.messages.push({
      student_sent: row.student_sent,
      message_content: row.message_content,
      time_sent: row.time_sent,
    });
  }
}

// Remove internal _sid before sending response
for (const moduleName of Object.keys(result)) {
  result[moduleName] = result[moduleName].map(({ _sid, ...rest }) => rest);
}

response.body = JSON.stringify(result);
```

### Edge Cases Verified

- **Module with no sessions**: LEFT JOIN on Sessions produces one row with `session_id = NULL`. The `if (!row.session_id) continue` skips it, but the module key is already initialized as `[]`. Frontend shows "Student has not entered the module yet." ✓
- **Session with no messages**: LEFT JOIN on Messages produces one row with `message_content = NULL`. The `if (row.message_content !== null)` check skips it. Session is added with empty messages array. ✓
- **Module ordering**: `ORDER BY cc.concept_number, cm.module_number` matches the original Step 2 query. `Object.keys(result)` preserves insertion order in modern JS engines. ✓
- **Duplicate module names across concepts**: Current code overwrites with `result[module.module_name] = []` in the loop. Combined query merges into one key. Same behavior. ✓
- **User not found**: Separate first query returns 404. ✓

### Impact

- Reduces 22+ queries to 2 for a typical student
- Saves ~200-500ms per request (20 × 10-25ms per round-trip)
- This endpoint is used when an instructor views a student's chat history (StudentDetails page)

### Risk Assessment

- **Low risk.** The JOIN path is identical to the original subqueries and already proven by the `view_student_messages` endpoint. The grouping logic is straightforward. All edge cases produce the same output as the current code.

---

## OPT-3: Reduce Sequential Queries in Student Chat Flow Endpoints (Medium Impact)

### Deep Dive Verification

The same pattern repeats across 6 student endpoints. Each one does some combination of:
1. `SELECT user_id FROM "Users" WHERE user_email = ?` — user lookup
2. Core operation (INSERT message, SELECT sessions, etc.)
3. `SELECT enrolment_id FROM "Enrolments" WHERE user_id = ? AND course_id = ?` — re-fetch enrolment
4. `INSERT INTO "User_Engagement_Log" ...` — engagement logging

Steps 3-4 appear in: `create_message`, `create_ai_message`, `create_session`, `delete_session`, `module`, and `update_module_score`.

The `enrolment_id` re-fetch (step 3) is the main waste. In `create_session` and `module`, step 2 already queries the `Enrolments` table via a subquery but doesn't return `enrolment_id` — it's used only in the WHERE clause. Returning it from the existing query eliminates the separate fetch.

### `POST /student/create_message` — 5 queries → 3

Current flow:
1. INSERT message → `Messages` (needed, returns response data)
2. UPDATE `Sessions.last_accessed` (needed)
3. SELECT `user_id` from `Users` by email (needed for engagement log)
4. SELECT `enrolment_id` from `Enrolments` (redundant — can combine with step 3)
5. INSERT into `User_Engagement_Log` (needed, but can use INSERT...SELECT)

**Recommended change**: Replace steps 3-5 with a single INSERT...SELECT:

```javascript
// Steps 1-2 unchanged

// Replace steps 3-5 with one query
await sqlConnection`
  INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
  SELECT uuid_generate_v4(), e.user_id, ${courseId}, ${moduleId}, e.enrolment_id, CURRENT_TIMESTAMP, 'message creation'
  FROM "Enrolments" e
  JOIN "Users" u ON e.user_id = u.user_id
  WHERE u.user_email = ${studentEmail} AND e.course_id = ${courseId}
  LIMIT 1;
`;
```

This is safe because the engagement log insert is fire-and-forget — if the user/enrolment doesn't exist, the INSERT...SELECT inserts 0 rows silently. The current code already handles this with `if (userId)` and `if (enrolmentId)` guards.

**Same fix applies to `create_ai_message`** — identical code structure, same 5→3 reduction.

### `POST /student/create_session` — 6 queries → 4

Current flow:
1. SELECT `user_id` from `Users` (needed for 404 check)
2. SELECT `student_module_id` from `Student_Modules` with enrolment subquery (needed for 404 check)
3. UPDATE `Student_Modules.last_accessed` (needed)
4. INSERT into `Sessions` (needed, returns response data)
5. SELECT `enrolment_id` from `Enrolments` (redundant — already in step 2's subquery)
6. INSERT into `User_Engagement_Log` (needed)

**Recommended change**: Return `enrolment_id` from step 2 instead of re-fetching in step 5:

```javascript
// Step 2: Return enrolment_id alongside student_module_id
const studentModuleData = await sqlConnection`
  SELECT sm.student_module_id, e.enrolment_id
  FROM "Student_Modules" sm
  JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
  WHERE sm.course_module_id = ${moduleId}
    AND e.user_id = ${userId} AND e.course_id = ${courseId};
`;
const studentModuleId = studentModuleData[0]?.student_module_id;
const enrolmentId = studentModuleData[0]?.enrolment_id;
```

Then use `enrolmentId` directly in step 6, eliminating step 5 entirely. Reduces 6→5.

### `GET /student/module` — 6 queries → 5

Identical pattern to `create_session`. Step 2 has the same subquery, step 5 re-fetches `enrolment_id`. Same fix: return `enrolment_id` from step 2, eliminate step 5.

### `DELETE /student/delete_session` — 5 queries → 4

Same pattern. Step 4 fetches `enrolment_id` separately. Can be combined with step 1 or use INSERT...SELECT for the engagement log.

### Combined Impact

These endpoints are called during every chat interaction:
- `create_session` — once per new chat
- `create_message` — every student message
- `create_ai_message` — every AI response
- `module` — when entering a module
- `update_module_score` — every message (checks verdict)

Per chat exchange (student sends message + receives response):
- `create_message`: 5→3 (saves ~20-40ms)
- `create_ai_message`: 5→3 (saves ~20-40ms)
- `update_module_score`: already has the pattern but the user_id lookup is needed for the 404 check

Total savings per chat exchange: ~40-80ms. For a new chat session (includes `create_session` + `module`): ~60-120ms additional.

### Risk Assessment

- **INSERT...SELECT**: Standard SQL, supported by the `postgres` library (porsager/postgres). If the user/enrolment doesn't exist, 0 rows are inserted — same behavior as the current `if (userId)` / `if (enrolmentId)` guards.
- **Returning enrolment_id from step 2**: Changes the query from a subquery-in-WHERE to an explicit JOIN. The JOIN is equivalent and returns the same `student_module_id`. Adding `enrolment_id` to the SELECT is a trivial change.
- **Engagement log is non-critical**: If the engagement log INSERT fails, it shouldn't block the response. The current code doesn't check the INSERT result. The INSERT...SELECT approach maintains this behavior.

---

## OPT-4: Combine and Parallelize Analytics Queries (Medium Impact)

### Deep Dive Verification

`GET /instructor/analytics` in `instructorFunction.js` runs 4 sequential queries:

1. `messageCreations` — message counts per module (joins through `Course_Modules → Student_Modules → Sessions → Messages → Enrolments → Users`)
2. `moduleAccesses` — engagement log access counts per module (joins through `Course_Modules → User_Engagement_Log → Enrolments → Users`)
3. `averageScores` — average module scores (joins through `Course_Modules → Student_Modules → Enrolments → Users`)
4. `perfectScores` — perfect score percentages (joins through `Course_Modules → Student_Modules → Enrolments → Users`)

**Queries 3 and 4 are identical** except for the SELECT aggregation — same FROM, JOIN, WHERE, and GROUP BY. Trivially combinable into one query.

**Queries 1 and 2 use different JOIN paths** — query 1 goes through `Sessions → Messages`, query 2 goes through `User_Engagement_Log`. Can't be combined into a single query without a complex CTE. But they're independent and can run in parallel.

**Frontend consumption** (`InstructorAnalytics.jsx`): Uses `module_name`, `message_count`, `access_count`, `perfect_score_percentage`. Does NOT render `average_score` — but it's returned in the response and should be kept for API compatibility.

**`Promise.all` is already used** in the codebase (`adminFunction.js`, `studentFunction.js`, `instructorFunction.js`) for parallel operations. The `postgres` library returns promises from tagged template queries.

### Recommended Change

Combine queries 3+4, then run all three remaining queries in parallel:

```javascript
const [messageCreations, moduleAccesses, scoreData] = await Promise.all([
  // Query 1: message counts (unchanged)
  sqlConnection`
    SELECT cm.module_id, cm.module_name, COUNT(m.message_id) AS message_count,
           cm.module_number, cc.concept_number
    FROM "Course_Modules" cm
    JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
    LEFT JOIN "Student_Modules" sm ON cm.module_id = sm.course_module_id
    LEFT JOIN "Sessions" s ON sm.student_module_id = s.student_module_id
    LEFT JOIN "Messages" m ON s.session_id = m.session_id
    LEFT JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
    LEFT JOIN "Users" u ON e.user_id = u.user_id
    WHERE cc.course_id = ${courseId}
    AND 'student' = ANY(u.roles)
    GROUP BY cm.module_id, cm.module_name, cm.module_number, cc.concept_number
    ORDER BY cc.concept_number ASC, cm.module_number ASC;
  `,

  // Query 2: access counts (unchanged)
  sqlConnection`
    SELECT cm.module_id, COUNT(uel.log_id) AS access_count
    FROM "Course_Modules" cm
    JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
    LEFT JOIN "User_Engagement_Log" uel ON cm.module_id = uel.module_id
    LEFT JOIN "Enrolments" e ON uel.enrolment_id = e.enrolment_id
    LEFT JOIN "Users" u ON e.user_id = u.user_id
    WHERE cc.course_id = ${courseId}
    AND uel.engagement_type = 'module access'
    AND 'student' = ANY(u.roles)
    GROUP BY cm.module_id;
  `,

  // Query 3+4 combined: scores
  sqlConnection`
    SELECT cm.module_id,
      AVG(sm.module_score) AS average_score,
      CASE
        WHEN COUNT(sm.student_module_id) = 0 THEN 0
        ELSE COUNT(CASE WHEN sm.module_score = 100 THEN 1 END) * 100.0 / COUNT(sm.student_module_id)
      END AS perfect_score_percentage
    FROM "Course_Modules" cm
    JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
    LEFT JOIN "Student_Modules" sm ON cm.module_id = sm.course_module_id
    LEFT JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
    LEFT JOIN "Users" u ON e.user_id = u.user_id
    WHERE cc.course_id = ${courseId}
    AND 'student' = ANY(u.roles)
    GROUP BY cm.module_id;
  `,
]);

// Combine results (same logic as before, just scoreData replaces both averageScores and perfectScores)
const analyticsData = messageCreations.map((module) => {
  const accesses = moduleAccesses.find((ma) => ma.module_id === module.module_id) || {};
  const scores = scoreData.find((s) => s.module_id === module.module_id) || {};

  return {
    module_id: module.module_id,
    module_name: module.module_name,
    concept_number: module.concept_number,
    module_number: module.module_number,
    message_count: module.message_count || 0,
    access_count: accesses.access_count || 0,
    average_score: parseFloat(scores.average_score) || 0,
    perfect_score_percentage: parseFloat(scores.perfect_score_percentage) || 0,
  };
});
```

### Impact

- Current: 4 sequential queries × ~15ms = ~60ms
- After: 3 parallel queries, wall clock = max(~15ms each) = ~15ms
- Saves ~45ms per analytics page load (better than the original ~15ms estimate from just combining 3+4)
- Low frequency endpoint (instructor-only), but the improvement is essentially free

### Risk Assessment

- **Query 3+4 combination**: Zero risk. Identical FROM/JOIN/WHERE/GROUP BY, just two aggregations in one SELECT instead of two separate queries.
- **Parallel execution**: The `postgres` library uses a connection pool internally. Three concurrent queries on the same pool is standard usage. RDS Proxy handles concurrent connections from the same Lambda.
- **Response structure**: Unchanged. The combining logic produces the same output object. The `.find()` lookups work the same whether the data comes from separate arrays or a combined one.

---

## OPT-5: Repeated `user_id` Lookups by Email — No Practical Optimization

### Deep Dive Verification

Nearly every endpoint in `studentFunction.js` (~10 occurrences) and `instructorFunction.js` (~10 occurrences) starts with:

```javascript
const userResult = await sqlConnection`
  SELECT user_id FROM "Users" WHERE user_email = ${email} LIMIT 1;
`;
```

**Why it exists**: The frontend passes `email` as a query parameter, but the DB uses `user_id` (UUID, auto-generated by `uuid_generate_v4()`) as the FK everywhere. The DB `user_id` is NOT the Cognito `sub` — they're completely separate UUIDs. There's no way to derive the DB `user_id` from the JWT token without a DB lookup.

**Already indexed**: `user_email` has a `UNIQUE` constraint in the schema, which automatically creates a B-tree index in PostgreSQL. The query is a fast index scan. The ~5ms per call is RDS Proxy round-trip overhead, not query execution time.

### Options Evaluated

- **Cache user_id in authorizer context**: Authorizers are outside VPC (P-3), can't query the DB. Dead end.
- **Cache user_id in Lambda global scope**: Lambda containers serve one request at a time but may serve different users. An in-memory `email → user_id` map would help if the same student sends multiple messages to the same container, but hit rate is unpredictable and the savings (~5ms per hit) are minimal.
- **Pass user_id from frontend**: Frontend has the Cognito `sub`, not the DB `user_id`. Different UUIDs. Would require schema changes.
- **Use email as FK instead of user_id**: Massive schema redesign. Not justified for ~5ms savings.
- **Add cognito_sub column to Users**: Same ~5ms round-trip, just a different lookup column. No improvement.

### Conclusion

The ~5ms indexed lookup is the minimum cost of translating email → user_id. No practical optimization exists without schema changes that aren't justified by the savings. The real win was OPT-3, which eliminates the redundant `enrolment_id` re-fetch that follows this lookup in most endpoints.

**No action needed.** Accept the ~5ms cost per request.

---

## OPT-6: `CognitoIdentityProviderClient` Created on Every Invocation — Moot (Removed by OPT-1)

### Deep Dive Verification

In both `studentFunction.js` and `instructorFunction.js`, `CognitoIdentityProviderClient` is:
- Imported at the top of the file
- Instantiated inside the handler on every invocation (`const client = new CognitoIdentityProviderClient()`)
- Used exactly once — for the `AdminGetUser` call that OPT-1 eliminates
- Not used anywhere else in either file

### Conclusion

**No standalone action needed.** When OPT-1 is implemented (pass email from authorizer context), the entire Cognito client — the import, the instantiation, the `AdminGetUserCommand`, and the `USER_POOL` environment variable — are all removed. OPT-6 is fully subsumed by OPT-1.


---

## OPT-7: `course_page` Endpoint — Engagement Log Never Written (Bug Fix)

### Deep Dive Verification

`GET /student/course_page` in `studentFunction.js` has two bugs that cancel each other out, resulting in the "course access" engagement log never being written.

**Bug 1 — Wrong column name**: The INSERT uses `user_email`, but the `User_Engagement_Log` table has `user_id` (uuid FK → Users). There is no `user_email` column. This would cause a PostgreSQL error: `column "user_email" of relation "User_Engagement_Log" does not exist`.

```javascript
// Bug: user_email is not a column in User_Engagement_Log
await sqlConnection`
  INSERT INTO "User_Engagement_Log" (log_id, user_email, course_id, module_id, enrolment_id, timestamp, engagement_type)
  VALUES (uuid_generate_v4(), ${studentEmail}, ${courseId}, null, ${enrolmentId}, CURRENT_TIMESTAMP, 'course access');
`;
```

**Bug 2 — `enrolmentId` is always undefined**: The code tries to extract `enrolment_id` from the CTE query result:

```javascript
const enrolmentId = data[0]?.enrolment_id;
```

But the CTE query's SELECT clause does not include `enrolment_id` — it selects `concept_id`, `concept_name`, `module_id`, `module_name`, `module_number`, `student_module_id`, `module_score`, `last_accessed`, `module_context_embedding`. So `data[0]?.enrolment_id` is always `undefined`, the `if (enrolmentId)` check is always `false`, and the INSERT never executes.

**Result**: The "course access" engagement log entry is silently never written. This is a data loss bug — instructors relying on engagement analytics won't see course access events.

**No other occurrences**: Checked all other engagement log inserts across the codebase. Only this one uses `user_email`. All others correctly use `user_id`. The `adminFunction.js` has a similar line but it's commented out.

### Recommended Change

Fix both bugs:

1. Add `enrolment_id` to the CTE query's SELECT (it's available from the `StudentEnrollment` CTE):

```javascript
data = await sqlConnection`
  WITH StudentEnrollment AS (
    SELECT "Enrolments".enrolment_id
    FROM "Enrolments"
    WHERE "Enrolments".user_id = ${userId}
      AND "Enrolments".course_id = ${courseId}
    LIMIT 1
  )
  SELECT
    "Course_Concepts".concept_id,
    "Course_Concepts".concept_name,
    "Course_Modules".module_id,
    "Course_Modules".module_name,
    "Course_Modules".module_number,
    "Student_Modules".student_module_id,
    "Student_Modules".module_score,
    "Student_Modules".last_accessed,
    "Student_Modules".module_context_embedding,
    StudentEnrollment.enrolment_id
  FROM "Course_Concepts"
  JOIN "Course_Modules" ON "Course_Modules".concept_id = "Course_Concepts".concept_id
  LEFT JOIN "Student_Modules" ON "Student_Modules".course_module_id = "Course_Modules".module_id
  JOIN StudentEnrollment ON "Student_Modules".enrolment_id = StudentEnrollment.enrolment_id
  WHERE "Course_Concepts".course_id = ${courseId}
  ORDER BY "Course_Modules".module_number;
`;
```

2. Fix the INSERT to use `user_id` instead of `user_email`:

```javascript
const enrolmentId = data[0]?.enrolment_id;
if (enrolmentId) {
  await sqlConnection`
    INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
    VALUES (uuid_generate_v4(), ${userId}, ${courseId}, null, ${enrolmentId}, CURRENT_TIMESTAMP, 'course access');
  `;
}
```

Alternatively, use the INSERT...SELECT pattern from OPT-3 to avoid the `enrolmentId` extraction entirely:

```javascript
await sqlConnection`
  INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
  SELECT uuid_generate_v4(), e.user_id, ${courseId}, null, e.enrolment_id, CURRENT_TIMESTAMP, 'course access'
  FROM "Enrolments" e
  WHERE e.user_id = ${userId} AND e.course_id = ${courseId}
  LIMIT 1;
`;
```

### Frontend Impact

Adding `enrolment_id` to the CTE query result means the frontend receives an extra field in each row. The frontend (`CourseView.jsx`) doesn't use `enrolment_id` — it only reads `concept_id`, `concept_name`, `module_id`, `module_name`, `module_number`, `student_module_id`, `module_score`, `last_accessed`. The extra field is ignored. No frontend changes needed.

### Risk Assessment

- **Bug fix, not optimization**: This restores missing engagement data. No performance impact (the INSERT was never executing before).
- **Schema verified**: `User_Engagement_Log` has `user_id` (uuid FK → Users), not `user_email`. All other inserts in the codebase use `user_id` correctly.
- **Frontend safe**: Extra `enrolment_id` field in the response is ignored by the frontend.

---

## OPT-8: `while not response` Infinite Loop in Text Generation (Reliability + Cost Risk)

### Deep Dive Verification

In `chat.py`, `get_response()`:

```python
response = ""
while not response:
    response = generate_response(conversational_rag_chain, query, session_id)
```

`generate_response` calls `conversational_rag_chain.invoke(...)["answer"]` — the full RAG chain including LLM calls, retrieval, and DynamoDB history read/write.

**When does the LLM return empty?**
- Bedrock Llama 3 70B can return empty strings if the prompt triggers only a stop token. Rare but documented.
- Bedrock Claude 3 Sonnet almost never returns empty.
- Network/timeout errors throw exceptions (not caught by the loop — they propagate to the handler's try/except and return 500). The loop only retries on empty string responses.

**What happens on each retry:**

Each iteration of the `while` loop runs the FULL RAG chain:
1. DynamoDB read — loads chat history (~20-50ms)
2. Bedrock LLM Call #1 — history-aware retriever (~2-8s)
3. Bedrock embedding + hybrid search (~0.5-2s)
4. Bedrock LLM Call #2 — RAG response (~2-10s)
5. DynamoDB write — saves the student's message + the empty AI response to history

**Critical issue: each retry corrupts the chat history.** `RunnableWithMessageHistory` appends the human message and the AI response (even if empty) to DynamoDB on every invocation. So retry 2 sees the student's message duplicated + an empty AI response from retry 1. Retry 3 sees it tripled. The history grows with garbage on each iteration.

**Cost of runaway retries:**
- Lambda timeout: 300 seconds
- Each retry: ~5-20 seconds
- Maximum retries before timeout: ~15-60
- Each retry costs: 1 Bedrock embedding call + 2 Bedrock LLM calls + DynamoDB read/write
- Worst case: ~120 Bedrock LLM calls before the Lambda times out

### Recommended Change

Replace the infinite loop with a retry limit and a user-friendly fallback:

```python
response = ""
max_retries = 3
for attempt in range(max_retries):
    response = generate_response(
        conversational_rag_chain,
        query,
        session_id
    )
    if response:
        break
    logger.warning(f"Empty response from LLM on attempt {attempt + 1}/{max_retries}")

if not response:
    logger.error(f"LLM returned empty response after {max_retries} attempts")
    response = "I'm sorry, I wasn't able to generate a response. Please try again."
```

3 retries is generous — if the LLM returns empty 3 times in a row, a 4th attempt is unlikely to succeed. The fallback message lets the student know something went wrong without a 500 error.

**Note on chat history corruption**: Even with 3 retries, the history gets 2 extra entries (the duplicated human message + empty AI response from the failed attempts). A more robust fix would be to not use `RunnableWithMessageHistory` for retries — instead, manage history manually and only write on success. But that's a larger refactor. The retry limit alone prevents the worst-case scenario.

### Impact

- Prevents runaway Lambda execution (300s timeout) and runaway Bedrock costs
- Prevents chat history corruption beyond 2 extra entries (vs unlimited with current code)
- Provides a user-friendly fallback instead of a timeout error
- Not a latency optimization — this is a reliability and cost safeguard

### Risk Assessment

- **Fallback message**: The student sees "I'm sorry, I wasn't able to generate a response. Please try again." instead of waiting for a timeout. This is better UX than the current behavior (spinner for 5 minutes, then error).
- **3 retries**: If the LLM consistently returns empty for a specific prompt, 3 retries add ~15-60 seconds before the fallback. This is acceptable — the alternative is 5 minutes of retries.
- **Chat history**: The 2 extra entries from failed retries are minor corruption. The student can use the "delete last message" feature to clean up, or start a new session.

---

## OPT-9: N+1 Metadata Query in `getFilesFunction` (Low Impact)

### Deep Dive Verification

`getFilesFunction.py` lists files from S3, then for each file makes a separate DB query to fetch metadata:

```python
for file_name in document_files:
    file_type = file_name.split('.')[-1]
    presigned_url = generate_presigned_url(BUCKET, f"{document_prefix}{file_name}")
    metadata = get_file_metadata_from_db(module_id, file_name.split('.')[0], file_type)
```

Each call to `get_file_metadata_from_db` opens a cursor, executes `SELECT metadata FROM "Module_Files" WHERE module_id = %s AND filename = %s AND filetype = %s`, fetches one row, and closes the cursor. For a module with 10 files, that's 10 sequential DB round-trips.

**Schema verified** (`Module_Files`): Has `module_id`, `filename`, `filetype`, `metadata` columns. A single `SELECT filename, filetype, metadata FROM "Module_Files" WHERE module_id = %s` returns all files for the module.

**Filename splitting bug found**: The current code uses `file_name.split('.')[0]` to strip the extension. This breaks for filenames with dots (e.g., `my.report.v2.pdf` → `my` instead of `my.report.v2`). The data ingestion code (`data_ingestion/src/main.py`) correctly uses `rsplit('.', 1)` when inserting into the DB. The batch fix should use `rsplit` too.

**S3 vs DB mismatch handling**: S3 listing is the source of truth for which files exist. If a file exists in S3 but not in the DB (metadata not set), the batch query returns no row for it — `dict.get()` returns `None`, same as the current per-file query. If a file exists in the DB but not in S3 (stale DB record), the extra metadata is fetched but never used. No behavioral difference.

### Recommended Change

Replace the per-file DB query with a single batch query:

```python
# Fetch all metadata for the module in one query
connection = connect_to_db()
cur = connection.cursor()
cur.execute(
    'SELECT filename, filetype, metadata FROM "Module_Files" WHERE module_id = %s;',
    (module_id,)
)
all_metadata = {f"{row[0]}.{row[1]}": row[2] for row in cur.fetchall()}
cur.close()

# Then in the loop — no DB call per file
for file_name in document_files:
    presigned_url = generate_presigned_url(BUCKET, f"{document_prefix}{file_name}")
    metadata = all_metadata.get(file_name)  # O(1) dict lookup
    document_files_urls[file_name] = {
        "url": presigned_url,
        "metadata": metadata,
    }
```

This also fixes the filename splitting bug — the dict key is `filename.filetype` from the DB (correctly stored via `rsplit`), matched directly against the S3 file name.

The `get_file_metadata_from_db` function can be removed since it's no longer called.

### Impact

- Reduces N DB queries to 1. For a module with 10 files, saves ~90ms (9 × ~10ms round-trip).
- Fixes the pre-existing filename splitting bug for files with dots in the name.
- Low frequency endpoint — called when an instructor views/edits module files.

### Risk Assessment

- **Zero risk for the batch query.** Same data, single query, dict lookup instead of per-file query.
- **Filename bug fix**: Changes behavior for files with dots in the name (e.g., `my.report.v2.pdf`). Currently these files would fail to find their metadata. After the fix, they'll match correctly. This is a correctness improvement.

---

## OPT-10: Frontend `fetchUserAttributes()` Called on Every API Interaction (Medium Impact)

### Deep Dive Verification

Across the entire frontend (~30+ occurrences in 15+ files), every API call follows this pattern:

```javascript
const session = await fetchAuthSession();
const { email } = await fetchUserAttributes();  // ← separate Cognito GetUser API call
const token = session.tokens.idToken;
```

**Every single usage** of `fetchUserAttributes()` only destructures `{ email }` or accesses `.email`. No other user attribute is ever read anywhere in the frontend.

**The email is already in the ID token.** The app already accesses `tokens.accessToken.payload["cognito:groups"]` in `App.jsx`, confirming that Amplify v6's `fetchAuthSession` returns token objects with a `.payload` property containing decoded JWT claims. The ID token (`session.tokens.idToken`) is a Cognito ID token which contains the `email` claim as a standard attribute (user pool configured with `signInAliases: { email: true }`).

So `session.tokens.idToken.payload.email` gives the email without any additional API call.

**`fetchUserAttributes` is not cached.** It calls the Cognito `GetUser` API on every invocation — a network round-trip to the Cognito service (~20-50ms). `fetchAuthSession` on the other hand caches tokens locally and only refreshes when they expire.

**Files affected** (every file that imports `fetchUserAttributes`):
- `StudentChat.jsx` — 5 occurrences (most impactful — chat flow)
- `StudentHomepage.jsx` — 2 occurrences
- `CourseView.jsx` — 1 occurrence
- `InstructorHomepage.jsx` — 2 occurrences
- `InstructorEditCourse.jsx` — 1 occurrence (wrapped in helper)
- `InstructorModules.jsx` — 1 occurrence
- `InstructorNewModule.jsx` — 1 occurrence
- `InstructorNewConcept.jsx` — 1 occurrence
- `InstructorEditConcept.jsx` — 1 occurrence
- `CourseDetails.jsx` — 1 occurrence
- `StudentDetails.jsx` — 1 occurrence
- `PromptSettings.jsx` — 2 occurrences
- `ChatLogs.jsx` — 3 occurrences
- `ViewStudents.jsx` — usage present
- `AdminInstructors.jsx` — 2 occurrences
- `StudentHeader.jsx` — 1 occurrence

### Recommended Change

Create a shared utility function that extracts the email from the ID token:

```javascript
// src/utils/auth.js
import { fetchAuthSession } from "aws-amplify/auth";

export async function getAuthSessionAndEmail() {
  const session = await fetchAuthSession();
  const token = session.tokens.idToken;
  const email = token.payload.email;
  return { token, email };
}
```

Then replace every `fetchAuthSession` + `fetchUserAttributes` pair across the frontend:

```javascript
// BEFORE (in every component):
const session = await fetchAuthSession();
const { email } = await fetchUserAttributes();
const token = session.tokens.idToken;

// AFTER:
import { getAuthSessionAndEmail } from "../../utils/auth";
const { token, email } = await getAuthSessionAndEmail();
```

Note: `InstructorEditCourse.jsx` already has a local `getAuthSessionAndEmail` helper — the shared utility replaces it and all other occurrences.

For the promise chain pattern in `StudentChat.jsx`:

```javascript
// BEFORE:
.then((authSession) => {
  authToken = authSession.tokens.idToken;
  return fetchUserAttributes();
})
.then(({ email }) => {
  userEmail = email;

// AFTER:
.then((authSession) => {
  authToken = authSession.tokens.idToken;
  userEmail = authSession.tokens.idToken.payload.email;
  // fetchUserAttributes() call removed — no extra .then() needed
```

### Impact

- Eliminates ~30+ Cognito `GetUser` API calls across the frontend
- Each call saves ~20-50ms (network round-trip to Cognito)
- On the student chat page: 5 occurrences × ~30ms = ~150ms saved per chat exchange
- On page loads: 1-3 occurrences × ~30ms = ~30-90ms faster initial load
- Also simplifies the code — one utility function replaces a two-call pattern in 15+ files

### Risk Assessment

- **Zero risk.** The ID token's `email` claim is the exact same value `fetchUserAttributes()` returns. It's cryptographically signed by Cognito and verified by the authorizer.
- **Token expiry**: `fetchAuthSession` handles token refresh automatically. If the ID token is expired, Amplify refreshes it before returning. The email in the refreshed token is always current.
- **Implementation approach**: Can be done incrementally — replace one file at a time. The shared utility function makes it a mechanical find-and-replace. No behavioral changes.
- **Remove `fetchUserAttributes` import**: After all occurrences are replaced, the import can be removed from each file. The `aws-amplify/auth` dependency stays (still needed for `fetchAuthSession`, `signOut`, etc.).

---

## OPT-11: Redundant `AdminGetUser` in Cognito Triggers (Low Impact)

### Deep Dive Verification

Both `adjustUserRoles.js` (POST_AUTHENTICATION trigger) and `addStudentOnSignUp.js` (POST_CONFIRMATION trigger) call `AdminGetUserCommand` to get the user's email:

```javascript
const client = new CognitoIdentityProviderClient();  // ← created every invocation
const getUserCommand = new AdminGetUserCommand({
  UserPoolId: userPoolId,
  Username: userName,
});
const userAttributesResponse = await client.send(getUserCommand);
const emailAttr = userAttributesResponse.UserAttributes.find(attr => attr.Name === 'email');
const email = emailAttr ? emailAttr.Value : null;
```

**The email is already in the trigger event.** Both POST_AUTHENTICATION and POST_CONFIRMATION events include `event.request.userAttributes` with all user attributes including `email`. This is documented in the [AWS Cognito Lambda trigger docs](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-authentication.html). The `AdminGetUser` call is completely redundant.

**`adjustUserRoles.js` also calls `AdminListGroupsForUser`** — this is NOT available in the event and is legitimately needed. So the Cognito client can't be removed entirely from this file, but the `AdminGetUser` call can be.

**`addStudentOnSignUp.js` calls `AdminGetUser` + `AdminAddUserToGroup`** — the `AdminGetUser` is redundant (email from event), but `AdminAddUserToGroup` is legitimately needed. Same situation.

### Recommended Change

**In both files**, replace the `AdminGetUser` call with direct event access:

```javascript
// BEFORE:
const { userName, userPoolId } = event;
const client = new CognitoIdentityProviderClient();
const getUserCommand = new AdminGetUserCommand({ UserPoolId: userPoolId, Username: userName });
const userAttributesResponse = await client.send(getUserCommand);
const emailAttr = userAttributesResponse.UserAttributes.find(attr => attr.Name === 'email');
const email = emailAttr ? emailAttr.Value : null;

// AFTER:
const { userName, userPoolId } = event;
const email = event.request.userAttributes.email;
```

**Move the Cognito client to module level** (still needed for `AdminListGroupsForUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`):

```javascript
// Module level — created once per container
const client = new CognitoIdentityProviderClient();

exports.handler = async (event) => {
  // use client directly — no AdminGetUser needed
```

**Remove `AdminGetUserCommand` import** from both files since it's no longer used.

### Impact

- Eliminates 1 Cognito API call (~30-50ms) per login (`adjustUserRoles`) and per signup (`addStudentOnSignUp`)
- Eliminates `CognitoIdentityProviderClient` re-creation (~5-10ms) per invocation
- Low frequency (only on auth events), but every login is affected by `adjustUserRoles`

### Risk Assessment

- **Zero risk.** `event.request.userAttributes.email` is the canonical way to access user attributes in Cognito triggers. It's the same data `AdminGetUser` returns, provided directly by Cognito without a network call.
- **Client still needed**: Both triggers still need the Cognito client for other operations (`AdminListGroupsForUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`). Only the `AdminGetUser` call and import are removed.

---

## Priority Order for Implementation

| ID | Description | Impact | Effort | Notes |
|----|-------------|--------|--------|-------|
| OPT-1 | Eliminate Cognito AdminGetUser | High | Low | -150-400ms per chat exchange. Pass email from authorizer context. Also removes OPT-6. |
| OPT-8 | Add retry limit to LLM response loop | Critical (reliability) | Low | Prevents runaway 300s Lambda execution, ~120 wasted Bedrock calls, and chat history corruption. |
| OPT-7 | Fix course_page engagement log bug | Bug fix | Low | Two bugs cancel out — "course access" engagement log is silently never written. Data loss. |
| OPT-10 | Eliminate frontend fetchUserAttributes() | Medium | Medium | -100-250ms per chat exchange. Extract email from ID token instead. ~30+ occurrences across frontend. |
| OPT-2 | Fix N+1 in student_modules_messages | High | Medium | 22+ queries → 2. Saves ~200-500ms on instructor student detail page. |
| OPT-3 | Reduce sequential queries in chat endpoints | Medium | Low | -40-80ms per chat exchange across 6 endpoints. Eliminate redundant enrolment_id re-fetches + INSERT...SELECT for engagement logging. |
| OPT-4 | Combine + parallelize analytics queries | Medium | Low | 4 sequential queries → 3 parallel. Saves ~45ms on instructor analytics page. |
| OPT-9 | Fix N+1 metadata query in getFilesFunction | Low | Low | N queries → 1. Instructor file management page only. |
| OPT-11 | Redundant AdminGetUser in Cognito triggers | Low | Low | Email already in trigger event. Eliminates 1 Cognito API call + client re-creation per login/signup. |
| OPT-5 | user_id lookup by email | No action | — | Already indexed (UNIQUE constraint). ~5ms is RDS Proxy round-trip, not query time. No practical fix. |
| OPT-6 | CognitoIdentityProviderClient per invocation | No action | — | Fully removed by OPT-1. No standalone value. |


