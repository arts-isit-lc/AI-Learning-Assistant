# Full Data Wipe — Reset to a Fresh State (dev **or** prod)

Complete cleanup for resetting the application. Works for **either** environment —
you pick the target in Step 0. Used when migrating pipelines or starting over.

> **DANGER — destructive and irreversible.** Back up first (full `pg_dump`, see
> `data_export.md` → "Full Database Export"), and clear the account guard in
> Step 0 before running anything below.

## App state lives in THREE stores
A complete reset must clear all of them, or you get dangling references:
- **RDS Postgres** — all relational tables + `retrieval_units` (pgvector).
- **DynamoDB** — chat history (`DynamoDB-Conversation-Table`), chatbot session
  state (`AILA-MultimodalRagStack-sessionStateTable`), and the embedding /
  enrichment caches (content-hash keyed — **safe to keep**; they just speed up
  re-ingestion).
- **S3** — uploaded course files, IR data, chat-log exports.

Cognito holds user accounts separately (Step 4).

> **Why this guide is env-parameterized:** most resource names are *identical*
> across dev and prod because both share `StackPrefix=AILA`
> (`DynamoDB-Conversation-Table`, `AILA-MultimodalRagStack-sessionStateTable`, …).
> DynamoDB/S3 tables are per-account, so **only your credentials decide which
> account you hit** — the Step 0 guard is the one thing preventing a
> cross-environment mistake. The IR bucket is the lone name that differs (S3 is a
> global namespace), so it's a per-env variable below.

## Step 0: Pick target + ACCOUNT GUARD (do this first)

Choose exactly ONE block:

```bash
# ─── DEV ────────────────────────────────────────────────
export AILA_PROFILE=vincent.adm-dev2
export AILA_ACCOUNT=724772090264
export AILA_IR_BUCKET=aila-multimodalragstack-ir-bucket        # dev: un-suffixed

# ─── PROD ───────────────────────────────────────────────
export AILA_PROFILE=vincent.adm.prod2
export AILA_ACCOUNT=509399614162
export AILA_IR_BUCKET=aila-multimodalragstack-ir-bucket-prod   # prod: -prod suffix
```

Authenticate, then run the hard guard:

```bash
export AILA_REGION=ca-central-1
aws sso login --profile "$AILA_PROFILE"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export $(aws configure export-credentials --profile "$AILA_PROFILE" --format env | xargs)

# MUST print "OK ..." — if it prints "STOP ...", do not run anything below.
ACTUAL=$(aws sts get-caller-identity --query Account --output text)
[ "$ACTUAL" = "$AILA_ACCOUNT" ] && echo "OK: targeting $AILA_ACCOUNT" || echo "STOP: on $ACTUAL, expected $AILA_ACCOUNT"
```

## Step 1: PostgreSQL

Needs the SSM tunnel — follow `data_export.md` for the **same** environment. Pick one:

**Option A — data only, keep schema (`TRUNCATE`):**
```sql
TRUNCATE TABLE
  "Users", "Courses", "Course_Concepts", "Course_Modules", "Enrolments",
  "Module_Files", "Module_File_References", "Student_Modules", "Sessions",
  "Messages", "User_Engagement_Log", "chatlogs_notifications", retrieval_units
CASCADE;
```

**Option B — fresh schema (recommended): `DROP` + redeploy.** Dropping the tables
and letting the initializer recreate them from `initializer.py` also fixes schema
drift that `TRUNCATE` leaves behind (e.g. a `text`-vs-`jsonb` column, or duplicate
FKs accumulated across deploys).
```sql
DROP TABLE IF EXISTS
  "Users", "Courses", "Course_Concepts", "Course_Modules", "Enrolments",
  "Module_Files", "Module_File_References", "Student_Modules", "Sessions",
  "Messages", "User_Engagement_Log", "chatlogs_notifications", retrieval_units,
  langchain_pg_embedding, langchain_pg_collection, upsertion_record   -- legacy v1
CASCADE;
```
```bash
# recreate: the initializer re-runs on deploy and rebuilds the tables
cd cdk
AWS_PROFILE=$AILA_PROFILE npm run deploy        # dev
AWS_PROFILE=$AILA_PROFILE npm run deploy:prod   # prod
```

## Step 2: DynamoDB — chat history + session state

Direct API (no tunnel). Uses only the AWS CLI + stdlib `python3` to parse the
scan output — no `boto3` needed (the old boto3 script failed with
`ModuleNotFoundError` on a clean Homebrew Python).

Verify the chat table's key schema first (guide assumes `SessionId` HASH):
```bash
aws dynamodb describe-table --table-name DynamoDB-Conversation-Table \
  --region "$AILA_REGION" --query 'Table.KeySchema'
```

Chat history:
```bash
aws dynamodb scan --table-name DynamoDB-Conversation-Table --region "$AILA_REGION" \
  --projection-expression "SessionId" --output json --no-cli-pager \
| python3 -c "import json,sys; [print(i['SessionId']['S']) for i in json.load(sys.stdin).get('Items',[])]" \
| while IFS= read -r sid; do [ -z "$sid" ] && continue; \
    aws dynamodb delete-item --table-name DynamoDB-Conversation-Table --region "$AILA_REGION" \
      --key "{\"SessionId\":{\"S\":\"$sid\"}}" --no-cli-pager; done; echo "chat history cleared."
```

Chatbot session state (partition key `session_id`, no sort key):
```bash
aws dynamodb scan --table-name AILA-MultimodalRagStack-sessionStateTable --region "$AILA_REGION" \
  --projection-expression "session_id" --output json --no-cli-pager \
| python3 -c "import json,sys; [print(i['session_id']['S']) for i in json.load(sys.stdin).get('Items',[])]" \
| while IFS= read -r sid; do [ -z "$sid" ] && continue; \
    aws dynamodb delete-item --table-name AILA-MultimodalRagStack-sessionStateTable --region "$AILA_REGION" \
      --key "{\"session_id\":{\"S\":\"$sid\"}}" --no-cli-pager; done; echo "session state cleared."
```

Leave `AILA-MultimodalRagStack-embeddingCacheTable` and
`AILA-MultimodalRagStack-enrichmentCacheTable` alone — content-hash keyed, so they
don't dangle and they accelerate re-ingestion. Clear them only to force a full recompute.

## Step 3: S3 — empty buckets

The API-Gateway bucket names are auto-generated, and on a long-lived account
there are usually **orphaned duplicates** from past deploys (RETAIN keeps the old
bucket whenever one is replaced). Don't guess from `aws s3 ls` — ask
CloudFormation which buckets the CURRENT stack owns:
```bash
aws cloudformation list-stack-resources --stack-name AILA-ApiGatewayStack --region "$AILA_REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].[LogicalResourceId,PhysicalResourceId]" --output table
```
Empty the IR bucket + the active data-ingestion bucket (it holds the uploaded
course files the wiped `Module_Files` rows referenced); optionally the active
chatlogs + embedding-storage buckets for a total reset:
```bash
aws s3 rm "s3://$AILA_IR_BUCKET" --recursive
aws s3 rm "s3://<active-DataIngestion-bucket-from-the-table>" --recursive
# optional: aws s3 rm "s3://<active-chatlogs-bucket>" --recursive
# optional: aws s3 rm "s3://<active-embeddingStorage-bucket>" --recursive
```
Any bucket from `aws s3 ls | grep -i aila` that is **not** in the
`list-stack-resources` table is an orphan from a past deploy — safe to empty and
`aws s3 rb` to stop paying for it, but confirm it's absent from the active list first.

## Step 4: Cognito — delete users

No bulk-delete API exists, so fetch the pool ID and loop. Only the users are
removed — the pool itself (and its ID) is preserved, so no app config changes.
**Irreversible.**

```bash
# Re-confirm the target account before deleting — must equal $AILA_ACCOUNT:
[ "$(aws sts get-caller-identity --query Account --output text)" = "$AILA_ACCOUNT" ] \
  && echo "OK: $AILA_ACCOUNT" || echo "STOP: wrong account"

# Pool ID from the stack (expect exactly one):
POOL_ID=$(aws cloudformation list-stack-resources --stack-name AILA-ApiGatewayStack --region "$AILA_REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId" --output text)
echo "Pool: $POOL_ID"

# (optional) count first:
aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$AILA_REGION" --query "length(Users)" --output text

# Delete every user (CLI auto-paginates the list):
aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$AILA_REGION" --output json --no-cli-pager \
| python3 -c "import json,sys; [print(u['Username']) for u in json.load(sys.stdin).get('Users',[])]" \
| while IFS= read -r u; do [ -z "$u" ] && continue; \
    echo "deleting $u"; \
    aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --region "$AILA_REGION" --username "$u"; \
  done; echo "all users deleted."
```

> If `POOL_ID` comes back empty, list pools and match by name — mind the account,
> dev has a same-named pool:
> `aws cognito-idp list-user-pools --max-results 60 --region "$AILA_REGION"`.
> On `TooManyRequestsException` for a large pool, add `sleep 0.2` inside the loop.

## Verification

```bash
# S3 — expect empty
aws s3 ls "s3://$AILA_IR_BUCKET" --recursive --summarize | tail -3

# DynamoDB — expect Count: 0
aws dynamodb scan --table-name DynamoDB-Conversation-Table --region "$AILA_REGION" --select COUNT --output json
aws dynamodb scan --table-name AILA-MultimodalRagStack-sessionStateTable --region "$AILA_REGION" --select COUNT --output json

# Cognito — expect 0 (reuses $POOL_ID from Step 4)
aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$AILA_REGION" --query "length(Users)" --output text
```
```sql
-- PostgreSQL (via tunnel) — expect all 0
SELECT 'Users' AS table_name, COUNT(*) FROM "Users"
UNION ALL SELECT 'Courses', COUNT(*) FROM "Courses"
UNION ALL SELECT 'Course_Modules', COUNT(*) FROM "Course_Modules"
UNION ALL SELECT 'Module_Files', COUNT(*) FROM "Module_Files"
UNION ALL SELECT 'retrieval_units', COUNT(*) FROM retrieval_units;
```

## After cleanup
1. Deploy code if not already: dev `npm run deploy`, prod `npm run deploy:prod`.
2. Recreate admin/instructor/student accounts in Cognito.
3. Create courses and modules via the frontend.
4. Upload files — the v2 ingestion pipeline processes them automatically.
