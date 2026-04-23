# API & Database Call Optimization Analysis

Comprehensive analysis of all backend API calls, DB queries, and AWS SDK calls across every Lambda function. Findings are grouped by severity.

## Critical: N+1 Query Patterns

### 1. `instructorFunction.js` — `student_modules_messages` endpoint

This is the worst offender. For each student's modules, it runs a separate query per module to get sessions, then a separate query per session to get messages:

```
Query 1: Get user_id from email
Query 2: Get all student modules for a course
For each module:
  Query N: Get sessions for this module
  For each session:
    Query N×M: Get messages for this session
```

For a student with 5 modules and 3 sessions each, that's 2 + 5 + 15 = 22 queries.

Replace with 2 queries (keep the user lookup for the 404 check, combine everything else):

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
  SELECT cm.module_name, cc.concept_number, cm.module_number,
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

// Group flat rows into the nested structure the frontend expects:
// { "Module Name": [{ sessionName: "...", messages: [...] }] }
const result = {};
for (const row of rows) {
  if (!result[row.module_name]) {
    result[row.module_name] = [];
  }
  // Skip null sessions (module with no sessions)
  if (!row.session_id) continue;

  const moduleArr = result[row.module_name];
  let session = moduleArr.find(s => s._sessionId === row.session_id);
  if (!session) {
    session = {
      _sessionId: row.session_id,
      sessionName: row.session_name,
      messages: [],
    };
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

// Remove internal _sessionId before sending response
for (const moduleName of Object.keys(result)) {
  result[moduleName] = result[moduleName].map(({ _sessionId, ...rest }) => rest);
}

response.body = JSON.stringify(result);
```

Reduces 22+ queries to 2.

**Frontend expected structure** (verified from `StudentDetails.jsx`):
```json
{
  "Module Name": [
    {
      "sessionName": "Session 1",
      "messages": [
        { "student_sent": true, "message_content": "Hello!", "time_sent": "2024-09-25T14:48:00.000Z" }
      ]
    }
  ]
}
```

The frontend uses:
- `Object.keys(data)` → tab labels (module names)
- `sessions[tabs[activeTab]]` → array of sessions for active tab
- `session.sessionName` → accordion header
- `session.messages` → array iterated by `formatMessages()` which reads `message.student_sent`, `message.message_content`, `message.time_sent`

**Edge cases verified:**
- Module with no sessions: LEFT JOIN produces row with `session_id = NULL`. The `if (!row.session_id) continue` skips it, but the module key is still created in `result` as an empty array. Frontend shows "Student has not entered the module yet." ✓
- Session with no messages: LEFT JOIN produces row with `message_content = NULL`. The `if (row.message_content !== null)` check skips it, session is added with empty messages array. Frontend shows empty chat history. ✓
- User not found: Separate first query returns 404. Frontend logs error. ✓
- Module ordering: `ORDER BY cc.concept_number, cm.module_number` matches the original query's ordering. `Object.keys(result)` preserves insertion order in modern JS. ✓

**One behavioral difference:** The original code initializes `result[module.module_name] = []` for every module from the Step 2 query, even if the module has no sessions. The combined query with LEFT JOIN also produces a row for sessionless modules (with null session fields), so the `if (!result[row.module_name])` initialization still happens. However, if a module exists in `Student_Modules` but has no sessions AND no messages, the LEFT JOIN still produces exactly one row for it (with all session/message fields null). The `continue` on null `session_id` means the module gets an empty array. This matches the original behavior. ✓

**Risk: Low.** The query uses the same JOIN path as the original subqueries. The grouping logic is straightforward. The main risk is a bug in the JS grouping code — test with real data before deploying to prod.

### 2. `instructorFunction.js` — `analytics` endpoint

Runs 4 separate queries against the same course data:
- `messageCreations` — counts messages per module (joins through Course_Modules → Student_Modules → Sessions → Messages → Enrolments → Users)
- `moduleAccesses` — counts engagement log entries per module (joins through Course_Modules → User_Engagement_Log → Enrolments → Users)
- `averageScores` — averages module scores (joins through Course_Modules → Student_Modules → Enrolments → Users)
- `perfectScores` — calculates perfect score percentages (joins through Course_Modules → Student_Modules → Enrolments → Users)

**Frontend expected response** (from `InstructorAnalytics.jsx`):
```json
[
  {
    "module_id": "uuid",
    "module_name": "Module A",
    "concept_number": 1,
    "module_number": 1,
    "message_count": 42,
    "access_count": 15,
    "average_score": 75.5,
    "perfect_score_percentage": 33.33
  }
]
```

Frontend uses: `module.module_name` (accordion header + graph label), `module.message_count` (bar chart + display), `module.access_count` (display), `module.perfect_score_percentage` (with `.toFixed(2)` + LinearProgress). `average_score` is computed but not rendered anywhere in the frontend.

**Analysis of combinability:**

Queries 3 (`averageScores`) and 4 (`perfectScores`) share the exact same JOIN chain and WHERE clause — they only differ in the SELECT aggregation. These can be safely combined with zero risk:

```sql
-- Combined Query A: Scores (replaces queries 3 + 4)
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
```

**Can Query 1 (messages) be combined with the scores query?**

Query 1 adds `Sessions → Messages` to the join chain. This creates row multiplication: if a student has 3 sessions with 10 messages each, the JOIN produces 30 rows per Student_Module. This would inflate `COUNT(sm.student_module_id)` in the perfect score denominator from 1 to 30.

Fix: Use `COUNT(DISTINCT ...)` for the score calculations:
- `AVG(sm.module_score)` — safe without DISTINCT (duplicated identical values don't change the average)
- `COUNT(DISTINCT sm.student_module_id)` — for the denominator
- `COUNT(DISTINCT CASE WHEN sm.module_score = 100 THEN sm.student_module_id END)` — for the numerator
- `COUNT(m.message_id)` — already correct (each message row is unique)

This works but is harder to reason about and verify. Safer to keep messages as a separate query.

**Can Query 2 (accesses) be combined with anything?**

Query 2 joins through `User_Engagement_Log` — a completely different path from `Sessions → Messages`. Combining both paths would create a cross product: a module with 30 messages and 5 access entries would produce 150 rows, inflating all counts. Even with DISTINCT, this is fragile and error-prone. Keep separate.

**Recommended approach — reduce from 4 queries to 3:**

```javascript
// Query 1: Message counts (unchanged)
const messageCreations = await sqlConnection`
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
`;

// Query 2: Access counts (unchanged)
const moduleAccesses = await sqlConnection`
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
`;

// Query 3: Scores — combined (replaces old queries 3 + 4)
const moduleScores = await sqlConnection`
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
`;

// Assembly (updated to use combined scores)
const analyticsData = messageCreations.map((module) => {
  const accesses = moduleAccesses.find((ma) => ma.module_id === module.module_id) || {};
  const scores = moduleScores.find((ms) => ms.module_id === module.module_id) || {};

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

**Additionally, queries 2 and 3 can run in parallel** since they're independent:

```javascript
const [moduleAccesses, moduleScores] = await Promise.all([
  sqlConnection`...query 2...`,
  sqlConnection`...query 3...`,
]);
```

This reduces wall-clock time from 4 sequential queries to: query 1 (sequential, needed as base) + max(query 2, query 3) in parallel. Roughly 2x faster than 4 sequential.

**Risk: Very low.** The combined scores query uses the exact same JOIN chain and WHERE clause as the original two separate queries. The only change is selecting both aggregations in one pass. The assembly code changes from two `.find()` calls to one. The response structure is identical.

**Edge cases verified:**
- Module with no student enrollments: All queries use the same WHERE filter (`'student' = ANY(u.roles)`), so the same modules are excluded across all queries. The assembly uses `messageCreations` as the base, so only modules present in query 1 appear in the response. Consistent with current behavior. ✓
- Module with zero messages but has enrollments: `COUNT(m.message_id)` returns 0 (LEFT JOIN). Module still appears. ✓
- Module with zero accesses: Not in `moduleAccesses` result. Assembly falls back to `{}`, `access_count` defaults to 0. ✓
- Module with all perfect scores: `perfect_score_percentage` = 100.0. ✓
- Module with no scores: `COUNT(sm.student_module_id) = 0`, CASE returns 0. ✓

---

## High: Sequential Queries That Should Be Combined

### 3. `text_generation/main.py` — Handler pre-LLM queries

5 separate functions, each opening a cursor, querying, and closing:
- `get_system_prompt(course_id)` — `SELECT system_prompt FROM "Courses" WHERE course_id = %s`
- `get_course_llm_model_id(course_id)` — `SELECT llm_model_id FROM "Courses" WHERE course_id = %s`
- `get_module_prompt(module_id)` — `SELECT module_prompt FROM "Course_Modules" WHERE module_id = %s`
- `get_module_name(module_id)` — `SELECT module_name FROM "Course_Modules" WHERE module_id = %s`
- `get_allowed_file_ids(module_id)` — 2 SELECTs from `Module_Files` + `Module_File_References`

The first two query the same `Courses` table with the same `course_id`. The next two query the same `Course_Modules` table with the same `module_id`. Combine into 3 queries:

```python
# Query 1: Course data (was 2 separate queries)
cur.execute("SELECT system_prompt, llm_model_id FROM \"Courses\" WHERE course_id = %s", (course_id,))

# Query 2: Module data (was 2 separate queries)
cur.execute("SELECT module_name, module_prompt FROM \"Course_Modules\" WHERE module_id = %s", (module_id,))

# Query 3: File IDs (was 2 separate queries)
cur.execute("""
    SELECT file_id FROM "Module_Files" WHERE module_id = %s
    UNION
    SELECT referenced_file_id FROM "Module_File_References" WHERE source_module_id = %s
""", (module_id, module_id))
```

Reduces 6 DB round-trips to 3.

Risk: Minimal. Each combined query returns the same data as the originals. The only behavioral difference is error handling — currently if `get_system_prompt` returns None, the handler returns 400 before calling the other functions. With combined queries, you'd fetch course data first, check for None, then proceed. The control flow stays the same.

Important: `get_system_prompt` returning None triggers a 400 response. `get_module_name` returning None also triggers a 400. These checks must be preserved after combining.

### 4. `studentFunction.js` + `instructorFunction.js` — Cognito `AdminGetUser` on every request

Both functions call Cognito `AdminGetUser` at the top of every handler invocation:

```javascript
const cognito_id = event.requestContext.authorizer.userId;  // This is payload.sub
const userAttributesResponse = await client.send(new AdminGetUserCommand({
  UserPoolId: USER_POOL,
  Username: cognito_id,
}));
const emailAttr = userAttributesResponse.UserAttributes.find(attr => attr.Name === "email");
const userEmailAttribute = emailAttr ? emailAttr.Value : null;
```

This is used for authorization — comparing the token owner's email against the query parameter email to prevent users from accessing other users' data.

The authorizer already verifies the ID token (which contains the `email` claim in the payload) but only passes `payload.sub` as `userId` in the context. The fix is to also pass the email from the authorizer:

```javascript
// In all 3 authorizer functions, change:
responseStruct["context"] = {
  "userId": payload.sub
};
// To:
responseStruct["context"] = {
  "userId": payload.sub,
  "email": payload.email
};
```

Then in `studentFunction.js` and `instructorFunction.js`, replace:
```javascript
const cognito_id = event.requestContext.authorizer.userId;
const client = new CognitoIdentityProviderClient();
const userAttributesCommand = new AdminGetUserCommand({ ... });
const userAttributesResponse = await client.send(userAttributesCommand);
const emailAttr = userAttributesResponse.UserAttributes.find(attr => attr.Name === "email");
const userEmailAttribute = emailAttr ? emailAttr.Value : null;
```
With:
```javascript
const userEmailAttribute = event.requestContext.authorizer.email;
```

Risk: The Cognito ID token `payload.email` is the verified email from the token. This is the same email that `AdminGetUser` returns — both come from Cognito. The security guarantee is identical. However, API Gateway Lambda authorizer context values are always strings and have a 5KB limit. Email addresses are well within this limit.

Important: The `CognitoIdentityProviderClient` import and `USER_POOL` env var can be removed from `studentFunction.js` and `instructorFunction.js` after this change, but keep them if any other code path in those files uses them. Check: `studentFunction.js` uses `AdminGetUserCommand` only at the top. `instructorFunction.js` also only uses it at the top. Both can be cleaned up.

Note: `adjustUserRoles.js` and `addStudentOnSignUp.js` also use Cognito SDK but for different purposes (group management, not email lookup) — don't change those.

### 5. `studentFunction.js` — Repeated `user_id` lookup pattern

Multiple endpoints follow this pattern:
```javascript
const userResult = await sqlConnection`SELECT user_id FROM "Users" WHERE user_email = ${email}`;
const userId = userResult[0].user_id;
// Then use userId in the next query
```

This appears in: `course`, `course_page`, `module`, `create_session`, `delete_session`, `enroll_student`, `update_module_score`, `create_message`, `create_ai_message`.

For endpoints that only need `user_id` as a join key, inline it:
```sql
-- Instead of two queries:
-- Query 1: SELECT user_id FROM "Users" WHERE user_email = $email
-- Query 2: SELECT ... FROM "Enrolments" WHERE user_id = $userId AND ...

-- Use one query:
SELECT ... FROM "Enrolments" e
JOIN "Users" u ON u.user_id = e.user_id
WHERE u.user_email = $email AND ...
```

Risk: Low for most endpoints. However, some endpoints check `userResult.length === 0` to return a 404 "User not found" error. If you inline the user lookup into a JOIN, a missing user would return an empty result set instead of a specific 404. You'd need to distinguish between "user not found" and "no data for this user" — which may or may not matter depending on the frontend's error handling.

Recommendation: Apply this optimization selectively to endpoints where the "User not found" check isn't critical (e.g., `course_page` where an empty result is fine). Keep the two-query pattern for endpoints like `create_session` where the 404 distinction matters.

### 6. `studentFunction.js` — `enroll_student` batch insert

Sequential queries that could be batched:
```javascript
// Step 4: Get all module IDs
const modulesResult = await sqlConnection`SELECT module_id FROM "Course_Modules" WHERE concept_id IN (...)`;
// Step 5: Insert Student_Modules one at a time via Promise.all
const studentModuleInsertions = modulesResult.map((module) => {
  return sqlConnection`INSERT INTO "Student_Modules" ... VALUES (uuid_generate_v4(), ${module.module_id}, ...)`;
});
await Promise.all(studentModuleInsertions);
```

Replace with a single INSERT...SELECT:
```sql
INSERT INTO "Student_Modules" (student_module_id, course_module_id, enrolment_id, module_score, last_accessed, module_context_embedding)
SELECT uuid_generate_v4(), cm.module_id, $enrolment_id, 0, NULL, NULL
FROM "Course_Modules" cm
JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
WHERE cc.course_id = $course_id;
```

Risk: None. The INSERT...SELECT produces the same rows. The `uuid_generate_v4()` is called per row in both approaches.

Same pattern exists in:
- `adminFunction.js` — `enroll_instructor` endpoint
- `instructorFunction.js` — `create_module` endpoint (inserts Student_Modules for all enrolled students)

---

## Medium: Connection Management Issues

### 7. `text_generation/helpers/vectorstore.py` — `hybrid_search` creates new connections

Every call to `hybrid_search` creates a fresh `psycopg2.connect()`:

```python
conn = psycopg2.connect(connection_string)  # new connection every call
# ... vector search + keyword search ...
conn.close()

# If missing IDs from keyword-only results:
conn2 = psycopg2.connect(connection_string)  # another new connection
```

The handler already maintains a global `connection` object. However, `hybrid_search` receives a `connection_string` (not a connection object) because it's called from `get_vectorstore_retriever` which builds the string from the config dict.

Fix: Pass the existing connection object through the chain instead of the connection string. This requires changing the function signatures:
- `get_vectorstore_retriever(llm, vectorstore_config_dict, embeddings, allowed_file_ids)` → add `connection` parameter
- `hybrid_search(query, query_embedding, connection_string, ...)` → change `connection_string` to `connection`

Risk: The current code opens and closes connections per call, which is clean but slow. Reusing the global connection means the connection stays open across calls. If a query fails and the connection enters an error state, subsequent calls would also fail. Add a try/except with `connection.rollback()` to handle this. The existing pattern in other functions (e.g., `get_module_name`) already does this.

### 8. `chat.py` — `create_dynamodb_history_table` paginates all tables on cold start

```python
def create_dynamodb_history_table(table_name):
    existing_tables = []
    while True:
        response = dynamodb_client.list_tables(...)
        existing_tables.extend(response.get('TableNames', []))
        if 'LastEvaluatedTableName' in response:
            exclusive_start_table_name = response['LastEvaluatedTableName']
        else:
            break
    if table_name not in existing_tables:
        table = dynamodb_resource.create_table(...)
        table.meta.client.get_waiter("table_exists").wait(...)
```

This paginates through ALL DynamoDB tables in the account on every cold start. Replace with:

```python
try:
    dynamodb_client.describe_table(TableName=table_name)
except dynamodb_client.exceptions.ResourceNotFoundException:
    dynamodb_resource.create_table(...)
    # wait for table
```

Or better: create the DynamoDB table in CDK and remove this runtime check entirely. The table name is a static SSM parameter — it should exist before the Lambda runs.

Risk: If the table doesn't exist and `describe_table` throws, the except block creates it. Same behavior as before, just faster. If the table already exists (99.9% of invocations), it's a single API call instead of paginating all tables.

---

## Medium: Redundant AWS SDK Calls

### 9. `deleteLastMessage.py` — SSM `get_parameter` for DynamoDB table name

The table name is fetched from SSM Parameter Store on every cold start:
```python
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
table_name = get_parameter(os.environ["TABLE_NAME_PARAM"])
```

The parameter name is already an environment variable. The parameter value (`DynamoDB-Conversation-Table`) is a static string set in CDK. Pass the value directly as an environment variable instead of fetching it from SSM at runtime:

```typescript
// In api-gateway-stack.ts, change:
TABLE_NAME_PARAM: tableNameParameter.parameterName,
// To:
TABLE_NAME: "DynamoDB-Conversation-Table",
```

Risk: If you ever change the table name, you'd need to redeploy the Lambda instead of just updating the SSM parameter. For a value that has never changed, this is fine. If you want to keep the flexibility of SSM, leave it as-is — the caching already minimizes the impact.

Same applies to `text_generation/main.py` which fetches 3 SSM parameters — but those are already cached in globals and only fetched on cold start, so the impact is minimal.

---

## Low: Batch Insert Opportunities

### 10. `instructorFunction.js` — `create_module` Student_Modules insertion

When creating a new module, inserts one `Student_Modules` row per enrolled student:

```javascript
const enrolments = await sqlConnection`SELECT enrolment_id FROM "Enrolments" WHERE course_id = ${course_id}`;
await Promise.all(
  enrolments.map(async (enrolment) => {
    await sqlConnection`INSERT INTO "Student_Modules" ... VALUES (uuid_generate_v4(), ${newModule[0].module_id}, ${enrolment.enrolment_id}, 0)`;
  })
);
```

Replace with:
```sql
INSERT INTO "Student_Modules" (student_module_id, course_module_id, enrolment_id, module_score)
SELECT uuid_generate_v4(), $moduleId, enrolment_id, 0
FROM "Enrolments" WHERE course_id = $courseId;
```

Risk: None. Same result, single round-trip.

### 11. `instructorFunction.js` — `module_file_references` PUT endpoint

Deletes all references then inserts them one at a time:
```javascript
await sqlConnection`DELETE FROM "Module_File_References" WHERE source_module_id = ${module_id}`;
await Promise.all(
  referenced_file_ids.map(file_id => sqlConnection`INSERT INTO "Module_File_References" ...`)
);
```

The postgres library supports bulk inserts. Replace with:
```javascript
await sqlConnection`DELETE FROM "Module_File_References" WHERE source_module_id = ${module_id}`;
if (referenced_file_ids?.length > 0) {
  const values = referenced_file_ids.map(id => ({ source_module_id: module_id, referenced_file_id: id }));
  await sqlConnection`INSERT INTO "Module_File_References" ${sqlConnection(values, 'source_module_id', 'referenced_file_id')}`;
}
```

Risk: None. Same result.

---

## Low: Missing Database Indexes (Potential)

The schema defines primary keys and foreign keys (which create indexes), plus a UNIQUE constraint on `user_email`. The following query patterns may benefit from additional indexes:

| Column(s) | Used In | Current Index? |
|---|---|---|
| `"Courses".course_access_code` | Student enrollment lookup | No — only PK on `course_id` |
| `"User_Engagement_Log"(course_id, engagement_type)` | Analytics queries | FK on `course_id`, no composite |
| `"Messages"(session_id, time_sent)` | Message retrieval ORDER BY | FK on `session_id`, no composite |

Verify with:
```sql
SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename;
```

Risk: Adding indexes has no functional risk. They slow down writes slightly but speed up reads. For a read-heavy app, this is a net win.

---

## Summary: Impact vs Effort

| # | Issue | Impact | Effort | Saves | Risk |
|---|---|---|---|---|---|
| 1 | N+1 in student_modules_messages | High | Medium | 22+ queries → 1 | Must preserve nested response structure |
| 2 | 4 analytics queries → 2 | High | Medium | 4 heavy queries → 2 | Must use COUNT(DISTINCT) to avoid row multiplication |
| 3 | TextGen 6 pre-LLM queries → 3 | High | Low | 30-90ms per chat message | Must preserve None checks for 400 responses |
| 4 | Pass email from authorizer | Medium | Low | ~50-100ms per API request | Authorizer change affects all endpoints |
| 5 | Inline user_id lookups | Medium | Low | 1 query per endpoint | Some endpoints need "User not found" 404 |
| 6 | Batch INSERT for enrollment | Low | Low | N queries → 1 | None |
| 7 | Reuse connection in hybrid_search | Medium | Low | 10-30ms per chat message | Need error handling for stale connections |
| 8 | DynamoDB table check optimization | Low | Low | Cold start improvement | None |
| 9 | SSM → env var for table name | Low | Low | 1 SSM call per cold start | Loses runtime flexibility |
| 10 | Batch Student_Modules insert | Low | Low | N queries → 1 | None |
| 11 | Batch file references insert | Low | Low | N queries → 1 | None |
