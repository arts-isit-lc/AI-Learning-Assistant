# Full Data Wipe — v2 Migration Runbook

Complete cleanup procedure for resetting the application to a fresh state.
Used when migrating to multimodal-rag v2 or starting from scratch.

## Prerequisites

```bash
# 1. Login via AWS SSO
aws sso login --profile vincent.adm-dev2

# 2. Export credentials to environment
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)
export CDK_DEFAULT_ACCOUNT=724772090264
export CDK_DEFAULT_REGION=ca-central-1
```

## Step 1: PostgreSQL — Truncate all tables & drop legacy tables

Run in **pgAdmin 4** (Query Tool):

```sql
-- Truncate all application tables
TRUNCATE TABLE "Users" CASCADE;
TRUNCATE TABLE "Courses" CASCADE;
TRUNCATE TABLE "Course_Concepts" CASCADE;
TRUNCATE TABLE "Course_Modules" CASCADE;
TRUNCATE TABLE "Enrolments" CASCADE;
TRUNCATE TABLE "Module_Files" CASCADE;
TRUNCATE TABLE "Module_File_References" CASCADE;
TRUNCATE TABLE "Student_Modules" CASCADE;
TRUNCATE TABLE "Sessions" CASCADE;
TRUNCATE TABLE "Messages" CASCADE;
TRUNCATE TABLE "User_Engagement_Log" CASCADE;
TRUNCATE TABLE "chatlogs_notifications" CASCADE;
TRUNCATE TABLE retrieval_units CASCADE;

-- Drop legacy LangChain tables (no longer used with v2)
DROP TABLE IF EXISTS langchain_pg_embedding CASCADE;
DROP TABLE IF EXISTS langchain_pg_collection CASCADE;
DROP TABLE IF EXISTS upsertion_record CASCADE;
```

## Step 2: DynamoDB — Clear chat history

Uses the AWS CLI for the deletes (no `boto3` dependency — `python3` is only used
to parse the scan output with its standard library, so this works on a clean
Homebrew Python). The CLI auto-paginates the scan, so it covers the whole table.

```bash
aws dynamodb scan --table-name DynamoDB-Conversation-Table --region ca-central-1 \
  --projection-expression "SessionId" --output json --no-cli-pager \
| python3 -c "import json,sys; [print(i['SessionId']['S']) for i in json.load(sys.stdin).get('Items',[])]" \
| while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    aws dynamodb delete-item --table-name DynamoDB-Conversation-Table --region ca-central-1 \
      --key "{\"SessionId\":{\"S\":\"$sid\"}}" --no-cli-pager
  done
echo "Done."
```

> Assumes `SessionId` is the table's sole (HASH) primary key. Verify with
> `aws dynamodb describe-table --table-name DynamoDB-Conversation-Table --region ca-central-1 --query 'Table.KeySchema'`
> — if there is also a RANGE (sort) key, add it to the `--key` object.
>
> Older note: the previous version of this step used a `boto3` script, which
> fails with `ModuleNotFoundError: No module named 'boto3'` on a Python that
> doesn't have it installed. The CLI version above avoids that.

## Step 3: S3 — Empty buckets

```bash
# V2 IR bucket (course files, images, IR data)
aws s3 rm s3://aila-multimodalragstack-ir-bucket --recursive

# Old v1 data ingestion bucket (only if it still exists from a pre-v2 deployment)
aws s3 rm s3://aila-apigatewaystack-ailaapigatewaystackdataingest-fdiqz53axtfn --recursive
```

## Step 4: Cognito — Delete users

Done manually in the AWS Console:
- Cognito → User Pools → Select your pool → Users → Delete all users

## Verification

**S3 — should return empty:**

```bash
aws s3 ls s3://aila-multimodalragstack-ir-bucket --recursive --summarize | tail -3
aws s3 ls s3://aila-apigatewaystack-ailaapigatewaystackdataingest-fdiqz53axtfn --recursive --summarize | tail -3
```

**DynamoDB — should show Count: 0:**

```bash
aws dynamodb scan --table-name DynamoDB-Conversation-Table --region ca-central-1 --select COUNT --output json
```

**PostgreSQL — all counts should be 0 (run in pgAdmin):**

```sql
SELECT 'Users' AS table_name, COUNT(*) FROM "Users"
UNION ALL SELECT 'Courses', COUNT(*) FROM "Courses"
UNION ALL SELECT 'Course_Modules', COUNT(*) FROM "Course_Modules"
UNION ALL SELECT 'Enrolments', COUNT(*) FROM "Enrolments"
UNION ALL SELECT 'Module_Files', COUNT(*) FROM "Module_Files"
UNION ALL SELECT 'retrieval_units', COUNT(*) FROM retrieval_units;
```

## After Cleanup

1. Deploy code changes: `cd cdk && npm run deploy`
2. Create new admin/instructor/student accounts in Cognito
3. Create courses and modules via the frontend
4. Upload files — v2 ingestion pipeline processes them automatically
5. Chatbot will retrieve from the new `retrieval_units` table
