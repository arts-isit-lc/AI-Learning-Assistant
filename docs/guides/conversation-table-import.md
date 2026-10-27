# Importing `DynamoDB-Conversation-Table` into CloudFormation

One-time procedure for each **existing** environment (dev, prod). New environments don't need it: a normal deploy creates the table.

## Why

`DynamoDB-Conversation-Table` holds chat history for `chatbotV2Function` and `DeleteLastMessage`. The V1 `text_generation` Lambda (removed 2026-10-26) created it at runtime, so no stack managed it. `ApiGatewayStack` now defines it (logical ID `ConversationTable`, `DeletionPolicy: Retain`). In an environment where the table already exists, it has to be **imported** into the stack, not created.

> ⚠️ Never run a plain `cdk deploy` with the table in the template against an environment that hasn't been imported. CloudFormation tries to *create* the table, fails with "already exists", and rolls back `ApiGatewayStack`. No data is lost, but the deploy fails. Deploy with `--import-existing-resources` instead (step 3).

## Before you start

- AWS credentials for the target account. The CDK CLI may not read SSO profiles directly; export them:
  ```bash
  eval "$(aws configure export-credentials --profile <profile> --format env)"
  export AWS_REGION=ca-central-1 CDK_DEFAULT_REGION=ca-central-1
  ```
- Run everything from `cdk/` on a branch that contains the table definition (`dev`).

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

### 3. Deploy with the import

```bash
docker pull public.ecr.aws/lambda/python:3.12
npm run deploy:prod -- --import-existing-resources   # dev: npm run deploy -- --import-existing-resources
```

`--import-existing-resources` tells CloudFormation to adopt existing resources that have a fixed name in the template (the table's `tableName`) instead of creating them. Unlike `cdk import`, it works in the same deploy as the stack's other pending changes, so nothing has to be deployed first.

- The flag applies to every stack in `--all`. Any other unmanaged resource whose fixed name matches one in the template is adopted too.
- A failed import rolls the stack back. The table is `Retain` and an import never changes its data.

<details>
<summary>Alternative: <code>cdk import</code> (only when the table is the stack's only pending change)</summary>

`cdk import` refuses to run alongside other changes. Use it only when this shows exactly one change, `[+] AWS::DynamoDB::Table ConversationTable`:

```bash
npx cdk diff AILA-ApiGatewayStack -c environment=<dev|prod>
npx cdk import AILA-ApiGatewayStack -c environment=<dev|prod> \
  --resource-mapping import/conversation-table-mapping.json
```

</details>

### 4. Verify

```bash
aws cloudformation describe-stack-resource --stack-name AILA-ApiGatewayStack \
  --logical-resource-id ConversationTable \
  --query 'StackResourceDetail.[PhysicalResourceId,ResourceStatus]'
# -> DynamoDB-Conversation-Table  *_COMPLETE

DID=$(aws cloudformation detect-stack-resource-drift --stack-name AILA-ApiGatewayStack \
  --logical-resource-id ConversationTable --query 'StackResourceDrift.StackResourceDriftStatus' --output text)
echo "$DID"   # -> IN_SYNC

npx cdk diff AILA-ApiGatewayStack -c environment=<dev|prod>   # -> no differences
```

Also confirm the item count matches step 1, and that a chat message still loads its history.

## After every existing environment is imported

Normal deploys manage the table and `--import-existing-resources` is no longer needed. New environments create the table.

## Undoing an import

To release the table from the stack while keeping it and its data, remove the `ConversationTable` resource from the template and deploy. `DeletionPolicy: Retain` makes CloudFormation leave the table in place.
