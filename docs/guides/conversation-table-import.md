# Importing `DynamoDB-Conversation-Table` into CloudFormation

One-time procedure for each **existing** environment (dev, prod). New environments don't need it: a normal deploy creates the table.

## Why

`DynamoDB-Conversation-Table` holds chat history for `chatbotV2Function` and `DeleteLastMessage`. The V1 `text_generation` Lambda (removed 2026-10-26) created it at runtime, so no stack managed it. `ApiGatewayStack` now defines it (logical ID `ConversationTable`, `DeletionPolicy: Retain`). In an environment where the table already exists, it has to be **imported** into the stack, not created.

> ⚠️ Never run `cdk deploy` with the table in the template against an environment that hasn't been imported. CloudFormation tries to *create* the table, fails with "already exists", and rolls back `ApiGatewayStack`. No data is lost, but the deploy fails.

## Before you start

- The environment is already deployed from code **without** the table (the `dev` branch before `feat/conversation-table-import` was merged). Step 3 checks this.
- AWS credentials for the target account. The CDK CLI may not read SSO profiles directly; export them:
  ```bash
  eval "$(aws configure export-credentials --profile <profile> --format env)"
  export AWS_REGION=ca-central-1 CDK_DEFAULT_REGION=ca-central-1
  ```
- Run everything from `cdk/` on the branch that contains the table definition.

## Steps

### 1. Confirm the live table matches the template

```bash
aws dynamodb describe-table --table-name DynamoDB-Conversation-Table \
  --query 'Table.{Keys:KeySchema,Attrs:AttributeDefinitions,Billing:BillingModeSummary.BillingMode,SSE:SSEDescription,Stream:StreamSpecification,GSI:GlobalSecondaryIndexes,Items:ItemCount}'
aws dynamodb describe-continuous-backups --table-name DynamoDB-Conversation-Table \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus'
aws dynamodb describe-time-to-live --table-name DynamoDB-Conversation-Table
```

Expect: key `SessionId` (`S`, `HASH`), billing `PAY_PER_REQUEST`, and `SSE`, `Stream` and `GSI` all `null`; PITR and TTL `DISABLED`. Note the item count.
**If anything differs, stop.** The template must be adjusted to match first.

### 2. Tag the live table

The app-wide `app=AI-Learning-Assistant` tag is in the template, and an import doesn't apply tags. Add the tag first so the template and the table match exactly; otherwise the stack records permanent drift.

```bash
ARN=$(aws dynamodb describe-table --table-name DynamoDB-Conversation-Table --query Table.TableArn --output text)
aws dynamodb tag-resource --resource-arn "$ARN" --tags Key=app,Value=AI-Learning-Assistant
```

### 3. Confirm the table is the only pending change

```bash
npx cdk diff AILA-ApiGatewayStack -c environment=<dev|prod>
```

The output must show exactly one change: `[+] AWS::DynamoDB::Table ConversationTable`. If anything else appears, deploy the `dev` branch to this environment first. `cdk import` refuses to run alongside other changes.

### 4. Import

```bash
npx cdk import AILA-ApiGatewayStack -c environment=<dev|prod> \
  --resource-mapping import/conversation-table-mapping.json
```

The import only records ownership; it doesn't modify the table, and a failed import rolls back without touching it.

### 5. Verify

```bash
aws cloudformation describe-stack-resource --stack-name AILA-ApiGatewayStack \
  --logical-resource-id ConversationTable \
  --query 'StackResourceDetail.[PhysicalResourceId,ResourceStatus]'
# -> DynamoDB-Conversation-Table  IMPORT_COMPLETE

DID=$(aws cloudformation detect-stack-resource-drift --stack-name AILA-ApiGatewayStack \
  --logical-resource-id ConversationTable --query 'StackResourceDrift.StackResourceDriftStatus' --output text)
echo "$DID"   # -> IN_SYNC

npx cdk diff AILA-ApiGatewayStack -c environment=<dev|prod>   # -> no differences
```

Also confirm the item count matches step 1, and that a chat message still loads its history.

## After every existing environment is imported

Merge `feat/conversation-table-import` into `dev`. From then on, normal deploys manage the table, and new environments create it.

## Undoing an import

To release the table from the stack while keeping it and its data, remove the `ConversationTable` resource from the template and deploy. `DeletionPolicy: Retain` makes CloudFormation leave the table in place.
