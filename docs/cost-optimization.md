# Cost Optimization

The following changes reduce AWS spend while maintaining or improving performance.

## Estimated Savings Summary

| Item | Dev (monthly) | Prod (monthly) | Risk | Effort | Performance Impact |
|---|---|---|---|---|---|
| CO-1: S3 + DynamoDB Gateway Endpoints | ~$30-50 | ~$30-50 | None | 5 min | Positive — traffic moves from NAT to AWS backbone, lower latency |
| CO-2: Lambda Memory Right-Sizing | ~$8-15 | ~$8-15 | None (data-backed) | 15 min | Neutral — functions are I/O-bound (network calls, DB queries), not CPU-bound. CPU reduction from lower memory is irrelevant |
| CO-3: Remove RDS Interface Endpoint | ~$14.40 | ~$14.40 | None | 5 min | Neutral — endpoint is unused by any Lambda |
| CO-4: NAT Gateway | No change | No change | — | — | — |
| CO-5: Lambda Timeout Right-Sizing | ~$0-5 (prevents waste) | ~$0-5 (prevents waste) | None | 15 min | Neutral — normal execution unaffected. Stuck functions get killed faster |
| CO-6: S3 Intelligent-Tiering | Varies by data volume | Varies by data volume | None | 10 min | Neutral — retrieval latency identical across all tiers (millisecond access) |
| CO-7: RDS Dev Storage 100→20GB | ~$9/mo | No change | Low — replaces dev DB instance, wipes data, auto-rebuilds | 15 min (2-step deploy) | Neutral — gp3 IOPS are independent of volume size |
| CO-8: CloudWatch Logs Cleanup | ~$10-30 | ~$5-15 | None | 20 min | Neutral — only affects log storage |
| CO-9: RDS Enhanced Monitoring (dev) | ~$3-5 | No change | None | 2 min | Neutral — standard metrics still available |
| **Total (immediate, both accounts)** | **~$75-130/mo** | **~$65-115/mo** | | | |
| **Combined annual savings** | **~$1,700-2,900/yr** | | | | |

Notes:
- CO-1 savings depend on S3/DynamoDB traffic volume through NAT. Estimate assumes moderate usage.
- CO-2 savings are based on 6 months of prod CloudWatch data. All 8 functions drop from 512MB to 256MB (50% reduction in per-invocation cost).
- CO-5 doesn't save money directly under normal operation — it prevents runaway functions from burning 5 minutes of compute when they get stuck.
- CO-6 savings depend on how much data ages past 30/90 days without being accessed. Could be significant for older course materials.
- CO-7 requires a two-step dev deploy. CloudFormation replaces the RDS instance (data wiped). The `initializerFunction` automatically recreates schema, DB users, and credentials. Prod is unaffected.

---

The same codebase deploys to two separate AWS accounts via a `environment` context variable:

| | Dev | Prod |
|---|---|---|
| AWS Account | `724772090264` | `509399614162` |
| Region | `ca-central-1` | `ca-central-1` |
| CDK Context | `-c environment=dev` | `-c environment=prod` |
| SSO Profile | `vincent.adm-dev2` | `vincent.adm.prod2` |

Both environments use the new VPC path (`existingVpcId` is empty), which means:
- 2 AZs, 1 NAT Gateway
- 2 interface endpoints: Secrets Manager + RDS
- No SSM, Glue, S3, or DynamoDB endpoints

Infrastructure differences between environments:

| Resource | Dev | Prod |
|---|---|---|
| RDS Instance | `db.t3.micro` (single-AZ) | `db.t3.medium` (multi-AZ) |
| SES From Email | `dev-noreply@ocelia.svc.ubc.ca` | `noreply@ocelia.svc.ubc.ca` |
| RDS Proxy TLS | Disabled | Disabled |
| RDS SSL | Disabled (`rds.force_ssl: '0'`) | Disabled (`rds.force_ssl: '0'`) |

Everything else (Lambda memory, timeouts, S3 buckets, WAF, Cognito, AppSync, VPC topology) is identical.

---

## CO-1: Add S3 and DynamoDB Gateway Endpoints (~$30-50/mo savings per account)

No gateway endpoints exist in either environment. All S3 and DynamoDB traffic from VPC-attached Lambda functions routes through the NAT Gateway at $0.045/GB.

The app uses S3 heavily (document uploads via `dataIngestionBucket`, embeddings via `embeddingStorageBucket`, chatlogs via `chatlogsBucket`) and DynamoDB for conversation history (via `TextGenLambdaDockerFunc`). Gateway endpoints are free — zero hourly cost, zero data processing cost.

Add to `vpc-stack.ts` in the `else` block (new VPC path), after the Secrets Manager and RDS interface endpoints:

```typescript
this.vpc.addGatewayEndpoint("S3Endpoint", {
  service: ec2.GatewayVpcEndpointAwsService.S3,
});
this.vpc.addGatewayEndpoint("DynamoDBEndpoint", {
  service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
});
```

---

## CO-2: Right-Size Lambda Memory Allocations (~$15-30/mo savings per account)

Several functions are already at 128MB. The following are oversized based on 6 months of prod CloudWatch data (account `509399614162`):

| Function | Allocated | Peak (6mo) | Avg (6mo) | Recommended | Headroom |
|---|---|---|---|---|---|
| `adminLambdaAuthorizer` | 512MB | 88MB | 86MB | 256MB | 2.9x peak |
| `studentLambdaAuthorizer` | 512MB | 89MB | 86MB | 256MB | 2.9x peak |
| `instructorLambdaAuthorizer` | 512MB | 88MB | 86MB | 256MB | 2.9x peak |
| `adjustUserRoles` | 512MB | 93MB | 91MB | 256MB | 2.8x peak |
| `studentFunction` | 512MB | 101MB | 93MB | 256MB | 2.5x peak |
| `instructorFunction` | 512MB | 100MB | 93MB | 256MB | 2.6x peak |
| `adminFunction` | 512MB | 92MB | 87MB | 256MB | 2.8x peak |
| `SQSTriggerDockerFunc` | 512MB | — | — | 512MB | Keep — `fetchall()` on large courses could spike |
| `initializerFunction` | 512MB | — | — | 256MB | Runs once at deploy, low risk |

All functions peak under 102MB — 256MB gives ~2.5x headroom across the board.

Already right-sized (no change needed):
- `generatePreSignedURL` — 128MB
- `getFilesFunction` — 128MB
- `deleteFile` — 128MB
- `deleteModule` — 128MB
- `deleteLastMessage` — 128MB
- `getChatLogsFunction` — 128MB
- `notificationFunction` — 128MB
- `sqsFunction` — 128MB
- `preSignupLambda` — 128MB
- `addStudentOnSignUp` — 128MB
- `TextGenLambdaDockerFunc` — 1024MB (keep — LLM orchestration)
- `DataIngestLambdaDockerFunc` — 512MB (keep — document processing)

Use Lambda Power Tuning (open-source tool) to validate these recommendations with actual invocation data.

---

## CO-3: Remove Unnecessary RDS Interface Endpoint (~$14.40/mo savings per account)

Both environments create 2 interface endpoints (2 AZs × ~$7.20/mo = ~$14.40/mo each):

| Endpoint | Cost/mo | Needed? |
|---|---|---|
| Secrets Manager | ~$14.40 | Yes — used by every VPC Lambda for DB credentials |
| RDS | ~$14.40 | No — not used by any Lambda function |

The RDS interface endpoint provides access to the RDS control plane API (`DescribeDBInstances`, `ModifyDBInstance`, etc.). No Lambda function in the codebase makes RDS API calls — they all connect to RDS Proxy over TCP port 5432 via the `postgres` library, which routes through the VPC's private networking directly. The RDS endpoint is unused. Zero risk to remove.

Remove from the `else` block in `vpc-stack.ts`:

```typescript
// DELETE THIS BLOCK
this.vpc.addInterfaceEndpoint(`${id}-RDS Endpoint`, {
  service: ec2.InterfaceVpcEndpointAwsService.RDS,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
});
```

Note: The existing VPC path (the `if` block) also creates SSM and Glue endpoints, but that code path is not used by either deployment.

---

## CO-4: Review NAT Gateway Usage (~$32/mo baseline per account)

A single NAT Gateway costs ~$32/mo (hourly) plus $0.045/GB data processing. After adding S3 and DynamoDB gateway endpoints (CO-1), the remaining NAT traffic would be:
- Bedrock API calls (from `TextGenLambdaDockerFunc` and `DataIngestLambdaDockerFunc`)
- Cognito API calls (from authorizers, `adjustUserRoles`)

Keep the NAT Gateway in both environments to avoid operational overhead. Adding a Bedrock VPC endpoint (see Performance Improvements P-2) would reduce the remaining NAT data transfer costs.

---

## CO-5: Lambda Timeout Right-Sizing (Cost + Reliability)

All Lambda functions use 300s timeout (600s for data ingestion). Identical in both environments. Runaway executions burn money silently.

| Function | Current | Recommended | Rationale |
|---|---|---|---|
| `adminLambdaAuthorizer` | 300s | 30s | JWT verification |
| `studentLambdaAuthorizer` | 300s | 30s | JWT verification |
| `instructorLambdaAuthorizer` | 300s | 30s | JWT verification |
| `preSignupLambda` | 300s | 30s | Email domain check |
| `addStudentOnSignUp` | 300s | 30s | Single DB insert |
| `adjustUserRoles` | 300s | 60s | Cognito + DB query |
| `generatePreSignedURL` | 300s | 30s | S3 presigned URL generation |
| `getFilesFunction` | 300s | 30s | DB query + S3 list |
| `deleteFile` | 300s | 30s | DB + S3 delete |
| `deleteModule` | 300s | 60s | S3 list + batch delete |
| `deleteLastMessage` | 300s | 30s | DB + DynamoDB update |
| `getChatLogsFunction` | 300s | 60s | S3 list + presigned URLs |
| `studentFunction` | 300s | 60s | CRUD queries |
| `instructorFunction` | 300s | 60s | CRUD queries |
| `adminFunction` | 300s | 60s | CRUD queries |
| `sqsFunction` | 300s | 60s | SQS send + DB query |
| `notificationFunction` | 300s | 60s | AppSync + SES calls |
| `SQSTriggerDockerFunc` | 300s | 300s | Chatlog processing, keep |
| `TextGenLambdaDockerFunc` | 300s | 300s | LLM calls are slow, keep |
| `DataIngestLambdaDockerFunc` | 600s | 600s | Document processing, keep |
| `initializerFunction` | 300s | 300s | DB schema setup at deploy, keep |

---

## CO-6: S3 Intelligent-Tiering for Document Buckets

All three S3 buckets have no lifecycle policies. Data must be retained indefinitely (no data retention policy), so expiration rules are off the table. However, S3 Intelligent-Tiering can still reduce costs by automatically moving infrequently accessed objects to cheaper storage tiers — with no retrieval fees and no data deletion.

| Bucket | Contents | Recommendation |
|---|---|---|
| `dataIngestionBucket` | Course documents (PDFs, etc.) | Enable Intelligent-Tiering |
| `embeddingStorageBucket` | Vector embeddings | Enable Intelligent-Tiering |
| `chatlogsBucket` | Exported chat logs | Enable Intelligent-Tiering |

Intelligent-Tiering automatically moves objects between Frequent Access, Infrequent Access (after 30 days), and Archive Instant Access (after 90 days) tiers. No data is deleted. Objects accessed again are moved back to Frequent Access automatically. The only cost is a small monitoring fee (~$0.0025 per 1,000 objects/mo).

This applies to both dev and prod.

---

## CO-7: RDS Instance and Storage Sizing

| | Dev | Prod |
|---|---|---|
| Instance | `db.t3.micro` (2 vCPU, 1GB RAM) | `db.t3.medium` (2 vCPU, 4GB RAM) |
| Multi-AZ | No | Yes |
| Allocated Storage | 100GB | 100GB |
| Max Storage | 115GB | 115GB |
| Backup | 7 days | 7 days |
| Estimated Storage Cost | ~$11.50/mo | ~$11.50/mo |

### Dev: Reduce storage to 20GB (~$9/mo savings)

AWS does not allow reducing `allocatedStorage` on an existing RDS instance. CloudFormation will replace the instance (delete old, create new). This wipes all dev data. The `initializerFunction` trigger runs automatically on deploy and recreates:
- All tables and schema (including foreign keys, constraints, extensions)
- Two DB users (`readwrite` and `tablecreator` roles) with fresh random credentials
- Stores new credentials in Secrets Manager (same secret paths)
- RDS Proxies reconnect automatically via CDK references

**Deployment steps (dev only):**

Step 1 — Manually disable deletion protection in the AWS Console:
- Go to RDS → Databases → select the dev instance → Modify
- Uncheck "Enable deletion protection" → Apply immediately

Step 2 — Update `database-stack.ts`:

```typescript
allocatedStorage: isProduction ? 100 : 20,
maxAllocatedStorage: isProduction ? 115 : 30,
backupRetention: Duration.days(isProduction ? 7 : 1),
deletionProtection: isProduction,  // was: true
```

Step 3 — Deploy to dev:
```bash
cdk deploy --all \
  --parameters AILA-AmplifyStack:githubRepoName=AI-Learning-Assistant \
  --context StackPrefix=AILA \
  --context environment=dev
```

CloudFormation will:
1. Detect `allocatedStorage` decreased (unsupported in-place update)
2. Disable deletion protection on the existing instance
3. Delete the old 100GB instance
4. Create a new 20GB instance
5. Recreate the 3 RDS Proxies pointing at the new instance
6. Run `initializerFunction` which creates schema and DB users
7. Lambda functions pick up new proxy endpoints via environment variables

**After deployment, verify:**
- Check CloudFormation events for the DatabaseStack — confirm the RDS instance was replaced successfully
- Check the `initializerFunction` CloudWatch logs — confirm "Initialization completed" appears
- Test the app — sign in, verify courses/modules load (they'll be empty since data was wiped)

**Prod: No storage change.** Monitor CloudWatch RDS metrics — if CPU stays under 20% and connections under 50, `db.t3.small` (2 vCPU, 2GB RAM) could save ~$15/mo. Instance class changes are supported on existing instances (causes a brief restart).

Aurora Serverless v2 is a longer-term consideration. Defer to Phase 5.


---

## CO-8: CloudWatch Logs Cost Reduction (~$10-30/mo savings per account)

Three sources of unbounded CloudWatch Logs growth:

### 8a: RDS Log Retention — Infinite

In `database-stack.ts`:
```typescript
cloudwatchLogsRetention: logs.RetentionDays.INFINITE,
```

Every RDS log entry (slow queries, connections, errors) is stored forever. This accumulates over months. For dev, 14 days is sufficient. For prod, 6 months covers most debugging and audit needs.

```typescript
cloudwatchLogsRetention: isProduction ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.TWO_WEEKS,
```

### 8b: VPC Flow Logs — No Retention Limit

In `vpc-stack.ts` (new VPC path):
```typescript
this.vpc.addFlowLog("aila-vpcFlowLog");
```

VPC Flow Logs record metadata about every network connection in the VPC (source/destination IPs, ports, bytes, accept/reject). With multiple Lambda functions making DB queries, S3 calls, and Bedrock calls, this generates significant log volume. Default retention is infinite.

At CloudWatch Logs pricing (~$0.50/GB ingestion + $0.03/GB/mo storage), flow logs can quietly cost $5-15/mo depending on traffic.

Keep flow logs for security auditing but add retention limits. 6 months for prod (matches RDS log retention), 7 days for dev (enough to debug connectivity issues):

```typescript
const flowLogGroup = new logs.LogGroup(this, "aila-vpcFlowLogGroup", {
  retention: isProduction ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK,
});

this.vpc.addFlowLog("aila-vpcFlowLog", {
  destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
});
```

Note: `vpc-stack.ts` will need the `isProduction` variable (already derived from `props?.environment`) and a `logs` import:
```typescript
import * as logs from "aws-cdk-lib/aws-logs";
```

### 8c: API Gateway Data Trace — Full Request/Response Logging

In `api-gateway-stack.ts`:
```typescript
deployOptions: {
  metricsEnabled: true,
  loggingLevel: apigateway.MethodLoggingLevel.ERROR,
  dataTraceEnabled: true,  // logs full request/response bodies
```

`dataTraceEnabled: true` logs the complete request and response bodies for every API call to CloudWatch — including successful ones. This means every student chat message, auth token, and user data ends up in logs. Expensive at scale and a PII concern.

Set to `false` for both environments. `loggingLevel: ERROR` is already configured, which still logs full details for any request that errors out — exactly when you need debugging info. For non-error debugging, Lambda function logs (`console.log` statements) provide the business logic output.

```typescript
dataTraceEnabled: false,
```

---

## CO-9: RDS Enhanced Monitoring — Reduce Interval for Dev (~$3-5/mo savings)

In `database-stack.ts`:
```typescript
monitoringInterval: Duration.seconds(60), // enhanced monitoring interval
```

Enhanced Monitoring sends OS-level metrics (CPU, memory, disk I/O, processes) to CloudWatch every 60 seconds. This is separate from standard RDS CloudWatch metrics and has its own cost based on data volume.

For dev, this granularity isn't needed. Disable it or reduce frequency:

```typescript
monitoringInterval: isProduction ? Duration.seconds(60) : Duration.seconds(0),
```

`Duration.seconds(0)` disables Enhanced Monitoring entirely for dev. Standard CloudWatch metrics (5-minute granularity) are still available at no extra cost.
