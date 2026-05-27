# Data Export: RDS PostgreSQL → pgAdmin / Tableau

## Overview

Access the AILA RDS PostgreSQL database using pgAdmin (visual browser) or export data to CSV for Tableau. Uses an SSM tunnel through a temporary bastion EC2 instance.

**Frequency:** Once per academic term
**Estimated time:** ~10 minutes to connect, then browse/export as needed
**Cost:** ~$0.01 per session (bastion runs only while you're connected)

---

## Architecture

```
Your laptop (localhost:5432) ←→ pgAdmin / psql / Tableau
    ↓  TLS-encrypted via HTTPS
AWS SSM Service
    ↓  AWS internal network
Bastion EC2 (t4g.micro, private subnet with NAT egress)
    ↓  VPC internal traffic, port 5432
RDS PostgreSQL (isolated subnet, database: "aila")
```

---

## Prerequisites (Install Once)

| Tool | Install Command | Verify |
|------|----------------|--------|
| AWS CLI v2 | Already installed | `aws --version` |
| Session Manager Plugin | `brew install --cask session-manager-plugin` | `session-manager-plugin --version` |
| PostgreSQL client (psql) | `brew install libpq` | `/opt/homebrew/opt/libpq/bin/psql --version` |
| pgAdmin 4 | `brew install --cask pgadmin4` | Open from Applications |

---

## Dev Environment

### Resource Reference

| Resource | Value |
|----------|-------|
| AWS Profile | `vincent.adm-dev2` |
| Account | 724772090264 |
| Region | ca-central-1 |
| VPC | vpc-077bcb32351fb851a |
| Subnet (private with egress) | subnet-071e1f8011d6613dd |
| Security Group (AILA-BastionSG) | sg-01b40b148d50b1d2d |
| Instance Profile | AILA-BastionProfile |
| RDS Endpoint | aila-databasestack-ailadatabasestackdatabase5e4d38-irqydsbvk7zf.c98g4kw8aeji.ca-central-1.rds.amazonaws.com |
| Database Name | aila |
| Credentials Secret | AILA-DatabaseStack-AILA/credentials/rdsDbCredential |

---

## Step-by-Step: Connect pgAdmin to RDS

### Step 1: Open Terminal and Authenticate with AWS

Open a terminal window. This will be your **tunnel terminal** — it will stay open the entire time you're connected.

```bash
aws sso login --profile vincent.adm-dev2
```

This opens a browser window. Approve the login, then return to the terminal.

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION

export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)
```

Verify you're authenticated:

```bash
aws sts get-caller-identity
```

You should see your account number (724772090264) and role in the output.

### Step 2: Launch the Bastion Instance

```bash
INSTANCE_ID=$(aws ec2 run-instances --region ca-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.micro \
  --subnet-id subnet-071e1f8011d6613dd \
  --security-group-ids sg-01b40b148d50b1d2d \
  --iam-instance-profile Name=AILA-BastionProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=AILA-DataExport-Bastion}]' \
  --query 'Instances[0].InstanceId' --output text)

echo "Bastion instance: $INSTANCE_ID"
```

Write down or remember the instance ID — you'll need it to terminate later.

### Step 3: Wait for the Bastion to Come Online

Wait approximately 60 seconds, then check:

```bash
aws ssm describe-instance-information --region ca-central-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text
```

- If it returns **`Online`** → proceed to Step 4
- If it returns **`None`** or nothing → wait 30 more seconds and try again
- If still not online after 2-3 minutes → see Troubleshooting section

### Step 4: Start the SSM Tunnel

```bash
aws ssm start-session --region ca-central-1 \
  --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-irqydsbvk7zf.c98g4kw8aeji.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

You should see:
```
Starting session with SessionId: ...
Port 5432 opened for sessionId ...
Waiting for connections...
```

**Do not close this terminal.** The tunnel stays open only while this command is running. Minimize it and move on.

### Step 5: Get Database Credentials

Open a **new terminal tab** (Cmd+T) and run:

```bash
export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)

aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id "AILA-DatabaseStack-AILA/credentials/rdsDbCredential" \
  --query 'SecretString' --output text
```

This outputs JSON like:
```json
{"password":"...","dbname":"aila","engine":"postgres","port":5432,"host":"...","username":"AILASecrets"}
```

Note the `username` and `password` values.

### Step 6: Connect pgAdmin

1. Open **pgAdmin 4** from Applications

2. In the left panel, **right-click "Servers"** → **Register** → **Server**

3. Fill in the tabs:

   **General tab:**
   | Field | Value |
   |-------|-------|
   | Name | `AILA Dev` |

   **Connection tab:**
   | Field | Value |
   |-------|-------|
   | Host name/address | `localhost` |
   | Port | `5432` |
   | Maintenance database | `aila` |
   | Username | `AILASecrets` |
   | Password | (paste from Step 5) |
   | Save password? | Yes (toggle on) |

   **SSL tab:**
   | Field | Value |
   |-------|-------|
   | SSL mode | `Require` |

4. Click **Save**

5. The server should appear in the left panel. Expand it:
   ```
   Servers
     └── AILA Dev
          └── Databases
               └── aila
                    └── Schemas
                         └── public
                              └── Tables
   ```

### Step 7: Browse and Export Data

**To browse tables:**
- Expand Tables in the tree → right-click a table → **View/Edit Data** → **All Rows** (or First 100 Rows)

**To run custom queries:**
- Click on the `aila` database → **Tools** menu → **Query Tool**
- Write your SQL and click **Execute** (▶ button or F5)
- Results appear in the bottom panel

**To export query results to CSV:**
- After running a query, click the **Download** button (↓) in the results panel
- Choose CSV format and save location

**To export an entire table to CSV:**
- Right-click the table → **Import/Export Data**
- Toggle to **Export**
- Format: CSV
- Header: Yes
- Choose filename
- Click **OK**

---

## When You're Done: Clean Up

### Step 8: Disconnect and Terminate

1. **Disconnect pgAdmin:** Right-click "AILA Dev" → **Disconnect Server** (or just close pgAdmin)

2. **Close the tunnel:** Go to the tunnel terminal and press **Ctrl+C**

3. **Terminate the bastion:**
   ```bash
   aws ec2 terminate-instances --region ca-central-1 --instance-ids $INSTANCE_ID
   ```

4. **Verify termination:**
   ```bash
   aws ec2 describe-instances --region ca-central-1 --instance-ids $INSTANCE_ID \
     --query 'Reservations[0].Instances[0].State.Name' --output text
   ```
   Should return `shutting-down` or `terminated`.

> **Important:** Always terminate the bastion when done. A running t4g.micro costs ~$7.50/month if left on.

---

## Quick Reference (Copy-Paste Block)

For returning users who just need the commands:

```bash
# === TERMINAL 1: Tunnel === #

# Authenticate
aws sso login --profile vincent.adm-dev2
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)

# Launch bastion
INSTANCE_ID=$(aws ec2 run-instances --region ca-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.micro --subnet-id subnet-071e1f8011d6613dd \
  --security-group-ids sg-01b40b148d50b1d2d \
  --iam-instance-profile Name=AILA-BastionProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=AILA-DataExport-Bastion}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "Instance: $INSTANCE_ID"

# Wait 60s, check status
aws ssm describe-instance-information --region ca-central-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text

# Start tunnel (blocks this terminal)
aws ssm start-session --region ca-central-1 --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-irqydsbvk7zf.c98g4kw8aeji.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

```bash
# === TERMINAL 2: Credentials === #

export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)
aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id "AILA-DatabaseStack-AILA/credentials/rdsDbCredential" \
  --query 'SecretString' --output text
```

Then open pgAdmin → connect to `localhost:5432` with the credentials.

```bash
# === CLEANUP (after done) === #

# Ctrl+C in tunnel terminal, then:
aws ec2 terminate-instances --region ca-central-1 --instance-ids $INSTANCE_ID
```

---

## Connecting with psql (Command Line Alternative)

If you prefer the command line over pgAdmin:

```bash
export PGPASSWORD="<password-from-step-5>"
/opt/homebrew/opt/libpq/bin/psql -h localhost -p 5432 -U AILASecrets -d aila
```

Useful commands:
```sql
\dt                          -- List all tables
\d table_name                -- Show table structure
\COPY (SELECT ...) TO './file.csv' WITH CSV HEADER   -- Export to CSV
\q                           -- Quit
```

---

## Exporting to Tableau

1. Export your data to CSV using either pgAdmin or psql (see above)
2. Open **Tableau Desktop**
3. **Connect** → **Text file**
4. Select your CSV file
5. Build your visualization

---

## Troubleshooting

### Bastion won't come online (SSM status stays "None")

**Possible causes:**
- Instance hasn't finished booting → Wait up to 2-3 minutes total
- Wrong security group → Verify you used `sg-01b40b148d50b1d2d` (AILA-BastionSG). This SG allows outbound HTTPS which the SSM agent needs.
- Wrong subnet → Must be `subnet-071e1f8011d6613dd` (private with NAT egress). The isolated subnet has no internet access.
- Instance profile not attached → Check with:
  ```bash
  aws ec2 describe-instances --region ca-central-1 --instance-ids $INSTANCE_ID \
    --query 'Reservations[0].Instances[0].IamInstanceProfile' --output json
  ```

**Fix:** Terminate the instance and relaunch with correct parameters.

### "TargetNotConnected" error when starting tunnel

**Cause:** The SSM agent briefly registered but lost connectivity, or you tried too soon.

**Fix:** Wait 30 seconds and retry the `aws ssm start-session` command. If it persists after 2 minutes, terminate and relaunch the bastion.

### pgAdmin shows "Unable to connect to server"

**Possible causes:**
- Tunnel isn't running → Check the tunnel terminal still shows "Waiting for connections..."
- Wrong host → Must be `localhost` (not the RDS endpoint)
- Wrong port → Must be `5432`
- SSL mode not set → Set to `Require` in the SSL tab
- Credentials wrong → Re-fetch from Secrets Manager

### pgAdmin was working but suddenly disconnected

**Cause:** The SSM session timed out (default idle timeout is 20 minutes) or the tunnel terminal was closed.

**Fix:** Restart the tunnel (Step 4). pgAdmin will reconnect automatically when you try to browse again, or right-click the server → **Connect Server**.

### "Connection refused" on localhost:5432

**Cause:** Nothing is listening on port 5432 locally.

**Fix:** The tunnel isn't running. Go back to Step 4 and start it.

### SSO token expired

**Cause:** AWS SSO sessions expire (typically after 1-8 hours depending on org settings).

**Symptoms:** Commands return "Token has expired" or "UnauthorizedSSOTokenError"

**Fix:** Re-run Step 1:
```bash
aws sso login --profile vincent.adm-dev2
export $(aws configure export-credentials --profile vincent.adm-dev2 --format env | xargs)
```

### Port 5432 already in use

**Cause:** Another process (local PostgreSQL, another tunnel) is using port 5432.

**Fix:** Either stop the other process, or use a different local port:
```bash
aws ssm start-session --region ca-central-1 --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-irqydsbvk7zf.c98g4kw8aeji.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}'
```
Then connect pgAdmin to `localhost:15432` instead.

### Forgot to terminate the bastion

Check for running bastion instances:
```bash
aws ec2 describe-instances --region ca-central-1 \
  --filters "Name=tag:Name,Values=AILA-DataExport-Bastion" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,LaunchTime]' --output table
```

Terminate any found:
```bash
aws ec2 terminate-instances --region ca-central-1 --instance-ids <instance-id>
```

---

## Production Environment

### Resource Reference

| Resource | Value |
|----------|-------|
| AWS Profile | `vincent.adm.prod2` |
| Account | 509399614162 |
| Region | ca-central-1 |
| VPC | vpc-0eeeae33bc6503309 |
| Subnet (private with egress) | subnet-0ce505eb9b20b0737 |
| Security Group (AILA-BastionSG) | sg-01d2afae7c37b515c |
| Instance Profile | AILA-BastionProfile |
| RDS Endpoint | aila-databasestack-ailadatabasestackdatabase5e4d38-xtmyzfuamaga.c5uy8cgaik6k.ca-central-1.rds.amazonaws.com |
| Database Name | aila |
| Credentials Secret | AILA-DatabaseStack-AILA/credentials/rdsDbCredential |

### Step-by-Step: Connect pgAdmin to Production RDS

The process is identical to dev, but with different credentials and resource IDs.

#### Step 1: Authenticate with Production AWS

```bash
aws sso login --profile vincent.adm.prod2

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION

export $(aws configure export-credentials --profile vincent.adm.prod2 --format env | xargs)
```

Verify:
```bash
aws sts get-caller-identity
```

Should show account `509399614162`.

#### Step 2: Launch the Bastion Instance

```bash
INSTANCE_ID=$(aws ec2 run-instances --region ca-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.micro \
  --subnet-id subnet-0ce505eb9b20b0737 \
  --security-group-ids sg-01d2afae7c37b515c \
  --iam-instance-profile Name=AILA-BastionProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=AILA-DataExport-Bastion}]' \
  --query 'Instances[0].InstanceId' --output text)

echo "Bastion instance: $INSTANCE_ID"
```

#### Step 3: Wait for the Bastion to Come Online

Wait ~60 seconds, then check:

```bash
aws ssm describe-instance-information --region ca-central-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text
```

> **Note:** In production, the `start-session` command may fail with "TargetNotConnected" even when ping shows "Online". This is a timing issue with the SSM WebSocket channel. If this happens, wait 30 seconds and retry. It typically works on the second or third attempt.

#### Step 4: Start the SSM Tunnel

```bash
aws ssm start-session --region ca-central-1 \
  --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-xtmyzfuamaga.c5uy8cgaik6k.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

Leave this terminal running once you see "Waiting for connections..."

#### Step 5: Get Database Credentials

In a **new terminal tab**:

```bash
export $(aws configure export-credentials --profile vincent.adm.prod2 --format env | xargs)

aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id "AILA-DatabaseStack-AILA/credentials/rdsDbCredential" \
  --query 'SecretString' --output text
```

#### Step 6: Connect pgAdmin

Register a new server in pgAdmin:

**General tab:**
| Field | Value |
|-------|-------|
| Name | `AILA Prod` |

**Connection tab:**
| Field | Value |
|-------|-------|
| Host name/address | `localhost` |
| Port | `5432` |
| Maintenance database | `aila` |
| Username | `AILASecrets` |
| Password | (paste from Step 5) |
| Save password? | Yes |

**SSL tab:**
| Field | Value |
|-------|-------|
| SSL mode | `Require` |

#### Step 7: Clean Up

```bash
# Ctrl+C in tunnel terminal, then:
aws ec2 terminate-instances --region ca-central-1 --instance-ids $INSTANCE_ID
```

### Production Quick Reference

```bash
# === TERMINAL 1: Tunnel === #

aws sso login --profile vincent.adm.prod2
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION
export $(aws configure export-credentials --profile vincent.adm.prod2 --format env | xargs)

INSTANCE_ID=$(aws ec2 run-instances --region ca-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.micro --subnet-id subnet-0ce505eb9b20b0737 \
  --security-group-ids sg-01d2afae7c37b515c \
  --iam-instance-profile Name=AILA-BastionProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=AILA-DataExport-Bastion}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "Instance: $INSTANCE_ID"

# Wait 60s, check status
aws ssm describe-instance-information --region ca-central-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text

# Start tunnel (may need to retry if "TargetNotConnected" — wait 30s and try again)
aws ssm start-session --region ca-central-1 --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["aila-databasestack-ailadatabasestackdatabase5e4d38-xtmyzfuamaga.c5uy8cgaik6k.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

```bash
# === TERMINAL 2: Credentials === #

export $(aws configure export-credentials --profile vincent.adm.prod2 --format env | xargs)
aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id "AILA-DatabaseStack-AILA/credentials/rdsDbCredential" \
  --query 'SecretString' --output text
```

```bash
# === CLEANUP === #

aws ec2 terminate-instances --region ca-central-1 --instance-ids $INSTANCE_ID
```

---

## Important: Connecting to Dev and Prod Simultaneously

Since both environments use `localhost:5432`, you **cannot** have both tunnels running at the same time on the same port. Options:

1. **Use different local ports** — run the prod tunnel on port `15432`:
   ```bash
   --parameters '{"host":["...prod-endpoint..."],"portNumber":["5432"],"localPortNumber":["15432"]}'
   ```
   Then register the pgAdmin prod server on port `15432`.

2. **Connect one at a time** — disconnect from one environment before connecting to the other.

---

## One-Time Setup (Already Completed)

These resources persist between sessions and don't need to be recreated:

### Dev (Account 724772090264)
- **IAM Role:** AILA-BastionSSMRole (with AmazonSSMManagedInstanceCore policy)
- **IAM Instance Profile:** AILA-BastionProfile
- **Security Group:** sg-01b40b148d50b1d2d (AILA-BastionSG — outbound HTTPS + PostgreSQL)

### Production (Account 509399614162)
- **IAM Role:** AILA-BastionSSMRole (with AmazonSSMManagedInstanceCore policy)
- **IAM Instance Profile:** AILA-BastionProfile
- **Security Group:** sg-01d2afae7c37b515c (AILA-BastionSG — outbound HTTPS + PostgreSQL)
