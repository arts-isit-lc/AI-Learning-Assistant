---
inclusion: always
---

# IAM Security Policy

Enforced by `cdk/test/iam-policies.test.ts` on every deploy. All rules are mandatory.

## Principle: Least Privilege
- Grant only required actions and resources
- Use explicit ARNs — `'*'` resources only when the service does not support resource-level permissions (document inline)
- Start restrictive; expand only on observed access failure
- Do not copy permissions "just in case"

## Pre-Change Checklist
- [ ] No action wildcards (`s3:*`, `dynamodb:*`, `logs:*`, `iam:*`)
- [ ] No resource wildcards unless service requires (documented inline)
- [ ] No banned managed policies (`AmazonS3FullAccess`, `AmazonSSMReadOnlyAccess`, any `*FullAccess`)
- [ ] Secrets Manager scoped to specific secret ARN
- [ ] CloudWatch Logs scoped to specific log group ARN
- [ ] DynamoDB data actions scoped to specific table ARN
- [ ] RDS Proxy connect scoped to specific instance resource ID
- [ ] SSM scoped to specific parameter path
- [ ] New IAM pattern has a test in `iam-policies.test.ts`

## Hard Rules

**No action wildcards** — forbidden on any service: `s3:*`, `dynamodb:*`, `logs:*`, `iam:*`, `iam:AddUserToGroup`

**Secrets Manager** — specific ARN required:
```typescript
resources: [db.secretPathUser.secretArn]
// or: `arn:aws:secretsmanager:${region}:${account}:secret:${name}-*`
```

**CloudWatch Logs** — specific log group required:
```typescript
resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${functionName}:*`]
```

**DynamoDB** — split into two statements:
```typescript
// Management (table wildcard acceptable for ListTables/CreateTable/DescribeTable)
{ actions: ['dynamodb:ListTables', 'dynamodb:CreateTable', 'dynamodb:DescribeTable'], resources: [`arn:...:table/*`] }
// Data — specific table only
{ actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [specificTableArn] }
```

**RDS Proxy connect** — specific instance resource ID required:
```typescript
resources: [`arn:aws:rds-db:${region}:${account}:dbuser:${dbInstance.instanceResourceId}/*`]
```

**SSM** — specific parameter path required:
```typescript
resources: [`arn:aws:ssm:${region}:${account}:parameter/AILA/AllowedEmailDomains`]
```

**X-Ray** — resource `'*'` acceptable (service does not support resource-level scoping):
```typescript
{ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] }
```

**EC2 VPC networking** — resource `'*'` required by AWS for ENI operations:
```typescript
{ actions: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface', ...], resources: ['*'] }
```

## Role Rules
- **No shared roles** — `lambdaRole` and `coglambdaRole` removed; never recreate
- **One role per function group** — new group = new dedicated role; never attach to an existing group's role
- **Prefer inline policies on the role** over scattered `addToRolePolicy()` calls
- **Avoid CDK grant helpers** (`grantReadWrite()`, `grantFullAccess()`, `addManagedPolicy()`) — use explicit `PolicyStatement` instead

## New AWS Services
Minimum actions, specific resource ARNs, no managed policies, add assertions to `iam-policies.test.ts`.

## Per-Function-Group Role Reference
| Role | Functions | Key Permissions |
|---|---|---|
| `dbLambdaRole` | studentFunction, instructorFunction | SecretsManager (secretPathUser), EC2 VPC, CW Logs |
| `adminLambdaRole` | adminFunction | SecretsManager (secretPathTableCreator), EC2 VPC, CW Logs, Cognito admin |
| `notificationLambdaRole` | notificationFunction | SecretsManager (secretPathUser), EC2 VPC, CW Logs, AppSync |
| `authorizerRole` | 3 authorizer functions | SecretsManager (Cognito secret), CW Logs (no VPC) |
| `cognitoTriggerRole` | addStudentOnSignUp, adjustUserRoles | SecretsManager (secretPathTableCreator), EC2 VPC, CW Logs, Cognito admin |
| `preSignupRole` | preSignupLambda | SSM (/AILA/AllowedEmailDomains), CW Logs (no VPC, no Secrets Manager) |
| `sqsLambdaRole` | sqsFunction | SecretsManager (secretPathUser), EC2 VPC, CW Logs, SQS (queue ARN) |
