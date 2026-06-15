# Data Export: RDS PostgreSQL → pgAdmin / Tableau

Connect to the AILA RDS database via an SSM tunnel through a temporary bastion EC2 instance.

**Cost:** ~$0.01 per session | **Time:** ~2 minutes to connect

---

## Prerequisites (Install Once)

```bash
brew install --cask session-manager-plugin   # SSM plugin
brew install libpq                           # psql client
brew install --cask pgadmin4                 # GUI (optional)
```

---

## Dev Environment

| Resource | Value |
|----------|-------|
| Profile | `vincent.adm-dev2` |
| Account | 724772090264 |
| Subnet | subnet-071e1f8011d6613dd |
| Security Group | sg-01b40b148d50b1d2d |
| RDS Endpoint | aila-databasestack-ailadatabasestackdatabase5e4d38-irqydsbvk7zf.c98g4kw8aeji.ca-central-1.rds.amazonaws.com |
| Secret | AILA-DatabaseStack-AILA/credentials/rdsDbCredential |
| Database | aila |

### Terminal 1: Tunnel

```bash
# Authenticate
aws sso login --profile vincent.adm-dev2
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)

# Launch bastion
INSTANCE_ID=$(aws ec2 run-instances --region ca-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.micro \
  --subnet-id subnet-071e1f8011d6613dd \
  --security-group-ids sg-01b40b148d50b1d2d \
  --iam-instance-profile Name=AILA-BastionProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=AILA-DataExport-Bastion}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "Instance: $INSTANCE_ID"

# Wait ~60s, then verify
aws ssm describe-instance-information --region ca-central-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text

# Start tunnel (keeps this terminal occupied)
aws ssm start-session --region ca-central-1 --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-irqydsbvk7zf.c98g4kw8aeji.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

### Terminal 2: Connect

```bash
# Get credentials
export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)
aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id "AILA-DatabaseStack-AILA/credentials/rdsDbCredential" \
  --query 'SecretString' --output text

# Connect with psql (paste password from above)
PGPASSWORD="<password>" /opt/homebrew/opt/libpq/bin/psql -h localhost -p 5432 -U AILASecrets -d aila
```

### Cleanup

```bash
# Ctrl+C in tunnel terminal, then:
aws ec2 terminate-instances --region ca-central-1 --instance-ids $INSTANCE_ID
```

---

## Production Environment

| Resource | Value |
|----------|-------|
| Profile | `vincent.adm.prod2` |
| Account | 509399614162 |
| Subnet | subnet-0ce505eb9b20b0737 |
| Security Group | sg-01d2afae7c37b515c |
| RDS Endpoint | aila-databasestack-ailadatabasestackdatabase5e4d38-xtmyzfuamaga.c5uy8cgaik6k.ca-central-1.rds.amazonaws.com |
| Secret | AILA-DatabaseStack-AILA/credentials/rdsDbCredential |
| Database | aila |

### Terminal 1: Tunnel

```bash
# Authenticate
aws sso login --profile vincent.adm.prod2
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export $(aws configure export-credentials --profile vincent.adm.prod2 --format env | xargs)

# Launch bastion
INSTANCE_ID=$(aws ec2 run-instances --region ca-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.micro \
  --subnet-id subnet-0ce505eb9b20b0737 \
  --security-group-ids sg-01d2afae7c37b515c \
  --iam-instance-profile Name=AILA-BastionProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=AILA-DataExport-Bastion}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "Instance: $INSTANCE_ID"

# Wait ~60s, then verify
aws ssm describe-instance-information --region ca-central-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text

# Start tunnel (may need retry if "TargetNotConnected" — wait 30s)
aws ssm start-session --region ca-central-1 --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-xtmyzfuamaga.c5uy8cgaik6k.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

### Terminal 2: Connect

```bash
# Get credentials
export $(aws configure export-credentials --profile vincent.adm.prod2 --format env | xargs)
aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id "AILA-DatabaseStack-AILA/credentials/rdsDbCredential" \
  --query 'SecretString' --output text

# Connect with psql (paste password from above)
PGPASSWORD="<password>" /opt/homebrew/opt/libpq/bin/psql -h localhost -p 5432 -U AILASecrets -d aila
```

### Cleanup

```bash
# Ctrl+C in tunnel terminal, then:
aws ec2 terminate-instances --region ca-central-1 --instance-ids $INSTANCE_ID
```

---

## pgAdmin Connection Settings

After the tunnel is running, register a server in pgAdmin:

| Field | Value |
|-------|-------|
| Host | `localhost` |
| Port | `5432` |
| Database | `aila` |
| Username | `AILASecrets` |
| Password | (from Secrets Manager) |
| SSL mode | `Require` |

---

## Connecting Both Environments Simultaneously

Use different local ports — run prod on `15432`:

```bash
# In the prod tunnel command, change localPortNumber:
--parameters '{"host":["...prod-endpoint..."],"portNumber":["5432"],"localPortNumber":["15432"]}'
```

Then connect pgAdmin prod server to `localhost:15432`.

---

## Useful psql Commands

```sql
\dt                                              -- List tables
\d "Table_Name"                                  -- Table structure
SELECT * FROM "Course_Modules" LIMIT 10;         -- Browse data
\COPY (SELECT ...) TO './export.csv' WITH CSV HEADER  -- Export CSV
\q                                               -- Quit
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bastion won't come online | Wait 2-3 min. Verify subnet (needs NAT egress) and SG (needs outbound HTTPS). |
| "TargetNotConnected" | Wait 30s and retry. Common timing issue with SSM WebSocket. |
| pgAdmin can't connect | Verify tunnel terminal shows "Waiting for connections..." Check host=localhost, port=5432, SSL=Require. |
| "Connection refused" on 5432 | Tunnel isn't running. Restart the tunnel command. |
| SSO token expired | Re-run `aws sso login --profile ...` and re-export credentials. |
| Port 5432 in use | Use `localPortNumber:["15432"]` in tunnel and connect to that port. |
| Forgot to terminate bastion | Find and kill: `aws ec2 describe-instances --region ca-central-1 --filters "Name=tag:Name,Values=AILA-DataExport-Bastion" "Name=instance-state-name,Values=running" --query 'Reservations[].Instances[].InstanceId' --output text` |

---

## Exporting to Tableau

1. Export data to CSV via pgAdmin or psql
2. Open Tableau Desktop → Connect → Text file → Select CSV
