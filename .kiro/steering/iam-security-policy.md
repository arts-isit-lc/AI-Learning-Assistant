---
inclusion: fileMatch
fileMatchPattern: "cdk/**"
---

# IAM Security Policy

Enforced by `cdk/test/iam-policies.test.ts`. All rules mandatory.

## Principle: Least Privilege
- Explicit ARNs only — `'*'` only when service requires it (document inline)
- Start restrictive; expand on observed failure
- New patterns must have a test in `iam-policies.test.ts`

## Forbidden
- Action wildcards: `s3:*`, `dynamodb:*`, `logs:*`, `iam:*`
- Managed policies: `*FullAccess`, `AmazonSSMReadOnlyAccess`
- CDK grant helpers: `grantReadWrite()`, `grantFullAccess()`, `addManagedPolicy()`
- Shared roles (never recreate `lambdaRole`/`coglambdaRole`)

## Scoping Rules
| Service | Scope to |
|---|---|
| Secrets Manager | `db.secretPathUser.secretArn` |
| CloudWatch Logs | `/aws/lambda/${functionName}:*` |
| DynamoDB data ops | specific table ARN |
| RDS Proxy connect | `dbuser:${instanceResourceId}/*` |
| SSM | specific parameter path |
| X-Ray | `'*'` (no resource-level support) |
| EC2 VPC (ENI) | `'*'` (required by AWS) |

## DynamoDB — Two Statements
```typescript
// Management (table/* acceptable)
{ actions: ['dynamodb:ListTables','dynamodb:CreateTable','dynamodb:DescribeTable'], resources: [`arn:...:table/*`] }
// Data (specific table)
{ actions: ['dynamodb:PutItem','dynamodb:GetItem','dynamodb:UpdateItem'], resources: [tableArn] }
```

## Role Rules
- One role per function group — never share across groups
- Prefer inline policies on the role over scattered `addToRolePolicy()`

## Per-Function-Group Roles
| Role | Functions | Key Permissions |
|---|---|---|
| `dbLambdaRole` | student, instructor | SecretsManager, VPC, Logs |
| `adminLambdaRole` | admin | SecretsManager, VPC, Logs, Cognito |
| `notificationLambdaRole` | notification | SecretsManager, VPC, Logs, AppSync |
| `authorizerRole` | 3 authorizers | SecretsManager (Cognito), Logs |
| `cognitoTriggerRole` | signUp, adjustRoles | SecretsManager, VPC, Logs, Cognito |
| `preSignupRole` | preSignup | SSM, Logs |
| `sqsLambdaRole` | sqs | SecretsManager, VPC, Logs, SQS |
