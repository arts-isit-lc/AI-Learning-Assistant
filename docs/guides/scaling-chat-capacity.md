# Scaling Chat Capacity

How to raise the number of students who can chat at the same time, and how to confirm the new number before relying on it.

## Background

All figures below were measured in prod on 2026-11-10, using the last 30 days of CloudWatch data.

A chat turn makes one Sonnet 4.5 call (about 3,370 input and 215 output tokens on average), about two Haiku 4.5 calls, and a few Titan embedding calls. The chatbot Lambda takes about 9 s per turn (median) and 13.6 s at p90.

Each limit below caps how many chat turns per minute the app can serve:

| Limit | Prod value | Chat turns per minute |
|---|---|---|
| Sonnet 4.5 tokens per minute (Bedrock) | 5,000,000, adjustable | **~700–1,100 (the lowest ceiling)** |
| Titan embedding tokens per minute | 300,000, not adjustable | ~1,400 |
| Haiku 4.5 tokens per minute | 5,000,000, adjustable | ~1,900 |
| Lambda concurrency (shared by every function in the account) | 1,000 | ~3,500–6,000 |
| API Gateway throttle, per method | 100 requests/s, 200 burst | ~6,000 |
| Database (`db.t3.medium` behind RDS Proxy) | not tested | **unknown** |

A student actively chatting sends about one message a minute, so 700 turns per minute is about 700 students chatting at once.

The range for Sonnet comes from how Bedrock counts tokens against the quota:
- When a request starts, Bedrock reserves `input tokens + max_tokens` from the quota. That is about 3,370 + 4,000 = 7,370 tokens, which allows about 680 turns per minute.
- When the request ends, Bedrock charges `input tokens + 5 × output tokens` and releases the rest. That is about 4,450 tokens, which allows about 1,100 turns per minute.

The three tasks below raise and confirm the ceiling. Tasks 1 and 2 are independent. Do task 3 after either of them to find the real number.

---

## 1. Raise the Sonnet 4.5 tokens-per-minute quota

### Which quota

The app calls Sonnet through the Geo-US inference profile (`us.anthropic.claude-sonnet-4-5-…`). That profile uses the **Cross-region** quotas. The **Global cross-region** quotas are a different set and don't apply. Request the increase in **ca-central-1**, the Region the app calls Bedrock from.

| Quota | Code | Prod value |
|---|---|---|
| Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1 | `L-F4DDD3EB` | 5,000,000 |
| Cross-region model inference requests per minute for Anthropic Claude Sonnet 4.5 V1 | `L-4A6BFAB1` | 10,000 (not a limit yet) |
| Cross-region model inference tokens per minute for Anthropic Claude Haiku 4.5 | `L-58BE175A` | 5,000,000 |

Quotas apply per account. Raise prod and dev separately. Dev needs a raise only if it is used for the load test in task 3.

### Choosing a value

```
quota ≈ target turns per minute × 7,400 tokens × 1.25 headroom
```

For example, 1,500 turns per minute needs about 14M tokens per minute. Use 4,900 tokens per turn instead of 7,400 if task 2 has been deployed.

Raising Sonnet alone stops helping at about 1,400 turns per minute. At that point the Titan embedding quota (300,000 tokens per minute, not adjustable) becomes the next limit, followed by Haiku.

### Requesting the increase

**Console:** open Service Quotas in ca-central-1, go to **AWS services → Amazon Bedrock**, search `Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1`, and choose **Request increase at account level**.

**CLI:**

```bash
export AWS_PROFILE=<prod profile> AWS_REGION=ca-central-1

# Current value
aws service-quotas get-service-quota --service-code bedrock --quota-code L-F4DDD3EB \
  --query 'Quota.Value'

# Request the increase
aws service-quotas request-service-quota-increase \
  --service-code bedrock --quota-code L-F4DDD3EB --desired-value 15000000

# Check status (PENDING → CASE_OPENED → APPROVED / DENIED)
aws service-quotas list-requested-service-quota-change-history-by-quota \
  --service-code bedrock --quota-code L-F4DDD3EB \
  --query 'RequestedQuotas[].[Created,DesiredValue,Status]' --output table
```

AWS often reviews large Bedrock increases by hand through a support case. Approval can take several days, so request well before the term starts. If AWS asks for a justification, something like this works:

> Educational tutoring application for university courses (ca-central-1, Geo-US cross-Region inference). Each student chat turn uses ~3,400 input and ~250 output tokens with max_tokens N. We expect up to X concurrent students at about one message per minute during class sessions, needing ~Y tokens per minute.

### Verify

Once the request is approved, `get-service-quota` returns the new value. During busy periods, watch `InvocationThrottles` in the `AWS/Bedrock` namespace for the `us.anthropic.claude-sonnet-4-5-20250929-v1:0` model. It should stay at zero.

---

## 2. Lower `RESPONSE_MAX_TOKENS`

### Why

`max_tokens` sets how much quota Bedrock reserves when each request starts. Prod responses are far below the current 4,000:

| Sonnet output tokens per response (prod, 30 days, n = 2,309) | |
|---|---|
| p50 | 237 |
| p90 | 321 |
| p99 | 415 |
| p99.9 | 634 |
| max | 1,011 |

Going from 4,000 to 1,500 cuts the start-of-request reservation from about 7,370 to about 4,870 tokens. That raises the Sonnet ceiling from about 680 to about 1,030 turns per minute without any quota change. The token count actually billed doesn't change.

### Risk: a cut-off response is not detected

A response that reaches `max_tokens` stops mid-sentence. [streaming.py](../../cdk/chatbot_v2/src/streaming.py) logs `stop_reason`, but it still returns the partial text to the student as a normal answer. Keep the limit well above the longest response seen so far. **1,500 is recommended** (about 1.5 times the observed maximum); don't go below about 1,200.

### Steps

1. **Add a warning for cut-off responses** so problems show up in logs. In `stream_response` in [streaming.py](../../cdk/chatbot_v2/src/streaming.py), after the `"Stream latency"` log:

   ```python
   if stop_reason == "max_tokens":
       logger.warning("Response truncated at max_tokens",
                      extra={"event": "response_truncated",
                             "max_tokens": model_kwargs.get("max_tokens"),
                             "output_tokens": output_tokens})
   ```

   Both streaming paths (InvokeModel and ConverseStream) report `max_tokens` as the stop reason. Add a unit test next to `test_streaming_converse.py` that feeds a `("stop", "max_tokens")` event and checks the warning.

2. **Change the constant** in [constants/models.py](../../cdk/chatbot_v2/src/constants/models.py):

   ```python
   RESPONSE_MAX_TOKENS = 1500
   ```

   Both generation call sites in `main.py` (the tutor path and the main path) read this constant. `streaming.py` also has a fallback default of `4000`, used only when the `max_tokens` kwarg is missing. Change it to match. The existing tests pass `max_tokens: 100` explicitly, so none depend on 4000.

   Leave these alone:
   - `EVAL_MAX_TOKENS` (500, Haiku).
   - The retrieval reasoning engine's `max_tokens: 4096`. It uses Haiku, which has quota headroom.

3. **Run the tests:** `cd cdk/chatbot_v2/src && python -m pytest -q`, then `cd cdk && npm test`.

4. **Deploy to dev and check.** Run a few long conversations (worked math problems, table comparisons, and the module-completion turn produce the longest answers). Then run this in CloudWatch Logs Insights on `/aws/lambda/<stack>-chatbotV2Function`:

   ```
   fields @timestamp, output_tokens, stop_reason
   | filter event = "stream_latency"
   | stats count(*) as turns, pct(output_tokens, 99) as p99, max(output_tokens) as max_out
   ```

   ```
   fields @timestamp, session_id, output_tokens
   | filter event = "response_truncated"
   ```

   The second query should return nothing.

5. **Deploy to prod** and run the same queries after a week of real use. If any responses were cut off, raise the value. To roll back, revert the constant and redeploy.

---

## 3. Load-test the database

### Why

Prod has never had more than 2 chat turns running at once. At that load the database peaked at 5.8% CPU and 29 connections. That's too little load to extrapolate from. The parts that could fail first under real load are:

- **CPU on `db.t3.medium`** (2 vCPUs, burstable). The vector search (HNSW index on `retrieval_units`) runs on every turn. RDS T3 instances default to Unlimited mode: sustained CPU above the baseline costs extra rather than slowing down, so the hard limit is 100% CPU.
- **Connections.** Postgres on this instance size allows about 400 connections (check with `SHOW max_connections;`). Three RDS Proxies share it, each allowed up to 100% of that.
  - Each warm Python Lambda keeps one connection open.
  - Each warm Node Lambda uses a `postgres.js` pool, which defaults to up to 10 connections ([lib.js](../../cdk/lambda/lib/lib.js)).
  - The retrieval function's figure lookups open a new connection, and fetch the database secret, on every call.
  - If the proxy has to keep a connection tied to one client ("session pinning"), it can't share it with others, and requests start waiting for one.
- **Silent degradation.** If retrieval fails, `retrieval_client.py` returns `None`, and the chatbot answers without course material instead of returning an error. Under load, this shows up as retrieval errors while the chatbot still reports success.

### Where to run it

**Not in prod.** A test there would share the Bedrock quota and database with real students, and every turn costs money. Use dev, set up to match prod:

1. **Database size.** Dev runs `db.t4g.micro` (PostgreSQL 17, since the P2.1 rebuild on 2026-11-26). Resize it to prod's class for the test (`db.t3.medium` today, `db.t4g.small` once prod is rebuilt):
   ```bash
   aws rds modify-db-instance --db-instance-identifier <dev db id> \
     --db-instance-class <prod class> --apply-immediately
   ```
   This takes the database offline for a few minutes and puts CloudFormation out of sync with the real instance until it is reverted. Prod's Multi-AZ standby doesn't serve reads, so single-AZ is a fair comparison.
2. **Data volume.** Compare `SELECT count(*) FROM retrieval_units;` in dev and prod. Vector search cost grows with the number of rows. Upload realistic course material to the test module if dev has much less.
3. **Bedrock quotas in dev.** If dev's Sonnet quota is lower than prod's, Bedrock will throttle before the database is stressed. Raise it (task 1) or run phase B only.

### Phase A: end-to-end ramp with k6

This measures the whole chat path. Bedrock costs about $0.02 per turn, so a 45-minute run that peaks at 300 students is about 9,000 turns, or roughly $180.

**Setup**

- Create a test course with one module that has ingested material.
- Create 20–50 test student accounts through the normal sign-up flow and enrol them in the course. Use as many accounts as practical. Sharing one account across many virtual users causes write contention on that student's rows, which real usage wouldn't have.
- Get Cognito ID tokens. The app client allows `USER_PASSWORD_AUTH`. Tokens last 1 hour, so keep each run under that. Keep `test-users.csv` and `users.json` out of git.

  ```bash
  CLIENT_ID=<dev Cognito app client id>   # aws cognito-idp list-user-pool-clients --user-pool-id <pool>
  echo '[]' > users.json
  while IFS=, read -r email pw; do
    tok=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "$CLIENT_ID" \
      --auth-parameters USERNAME="$email",PASSWORD="$pw" \
      --query AuthenticationResult.IdToken --output text)
    jq --arg e "$email" --arg t "$tok" '. += [{email:$e, token:$t}]' users.json > u.tmp && mv u.tmp users.json
  done < test-users.csv
  ```

**Script** (`chat-load.js`). Each virtual user creates one session, then sends a message about once a minute. That's the same request sequence the frontend uses (`create_session`, then `POST student/chatbot-v2`). The streamed output over AppSync is still produced, but k6 doesn't subscribe to it.

```js
import http from "k6/http";
import { check, sleep } from "k6";

const API = __ENV.API_URL; // e.g. https://<id>.execute-api.ca-central-1.amazonaws.com/prod/
const COURSE = __ENV.COURSE_ID;
const MODULE = __ENV.MODULE_ID;
const USERS = JSON.parse(open("./users.json"));
const QUESTIONS = [
  "Can you explain the main idea of this module?",
  "What does the figure in the second section show?",
  "Can you give me a worked example?",
  "How does this relate to the previous topic?",
];

export const options = {
  stages: [
    { duration: "5m", target: 50 }, { duration: "8m", target: 50 },
    { duration: "5m", target: 150 }, { duration: "8m", target: 150 },
    { duration: "5m", target: 300 }, { duration: "8m", target: 300 },
    { duration: "2m", target: 0 },
  ],
  thresholds: {
    "http_req_failed{name:chatbot}": ["rate<0.01"],
    "http_req_duration{name:chatbot}": ["p(90)<20000"],
  },
};

const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const user = USERS[(__VU - 1) % USERS.length];
const headers = { Authorization: user.token, "Content-Type": "application/json" };
let session; // per virtual user

export default function () {
  if (!session) {
    const name = `load-${__VU}`;
    const r = http.post(`${API}student/create_session?` + qs({
      email: user.email, course_id: COURSE, module_id: MODULE, session_name: name,
    }), null, { headers, tags: { name: "create_session" } });
    if (!check(r, { "session created": (x) => x.status === 200 })) { sleep(10); return; }
    const body = r.json();
    session = { id: (Array.isArray(body) ? body[0] : body).session_id, name };
  }
  const res = http.post(`${API}student/chatbot-v2?` + qs({
    course_id: COURSE, session_id: session.id, module_id: MODULE, session_name: session.name,
  }), JSON.stringify({ message_content: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] }),
  { headers, timeout: "60s", tags: { name: "chatbot" } });
  check(res, { "chat ok": (x) => x.status === 200 });
  sleep(45 + Math.random() * 30); // ≈ 1 message per minute per student, including response time
}
```

```bash
k6 run -e API_URL=... -e COURSE_ID=... -e MODULE_ID=... chat-load.js
```

Increase the stage targets (500, 700, and so on) on later runs until something fails. The highest stage where every pass criterion still holds is the real capacity.

### Phase B (optional): database-only test with pgbench

This stresses just the vector search, without any Bedrock cost. Run it from a machine inside the VPC: an AWS CloudShell VPC environment in the private subnets, or a small EC2 instance if those subnets have no internet route for installing `postgresql17` (the client must be at least the server's major version). Connect through the RDS Proxy endpoint, using the user credentials from the `DB_SECRET_ARN` secret.

`retrieval.sql` uses a random existing embedding as the query vector. Copy the real `WHERE` clause from the vector store's `search` method and `_append_metadata_filter` in [retrieval/handler.py](../../cdk/multimodal_rag_v2/retrieval/handler.py). The module filter changes how Postgres runs the query, so leaving it out gives misleading numbers.

```sql
\set n random(0, 999)
SELECT retrieval_id, 1 - (embedding <=> q.e) AS score
FROM retrieval_units,
     (SELECT embedding AS e FROM retrieval_units OFFSET :n LIMIT 1) q
WHERE embedding_version = '<current version>'   -- plus the module/file filter
ORDER BY embedding <=> q.e
LIMIT 20;
```

```bash
PGSSLMODE=require pgbench -h <proxy endpoint> -U <user> -d aila -n -f retrieval.sql \
  -c 50 -j 4 -T 300 -P 10      # repeat with -c 100, 200, 400
```

`pgbench` reports transactions per second and latency at each client count. A turn runs at least one such query, so queries per second × 60 is an upper bound on turns per minute from the database's side.

### What to watch

Build a temporary CloudWatch dashboard before the test with these metrics:

| Where | Metric | Problem sign |
|---|---|---|
| RDS (`DBInstanceIdentifier`) | `CPUUtilization` | above about 70% for several minutes |
| | `DatabaseConnections` | approaching `max_connections` |
| | `ReadLatency`, `DiskQueueDepth`, `FreeableMemory` | rising steadily while load holds level |
| RDS Proxy (`ProxyName`) | `DatabaseConnectionsBorrowLatency` | rising; requests are waiting for a connection |
| | `DatabaseConnectionsCurrentlySessionPinned` | non-zero and growing with load |
| | `ClientConnections` | compare with Lambda concurrency |
| Lambda | `Errors` on `ragRetrievalFunction` | any. These turns are being answered without course material. |
| | `Duration` p90 on `chatbotV2Function` | more than 1.5 times the baseline (about 20 s) |
| | `ConcurrentExecutions` (account), `Throttles` | approaching 1,000 / any throttles |
| Bedrock | `InvocationThrottles` | any. Bedrock is the limit, not the database. |
| API Gateway | `5XXError`, `4XXError` (429s), `Latency` | 504s mean a turn took longer than 29 s |

**Pass criteria for a stage:** under 1% failed chat requests, chatbot p90 under 20 s, zero retrieval errors, zero throttles, and database CPU under 70%.

### Cleanup

1. Revert the dev database size (`--db-instance-class db.t4g.micro --apply-immediately`).
2. Delete the test users, course and sessions.
3. Check Bedrock spend in Cost Explorer.
4. Record the measured capacity, and whichever limit failed first, in `CLAUDE_HISTORY.md`.
