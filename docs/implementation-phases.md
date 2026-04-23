# Implementation Phases

## Phase 1 — Quick Wins (Low Risk, High Impact)

### 1.1 Remove Dead Code

Three files in `frontend/src/functions/` are never imported anywhere:

- `sigV4Client.js` — custom AWS SigV4 signing implementation (250+ lines)
- `getSignedRequest.js` — wrapper around sigV4Client

These are leftover from an earlier architecture where the app signed API requests with IAM credentials. The current app uses Cognito JWT tokens directly. Removing them also eliminates the `crypto-js` dependency.

Additionally, `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node`, and `@smithy/signature-v4` in `package.json` were only needed for the SigV4 flow and can be removed.

### 1.2 Extract Duplicated Utility Functions

`titleCase()` is copy-pasted into 15 files. `courseTitleCase()` is in 6 files. These should live in a single shared utility:

```
frontend/src/utils/formatters.js
  - titleCase(str)
  - courseTitleCase(str)
```

Every page that defines these locally should import from the shared module instead.

### 1.3 Create a Centralized API Client

Every page manually calls `fetchAuthSession()`, extracts the token, constructs a URL with `import.meta.env.VITE_API_ENDPOINT`, and calls `fetch()` with the same headers pattern. This is repeated 40+ times across the codebase.

Create a single API client:

```
frontend/src/services/api.js
  - apiClient.get(path, params)
  - apiClient.post(path, params, body)
  - apiClient.put(path, params, body)
  - apiClient.delete(path, params)
```

This client would handle auth token injection, error handling, and base URL construction in one place. When the token format or API endpoint changes, you update one file instead of 40.

### 1.4 Add `.env.example`

No `.env.example` exists. New developers have to reverse-engineer which environment variables are needed by grepping the source. Create:

```
frontend/.env.example
  VITE_API_ENDPOINT=
  VITE_AWS_REGION=
  VITE_COGNITO_USER_POOL_ID=
  VITE_COGNITO_USER_POOL_CLIENT_ID=
  VITE_IDENTITY_POOL_ID=
  VITE_GRAPHQL_WS_URL=
  VITE_API_KEY=
```

### 1.5 Clean Up Unused Imports in App.jsx

`cognitoUserPoolsTokenProvider` and `CookieStorage` are imported but never used in `App.jsx`.

---

## Phase 2 — Frontend Architecture (Medium Risk, High Impact)

### 2.1 Standardize Styling Approach

The app mixes three styling systems:
- Tailwind CSS (utility classes in JSX)
- MUI `sx` prop (inline style objects)
- Inline `style={{ }}` attributes

This creates inconsistency and makes it hard to maintain a design system. Pick one primary approach:

- **Option A**: Tailwind-first — use Tailwind for layout/spacing, MUI only for component behavior. Remove `sx` props where Tailwind equivalents exist.
- **Option B**: MUI-first — use MUI's `sx` and theme system for everything. Remove Tailwind.

Option A is recommended since the app already uses Tailwind heavily for layout and MUI primarily for pre-built components (tables, dialogs, drawers).

### 2.2 Add Error Boundaries

No error boundaries exist. A single unhandled error in any component crashes the entire app with a white screen. Add:

- A top-level `ErrorBoundary` wrapping `<Router>` in `App.jsx`
- Page-level error boundaries for each major route

### 2.3 Improve State Management

The app passes `course`, `module`, `setCourse`, `setModule` through 3-4 levels of props. `UserContext` only manages `isInstructorAsStudent`.

Options:
- Expand `UserContext` to include `course`, `module`, and auth state
- Or adopt a lightweight state library like Zustand (simpler than Redux, no boilerplate)

This eliminates prop drilling and makes it easier to add new features that need access to the current course/module.

### 2.4 Add Frontend Tests

Zero test files exist. At minimum:
- Unit tests for utility functions (`titleCase`, API client)
- Component tests for critical flows (login, chat submission)
- Use Vitest (already compatible with Vite) + React Testing Library

### 2.5 Migrate MUI Deprecated Props

27 instances of deprecated `inputProps`/`InputProps`/`InputLabelProps` across 11 files. These still work but will break in a future MUI major. Migrate to `slotProps.htmlInput`, `slotProps.input`, `slotProps.inputLabel`.

---

## Phase 3 — Infrastructure Hardening (Medium Risk, High Impact)

### 3.1 Tighten IAM Permissions

Several IAM policies use `resources: ["*"]` or wildcard ARNs:

| Policy | Current | Should Be |
|---|---|---|
| EC2 network interfaces | `resources: ["*"]` | Scoped to VPC/subnet ARNs |
| CloudWatch logs | `arn:aws:logs:*:*:*` | Scoped to specific log groups (`/aws/lambda/${functionName}`) |
| Secrets Manager | `arn:aws:secretsmanager:*:*:secret:*` | Scoped to specific secret ARNs |
| AWS Marketplace | `resources: ["*"]` | Only needed if using Anthropic models via Marketplace |

The EC2 one genuinely requires `*` for `CreateNetworkInterface` (AWS limitation), but the others can be scoped.

### 3.2 Add S3 Lifecycle Policies

The `dataIngestionBucket`, `embeddingStorageBucket`, and `chatlogsBucket` have no lifecycle policies. Old/orphaned objects accumulate indefinitely. Add:

- Transition to Infrequent Access after 90 days
- Transition to Glacier after 365 days (for chatlog archives)
- Enable versioning with a noncurrent version expiration

### 3.3 RDS SSL Enforcement

The database parameter group has `rds.force_ssl: '0'` — SSL is not enforced for database connections. This means Lambda-to-RDS traffic inside the VPC is unencrypted. Set to `'1'`.

### 3.4 Split the API Gateway Stack

`api-gateway-stack.ts` is a 1000+ line monolith that creates Cognito, Lambda functions, S3 buckets, SQS queues, AppSync, SES, WAF, and IAM roles all in one stack. This makes it:
- Hard to read and maintain
- Slow to deploy (any change redeploys everything)
- Risky (a bad change to one resource can block deployment of unrelated resources)

Recommended split:
- `auth-stack.ts` — Cognito user pool, identity pool, groups, roles
- `lambda-stack.ts` — All Lambda functions and layers
- `storage-stack.ts` — S3 buckets
- `api-stack.ts` — API Gateway, WAF, OpenAPI spec
- `messaging-stack.ts` — SQS, AppSync, SES

### 3.5 Add CDK Tests

`cdk/test/cdk.test.ts` exists but likely only has the default snapshot test. Add:
- Assertion tests for IAM policies (verify no `*` resources where avoidable)
- Assertion tests for Lambda configurations (runtime, timeout, memory)
- Assertion tests for security configurations (S3 block public access, encryption)

---

## Phase 4 — Observability & Reliability (Low Risk, Medium Impact)

### 4.1 Add CloudWatch Alarms

No alarms are configured. At minimum:
- Lambda error rate > 5% over 5 minutes
- Lambda duration > 80% of timeout
- API Gateway 5xx error rate > 1%
- RDS CPU > 80%
- RDS free storage < 20%
- SQS dead letter queue depth > 0

### 4.2 Enable X-Ray Tracing

X-Ray is enabled on AppSync but not on Lambda functions or API Gateway. Enable it across the stack to trace requests end-to-end (API Gateway → Lambda → RDS/Bedrock/DynamoDB).

### 4.3 Structured Logging

Python Lambdas use basic `logging.basicConfig()`. Adopt AWS Lambda Powertools structured logging (already installed via the Powertools layer) for consistent JSON log output with correlation IDs, which makes CloudWatch Insights queries much easier.

---

## Phase 5 — Future Considerations (Higher Risk, Strategic)

### 5.1 React 18 → 19

React 19 is available. The app is on `^18.3.1`. React 19 brings Server Components, `use()` hook, and improved Suspense. Not urgent — React 18 is fully supported. Wait until MUI and MRT officially support React 19 before upgrading.

### 5.2 Vite 5 → 8

Vite 8 is the latest. The remaining 2 moderate npm audit vulnerabilities (`esbuild`/`vite`) would be resolved by this upgrade. However, Vite 8 may have breaking changes in config format. Evaluate when ready.

### 5.3 Python Lambda Runtime 3.11 → 3.13

Python 3.11 is still supported but 3.13 is available on Lambda. Upgrading would allow:
- PyMuPDF upgrade beyond 1.25.5 (requires C++20 / gcc 11+ from AL2023)
- Better performance from Python 3.13 optimizations
- Requires rebuilding Docker images with `python:3.13` base

### 5.4 Consider Aurora Serverless v2

The current RDS PostgreSQL instance is a fixed-size instance. Aurora Serverless v2 would:
- Auto-scale based on load
- Reduce cost during low-traffic periods
- Provide better availability with multi-AZ by default
- Support the same PostgreSQL extensions (pgvector)

### 5.5 Implement CI/CD Pipeline

No CI/CD pipeline exists. Deployments are manual. Implement:
- GitHub Actions (or CodePipeline) for automated testing on PR
- Automated `cdk diff` on PR for infrastructure review
- Automated deployment to dev on merge to main
- Manual approval gate for production deployment
