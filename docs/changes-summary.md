# AILA Platform Improvements — Summary of Changes

This document summarizes all infrastructure, performance, reliability, and code quality improvements made to the AI Learning Assistant (AILA) platform. It is organized by category with clear before/after comparisons and measurable outcomes.

---

## 1. Chatbot Performance

The chatbot is the core student-facing feature. Before these changes, students waited 5–20+ seconds for every AI response with no visual feedback.

### What changed

| Improvement | Before | After | Impact |
|---|---|---|---|
| **Response streaming** (ARCH-1) | Student saw a loading spinner for 5–20 seconds, then the full response appeared at once | Tokens appear in the chat within 1.5–2.5 seconds as the AI generates them, using the existing AppSync WebSocket | Perceived wait time drops from 5–20s to under 2s |
| **Smart query reformulation** (ARCH-2) | Every student message triggered a full LLM call (2–8 seconds) just to rephrase the question before searching course materials | A lightweight heuristic detects standalone questions and skips the unnecessary LLM call on ~70–80% of messages | Saves 2–8 seconds on most messages |
| **Session naming removed from critical path** (ARCH-3) | After generating the AI response, the system made another LLM call (2–8 seconds) to generate a chat title before showing the response | The AI response is returned immediately; the frontend generates a session name client-side | Saves 2–8 seconds on the first student reply |
| **Database query consolidation** (P-2) | 6 sequential database queries ran before any AI work began | Combined into 2 queries using JOINs | Saves 30–60ms per message |
| **Connection reuse** (P-6) | Each search operation opened a new database connection | Reuses the existing global connection | Saves 30–70ms per message |

**Net result**: A typical chat exchange went from 5–20 seconds (with no feedback) to tokens appearing in under 2 seconds.

### What changed (backend API calls)

| Improvement | Before | After | Impact |
|---|---|---|---|
| **Eliminated redundant Cognito calls** (OPT-1) | Every API request called Cognito AdminGetUser (30–80ms) to get the user's email | Email is now passed from the JWT authorizer context — zero network calls | Saves 150–400ms per chat exchange (multiple API calls per exchange) |
| **Reduced sequential queries in chat endpoints** (OPT-3) | 5 database queries per message save operation | 3 queries using INSERT...SELECT | Saves 40–80ms per chat exchange |
| **Eliminated redundant frontend Cognito calls** (OPT-10) | Every API call in the browser made a separate Cognito GetUser request (~30ms each, 30+ occurrences) | Email extracted directly from the cached JWT token | Saves 100–250ms per chat exchange |
| **Fixed infinite retry loop** (OPT-8) | If the LLM returned an empty response, the system retried indefinitely — up to 120 wasted LLM calls over 5 minutes, corrupting chat history | Limited to 3 retries with a user-friendly fallback message | Prevents runaway costs and chat history corruption |

---

## 2. Instructor Dashboard Performance

| Improvement | Before | After | Impact |
|---|---|---|---|
| **Fixed N+1 query in student chat history** (OPT-2) | Viewing a student's chat history ran 22+ sequential database queries (one per module, one per session) | Replaced with 2 queries using a single JOIN | Saves 200–500ms per page load |
| **Parallelized analytics queries** (OPT-4) | 4 sequential database queries for the analytics dashboard | Combined into 3 queries running in parallel | Saves ~45ms per analytics page load |
| **Fixed N+1 metadata query in file management** (OPT-9) | Listing module files ran one database query per file | Single batch query for all files | Saves ~90ms for a module with 10 files |

---

## 3. Infrastructure Cost Reduction

Estimated annual savings: **$1,570–$2,830** across both AWS accounts.

| Change | Savings | Details |
|---|---|---|
| **S3 + DynamoDB gateway endpoints** (CO-1) | ~$60–100/mo | Free endpoints replace NAT Gateway routing for S3 and DynamoDB traffic |
| **Lambda memory right-sizing** (CO-2) | ~$16–30/mo | 8 functions reduced from 512MB to 256MB based on 6 months of production data (all peak under 102MB) |
| **Removed unused RDS VPC endpoint** (CO-3) | ~$28.80/mo | The RDS control plane endpoint was created but never used by any Lambda |
| **Lambda timeout right-sizing** (CO-5) | Prevents waste | 14 functions reduced from 300s to 30–60s; prevents stuck functions from burning 5 minutes of compute |
| **S3 Intelligent-Tiering** (CO-6) | Varies | Automatically moves infrequently accessed course materials to cheaper storage tiers |
| **CloudWatch log retention** (CO-8) | ~$15–45/mo | RDS logs, VPC flow logs, and API Gateway logs now have retention limits instead of infinite storage |
| **Disabled Enhanced Monitoring in dev** (CO-9) | ~$3–5/mo | Standard CloudWatch metrics are sufficient for development |
| **Bedrock VPC endpoint** (P-1) | Reduces NAT costs | Bedrock API traffic (3–4 calls per chat message) stays on AWS backbone instead of routing through NAT |

---

## 4. Observability & Monitoring

Before these changes, the platform had no alarms, incomplete tracing, inconsistent logging, and no operational dashboard. Operators had no way to detect issues proactively.

### CloudWatch Alarms (101 total)

| Category | What's monitored | Thresholds |
|---|---|---|
| **Lambda errors** (42 alarms) | Error rate per function | Warning at 5% (prod) / 10% (dev), Critical at 25% |
| **Lambda duration** (21 alarms) | p99 execution time per function | Warning at 80% of configured timeout |
| **Lambda throttling** (21 alarms) | Any throttle event per function | Critical on any occurrence |
| **API Gateway errors** (3 alarms) | 5xx error rate + missing traffic detection | Warning at 1%, Critical at 5%, Missing traffic after 15 min |
| **Database health** (6 alarms) | CPU, storage, connections, latency | CPU warning at 80%/90%, storage warning at 20% free, latency at 100ms |
| **Message queue** (4 alarms) | Dead letter queue depth, queue backlog, consumer delay | DLQ > 0 is critical, queue depth > 100 is warning |
| **GraphQL API** (2 alarms) | AppSync 5xx errors and latency | Any 5xx is warning, latency > 5s is warning |
| **Composite alarms** (2 alarms) | Multi-component failure detection | Reduces alert storms during cascading failures |

Every alarm includes runbook-style descriptions with specific investigation steps.

### Notification Routing

- **Production**: Warning alarms → Warning SNS topic, Critical alarms → Critical SNS topic
- **Development**: All alarms → Warning topic only (avoids off-hours noise)
- Email notifications delivered to the operations team

### Distributed Tracing (X-Ray)

| Before | After |
|---|---|
| X-Ray enabled only on AppSync | X-Ray active on API Gateway, all 21 Lambda functions, and container images |
| No downstream call tracing | Container Lambdas instrument boto3 and httpx calls as X-Ray subsegments |
| No sampling control | Environment-aware sampling: 100% in dev, 5% in prod |

### Structured Logging

| Before | After |
|---|---|
| Mix of `print()`, `logging.basicConfig()`, and `console.log` | Python handlers use AWS Lambda Powertools Logger with structured JSON output |
| No correlation between log entries | Session ID, course ID, and request ID appended as correlation keys |
| No log retention policies | 30-day retention in dev, 90-day in prod |

### Operational Dashboard

A single CloudWatch dashboard (`AILA-{env}-Dashboard`) provides a consolidated view:
- Lambda error counts and p99 duration for all functions
- API Gateway 5xx/4xx errors and latency
- RDS CPU, storage, connections, and read latency
- SQS queue depth and dead letter queue depth
- AppSync errors and latency
- Container Lambda cold start (Init Duration) metrics
- Alarm status for all 101 alarms

### Dead Letter Queue

| Before | After |
|---|---|
| Failed SQS messages were silently lost | FIFO dead letter queue captures messages after 3 failed processing attempts |
| No visibility into processing failures | DLQ alarm fires immediately on any message, with runbook guidance |

---

## 5. Security Hardening

| Change | Before | After |
|---|---|---|
| **IAM policy scoping** (3.1) | Several policies used `resources: ["*"]` for CloudWatch Logs and Secrets Manager | Scoped to specific log groups and secret ARNs per function |
| **Authorizers moved out of VPC** (P-3) | JWT authorizers were in the VPC despite only accessing public services (Secrets Manager, Cognito JWKS) | Moved out of VPC — eliminates 1–5 second cold starts on auth, reduces attack surface |
| **Pre-signup Lambda moved out of VPC** (P-8) | Email domain validation Lambda was in the VPC despite only accessing SSM (public service) | Moved out of VPC — faster signups after idle periods |
| **API Gateway data trace disabled** (CO-8c) | Full request/response bodies logged for every API call (PII exposure risk) | Disabled — error-level logging still captures details when needed |
| **SNS topic encryption** | No SNS topics existed | Warning and Critical topics created with KMS server-side encryption |

---

## 6. Code Quality & Maintainability

| Change | Details |
|---|---|
| **Dead code removal** | Removed unused functions (`update_session_name`, `get_response`, `generate_response`, `s3_key_exists`, `LLM_evaluation` class), unused imports across 8+ files |
| **Unused dependency removal** | Removed `postgres`, `readline-sync` from CDK; removed `Pillow`, `PyMuPDF`, `sqlalchemy` from sqsTrigger Docker image (reduced image size) |
| **Bare print() cleanup** | Replaced remaining `print()` statements in data ingestion pipeline with structured logger calls |
| **Unused import cleanup** | Removed 6 unused TypeScript imports from the API Gateway stack (`Architecture`, `Function`, `CfnJson`, `parse`/`stringify`, `bedrock`) |
| **Bug fix: engagement log** (OPT-7) | The "course access" engagement log was silently never written due to two bugs (wrong column name + undefined variable). Fixed both — instructors now see course access data in analytics. |
| **Bug fix: filename parsing** (OPT-9) | File metadata lookup broke for filenames with dots (e.g., `report.v2.pdf`). Fixed by using `rsplit` instead of `split`. |

---

## 7. Frontend Improvements

| Change | Details |
|---|---|
| **Code splitting** (P-4) | Role-specific pages lazy-loaded — students no longer download instructor/admin code, `recharts`, or `material-react-table` |
| **Parallel API calls** (P-7) | Message save and AI generation now fire in parallel instead of sequentially — saves 100–300ms per message |
| **Centralized API client** (1.3) | 79 fetch calls across 23 files consolidated into a shared API client with consistent auth, error handling, and token management |
| **Deduplicated utilities** (1.2) | ~645 lines of duplicated code (text formatting, file helpers, sign-out handler, toast config) extracted into 4 shared modules |
| **Toast consolidation** (1.4) | 14 duplicate `<ToastContainer>` instances replaced with a single root-level container; 90 toast calls simplified from 7-line config blocks to single-line calls |
| **Environment documentation** (1.5) | Added `.env.example` documenting all 6 required environment variables |

---

## 8. Reliability Improvements

| Change | Before | After |
|---|---|---|
| **LLM retry limit** (OPT-8) | Infinite retry loop on empty LLM response — could run for 5 minutes, make ~120 wasted Bedrock calls, and corrupt chat history | 3 retries with user-friendly fallback message |
| **X-Ray SDK failure isolation** | No X-Ray instrumentation | X-Ray SDK wrapped in try/except — if patching fails, the function continues without tracing |
| **Dead letter queue** | Failed SQS messages silently lost | Captured after 3 attempts with immediate alerting |
| **Composite alarms** | No multi-component failure detection | SystemHealthCritical and DataPipelineHealth alarms reduce alert noise during cascading failures |
| **Missing traffic detection** | No way to detect if the API stopped receiving requests | Alarm fires after 15 minutes of zero traffic (prod only) |
| **Cognito trigger optimization** (OPT-11) | Redundant AdminGetUser call on every login/signup | Email read directly from trigger event — eliminates unnecessary API call |

---

## Deployment Notes

- All changes deploy via CDK: `cdk deploy --all --context StackPrefix=AILA --context environment=dev`
- The ObservabilityStack is a new stack that deploys after the ApiGatewayStack
- Container Lambda changes (Powertools Logger, X-Ray SDK) require Docker image rebuilds — use `--no-cache` on first deploy to ensure fresh dependencies
- Environment-specific behavior is controlled by the `environment` CDK context parameter (`dev` vs `prod`)
