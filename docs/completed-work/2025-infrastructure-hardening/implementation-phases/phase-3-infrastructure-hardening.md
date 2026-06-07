# Phase 3 — Infrastructure Hardening (Medium Risk, High Impact)

## 3.1 Tighten IAM Permissions

### Summary

A full audit of every IAM policy statement across all four CDK stacks (`api-gateway-stack.ts`, `dbFlow-stack.ts`, `database-stack.ts`, `vpc-stack.ts`) identified 12 distinct findings. Each was cross-referenced against the actual Lambda application code to verify breakage risk.

### Findings

#### 3.1.1 Remove `AmazonS3FullAccess` Managed Policy — CRITICAL

- **Location**: `dbFlow-stack.ts` line 68, attached to the initializer Lambda role
- **Current**: `AmazonS3FullAccess` — grants read/write/delete to every S3 bucket in the account
- **Code evidence**: `initializer.py` only uses `secretsmanager` (GetSecretValue, PutSecretValue) and PostgreSQL via psycopg2. Zero S3 calls, no `boto3.client('s3')`, no bucket references anywhere in the file.
- **Action**: Remove entirely
- **Breakage risk**: None

#### 3.1.2 Remove `AmazonSSMReadOnlyAccess` Managed Policy

- **Location**: `dbFlow-stack.ts` line 65, attached to the initializer Lambda role
- **Current**: Grants read access to all SSM parameters in the account
- **Code evidence**: `initializer.py` doesn't use SSM — no `ssm` client, no `GetParameter` calls. Environment variables (`DB_SECRET_NAME`, `DB_USER_SECRET_NAME`, `DB_PROXY`) are all Secrets Manager references.
- **Action**: Remove entirely
- **Breakage risk**: None

#### 3.1.3 Remove IAM `AddUserToGroup` Permission

- **Location**: `api-gateway-stack.ts` line 681, on `coglambdaRole`
- **Current**: `iam:AddUserToGroup` on `arn:aws:iam::${account}:user/*` and `group/*`
- **Code evidence**: All four functions using `coglambdaRole` were checked:
  - `preSignupLambda` → uses SSM only
  - `addStudentOnSignUp` → uses Cognito `AdminAddUserToGroupCommand` (not IAM)
  - `adjustUserRoles` → uses Cognito `AdminAddUserToGroupCommand`/`AdminRemoveUserFromGroupCommand` (not IAM)
  - `sqsFunction` → uses SQS and database only
  - None import `IAMClient` or call `iam:AddUserToGroup`. The app uses Cognito group management, not IAM group management.
- **Action**: Remove entirely
- **Breakage risk**: None

#### 3.1.4 Remove Unused SES Permission

- **Location**: `api-gateway-stack.ts` line 1484, added to `notificationFunction` via `addToRolePolicy`
- **Current**: `ses:SendEmail`, `ses:SendRawEmail` on `resources: ['*']`
- **Code evidence**: `eventNotification.py` receives an AppSync event and returns data — it does not call SES. No `ses` client, no `send_email` calls. Cognito sends emails directly via its SES configuration (configured in `cfnUserPool.emailConfiguration`), not through this Lambda.
- **Side effect**: Because `notificationFunction` uses the shared `lambdaRole`, this SES permission is also granted to `studentFunction`, `instructorFunction`, and `adminFunction` — none of which use SES.
- **Action**: Remove entirely
- **Breakage risk**: None

#### 3.1.5 Scope RDS Proxy `rds-db:connect`

- **Location**: `database-stack.ts` line 142, on `rdsProxyRole`
- **Current**: `rds-db:connect` on `resources: ['*']` — can connect to any RDS database in the account
- **Should be**: `arn:aws:rds-db:${region}:${account}:dbuser:${dbResourceId}/*` where `dbResourceId` is the DBI resource ID of the RDS instance
- **Code evidence**: Three RDS proxies are created, all connecting to the same `dbInstance`.
- **Implementation note**: The DBI resource ID isn't directly available as a high-level CDK property. Use `dbInstance.instanceResourceId` (available via `CfnDBInstance` or the `instanceResourceId` attribute on `DatabaseInstance`). Verify the attribute is available in your CDK version.
- **Action**: Scope to specific DB resource ID
- **Breakage risk**: Low if implemented correctly, high impact if the resource ID is wrong (all three proxies lose connectivity). Test in dev first.

#### 3.1.6 Scope Secrets Manager Wildcards (8+ occurrences)

- **Locations**: `api-gateway-stack.ts` (lines 476, 643, 723, 1018, 1214, 1266, 1315, 1396, 1670), `dbFlow-stack.ts` (line 38)
- **Current**: `arn:aws:secretsmanager:${region}:${account}:secret:*` — access to every secret in the account
- **Code evidence** — each function accesses specific secrets:

| Function | Secret(s) accessed | CDK construct available? |
|---|---|---|
| `studentFunction` | `db.secretPathUser` | Yes — `.secretArn` |
| `instructorFunction` | `db.secretPathUser` | Yes |
| `adminFunction` | `db.secretPathTableCreator` | Yes — `.secretArn` |
| Authorizer functions (×3) | `this.secret` (Cognito secrets) | Yes — `.secretArn` |
| `textGenLambdaDockerFunc` | `db.secretPathUser` | Yes |
| `dataIngestLambdaDockerFunc` | `db.secretPathAdminName` | Partial — name available, ARN needs construction |
| `getFilesFunction` | `db.secretPathUser` | Yes |
| `deleteFile` | `db.secretPathUser` | Yes |
| `deleteLastMessage` | `db.secretPathUser` | Yes |
| `sqsTrigger` | `db.secretPathUser` | Yes |
| `initializer` | `DB_SECRET_NAME` (admin), `DB_USER_SECRET_NAME`, `DB_PROXY` (table creator) | Partial |

- **Dependency note**: The shared `lambdaRole` serves functions accessing different secrets (`secretPathUser`, `secretPathTableCreator`, `this.secret`). Scoping the shared role requires including all secrets those functions need. Splitting shared roles first (3.1.11) makes this simpler.
- **Additional note**: `coglambdaRole` has a redundant second Secrets Manager policy (line 723) granting `PutSecretValue` — no function using `coglambdaRole` calls `PutSecretValue`. This can be removed.
- **Action**: Scope to specific secret ARNs using CDK construct references. For `secretPathAdminName` (a string, not a Secret construct), construct the ARN as `arn:aws:secretsmanager:${region}:${account}:secret:${secretPathAdminName}-*` (the `-*` suffix accounts for the random characters AWS appends).
- **Breakage risk**: Low — secret ARNs are deterministic and available from CDK constructs

#### 3.1.7 Scope DynamoDB Wildcards (2 occurrences)

- **Location**: `api-gateway-stack.ts` lines 1034 and 1405
- **Current**: `arn:aws:dynamodb:${region}:${account}:table/*` — access to every DynamoDB table in the account
- **Code evidence**:
  - `textGenLambdaDockerFunc`: calls `list_tables()`, `create_table()`, `describe_table()` (require `*` resource), plus `PutItem`/`GetItem`/`UpdateItem` on a specific table. Table name comes from SSM parameter `TABLE_NAME_PARAM`.
  - `deleteLastMessage`: calls `GetItem`/`UpdateItem` on the same table (via `TABLE_NAME_PARAM`).
- **Action**:
  - `textGenLambdaDockerFunc`: Split into two policy statements — one for `ListTables`/`CreateTable`/`DescribeTable` on `*`, another for `PutItem`/`GetItem`/`UpdateItem` on the specific table ARN
  - `deleteLastMessage`: Scope fully to the specific table ARN
- **Implementation note**: The table name is stored in SSM, not as a CDK construct. Options: (a) create the DynamoDB table in CDK and reference its ARN, (b) use a known table name pattern, or (c) accept `*` for the `ListTables`/`CreateTable` actions only.
- **Breakage risk**: Low

#### 3.1.8 Scope CloudWatch Logs Wildcards (3 occurrences)

- **Locations**: `api-gateway-stack.ts` (lines 505, 672), `dbFlow-stack.ts` (line 50)
- **Current**: `arn:aws:logs:*:*:*` — access to all log groups in all regions and accounts
- **Should be**: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${functionName}:*` for each function using the role
- **Code evidence**: Each role serves known Lambda functions with predictable log group names:
  - `lambdaRole` (api-gateway-stack): `studentFunction`, `instructorFunction`, `adminFunction`, `notificationFunction`, plus 3 authorizer functions — 7 log groups
  - `coglambdaRole`: `preSignupLambda`, `addStudentOnSignUp`, `adjustUserRoles`, `sqsFunction` — 4 log groups
  - `lambdaRole` (dbFlow-stack): `initializerFunction` — 1 log group
- **Action**: Scope to specific log group ARNs for all functions sharing each role
- **Breakage risk**: None — log group names are deterministic from `functionName` properties

#### 3.1.9 Scope SSM `parameter/*` Wildcard (coglambdaRole)

- **Location**: `api-gateway-stack.ts` line 730
- **Current**: `arn:aws:ssm:${region}:${account}:parameter/*` — read access to every SSM parameter
- **Code evidence**: The only `coglambdaRole` function that uses SSM is `preSignupLambda`, which reads `/AILA/AllowedEmailDomains`.
- **Should be**: `arn:aws:ssm:${region}:${account}:parameter/AILA/AllowedEmailDomains`
- **Action**: Scope to the specific parameter ARN
- **Breakage risk**: None

#### 3.1.10 Verify and Potentially Remove AWS Marketplace Permission

- **Location**: `api-gateway-stack.ts` line 999, applied to `textGenLambdaDockerFunc` and `dataIngestLambdaDockerFunc`
- **Current**: `aws-marketplace:ViewSubscriptions`, `Subscribe`, `Unsubscribe` on `resources: ["*"]`
- **Code evidence**: The Bedrock policy references `meta.llama3-70b-instruct-v1:0`, `anthropic.claude-3-sonnet-20240229-v1:0`, and `amazon.titan-embed-text-v2:0`. Claude is available natively through Bedrock without a Marketplace subscription.
- **Action**: Check if the AWS account has a Marketplace subscription for Claude. If using Bedrock native access → remove. If using Marketplace → keep (`*` is required since Marketplace actions don't support resource-level restrictions).
- **Breakage risk**: Low if verified; removing when Marketplace is actually in use would break Claude model access

#### 3.1.11 Split Shared IAM Roles

- **Location**: `api-gateway-stack.ts`
- **Current state**:
  - `lambdaRole` (`postgresLambdaRole`): shared by `studentFunction`, `instructorFunction`, `adminFunction`, `notificationFunction`, and 3 authorizer functions (7 functions total)
  - `coglambdaRole` (`cognitoLambdaRole`): shared by `preSignupLambda`, `addStudentOnSignUp`, `adjustUserRoles`, `sqsFunction` (4 functions total)
- **Actual permissions needed per function**:

| Function | Actually needs |
|---|---|
| `studentFunction` | Secrets Manager (secretPathUser), EC2 VPC, Logs |
| `instructorFunction` | Secrets Manager (secretPathUser), EC2 VPC, Logs |
| `adminFunction` | Secrets Manager (secretPathTableCreator), EC2 VPC, Logs, Cognito admin |
| `notificationFunction` | Secrets Manager (secretPathUser), EC2 VPC, Logs, AppSync |
| Authorizer functions (×3) | Secrets Manager (Cognito secret), Logs |
| `preSignupLambda` | SSM (AllowedEmailDomains), Logs |
| `addStudentOnSignUp` | Secrets Manager (secretPathTableCreator), EC2 VPC, Logs, Cognito admin |
| `adjustUserRoles` | Secrets Manager (secretPathTableCreator), EC2 VPC, Logs, Cognito admin |
| `sqsFunction` | Secrets Manager (secretPathUser), EC2 VPC, Logs, SQS |

- **Key over-permissions from sharing**:
  - `studentFunction` and `instructorFunction` get Cognito admin permissions they don't use
  - All `lambdaRole` functions get SES permissions none of them use
  - `notificationFunction` gets Cognito admin permissions it doesn't use
  - Authorizer functions get EC2 VPC and Cognito admin permissions they don't need (they run outside VPC)
  - `preSignupLambda` gets EC2 VPC, Secrets Manager, Cognito admin, IAM AddUserToGroup, and PutSecretValue — it only needs SSM
  - `sqsFunction` gets IAM AddUserToGroup, Cognito admin, and PutSecretValue it doesn't use
- **Action**: Create per-function (or per-function-group) roles with only the permissions each function actually needs. Suggested groupings:
  - `dbLambdaRole`: for `studentFunction`, `instructorFunction` (identical needs)
  - `adminLambdaRole`: for `adminFunction` (needs different secret + Cognito admin)
  - `notificationLambdaRole`: for `notificationFunction` (needs AppSync, no Cognito)
  - `authorizerRole`: for the 3 authorizer functions (no VPC, just Secrets Manager + Logs)
  - `cognitoTriggerRole`: for `addStudentOnSignUp`, `adjustUserRoles` (Cognito admin + DB)
  - `preSignupRole`: for `preSignupLambda` (SSM only)
  - `sqsLambdaRole`: for `sqsFunction` (SQS + DB)
- **Breakage risk**: None if each new role gets the permissions its function actually uses. This is the highest-effort change but is the root cause of most over-permissioning.

#### 3.1.12 EC2 Network Interfaces — No Change Needed

- **Locations**: `api-gateway-stack.ts` (lines 491, 658), `dbFlow-stack.ts` (line 61)
- **Current**: `resources: ["*"]` for `CreateNetworkInterface`, `DescribeNetworkInterfaces`, `DeleteNetworkInterface`, `AssignPrivateIpAddresses`, `UnassignPrivateIpAddresses`
- **Verdict**: Must remain `*` — AWS does not support resource-level permissions for these EC2 actions. This is documented in the [AWS IAM documentation](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html).
- **Action**: None

### Recommended Implementation Order

Based on breakage risk and dependency analysis:

| Phase | Items | Risk | Effort |
|---|---|---|---|
| **1. Remove unused permissions** | 3.1.1, 3.1.2, 3.1.3, 3.1.4 | None | Low |
| **2. Scope single-function policies** | 3.1.9, 3.1.7 (deleteLastMessage only) | None | Low |
| **3. Split shared roles** | 3.1.11 | None (if mapped correctly) | High |
| **4. Scope shared-role policies** | 3.1.6, 3.1.7 (textGen), 3.1.8 | Low | Medium |
| **5. Scope infrastructure roles** | 3.1.5 (RDS Proxy) | Low–Medium | Low |
| **6. Verify and remove Marketplace** | 3.1.10 | Low (needs account check) | Low |


## 3.2 S3 Storage Policies

### Summary

All three S3 buckets were audited for storage configuration, access patterns, and cost optimization. The goal is to keep all data forever while minimizing storage costs and preventing silent failures from archived objects.

All three buckets currently have Intelligent Tiering with Archive Access at 90 days. This creates a latent bug: presigned URL downloads will fail silently for objects that have been archived, because none of the download Lambda functions handle the `RestoreObject` flow.

### Findings

#### 3.2.1 `dataIngestionBucket` — Fix Archive Access Tier Risk

- **Purpose**: Stores course documents (PDFs, DOCX, PPTX, TXT, etc.) uploaded by instructors
- **Write pattern**: Instructors upload documents via presigned URLs (`generatePreSignedURL` Lambda)
- **Read pattern**: Data ingestion Lambda reads immediately on upload to extract text and generate embeddings. After initial processing, files are read on-demand when instructors view/download them via `getPresignedURL` Lambda.
- **Current config**: Intelligent Tiering with `archiveAccessTierTime: 90 days`
- **Problem**: When an object moves to Archive Access tier after 90 days without access, it requires 3–5 hours to restore. The `getPresignedURL` Lambda generates a presigned URL immediately and returns it — but the GET request against that URL will fail with a `403 InvalidObjectState` error because the object is archived. There is no restore handling in the download flow.
- **Action**: Remove the `archiveAccessTierTime` property. Standard Intelligent Tiering (Frequent ↔ Infrequent Access) provides automatic cost savings with zero retrieval latency. Infrequent Access tier kicks in after 30 days of no access and costs ~45% less than Frequent Access.
- **Cost analysis** (prices from [AWS S3 Pricing](https://aws.amazon.com/s3/pricing/) and [aws51.com](https://aws51.com/en/s3-intelligent-tiering-deep-dive/), US East rates — Canada Central is slightly higher but ratios are the same):

  Current setup (with Archive Access at 90 days):

  | Tier | Triggers after | $/GB/month | Retrieval latency |
  |---|---|---|---|
  | Frequent Access | Day 0 | ~$0.023 | Milliseconds |
  | Infrequent Access | 30 days no access | ~$0.0125 | Milliseconds |
  | Archive Access | 90 days no access | ~$0.0036 | **3–5 hours** |

  Recommended setup (without Archive Access):

  | Tier | Triggers after | $/GB/month | Retrieval latency |
  |---|---|---|---|
  | Frequent Access | Day 0 | ~$0.023 | Milliseconds |
  | Infrequent Access | 30 days no access | ~$0.0125 | Milliseconds |

  Both setups include a monitoring fee of $0.0025 per 1,000 objects/month.

  Example cost comparison (100 GB, 80% not accessed in 90+ days):
  - Current: ~20 GB × $0.0125 + 80 GB × $0.0036 = **~$0.54/month**
  - Recommended: ~20 GB × $0.023 + 80 GB × $0.0125 = **~$1.46/month**
  - Difference: **~$0.92/month** ($11/year) for 100 GB
  - At 1 TB: ~$9.20/month ($110/year) more
  - At 10 TB: ~$92/month ($1,100/year) more

  The tradeoff is ~$0.009/GB/month more to avoid the silent download failure bug. For an educational platform where instructors expect instant file downloads, a 3–5 hour restore wait (or a cryptic 403 error) is a poor user experience. At typical educational app scale (hundreds of GBs), the cost difference is single-digit dollars per month.

- **Alternative**: If the bucket grows to multi-TB scale and cost becomes a concern, add Archive Access back along with a restore-and-notify flow in the download Lambda (`RestoreObject` → poll for completion → notify user). Not worth the engineering effort at smaller scale.
- **Breakage risk**: None (removing archive tier only increases availability)

#### 3.2.2 `embeddingStorageBucket` — Add Orphan Cleanup

- **Purpose**: Temporary storage for extracted per-page `.txt` files during the data ingestion pipeline
- **Write pattern**: Data ingestion Lambda writes one `.txt` file per page of each uploaded document
- **Read pattern**: The chunking step reads each `.txt` file back, processes it, then **explicitly deletes it** (`s3.delete_object` in `store_doc_chunks` in `documents.py`). Objects should never persist beyond a single Lambda invocation.
- **Current config**: Intelligent Tiering with `archiveAccessTierTime: 90 days`
- **Problem**: The tiering config is harmless but pointless — objects are deleted within seconds of creation. The real risk is orphaned objects from failed Lambda runs (crash after writing page text but before deletion). These accumulate silently and cost money.
- **Action** — two lifecycle rules targeting two different failure modes:
  1. **Object expiration rule (7 days)**: Cleans up orphaned complete objects. When the data ingestion Lambda crashes between writing per-page `.txt` files and deleting them (timeout, out of memory, Bedrock throttling), those files are left behind as finished objects in S3. They're small (a few KB each) but accumulate over time. Since normal objects are created and deleted within seconds of the same Lambda invocation, anything still present after 7 days is guaranteed to be an orphan from a failed run. The 7-day window gives time to investigate failures before evidence is cleaned up.
  2. **AbortIncompleteMultipartUpload rule (1 day)**: Cleans up incomplete upload parts. When a large file upload starts but never finishes (network drop, Lambda timeout mid-upload), the uploaded parts sit invisibly in S3 — they don't appear in object listings but still incur storage charges (only visible via the `ListMultipartUploads` API). This rule aborts any multipart upload that has been in progress for more than 1 day without completing, and deletes the orphaned parts.
  - These are two different S3 lifecycle actions: object expiration targets files that were successfully written but never deleted; abort-multipart targets uploads that were started but never became objects.
  - Also remove the `archiveAccessTierTime` (objects never live long enough to be tiered)
- **Breakage risk**: None — only affects objects that should have been deleted

#### 3.2.3 `chatlogsBucket` — Fix Archive Access Tier Risk

- **Purpose**: Stores exported chat log CSV files generated by the SQS trigger Lambda
- **Write pattern**: SQS trigger Lambda queries the database, generates CSV files, and uploads them with key pattern `{course_id}/{instructor_email}/{timestamp}.csv`
- **Read pattern**: Instructors download via `getChatLogsFunction` which lists files and generates presigned URLs. Downloads are concentrated right after generation, with occasional re-downloads later.
- **Current config**: Intelligent Tiering with `archiveAccessTierTime: 90 days`
- **Problem**: Same as `dataIngestionBucket` — `getChatLogsFunction` generates presigned URLs without checking object storage class. Downloads of chatlogs older than 90 days (without intervening access) will fail with `403 InvalidObjectState`.
- **Action**: Remove the `archiveAccessTierTime` property. Standard Intelligent Tiering (Frequent ↔ Infrequent) provides automatic savings with instant access.
- **Alternative**: Same as 3.2.1 — add Deep Archive at 365 days with a restore flow if deeper savings are needed.
- **Breakage risk**: None (removing archive tier only increases availability)

#### 3.2.4 Add `AbortIncompleteMultipartUpload` to All Buckets

- **Current**: No multipart upload cleanup on any bucket
- **Problem**: Large file uploads (PDFs, PPTX) that fail midway leave incomplete multipart upload parts in S3. These are invisible in the console but accumulate and incur storage charges.
- **Action**: Add a lifecycle rule with `abortIncompleteMultipartUploadAfter: 1 day` to all three buckets
- **Breakage risk**: None — only affects uploads that were never completed

#### 3.2.5 Explicitly Set Server-Side Encryption

- **Current**: No `encryption` property set on any bucket
- **Reality**: S3 encrypts all new objects with SSE-S3 (AES-256) by default since January 2023, so data is encrypted at rest regardless. However, explicitly setting this in CDK is good practice for compliance audits and documentation.
- **Action**: Add `encryption: s3.BucketEncryption.S3_MANAGED` to all three buckets. If the application handles sensitive student data subject to FERPA or similar regulations, consider `KMS_MANAGED` for key rotation and audit trail capabilities (higher cost).
- **Breakage risk**: None — makes the existing default explicit

### Recommended Implementation Order

| Phase | Items | Risk | Effort |
|---|---|---|---|
| **1. Fix archive tier bug** | 3.2.1, 3.2.3 (remove `archiveAccessTierTime`) | None | Low |
| **2. Add cleanup rules** | 3.2.2 (orphan expiration), 3.2.4 (abort multipart) | None | Low |
| **3. Explicit encryption** | 3.2.5 | None | Low |

## 3.3 RDS SSL Enforcement

### Summary

The database parameter group has `rds.force_ssl: '0'` — SSL is not enforced for database connections. This means Lambda-to-RDS traffic inside the VPC is unencrypted. Enabling SSL requires coordinated changes across three layers: the RDS parameter group, the RDS proxies, and every Lambda function's connection code.

There are **13 distinct database connection paths** across the application. All of them currently connect without SSL. Enabling `rds.force_ssl: '1'` without updating all connection paths simultaneously will cause an immediate outage for any Lambda that hasn't been updated.

### Findings

#### 3.3.1 Three-Layer SSL Architecture

Database connections in this application flow through three layers, each with its own SSL setting:

```
Lambda → RDS Proxy → RDS Instance
  ↑          ↑            ↑
ssl:false  requireTLS:false  rds.force_ssl:'0'
```

All three layers must be updated together:

1. **RDS Instance** (`database-stack.ts` line 71): `rds.force_ssl: '0'` → `'1'`
   - Forces the PostgreSQL server to reject non-SSL connections
2. **RDS Proxies** (`database-stack.ts` lines 157, 164, 174): `requireTLS: false` → `true` on all three proxies (`rdsProxy`, `rdsProxyTableCreator`, `rdsProxyAdmin`)
   - Forces the proxy to require TLS from Lambda clients AND use TLS to the RDS backend
3. **Lambda connection code**: Must add SSL parameters to every connection string

#### 3.3.2 Complete Inventory of Connection Paths Requiring Updates

**Node.js Lambda functions (using `postgres` library)**:

| File | Current SSL setting | Connects via |
|---|---|---|
| `cdk/lambda/lib/lib.js` | `ssl: false` | `rdsProxy` (user credentials) |
| `cdk/lambda/adminFunction/libadmin.js` | `ssl: false` | `rdsProxyTableCreator` (table creator credentials) |

These serve 7 Lambda functions total:
- `lib.js`: `studentFunction`, `instructorFunction`, `notificationFunction`, `sqsFunction`
- `libadmin.js`: `adminFunction`, `addStudentOnSignUp`, `adjustUserRoles`

**Fix**: Change `ssl: false` to `ssl: 'require'` (or `ssl: { rejectUnauthorized: false }` if using RDS Proxy, since the proxy terminates TLS and presents its own certificate). The `postgres` npm library accepts `ssl: 'require'` to enable SSL without certificate verification, which is appropriate for RDS Proxy connections within a VPC.

**Python Lambda functions (using `psycopg2` with connection string)**:

| File | Current SSL setting | Connects via |
|---|---|---|
| `cdk/lambda/deleteFile/deleteFile.py` | No SSL param | `rdsProxy` |
| `cdk/lambda/deleteLastMessage/deleteLastMessage.py` | No SSL param | `rdsProxy` |
| `cdk/lambda/getFilesFunction/getFilesFunction.py` | No SSL param | `rdsProxy` |
| `cdk/sqsTrigger/src/main.py` | No SSL param | `rdsProxy` |
| `cdk/text_generation/src/main.py` | No SSL param | `rdsProxy` |
| `cdk/data_ingestion/src/main.py` | No SSL param | `rdsProxyAdmin` |

All six use the same pattern:
```python
connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
connection = psycopg2.connect(connection_string)
```

**Fix**: Add `'sslmode': 'require'` to the `connection_params` dict in each file.

**Python Lambda function (using `psycopg2` with keyword arguments)**:

| File | Current SSL setting | Connects via |
|---|---|---|
| `cdk/lambda/initializer/initializer.py` | `# sslmode="require"` (commented out) | Direct to RDS (via `dbSecret["host"]`) |

This is the only function that connects directly to the RDS instance (not through a proxy). It uses the admin credentials from Secrets Manager.

**Fix**: Uncomment `sslmode="require"`.

**Python SQLAlchemy/LangChain connections (using `postgresql+psycopg://` URI)**:

| File | Current SSL setting | Used by |
|---|---|---|
| `cdk/data_ingestion/src/helpers/helper.py` | No SSL param in URI | Data ingestion vectorstore (PGVector + SQLRecordManager) |
| `cdk/text_generation/src/helpers/helper.py` | No SSL param in URI | Text generation vectorstore (PGVector) |

These construct SQLAlchemy connection strings like:
```python
f"postgresql+psycopg://{user}:{password}@{host}:{port}/{dbname}"
```

**Fix**: Append `?sslmode=require` to the URI:
```python
f"postgresql+psycopg://{user}:{password}@{host}:{port}/{dbname}?sslmode=require"
```

**Python raw psycopg2 connection (in vectorstore hybrid search)**:

| File | Current SSL setting | Used by |
|---|---|---|
| `cdk/text_generation/src/helpers/vectorstore.py` | No SSL param | Text generation hybrid search |

This constructs a psycopg2 connection string:
```python
f"dbname={...} user={...} password={...} host={...} port={...}"
```

**Fix**: Add `sslmode=require` to the connection string:
```python
f"dbname={...} user={...} password={...} host={...} port={...} sslmode=require"
```

#### 3.3.3 Deployment Order — CRITICAL

This change must be deployed in a specific order to avoid downtime:

**Option A: Zero-downtime (recommended)**
1. **First**: Update all Lambda connection code to use SSL (deploy Lambda changes only)
   - With `rds.force_ssl: '0'` still set, SSL connections are accepted but not required
   - All Lambdas will start using SSL, but non-SSL would still work as fallback
   - With `requireTLS: false` on proxies, the proxy accepts both SSL and non-SSL from Lambda
2. **Second**: Set `requireTLS: true` on all three RDS proxies
   - Now proxies require SSL from Lambda (already done in step 1) and use SSL to RDS backend
3. **Third**: Set `rds.force_ssl: '1'` on the RDS parameter group
   - Now the database rejects any non-SSL connection (all paths already use SSL)

**Option B: Maintenance window**
1. Deploy all changes at once during a maintenance window
2. Simpler but causes brief downtime while CloudFormation updates the parameter group and proxies

**Option A is strongly recommended** because a failed deployment in Option B could leave the system in a partially-updated state where some connections work and others don't.

#### 3.3.4 RDS Proxy Certificate Considerations

When `requireTLS: true` is set on RDS Proxy:
- **Lambda → Proxy**: The proxy presents an AWS-managed TLS certificate. Using `sslmode=require` (without `verify-full`) is sufficient and recommended for RDS Proxy connections, because the proxy's certificate CN doesn't match the proxy endpoint hostname. Using `sslmode=verify-full` would require additional certificate configuration and is not necessary within a VPC.
- **Proxy → RDS**: The proxy automatically uses TLS to connect to the RDS backend when `requireTLS: true` is set. No additional configuration needed.

#### 3.3.5 Initializer Lambda — Special Case

The initializer (`initializer.py`) connects directly to the RDS instance (not through a proxy) using `dbSecret["host"]`. After enabling `rds.force_ssl: '1'`, this function must use SSL. The `sslmode="require"` parameter is already present but commented out — uncomment it.

However, the initializer runs only during deployment (it's a CDK `TriggerFunction`). If the SSL change is deployed in the same stack update that enables `rds.force_ssl: '1'`, the trigger will re-run with the updated code. Verify that the CDK trigger re-executes on code changes (it should, since `TriggerFunction` re-runs when the Lambda code asset hash changes).

### Recommended Implementation Order

| Phase | Action | Risk | Notes |
|---|---|---|---|
| **1. Update Lambda code** | Add SSL params to all 13 connection paths | None | SSL works even with `force_ssl: '0'` |
| **2. Test in dev** | Deploy Lambda changes, verify all functions connect successfully with SSL | None | Rollback is just reverting Lambda code |
| **3. Enable proxy TLS** | Set `requireTLS: true` on all 3 proxies | Low | Proxies will require TLS from Lambda (already enabled in step 1) |
| **4. Enable RDS force SSL** | Set `rds.force_ssl: '1'` | Low | All connections already use SSL from steps 1–3 |

## 3.4 Add CDK Tests

> **Note**: The original section 3.4 (Split the API Gateway Stack) has been deferred to a separate document: [`docs/implementation-phases/future-stack-split.md`](future-stack-split.md). It's the highest-effort, highest-risk item and doesn't fix any security or correctness issues — purely a maintainability improvement. Tackle it after sections 3.1–3.3 and 3.4 (tests) are complete and stable.

### Summary

The existing test file (`cdk/test/cdk.test.ts`) is the CDK default scaffold — entirely commented out with a placeholder `test('SQS Queue Created')` that asserts nothing. There is zero test coverage for infrastructure configuration.

CDK assertion tests synthesize stacks into CloudFormation templates and verify resource properties without deploying anything. They run locally in seconds via `npm test` (Jest). The primary value is preventing configuration drift — catching regressions on the hardening work done in sections 3.1–3.3.

### Findings

#### 3.4.1 Test Infrastructure — Ready to Use

The test tooling is already set up:
- `jest` 29.7.0 and `ts-jest` 29.1.2 are installed as devDependencies
- `jest.config.js` is configured to find `**/*.test.ts` in the `test/` directory
- `npm test` script is wired up in `package.json`
- `aws-cdk-lib/assertions` (the `Template` and `Match` APIs) ships with `aws-cdk-lib` — no additional dependency needed

**Test setup consideration**: The CDK app uses `tryGetContext("StackPrefix")` and `tryGetContext("environment")`. Tests must provide these values when instantiating stacks. This is done by setting context on the `App` construct:

```typescript
const app = new cdk.App({
  context: {
    StackPrefix: "Test",
    environment: "dev",
  },
});
```

**Docker asset consideration**: Two Lambda functions use `DockerImageCode.fromImageAsset()` (`textGenLambdaDockerFunc` and `dataIngestLambdaDockerFunc`). CDK synth will attempt to build Docker images during synthesis. In CI environments without Docker, tests will fail. Options:
- Run tests in environments with Docker available
- Mock the Docker asset builds in tests (more complex)
- Accept that these tests require Docker as a prerequisite

#### 3.4.2 Recommended Test Categories

**Category 1: IAM Policy Guardrails (prevents 3.1 regression)**

Tests that scan all `AWS::IAM::Policy` and `AWS::IAM::Role` resources in the synthesized template:

- No Secrets Manager policy should use `arn:aws:secretsmanager:*:*:secret:*` (after 3.1.6 is implemented)
- No DynamoDB policy should use `arn:aws:dynamodb:*:*:table/*` for data-plane actions (after 3.1.7)
- No CloudWatch Logs policy should use `arn:aws:logs:*:*:*` (after 3.1.8)
- No `AmazonS3FullAccess` managed policy should be attached to any role (after 3.1.1)
- No `AmazonSSMReadOnlyAccess` managed policy should be attached to any role (after 3.1.2)
- No `iam:AddUserToGroup` action should appear in any policy (after 3.1.3)
- EC2 network interface actions (`CreateNetworkInterface`, etc.) are allowed to use `*` (whitelist)

**Category 2: S3 Bucket Security (prevents 3.2 regression)**

Tests for each S3 bucket (`dataIngestionBucket`, `embeddingStorageBucket`, `chatlogsBucket`):

- `BlockPublicAccess` is set to `BLOCK_ALL` on all buckets
- `enforceSSL: true` (the bucket policy requires `aws:SecureTransport`)
- No `archiveAccessTierTime` in Intelligent Tiering configuration (after 3.2.1/3.2.3 fix)
- `AbortIncompleteMultipartUpload` lifecycle rule exists (after 3.2.4)

**Category 3: Database Security (prevents 3.3 regression)**

Tests for the database stack:

- `rds.force_ssl` parameter is `'1'` in the parameter group (after 3.3 is implemented)
- `requireTLS: true` on all three RDS proxies (after 3.3)
- `publiclyAccessible: false` on the RDS instance
- `storageEncrypted: true` on the RDS instance
- `deletionProtection` is `true` in production environment

**Category 4: Lambda Configuration Consistency**

Tests for all Lambda functions:

- All Node.js Lambda functions use `NODEJS_22_X` runtime (no accidental downgrades)
- All Python Lambda functions use `PYTHON_3_11` runtime
- No Lambda function has a timeout exceeding 600 seconds (the current max is `dataIngestLambdaDockerFunc` at 600s)
- All VPC-attached Lambda functions are actually in the VPC (have `VpcConfig` property)
- Authorizer Lambda functions are NOT in the VPC (they were moved out per P-3/P-8 optimizations)

**Category 5: Cognito Security**

Tests for the Cognito user pool:

- Password policy enforces minimum length 10, requires lowercase, uppercase, digits, and symbols
- Self-sign-up is enabled
- Email verification is enabled
- Account recovery is email-only

**Category 6: Network Security**

Tests for the VPC and API Gateway:

- WAF is associated with the API Gateway
- WAF includes the `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesSQLiRuleSet` rules
- Rate limiting rule exists (1000 requests per IP)
- API Gateway has throttling configured (100 rate, 200 burst)
- API Gateway logging level is at least `ERROR`

#### 3.4.3 Test File Organization

Recommended structure:

```
cdk/test/
├── iam-policies.test.ts        # Category 1: IAM guardrails
├── s3-buckets.test.ts          # Category 2: S3 security
├── database.test.ts            # Category 3: RDS security
├── lambda-config.test.ts       # Category 4: Lambda consistency
├── cognito.test.ts             # Category 5: Cognito security
└── network-security.test.ts    # Category 6: WAF, API Gateway, VPC
```

Each test file instantiates the relevant stacks and uses `Template.fromStack()` to get the synthesized CloudFormation template, then uses `template.hasResourceProperties()`, `template.allResourcesProperties()`, and `Match` utilities to assert configurations.

A shared test helper should handle stack instantiation with the required context values to avoid duplication across test files.

#### 3.4.4 What NOT to Test

- **Snapshot tests**: The default CDK scaffold suggests snapshot tests, but they're brittle for a stack this large. Any CDK version upgrade or minor refactor generates a massive diff that gets rubber-stamped. Assertion tests are more targeted and maintainable.
- **Lambda application logic**: CDK tests verify infrastructure configuration, not application behavior. Lambda function code should be tested separately with unit tests.
- **Cross-stack references**: These are CDK's responsibility. Testing that `Fn::ImportValue` resolves correctly is testing CDK itself, not your configuration.
- **Exact resource counts**: Asserting "there are exactly 15 Lambda functions" is fragile. New features will add functions. Test properties, not counts.

#### 3.4.5 Pre-Deploy Test Gate

Since this is a solo-developer project, CI pipelines are unnecessary overhead. Instead, wire `npm test` into the deployment flow so tests run automatically before every deploy:

- Update the `cdk` scripts in `package.json` to run tests before deploy:
  ```json
  "scripts": {
    "predeploy": "npm test",
    "deploy": "cdk deploy --all",
    "deploy:prod": "cdk deploy --all -c environment=prod"
  }
  ```
  The `predeploy` script runs automatically before `deploy` (npm lifecycle hook). If tests fail, the deploy is blocked.
- Alternatively, add a simple shell alias or wrapper script: `npm test && cdk deploy --all`
- Requires Docker for the two `DockerImageCode` Lambda functions (or mock them)
- Requires no AWS credentials for the test step (CDK assertion tests are purely local synthesis)
- Typical runtime: 10–30 seconds for a stack this size
- **Future consideration**: If the team grows, add CI to run tests on every pull request

### Recommended Implementation Order

| Phase | Items | Effort | Notes |
|---|---|---|---|
| **1. Test setup + IAM guardrails** | Shared helper + Category 1 | Medium | Write after 3.1 IAM changes are implemented |
| **2. S3 + Database tests** | Categories 2–3 | Low | Write after 3.2 and 3.3 are implemented |
| **3. Lambda + Cognito tests** | Categories 4–5 | Low | Can be written immediately (tests current state) |
| **4. Network security tests** | Category 6 | Low | Can be written immediately |
| **5. Pre-deploy gate** | Wire `npm test` into deploy scripts | Low | After tests are stable |

---

## Phase 3 — Overall Implementation Order

The four sections have inter-dependencies that dictate the order they should be implemented. Here is the recommended sequence, with rationale for each dependency.

### Dependency Map

```
3.2 S3 Policies ──────────────────────────────────────┐
  (no dependencies, safe to do first)                  │
                                                       │
3.1 IAM Permissions ──────────────────────────────────┐│
  Phase 1: Remove unused (no deps)                    ││
  Phase 2: Scope single-function (no deps)            ││
  Phase 3: Split shared roles (no deps)               ││
  Phase 4-6: Scope remaining (depends on Phase 3)     ││
                                                       ││
3.3 RDS SSL ───────────────────────────────────────┐  ││
  Phase 1: Update Lambda code (no deps)            │  ││
  Phase 2: Test in dev                             │  ││
  Phase 3-4: Enable proxy + RDS SSL (depends on 1) │  ││
                                                    │  ││
3.4 CDK Tests ──────────────────────────────────────┘──┘┘
  (write tests AFTER each section is implemented
   to lock in the new configuration)
```

### Recommended Sequence

| Step | Section | What to do | Dependencies | Risk |
|---|---|---|---|---|
| **1** | 3.2 (S3) | Remove archive tiers, add cleanup rules, add encryption | None | None |
| **2** | 3.1 Phase 1 | Remove unused permissions (S3FullAccess, SSMReadOnly, IAM AddUserToGroup, SES) | None | None |
| **3** | 3.1 Phase 2 | Scope single-function policies (SSM parameter, DynamoDB for deleteLastMessage) | None | None |
| **4** | 3.3 Phase 1 | Update all 13 Lambda connection paths to use SSL | None | None |
| **5** | 3.3 Phase 2 | Test SSL connections in dev | Step 4 | None |
| **6** | 3.3 Phase 3–4 | Enable `requireTLS` on proxies, then `rds.force_ssl: '1'` | Step 5 | Low |
| **7** | 3.1 Phase 3 | Split shared IAM roles into per-function roles | Steps 2–3 done first simplifies this | None (if mapped correctly) |
| **8** | 3.1 Phase 4–6 | Scope shared-role policies, RDS Proxy connect, verify Marketplace | Step 7 | Low |
| **9** | 3.4 | Write CDK tests for all implemented changes, wire into deploy scripts | Steps 1–8 | None |

### Key ordering rationale

- **3.2 first**: Zero-risk changes that fix a latent bug (archive tier download failures). Quick win.
- **3.1 unused permissions early**: Removing unused permissions (steps 2–3) is zero-risk and reduces the attack surface immediately. It also simplifies the later role-splitting work.
- **3.3 before 3.1 role split**: SSL changes touch Lambda code across all functions. Doing this before splitting roles avoids having to coordinate SSL changes with role changes in the same deployment.
- **3.1 role split after SSL**: Once SSL is enforced and unused permissions are removed, splitting roles is cleaner because you're working with a smaller, more accurate set of permissions per function.
- **3.4 after implementation**: Tests should codify the new state, not the old state. Write them after each section is implemented to lock in the correct configuration.
