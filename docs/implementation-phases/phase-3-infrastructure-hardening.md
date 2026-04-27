# Phase 3 — Infrastructure Hardening (Medium Risk, High Impact)

## 3.1 Tighten IAM Permissions

Several IAM policies use `resources: ["*"]` or wildcard ARNs:

| Policy | Current | Should Be |
|---|---|---|
| EC2 network interfaces | `resources: ["*"]` | Scoped to VPC/subnet ARNs |
| CloudWatch logs | `arn:aws:logs:*:*:*` | Scoped to specific log groups (`/aws/lambda/${functionName}`) |
| Secrets Manager | `arn:aws:secretsmanager:*:*:secret:*` | Scoped to specific secret ARNs |
| AWS Marketplace | `resources: ["*"]` | Only needed if using Anthropic models via Marketplace |

The EC2 one genuinely requires `*` for `CreateNetworkInterface` (AWS limitation), but the others can be scoped.

## 3.2 Add S3 Lifecycle Policies

The `dataIngestionBucket`, `embeddingStorageBucket`, and `chatlogsBucket` have no lifecycle policies. Old/orphaned objects accumulate indefinitely. Add:

- Transition to Infrequent Access after 90 days
- Transition to Glacier after 365 days (for chatlog archives)
- Enable versioning with a noncurrent version expiration

## 3.3 RDS SSL Enforcement

The database parameter group has `rds.force_ssl: '0'` — SSL is not enforced for database connections. This means Lambda-to-RDS traffic inside the VPC is unencrypted. Set to `'1'`.

## 3.4 Split the API Gateway Stack

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

## 3.5 Add CDK Tests

`cdk/test/cdk.test.ts` exists but likely only has the default snapshot test. Add:
- Assertion tests for IAM policies (verify no `*` resources where avoidable)
- Assertion tests for Lambda configurations (runtime, timeout, memory)
- Assertion tests for security configurations (S3 block public access, encryption)
