# AWS Account Baseline Cost: Findings

*Prepared 3 November 2026 from the production AWS account (ca-central-1), using Cost Explorer, CloudWatch, CloudTrail, AWS Config, Security Hub, Systems Manager and EC2 data.*

All amounts are USD before tax.

---

## Summary

- The "UBC account baseline" was **$104.36 in October 2026** and **$101.86 in September 2026**.
- **The production account is not an OCELIA-only account.** Its alias is `ubc-arts-isit-prod`, created 14 January 2025. It is Arts ISIT's production account, and OCELIA is one workload in it.
- **Only about $10–17 a month of the baseline is caused by OCELIA.** The rest comes from:
  - UBC's standard account setup
  - 52 Arts on-premises servers managed from this account
  - an idle network connection
- **The $44.64 a month Transit Gateway charge pays for an empty VPC** in ca-west-1. No traffic went through it in September or October, and OCELIA doesn't use it.
- If OCELIA's budget pays the whole account bill, it is covering about **$87–94 a month (about $1,050–1,130 a year)** of costs that aren't OCELIA's.

---

## 1. What was billed

From Cost Explorer, grouped by service and usage type.

| Service | Sep 2026 | Oct 2026 | October usage | Unit price |
|---|---|---|---|---|
| Transit Gateway (ca-west-1) | $43.20 | **$44.64** | 744 attachment-hours, **0 bytes of traffic** | $0.06 per hour |
| AWS Config | $33.16 | **$32.86** | 10,923 items recorded in ca-central-1, 29 in other regions | $0.003 per item |
| AWS Security Hub | $14.09 | **$14.07** | 13,226 checks in ca-central-1 ($8.75), plus checks in 17 other regions ($5.32) | Tiered per check |
| Amazon Security Lake | $8.36 | **$9.35** | 9.78 GB of CloudTrail logs from ca-central-1 ($7.33), plus other logs and normalization | $0.75 per GB of CloudTrail |
| Amazon GuardDuty | $2.27 | **$2.62** | 569,603 CloudTrail events analysed | $4.60 per million events |
| AWS Systems Manager | $0.78 | **$0.82** | Patch automation steps and commands sent to hybrid servers | – |
| **Baseline total** | **$101.86** | **$104.36** | | |
| Whole account, before tax | $452.79 | $483.99 | | |

CloudTrail itself costs $0. It recorded 7.06 million events in ca-central-1 in October, all in the free tier. Those events still drive the Security Lake and GuardDuty charges.

---

## 2. Evidence that the baseline comes from UBC's standard setup

| Item | What the account shows |
|---|---|
| Account | Alias `ubc-arts-isit-prod`, created 14 January 2025 |
| AWS Config | Recorder `aws-controltower-BaselineConfigRecorder`, recording all resource types continuously, including global ones. It delivers to a Control Tower log bucket in UBC's central log archive account |
| Security Hub | Enabled 14 January 2025 and managed by UBC's central security account. The AWS Foundational Security Best Practices standard is enabled, with new controls switched on automatically |
| GuardDuty | Managed by the same central security account |
| Control Tower stacks | Six `StackSet-AWSControlTowerBP-*` stacks in the account: baseline Config, baseline CloudWatch, service roles, service-linked roles, baseline roles, and the account-factory VPC |
| Transit Gateway | Owned by UBC's central network account and attached to a VPC in this account (see section 3.1) |

The OCELIA team can't change any of these, which is why they're called the baseline.

*Account IDs for UBC's central accounts are left out of this file on purpose. The commands in section 8 show them.*

---

## 3. What drives each charge

### 3.1 Transit Gateway: $44.64, none of it OCELIA's

| Finding | Detail |
|---|---|
| What's attached | VPC `arts-isit-prod-services-vpc` (10.57.83.192/27) in **ca-west-1** |
| Who created it | CloudFormation stack `arts-isit-prod-services`, described as *"Deploy a UBC Standard TGW attached VPC in region ca-west-1"*, created 15 January 2025, one day after the account |
| What's in it | Nothing but the Transit Gateway's own two network interfaces. The stack contains only a VPC, subnets, route tables, an internet gateway, DHCP options and the attachment |
| Traffic | **0 bytes** in September and in October |
| OCELIA's network | OCELIA's VPC (`AILA-VpcStack/aila-Vpc`) is in ca-central-1, where the account has **no** Transit Gateway attachments |

The charge is for keeping an unused connection to UBC's network open. Removing it would save $44.64 a month (about $536 a year), if UBC Hybrid Cloud allows it.

### 3.2 AWS Config: $32.86, mostly from Arts servers

Configuration items recorded in October, by resource type (CloudWatch `AWS/Config` `ConfigurationItemsRecorded`):

| Resource type | Items | Cost at $0.003 | Source |
|---|---|---|---|
| `AWS::SSM::AssociationCompliance` | 6,001 | $18.00 | Arts servers |
| `AWS::Config::ResourceCompliance` | 2,431 | $7.29 | Mixed: compliance results for Control Tower and Security Hub rules |
| `AWS::SSM::PatchCompliance` | 1,308 | $3.92 | Arts servers |
| `AWS::SSM::ManagedInstanceInventory` | 792 | $2.38 | Arts servers |
| All OCELIA resource types combined (Lambda 92, RDS snapshots 62, alarms 61, network interfaces 38, RDS instance 31, subnets 23, VPC 17, security groups 16, backups 14, stacks 13, and smaller) | ~392 | ~$1.18 | OCELIA |
| **Total** | **10,924** | **$32.77** | |

**The Arts servers.** Systems Manager in this account manages **52 on-premises servers** registered as hybrid managed nodes: 38 online and 14 disconnected.
- They were registered from February 2026 onward.
- They are UBC servers outside AWS. 37 are under arts.ubc.ca, and the rest are under other Arts and UBC domains, plus 4 Windows workgroup servers.
- Their patching and inventory run from this account, and every patch or compliance change becomes a billed Config item.

**About 74% of Config items come from these servers. About 4% come from OCELIA.**

### 3.3 Security Hub: $14.07, about $3 from OCELIA

| Part | Cost | Source |
|---|---|---|
| Checks in 17 regions other than ca-central-1 | $5.32 | Account-wide controls. OCELIA doesn't run in these regions |
| Checks in ca-central-1 | $8.75 | Mixed (see sample below) |

Active Security Hub findings in ca-central-1, by resource type. This is a partial sample of about 1,350 findings across the 25 most common resource types, because the API throttled the query.

| Resource type | Findings | Source |
|---|---|---|
| `AwsAccount` | 842 | Account-level controls (~62%) |
| IAM roles, Lambda functions, CloudFormation stacks, security groups, S3 buckets, network interfaces, secrets, RDS, VPC, DynamoDB, SQS, Cognito and others | ~435 | Mostly OCELIA (~32%) |
| `AwsSsmPatchCompliance`, `AwsSsmAssociationCompliance`, `AwsSsmDocument` | 70 | Arts servers (~5%) |

OCELIA's estimated share is about a third of the ca-central-1 checks, or about $3.

### 3.4 Security Lake ($9.35) and GuardDuty ($2.62): about half from OCELIA

Both charges grow with CloudTrail activity. A 30-minute sample on 2 November 2026 (18:00–18:30 UTC) recorded 4,435 events, consistent with about 6.6–7 million a month.

| Who made the calls | Events | Share | Source |
|---|---|---|---|
| API Gateway service role (X-Ray sampling-rule polling) | 1,468 | 33% | **OCELIA** |
| CrowdStrike cloud security scanner | 1,267 | 29% | UBC security tooling |
| OCELIA's own roles (`AILA-*`) | 356 | 8% | **OCELIA** |
| Systems Manager hybrid servers (`mi-*`) | 350 | 8% | Arts servers |
| API Gateway service (authorizers and integrations) | 294 | 7% | **OCELIA** |
| AWS Config service role | 216 | 5% | UBC baseline |
| EventBridge | 100 | 2% | **OCELIA** |
| Cloudability (cost reporting) | 76 | 2% | UBC tooling |
| Lambda, AppSync | 125 | 3% | **OCELIA** |
| Other (Config, Systems Manager, Security Hub services) | ~145 | 3% | UBC baseline and Arts |

Rough split: **OCELIA ~53%, UBC security and cost tools ~38%, Arts servers ~9%.**

| Most frequent calls | Events |
|---|---|
| `xray:GetSamplingRules` | 1,498 |
| `sts:AssumeRole` | 621 |
| `kms:Decrypt` | 344 |
| `ssm:UpdateInstanceInformation` | 228 |
| `apigateway:GetMethod` | 167 |
| `secretsmanager:GetSecretValue` | 165 |
| `ssm:ListInstanceAssociations` | 114 |

**A third of all CloudTrail events in the account comes from one OCELIA setting.** X-Ray tracing is turned on for the `prod` stage of `AILA-ApiGatewayStack-API`, and API Gateway polls for X-Ray sampling rules about 50 times a minute as a result.

### 3.5 Systems Manager: $0.82, none of it OCELIA's

Patch automation steps (343) and hybrid commands (64) for the Arts servers.

---

## 4. OCELIA's share of the baseline (October)

| Service | Billed | OCELIA's share | Confidence |
|---|---|---|---|
| Transit Gateway | $44.64 | **$0** | High: zero traffic, not attached to OCELIA's VPC |
| AWS Config | $32.86 | **~$1–8** | High for the $1.18 floor. The upper end assumes every compliance result is OCELIA's |
| Security Hub | $14.07 | **~$3** | Medium: based on a partial findings sample |
| Security Lake | $9.35 | **~$4.50** | Medium: based on a 30-minute CloudTrail sample |
| GuardDuty | $2.62 | **~$1.40** | Medium: same sample |
| Systems Manager | $0.82 | **$0** | High |
| **Total** | **$104.36** | **~$10–17** | |

**If OCELIA had its own UBC account,** its baseline would probably be about $25–35 a month. That covers OCELIA's own share plus the account-wide checks and UBC tooling every account carries. It would be about $70–80 if UBC requires an attached Transit Gateway in every account. These are estimates.

---

## 5. What this means

### Who pays
If OCELIA's budget pays the whole bill for this account, it is paying about **$87–94 a month (about $1,050–1,130 a year)** for Arts ISIT's account setup and servers. The first question is how this account's bill is actually charged.

### Effect on the hosting comparison
The figures in [HOSTING_OPTIONS.md](HOSTING_OPTIONS.md) charge the full $104 to OCELIA. Counting only OCELIA's share (~$10–17):

| Option (with the UBC AI Gateway) | Full baseline | OCELIA's share only |
|---|---|---|
| 1. UBC OpenStack server | ~$51 | ~$51 (no AWS account needed) |
| 2. Trimmed AWS | ~$223 | **~$130–135** |
| 3. AWS, pay-as-you-go database | ~$195–220 | **~$100–135** |
| 4. AWS, no database server | ~$150–160 | **~$65–75** |

The gap between AWS and OpenStack is much smaller when only OCELIA's share counts. This applies only if the account's costs are actually split that way.

### What OCELIA moving out would change
If OCELIA moved to OpenStack, most of the baseline would stay in this account, because it comes from the Arts servers, the idle Transit Gateway and UBC's standard setup. The account's total cost would fall by roughly OCELIA's share plus OCELIA's own services. The account wouldn't close.

---

## 6. Other findings from this review

| Finding | Detail | Suggested action |
|---|---|---|
| X-Ray tracing on API Gateway | The `prod` stage of `AILA-ApiGatewayStack-API` has tracing on. It causes about a third of the account's CloudTrail events (about $3 a month in Security Lake and GuardDuty), plus the X-Ray charge itself (about $0.40 a month) | Turn it off if nobody uses the traces. Not changed |
| Document ingestion memory | `ragIngestionFunction` peaked at 1,024 MB over the last 30 days, which is its configured limit. Large uploads may be failing or retrying | Check the logs for out-of-memory errors, and raise the memory if needed. Not changed |

---

## 7. Questions for UBC Hybrid Cloud and Arts ISIT

| Question | Why it matters |
|---|---|
| How is the bill for `ubc-arts-isit-prod` charged, and to whom? | Decides whether OCELIA is paying ~$90 a month of other teams' costs |
| Can the baseline be split between OCELIA and the Arts servers? | OCELIA causes only about $10–17 of the $104 |
| Can the idle ca-west-1 Transit Gateway attachment be removed? | $44.64 a month, with zero traffic |
| Should the 52 Arts servers be managed from this account? | They cause about three-quarters of the Config charge |
| Would OCELIA be better off in its own account? | A cleaner bill, at about $25–35 a month of baseline (an estimate) |

---

## 8. Confidence, limits and how to reproduce

### Exact
- Billed amounts and usage quantities come from Cost Explorer.
- Config item counts by resource type come from CloudWatch.
- Transit Gateway traffic, the attachment and the VPC contents come from EC2 and CloudFormation.
- Recorder names, management accounts and the number of Systems Manager nodes are taken directly from the account.

### Estimated
- The CloudTrail split comes from one 30-minute sample and assumes Security Lake bytes follow event counts.
- The Security Hub split comes from about 1,350 findings, because the query was throttled.
- The source of Config's 2,431 compliance results can't be determined, which is why that row is a range.

### Commands
All commands were run with read-only access using the production SSO profile.

```bash
# Billed cost by service and usage type (one month)
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-10-01,End=2026-11-01 --granularity MONTHLY \
  --metrics UnblendedCost UsageQuantity \
  --group-by Type=DIMENSION,Key=SERVICE Type=DIMENSION,Key=USAGE_TYPE

# Account alias
aws iam list-account-aliases

# Transit Gateway attachment, the VPC it serves, and what's inside that VPC
aws ec2 describe-transit-gateway-attachments --region ca-west-1
aws ec2 describe-network-interfaces --region ca-west-1 \
  --filters Name=vpc-id,Values=<vpc-id from the attachment>
aws cloudformation describe-stacks --region ca-west-1 --stack-name arts-isit-prod-services

# Config recorder and items recorded by resource type
aws configservice describe-configuration-recorders --region ca-central-1
aws cloudwatch get-metric-statistics --region ca-central-1 --namespace AWS/Config \
  --metric-name ConfigurationItemsRecorded \
  --dimensions Name=ResourceType,Value=AWS::SSM::AssociationCompliance \
  --start-time 2026-10-01T00:00:00Z --end-time 2026-11-01T00:00:00Z \
  --period 2678400 --statistics Sum

# Security Hub and GuardDuty administrators
aws securityhub get-administrator-account --region ca-central-1
aws guardduty get-administrator-account --region ca-central-1 --detector-id <detector-id>

# Systems Manager hybrid servers
aws ssm describe-instance-information --region ca-central-1 \
  --query 'InstanceInformationList[].[ResourceType,PingStatus]'

# CloudTrail sample (30 minutes)
aws cloudtrail lookup-events --region ca-central-1 \
  --start-time 2026-11-02T18:00:00Z --end-time 2026-11-02T18:30:00Z

# API Gateway tracing setting
aws apigateway get-stages --region ca-central-1 --rest-api-id <api-id>
```
