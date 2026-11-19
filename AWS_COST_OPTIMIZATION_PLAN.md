# AWS Cost Optimization Plan

*Draft · 19 November 2026 · Prod and dev accounts (ca-central-1) · Based on the October 2026 bills (Cost Explorer, by usage type)*

USD per month, before tax (AWS adds about 11%). Companion documents: [HOSTING_OPTIONS.md](HOSTING_OPTIONS.md) (where to host) and [AWS_BASELINE_COST_FINDINGS.md](AWS_BASELINE_COST_FINDINGS.md) (the account baseline). This plan is the implementation detail for staying on AWS (the brief's "Option 2: Trimmed AWS"), and it goes further than that option did.

---

## Summary

- **Prod cost $484 in October:** about **$380** under OCELIA's control, and **$104** of UBC account baseline.
- **Three items make up $290 of the $380:** the database, three RDS Proxies, and the private networking. All are sized far beyond today's load (at peak: 3 concurrent chats, 5.8% database CPU, 29 connections).
- **The team's decisions (section 0) unlock most of the savings.** Phase 1 brings OCELIA's prod share to **~$251** and Phase 2 to **~$146 (−62%)**. Chat response times don't change.
- **Every change is proven in dev before it touches prod** (section 12). Prod follows once dev passes a validation gate, and the dev hibernate switch (Phase 4) is revisited after both environments are stable.
- **Dev cost another $296** with almost no use. It keeps prod's infrastructure at smaller sizes (section 9): **~$135**, or ~$126 with nightly stops.
- **Both accounts together: ~$780 → ~$385 a month.** The two idle Transit Gateway attachments ($44.64/mo each) **can't be removed** (confirmed 19 November 2026), so they stay in the baseline.

| Prod | OCELIA share | Baseline | Total | Incl. tax | Work |
|---|---|---|---|---|---|
| Today (Oct 2026) | $380 | $104 | **$484** | $537 | – |
| After Phase 1 (proxies, single-AZ, alarms) | ~$251 | $104 | **~$356** | ~$395 | After the dev gate; low risk |
| After Phase 2 (rebuild DB, NAT, endpoints) | ~$146 | $104 | **~$250** | ~$277 | 2–3 weeks incl. dev rehearsal |
| + Phase 3 options (caching, no proxy, RI) | ~$104–138 | $104 | ~$208–242 | ~$231–269 | Conditional |
| + UBC AI Gateway (hosting brief) | ~$80–114 (−$24 on AI) | $104 | ~$184–218 | ~$204–242 | 2–3 weeks |

| Dev | OCELIA share | Baseline | Total |
|---|---|---|---|
| Today (Oct 2026) | $228 | $68 | **$296** |
| After the same phases, at dev sizes | ~$67 | $68 | **~$135** |
| + D4 nightly stop | ~$58 (~$41 if the proxy stops billing too) | $68 | ~$126 (~$109) |
| *Later:* Phase 4 hibernate switch instead of D4 (dev on ~40 h/mo) | ~$9 | $68 | ~$77 |

---

## 0. Decisions made (19 November 2026)

| Decision | Effect on the plan |
|---|---|
| **Prod can run single-AZ.** The team accepts longer recovery from a database host or AZ failure | Multi-AZ comes off in Phase 1 (P1.2): an online change that saves ~$72/mo on the current instance |
| **The database may be dropped and recreated to resize it** | Storage can shrink from 100 GB to 20 GB, which RDS can't do in place. The class change goes into the same rebuild (P2.1). The data is still copied across; losing data isn't part of the plan |
| **Dev keeps prod's infrastructure, at a smaller scale** | No dev-only removals: WAF, monitoring and the proxy stay. Only sizes differ, set in one sizing profile (section 9) |
| **Rebuild on PostgreSQL 17** | P2.1 targets 17 (standard support to Feb 2030) with Extended Support disabled. Next major upgrade in early 2029 |
| **NAT instance in both accounts** | P2.2 goes ahead (`t4g.micro` prod, `t4g.nano` dev). The patching and minutes-long recovery are accepted; P2.3 follows |
| **Critical-tier alarms only, in both accounts** | P1.3 drops all 43 warning-tier alarms. Critical alarms and the `SystemHealthCritical` composite stay |
| **Trim the dashboard to ≤50 metrics; keep D4 (nightly dev stops)** | Both stay in the plan |
| **Drop P1.5 (secret caching) and P1.6 (API Gateway X-Ray)** | Both moved to section 11 |
| **Dev first, then prod; tested manually** | Every Phase 1 and Phase 2 change runs in dev first. Prod follows only after dev passes the validation gate (section 12). Testing is manual, using the checklist in section 15 (tester UI flows plus engineer CLI checks) |
| **The idle Transit Gateway attachments stay** (prod and dev, $44.64/mo each) | Confirmed 19 November 2026 that they can't be removed. Track B items B1 and B3 are closed, and the totals no longer count them |
| **Include fixes F1–F3** (Amplify branches in CDK, alarm email subscriptions, API Gateway execution logging) | Related fixes in section 5, rolled out dev first with Stage A step 1 and Stage B step 1 |
| **Hibernate switch later** | Phase 4 (section 8) is revisited after both environments are stable. P2.1 keeps the option cheap (fixed instance identifier, standalone admin secret) |

---

## 1. Performance guardrails

**Goal:** the lowest bill that keeps today's user-facing performance and room for growth ([scaling-chat-capacity.md](docs/guides/scaling-chat-capacity.md)). Record these in Phase 0 and check them again after every change:

| Measure | Baseline (prod, 30 days to 2026-11-19) | Regression threshold |
|---|---|---|
| `chatbotV2Function` duration | p50 8.6 s · p90 12.7 s · p99 17.7 s (1,938 calls, 0 errors) | p90 more than 10% higher |
| `ragRetrievalFunction` duration and errors | p50 0.77 s · p90 2.05 s · p99 6.65 s (1,937 calls, 0 errors) | p90 more than 10% higher, or any errors |
| `studentFunction` duration | p50 21 ms · p90 663 ms · p99 898 ms (13,066 calls, 0 errors) | p90 more than 10% higher |
| API Gateway `Latency` and `5XXError` | p50 31 ms · p90 1.24 s · p99 12.0 s; 11 server errors (5xx) in 31,507 requests | any sustained increase |
| RDS `CPUUtilization`, `ReadLatency`, `WriteLatency` | CPU ~6% average; ReadLatency 0 (all reads from cache); WriteLatency p99 0.05 s | CPU above 40% at today's load; ReadLatency rising above ~0 (the working set no longer fits) |
| Document ingestion (Lambda) | Ingestion p50 3.5 s · p90 14.0 s; enrichment p50 16.9 s · p90 75.7 s (55 uploads, 0 errors) | more than 10% higher; plus the timed upload in checklist row 10 |
| Answer quality | `track-a` set (`.kiro/specs/chatbot-latency-optimization/`) | only for prompt changes (P3.1) |

**Availability is separate from performance.** Single-AZ (accepted) and the NAT instance (P2.2) don't change latency, but they lengthen recovery from rare failures.

---

## 2. Where the money goes (prod, October 2026)

From Cost Explorer, grouped by usage type (pulled 19 November 2026). Dev is in section 9.

| Billed line | Oct | Usage types | Controllable |
|---|---|---|---|
| **RDS** | **$215.86** | `Multi-AZUsage:db.t3.medium` 744 h, $119.04 ($0.16/h) · **`RDS:ProxyUsage` 4,464 vCPU-h, $71.42** (3 proxies × 2 vCPU × 744 h at $0.016) · `Multi-AZ-GP3-Storage` 100 GB, $25.40 · no billed backup storage | Yes |
| **VPC** | $81.10 | `TransitGateway-Hours` (ca-west-1, idle) $44.64 · `VpcEndpoint-Hours` 2,976 h (2 endpoints × 2 AZs), $32.74 · `PublicIPv4:InUseAddress` (NAT), $3.72 | Partly |
| **EC2 – Other** | $38.40 | `NatGateway-Hours` $37.20 · NAT data processing **under $0.05** · `EBS:SnapshotUsage` 21 GB, $1.17 (ended; see below) | Yes |
| **Bedrock** | $58.20 | Sonnet 4.5: input 10.49M tokens $34.62 ($3.30/M), output 0.70M $11.57 · Haiku 4.5: input 3.70M $4.07, output 0.97M $5.35 · Guardrails (topic + content, 8,397 text units each) $2.52 · Titan embeddings $0.07 | Yes (prompt structure, provider) |
| Config, Security Hub, Security Lake, GuardDuty, Systems Manager | $59.72 | UBC account baseline (mostly not OCELIA's) | No |
| **CloudWatch** | $14.62 | **86 alarms, $8.57** · 2 composite alarms, $1.00 · 1 dashboard beyond the 3 free, $3.00 · vended logs (flow logs, RDS) 1.77 GB, $0.97 · log storage $0.61 · other ~$0.47 · API Gateway detailed metrics under $0.05 | Partly |
| WAF | $8.03 | Web ACL $5 + 3 rules $3 + requests | Keep |
| Secrets Manager | $4.85 | **9 secrets**, $3.60 · 250k API calls, $1.25 (91% by RDS Proxy; see P3.2) | Yes |
| Everything else | $3.16 | Lambda $0.64, EventBridge $0.94, X-Ray $0.41, AppSync, SQS, API Gateway, ECR, Amplify, S3, DynamoDB, KMS | Negligible |
| **Total** | **$483.97** | Plus $53.65 tax ($6.66 of it Marketplace tax on the Claude models) | |

**What this shows:**
- **The three RDS Proxies ($71) cost more than half as much as the Multi-AZ instance.** RDS Proxy bills a 2-vCPU minimum per proxy whatever the load, and one proxy can serve all three database users.
- **Multi-AZ doubles both the instance and the storage charge.** The 100 GB volume holds about 6 GB, most of it fixed overhead (P2.1).
- **Networking costs $74 and processes almost no data.** The charge is entirely hourly.
- **CloudWatch is mostly alarms and one paid dashboard**, not logs or metrics.
- **Compute is essentially free:** Lambda, API Gateway and AppSync together cost about $1.
- **Sonnet input tokens ($34.62) are the largest AI cost.**
- **EBS snapshots need no action.** The $1.17 was the tail of a decline (68 GB-months in August, 30 in September, 21 in October) that ended on 7 November. Prod has no snapshots, EC2 instances or temporary security groups left.

---

## 3. Plan at a glance

| ID | Change | Saves / mo | Effect on performance | Effort | Risk |
|---|---|---|---|---|---|
| **Phase 1: no performance impact** | | **Prod** | | | |
| P1.1 | Replace the 3 RDS Proxies with **one standalone proxy** | **~$48** | None | 1 day | Low (two-step deploy) |
| P1.2 | Prod Multi-AZ → single-AZ *(decided)* | **~$72** | None (availability accepted) | 1 h, online | Low |
| P1.3 | Drop all warning-tier alarms *(decided)*; trim the dashboard to ≤50 metrics (both accounts) | **~$7.30** | None | ½ day | Problems surface only at the critical threshold (accepted) |
| P1.4 | AWS Budgets + Cost Anomaly Detection | $0 (guardrail) | None | 1 h | None |
| **Related fixes (section 5; no cost impact)** | | | | | |
| F1 | Bring the Amplify branch setup into CDK (dev builds `dev`, prod builds `main`) | – | None | ½ day | Low (import first; fallback documented) |
| F2 | Restore alarm email subscriptions (dev done and confirmed; prod in Stage B) | – | None | 15 min | None |
| F3 | API Gateway execution-error logging: one `/*/*` setting, log group with retention | Pennies | None | ½ day | Low; fixes Security Hub APIGateway.1 |
| **Phase 2: right-size the database and network** | | | | | |
| P2.1 | **Rebuild the database:** `db.t4g.small`, 20 GB gp3, PostgreSQL 17, Extended Support disabled (dev first, as a rehearsal) | **~$43** (~$16 if `t4g.medium`) | Neutral, if the memory gate passes | 3–4 days incl. rehearsal | Medium |
| P2.2 | NAT Gateway → NAT instance | **~$30** | Negligible | 1–2 days | Medium |
| P2.3 | Remove the Secrets Manager and Bedrock interface endpoints | **~$33** | Negligible | ½ day | Low (after P2.2) |
| **Phase 3: conditional** | | | | | |
| P3.1 | Restructure prompts for Bedrock prompt caching | ~$8–12 now, grows with use | **Better** (faster first token) | 1–2 weeks | Answer quality (eval-gated) |
| P3.2 | Remove RDS Proxy entirely (both environments) | ~$27 each, incl. polling costs | Neutral now, less headroom at scale | 2–3 days | Medium |
| P3.3 | 1-year RDS Reserved Instance | ~$8 | None | 1 h | Commitment |
| P3.4 | UBC AI Gateway (hosting brief) | ~$24 | To be tested | 2–3 weeks | Approval |
| **Dev (section 9): prod's infrastructure, smaller sizes** | | **Dev** | | | |
| D1 | Turn off dev's Multi-AZ (confirmed drift; fix with the CLI) | ~$28 | None | 15 min | Low |
| D2 | Dev sizing profile: `t4g.micro` DB, `t4g.nano` NAT | ~$5 beyond the shared changes | None for dev's use | ½ day | Low |
| D3 | Remove the leftover `temp-pg-dump-sg` rule and group | $0 (security) | None | 15 min | Low |
| D4 | Stop the dev DB outside working hours *(decided; after the dev gate, until Phase 4)* | ~$9, or ~$26 if the proxy stops billing too | DB takes ~5–10 min to start | ½ day | Friction (accepted) |
| **Phase 4 (later, section 8): dev hibernate switch** | | **Dev** | | | |
| P4.1 | One command removes dev's hourly resources (DB via snapshot, proxy, NAT, WAF, alarms) and restores them on demand | ~$45–58 more than the current plan | None when on; dev unavailable when off | ~3–5 days | Medium; revisit after Stage B |
| **Track B: account level (Arts ISIT / UBC Hybrid Cloud)** | | | | | |
| B2 | Agree how the account baseline is split (section 10) | Billing only | None | Not ours | – |

---

## 4. Phase 0: Measure first (½ day, read-only)

These numbers decide P2.1 and P1.3, and they become the "before" figures for the guardrails.

**Done on 19 November 2026:**
- steps 1, 3 and 4 in both accounts
- step 2 in prod
- drift detection on both `AILA-DatabaseStack`s
- the EBS snapshot check
- the engine version and lifecycle check
- the database size part of step 5 (from `FreeStorageSpace`)
- the existing proxy settings: all three have `RequireTLS: true`, a 1,800 s idle client timeout, and debug logging off. Copy these to the new proxy

**Stage A prep, done 19 November 2026:**
- the prod guardrail baselines (section 1)
- `npm test` (42 suites, 409 tests pass)
- `cdk diff` against dev (0 differences across 7 stacks)
- drift detection on every dev stack
- dev test accounts confirmed (5 students, 5 instructors, 2 admins)

Known pre-existing dev drift, which is the reference for the gate:
- **API Gateway stage:** a template quirk, the same in prod. Two `*/*` method settings are merged, so throttling is active, but `loggingLevel: ERROR` and `metricsEnabled` aren't applied.
- **Observability:** no email subscription on the critical alarm topic, in **both** accounts. The subscription in the template was never confirmed and has expired. Dev was re-subscribed and confirmed on 19 Nov 2026; prod is still unsubscribed. Dev's dashboard tags are also missing.
- **Amplify:** dev already builds from a `dev` branch, and `ocelia-dev.arts.ubc.ca` points at it, but both were set up by hand outside CDK. The CDK-defined `main` branch in dev has auto-build off. The repository URL differs only in letter case; the custom headers are a formatting false positive.
- **Database:** see section 9.
- **Retrieval embedding-cache warning (pre-existing, both accounts):** every retrieval query logs `EmbeddingCache put failed … AccessDeniedException`. The retrieval role is deliberately read-only on the embedding cache ([multimodal-rag-stack.ts:347](cdk/lib/multimodal-rag-stack.ts#L347)), but the code still attempts `PutItem`. Prod logged it 1,934 times in 30 days. It's harmless (a WARNING; retrieval continues), and it isn't a plan regression. Follow-up: make retrieval use the cache read-only.
- **Leftover S3 buckets (follow-up, not part of this plan):** dev keeps **24 orphaned `aila-apigatewaystack-*` buckets** (8 sets of chat-log, ingestion and embedding buckets) and **6 from an older `aila2` prefix**. They're left over from earlier deployments under the buckets' RETAIN policy. The cost is negligible (all of dev's S3 is $0.07/mo), but **they may hold old chat logs and course documents**, so review them for data retention, and check prod for the same.

**Still to do, before the first change:**
- the baseline checklist run (step 0). The tester (Vincent) and the test course (dev's existing one) are settled
- *(optional)* a manual dev database snapshot. The permission check blocked me from creating it, so it needs running by hand or a permission rule

**Still to do, before Phase 2:**
- drift detection on `AILA-VpcStack`
- the subnet placement check for P2.3
- step 5's SQL (index size, roles and ownership). This needs the SSM tunnel from [data_export.md](docs/guides/data_export.md), or can be run at the start of the dev rehearsal and the prod dump

```bash
# 1. Usage-type breakdown (done; rerun monthly to track progress)
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-10-01,End=2026-11-01 --granularity MONTHLY \
  --metrics UnblendedCost UsageQuantity \
  --group-by Type=DIMENSION,Key=SERVICE Type=DIMENSION,Key=USAGE_TYPE

# 2. Memory headroom (30 days, 1 h periods): minimum FreeableMemory is the key number.
#    Same for CPUUtilization (Max), DatabaseConnections (Max), ReadIOPS, SwapUsage
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name FreeableMemory \
  --dimensions Name=DBInstanceIdentifier,Value=<prod db id> \
  --start-time <30 days ago> --end-time <now> --period 3600 --statistics Minimum

# 3. Secrets Manager callers (done) and the billed secrets
aws secretsmanager list-secrets --query 'SecretList[].[Name,LastAccessedDate]' --output table

# 4. Alarms and dashboards, grouped by name prefix
aws cloudwatch describe-alarms --query 'MetricAlarms[].AlarmName' --output text | tr '\t' '\n' \
  | sed -E 's/-[^-]+$//' | sort | uniq -c | sort -rn
aws cloudwatch list-dashboards --query 'DashboardEntries[].DashboardName'

# Drift on the VPC stack, which Phase 2 changes
aws cloudformation detect-stack-drift --stack-name AILA-VpcStack
```

```sql
-- 5. Data size, vector working set, and roles and ownership (as the master user)
SELECT pg_size_pretty(pg_database_size('aila'));
SELECT rolname FROM pg_roles WHERE rolname !~ '^(pg_|rds)';              -- includes pre-ADR-017 random users?
SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public';    -- who owns the app tables
SELECT count(*) FROM retrieval_units;
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class
 WHERE relname IN ('retrieval_units') OR relname LIKE '%retrieval_units%idx%' OR relname LIKE '%hnsw%';
SHOW shared_buffers; SHOW max_connections;
SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 2) AS cache_hit_pct
  FROM pg_stat_database WHERE datname = 'aila';
```

---

## 5. Phase 1: No performance impact (~2 weeks)

*IDs P1.5 and P1.6 were dropped (section 11).*

### P1.1 One standalone RDS Proxy instead of three (~$48/mo)

**Today**, [database-stack.ts](cdk/lib/database-stack.ts) creates one proxy per database user with `this.dbInstance.addProxy(...)`:

| Proxy | Secret | Used by |
|---|---|---|
| `rdsProxyEndpoint` | app user | student, instructor, chat, RAG, SQS trigger and most other functions |
| `rdsProxyEndpointTableCreator` | table creator | `adminFunction`, `addStudentOnSignUp`, `adjustUserRoles` |
| `rdsProxyEndpointAdmin` | master | `generatePreSignedURL`, `orphanCleanupFunc` |

**Change:** one proxy can hold several secrets. Each client authenticates as its own user, and the proxy picks the matching secret. Create one proxy **as a standalone construct** and point every function at it:

```ts
new rds.DatabaseProxy(this, `${id}-sharedProxy`, {
  proxyTarget: rds.ProxyTarget.fromInstance(this.dbInstance),
  secrets: [userSecret, tableCreatorSecret, adminSecret], ...
})
```

The functions already read their own credentials, so no Lambda code changes.

**Why standalone:** `addProxy` makes proxies children of the instance construct. Replacing the instance then replaces the proxies and changes the endpoints other stacks import, which is what broke the 2025 storage shrink (CO-7). A standalone proxy keeps its endpoint through P2.1, because only its target changes, and that's an in-place update.

**Deploy in two steps.** Removing an export that another stack still imports fails the deploy (the cause of prod's `UPDATE_ROLLBACK_COMPLETE` in September):
1. Add the new proxy, repoint all consumers in ApiGatewayStack and MultimodalRagStack, and keep the old proxies and their exports alive with `this.exportValue(...)`. Deploy, then check every database function.
2. Remove the old proxies and the pinned exports. Deploy.

**Performance:** none; proxies scale with load, and pooling and TLS behave the same. Keep `maxConnectionsPercent` at 100%.
**Secrets Manager calls:** probably unchanged, because one proxy still polls three secrets (P3.2).
**Rollback:** revert and deploy.

**Security follow-up:** `generatePreSignedURL` and `orphanCleanupFunc` connect as the **master** user. Moving them to the table-creator or app user also removes a third of the proxy's secret polling (P3.2).

### P1.2 Prod Multi-AZ → single-AZ (~$72/mo) · decided

Set `multiAz: false` for prod. CloudFormation modifies the instance in place with **no downtime**, halving the instance ($119.04 → ~$59.52) and storage ($25.40 → $12.70) charges. It's done now rather than in the rebuild so the saving starts immediately. The rebuilt instance is single-AZ too.

**Speed:** unchanged; writes get slightly faster without synchronous replication, and the standby never served reads.

**Accepted effect on availability:**

| Event | Multi-AZ (before) | Single-AZ |
|---|---|---|
| Patching or minor version upgrade | ~1–2 min failover | ~5–10 min of downtime, in the maintenance window |
| Host failure | ~1–2 min automatic failover | Automatic recovery, typically minutes, sometimes longer |
| Whole-AZ outage (rare) | ~1–2 min | Point-in-time restore to another AZ: ~30–60 min, up to ~5 min of data loss |

**With it:**
- Set `preferredMaintenanceWindow` explicitly in CDK to prod's current `sat:09:38-sat:10:08` UTC (1:38 a.m. Saturday in Vancouver). It's already low-traffic, but RDS assigned it at random, so the rebuild could otherwise move it.
- Record Security Hub control RDS.5 as accepted.
- Multi-AZ can be switched back on online at any time, for example for an exam period.

### P1.3 Critical-tier alarms only; trim the dashboard (~$7.30/mo prod, similar in dev) · decided

CloudWatch is mostly alarms ($8.57 for 86, plus $1.00 for 2 composites) and one billed dashboard ($3.00). Logs (~$1.60) and API Gateway detailed metrics (under $0.05) aren't worth changing.

- **Alarms:** the 86 are all OCELIA's: **43 warning/critical pairs**, one pair per metric (each function's error rate, API Gateway 5xx, RDS CPU and storage, DLQ depth and so on).
  - **Drop the whole warning tier** in [observability-stack.ts](cdk/lib/observability-stack.ts), in both accounts: 43 × $0.10 = ~$4.30.
  - Keep every critical alarm, the email pages and the `SystemHealthCritical` composite.
  - **Trade-off (accepted):** a degrading metric is noticed only once it crosses the critical threshold.
  - First check that the composite rule references only critical alarms. Its rule is about 5.4k of the 10,240-character limit and counts the RAG critical alarms. If it references any warning alarm, the synth fails or the rule breaks.
- **Dashboard:** `AILA-prod-Dashboard` (7 widgets) is the only one. It's billed because the free tier covers 3 dashboards of **up to 50 metrics each**, and it exceeds 50. Trim it to 50 metrics or fewer ($3). Dev's copy gets the same treatment.

### P1.4 Budgets and anomaly alerts (free)

In both accounts, set an AWS Budget at the target total with 80% and 100% alerts, plus Cost Anomaly Detection per service. Regressions such as a runaway ingestion loop or a quota-sized Bedrock spike then show up immediately, not on the next bill.

**Secrets inventory (prod, Phase 0 step 3): nothing to delete.** Of the 9 billed secrets:
- 5 are OCELIA's CDK secrets.
- `github-personal-access-token` is OCELIA's too: [amplify-stack.ts](cdk/lib/amplify-stack.ts) uses it for Amplify builds.
- `/CrowdStrike/…` is UBC security tooling.
- `wok/wok-api/*` (2) belong to another workload, last accessed in August 2025. Mention them to Arts ISIT; they aren't OCELIA's to delete.

### Related fixes found during prep (no cost impact)

These came out of the Stage A prep. They follow the same dev-first rollout (section 12) and are included by decision (section 0).

#### F1 Bring the Amplify branch setup into CDK

**Today:** the live setup already matches the intended git flow, but **it was configured by hand**:
- dev's Amplify app builds the `dev` git branch (auto-build on), and `ocelia-dev.arts.ubc.ca` points at it
- prod builds `main`, and `ocelia.arts.ubc.ca` points at `main`

[amplify-stack.ts](cdk/lib/amplify-stack.ts) defines only `addBranch("main")` in both environments. In dev that branch's auto-build was turned off by hand (it shows as drift), and [domains.ts](cdk/lib/constants/domains.ts) still names `main.<appId>` as dev's redirect source. A fresh environment, or an Amplify stack change, wouldn't reproduce the real setup.

**Change:**
1. **Pick the branch per environment:** `dev` for dev, `main` for prod. Prod's template stays identical (check with `cdk diff`).
2. **Bring dev's hand-made `dev` branch under CDK** with `--import-existing-resources`, as was done for the conversation table. First confirm with a read-only `cdk diff --import-existing-resources` that it shows `[←] import` for the branch. **If Amplify branches can't be imported,** leave that branch unmanaged and do only steps 3–4. Don't delete and recreate it: the custom domain is mapped to it.
3. **Remove the unused `main` branch from dev's app.** It serves nothing, because the domain points at `dev`.
4. **Point dev's redirect source** (`AMPLIFY_DEFAULT_ORIGIN.dev`) at `https://dev.dbqfar7gbtstn.amplifyapp.com`. In [cors.ts](cdk/lib/constants/cors.ts), drop the now-duplicate `dev.` literal and the `main.` origin. Update [s3-cors.test.ts](cdk/test/s3-cors.test.ts) lines 84–85 to match.
5. **Out of scope:** the custom-domain associations stay outside CDK (follow-up). Bringing them in risks the live domains for no gain.

#### F2 Restore alarm email subscriptions

**Today:** neither account's critical SNS topic has a subscription, so **no critical alarm has emailed anyone, in prod or dev.** [observability-stack.ts:71](cdk/lib/observability-stack.ts#L71) subscribes `vincent.lam@ubc.ca`, but the confirmation was never clicked and SNS deleted the pending subscription. CloudFormation still believes it exists.

**Change:**
1. **Re-subscribe with `aws sns subscribe`** and **click the confirmation email.**
   - Dev: done and **confirmed** on 19 Nov 2026.
   - Prod: Stage B step 1.
2. **Re-check after any change that replaces the topic.** CloudFormation doesn't notice when a subscription disappears.

This matters more after P1.3, when the critical tier is the only alarm level left.

#### F3 Turn on API Gateway execution-error logging

**Today:** [api-gateway-stack.ts:340-351](cdk/lib/api-gateway-stack.ts#L340-L351) sets the stage options (`loggingLevel: ERROR`, `metricsEnabled: true`) and a separate `/*/*` throttling entry. CDK emits **two method settings for the same `*/*` path**, and API Gateway keeps one: the throttling entry, which has no logging.

Live, in both accounts:
- throttling works (100/s, burst 200)
- **execution logging is off**
- detailed metrics are off
- **no execution log group has ever been created**
- **Security Hub APIGateway.1 is FAILED** on the stage

Prerequisites are in place: the account-level API Gateway CloudWatch role exists in both accounts.

**What's missing without it:** a record of failures *inside* API Gateway, which Lambda logs can't show:
- authorizer errors
- 502s from Lambda crashes or malformed responses
- 504s at the 29-second integration limit
- throttling and mapping errors

Prod's 11 5xx errors in the last 30 days have no recorded cause. The 26 October incident (chat errors from an idle, Inactive Lambda) had to be reconstructed from CloudTrail.

**Change:**
1. **Merge into a single `/*/*` method setting:** throttling plus `loggingLevel: ERROR`, with **`metricsEnabled: false` explicitly**. Detailed per-method metrics have been off all along, they'd add paid custom metrics, and the alarms use the free API-level metrics.
2. **Create the log group `API-Gateway-Execution-Logs_<apiId>/prod` in CDK**, with the same retention as the Lambda logs: 3 months in prod, 1 month in dev. Otherwise API Gateway creates it on first write with no expiry.
3. **Expected results:**
   - **Cost:** pennies, because only failed requests are logged.
   - **Security Hub:** APIGateway.1 should pass.
   - **Drift:** the API Gateway stage drift goes away.

**Not proposed:** access logs (one line per request), a separate feature that's also off.

---

## 6. Phase 2: Right-size the database and network (2–3 weeks)

**When:** rehearse every change in dev first. Do prod in the winter break, the lowest-traffic window of the year, and avoid the December exam period.

### P2.1 Rebuild the database at the right size (~$43/mo prod)

RDS can't shrink allocated storage in place, so the rebuild **replaces the instance and copies the data across**, changing the class, storage and engine in one event.

| Target | Prod | Dev |
|---|---|---|
| Class | **`db.t4g.small`** (2 vCPU, 2 GB) if the memory gate passes, otherwise `db.t4g.medium` | `db.t4g.micro` (2 vCPU, 1 GB) |
| Storage | 20 GB gp3 (the minimum; 3,000 IOPS at any size), `maxAllocatedStorage: 50` | 20 GB gp3, `maxAllocatedStorage: 30` |
| Multi-AZ | Off | Off |
| Engine | **PostgreSQL 17**, `engineLifecycleSupport: OPEN_SOURCE_RDS_EXTENDED_SUPPORT_DISABLED` (see below) | Same |
| Unchanged | Parameter settings (`rds.force_ssl=1`), encryption, backups (7 days), deletion protection | Backups 1 day |
| Instance + storage cost | ~$29 (from ~$72 after P1.2) | ~$16 (from ~$28 after D1) |

#### Gates

**Size: passed.** `FreeStorageSpace` (14 days) shows ~5.9 GB used in prod and ~5.7 GB in dev. The 100 GiB volume is ~107.4 GB, with 101.5 and 101.7 GB free. Most of it isn't course data:

| Part | Prod | Dev | Source |
|---|---|---|---|
| WAL | **2.33 GB** | **2.33 GB** | `TransactionLogsDiskUsage`. Fixed by RDS defaults: `wal_keep_size` = 2 GB, and `archive_timeout` = 300 s writes a 16 MB WAL file every 5 minutes even when the database is idle |
| Log files | under 1 MB | under 1 MB | `describe-db-log-files` (73 files, 3-day retention) |
| Replication slots | 0 | 0 | `ReplicationSlotDiskUsage` |
| Everything else | ~3.5 GB | ~3.3 GB | Course data, system databases, and filesystem overhead (which grows with volume size). Not measurable without SQL |

- **Prod uses only ~0.2 GB more than dev**, which caps how much more data it holds.
- App data is likely a few hundred MB: each chunk is a 1024-dimension embedding (4 KB) plus text and its share of the HNSW index, ~10 KB in all. Confirm with step 5's SQL.
- On 20 GiB (~21.5 GB), prod would be at most ~27% full, and more likely 3–4 GB, because filesystem overhead shrinks with the volume. That's far from the 10%-free point where autoscaling grows the volume (it can never shrink again).
- Leave `wal_keep_size` alone: shrinking it saves nothing on the bill, and it protects recovery.

**Memory (prod).** Prod over 30 days:

| Metric | Value |
|---|---|
| Minimum `FreeableMemory` (of 4 GB) | 2.14 GB |
| Maximum `SwapUsage` | 0.02 GB |
| Maximum `ReadIOPS` | 3.8 |
| Maximum CPU | 5.7% |
| Maximum connections | 18 |

- **The earlier rule of thumb ("more than ~2.5 GB free") isn't met, but it measured the wrong thing.** About 1 GB of the used memory is `shared_buffers`, which RDS sizes at ~25% of instance RAM, so it shrinks with the instance; it isn't a fixed working set.
- **The real signals point to a small working set.** Peak read IOPS of 3.8 means reads are served from cache, swap is nil, and the data is a few hundred MB.
- **Decision rule:** choose **`t4g.small`** unless step 5 shows `retrieval_units` plus its indexes above ~700 MB.
- **After the cutover, watch** `ReadIOPS`, `ReadLatency`, `SwapUsage` and the retrieval p90 for a week.
- **Fallback:** if they rise, change the class to `t4g.medium` in place. That takes ~5–10 min of downtime on single-AZ, and it's reversible.
- **Limit of the dev test:** dev holds dev's data, not prod's, so the pgbench test there checks the class and engine, not prod's data volume. Copying prod's student data into dev isn't proposed (privacy).

Graviton matches or beats t3 per vCPU.

**Load test:** rebuild dev at `t4g.small` first and run phase B (pgbench) from the [scaling guide](docs/guides/scaling-chat-capacity.md) at today's load and at 10×. Pass if query p95 is within 10% of the baseline and the cache hit ratio stays above 99%. Then change dev to `t4g.micro` in place. `max_connections` drops from ~400 to ~190, which one proxy handles easily at 29 connections.

#### Engine version and Extended Support

| Checked 19 November 2026 | Prod | Dev |
|---|---|---|
| Running version | 16.13 | 16.13 |
| Extended Support | **enrolled** (`open-source-rds-extended-support`, RDS's default when CDK doesn't set it) | disabled (set outside CDK) |
| CDK pin | `VER_16_10`, **no longer offered in ca-central-1** (the oldest is 16.11) | Same |

- **The pin breaks the rebuild as written:** creating an instance at 16.10 fails. Running instances aren't affected, because `autoMinorVersionUpgrade` took them to 16.13.
- **Standard support on RDS** (from `describe-db-major-engine-versions`):
  - PostgreSQL 16: ends **28 Feb 2029** (Extended Support to 29 Feb 2032)
  - 17: ends 28 Feb 2030 (to 2033)
  - 18: ends 28 Feb 2031 (to 2034)
- **Cost if nothing changes:** Extended Support bills per vCPU-hour. AWS's PostgreSQL example (US East, Ohio) is $0.100 in years 1–2 and $0.200 in year 3. For 2 vCPUs that's **~$150–160/mo, then $300+**, more than OCELIA's whole planned prod bill. The ca-central-1 rate is likely slightly higher; confirm it in the pricing calculator.
- **"Disabled" is a safety net, not a plan.** RDS then upgrades the major version automatically at the end of standard support, and refuses to create new instances on the old version. If the upgrade's pre-checks fail, the instance stays put and **is** charged until it's upgraded manually.

**Decision (19 November 2026):**
1. **Rebuild on PostgreSQL 17.** The latest offered is 17.11; CDK has `VER_17_9`, or use `PostgresEngineVersion.of('17.11', '17')`.
   - `pg_dump`/`pg_restore` is the standard major-version path, so the only added risk is application compatibility, which the dev rehearsal tests.
   - It moves the deadline to February 2030 at no extra project cost.
   - RDS Proxy has supported RDS for PostgreSQL 17 since November 2024.
   - PostgreSQL 18 (supported to February 2031) was set aside because RDS Proxy support for RDS PostgreSQL 18 isn't documented (only Aurora PostgreSQL 18.3+). Staying on 16 would have needed a separate upgrade before February 2029.
2. **What changes with a new major version:**
   - a `postgres17` parameter group, keeping `rds.force_ssl=1`
   - `ALTER EXTENSION vector UPDATE` after the restore, if needed
   - the HNSW index check (already in the procedure)

   `psycopg2` 2.9.11 and `postgres.js` 3.4.9 work with newer servers.
3. **Set `engineLifecycleSupport` disabled** in the sizing profile for both environments. That puts dev's setting into code and ends prod's silent enrollment.
4. **Calendar the next major upgrade** about a year before support ends (early 2029 for 17), using this procedure or Blue/Green.

#### What has to move

| Reference | Used by | Handling |
|---|---|---|
| Proxy endpoint | ApiGatewayStack, MultimodalRagStack | **Unchanged** (standalone proxy from P1.1); only its target changes |
| `instanceIdentifier` | ObservabilityStack (`rdsInstanceId`, RDS alarms) | Repoint; pin the old export with `exportValue` until the old instance is gone |
| `instanceResourceId` | MultimodalRagStack (5 IAM statements), proxy role | Repoint the same way. IAM database auth is off on the live instances, so check whether these `rds-db:connect` grants are used at all, and remove them if not |
| Admin credentials secret | ApiGatewayStack, DBFlowStack (by name) | The current name (`<stack>-AILA/credentials/rdsDbCredential`) belongs to the old instance's construct. Give the new one a new name (for example, a `-v2` suffix) and make it a **standalone** `rds.DatabaseSecret` (keeps Phase 4 open); `secretPathAdminName` follows. It's a plain string, not an export. **Its `host` field is the instance endpoint**, and the DB initializer connects straight to it, not through the proxy ([initializer.py](cdk/lambda/initializer/initializer.py) line 67) |
| App and table-creator secrets | Everyone | Unchanged (stack-level) |
| Instance endpoint | [data_export.md](docs/guides/data_export.md) (SSM tunnel target; the guide hard-codes both endpoints) | Update the guide after the rebuild |

#### Procedure (dev first, then prod)

1. **Deploy A:** add the new instance next to the old one (new construct ID, a **fixed instance identifier**, target sizes and engine, new standalone admin secret). The app keeps using the old database.
   - **Don't repoint DBFlowStack yet.** The initializer's CDK Trigger reruns whenever its function changes, and a new admin secret name is such a change. Run then, it would create the schema on the empty new instance before the restore. Repoint it in Deploy B, where rerunning against the restored database is harmless (it's idempotent, ADR-017) and a useful check.
2. **Freeze writes** (prod: an announced window of ~30–60 min).
   - Set reserved concurrency to 0 on the database functions, or throttle the API stage to 0.
   - Disable the ingestion and enrichment event sources.
3. **Copy the data** from a temporary EC2 instance or a CloudShell VPC environment ([data_export.md](docs/guides/data_export.md)):
   - Use a **PostgreSQL 17 (or newer) client.** `pg_dump` must be at least the target's major version.
   - **Copy the roles first:** `pg_dumpall --roles-only --no-role-passwords` from the old instance, applied to the new one. Then set the app and table-creator passwords from their existing secrets, using the same idempotent `CREATE USER … / ALTER USER` logic as the initializer (ADR-017). This matters because before ADR-017 the initializer created a new random user on every run, so prod may have leftover roles that own objects or hold grants. `pg_restore` fails on owners that don't exist. Check with step 5's role and owner queries.
   - Run `pg_dump -Fc`, then `pg_restore` as the master user so ownership and grants carry over. The dump includes `CREATE EXTENSION vector`, and the `readwrite` role's default privileges.
   - Run `ANALYZE`.
   - Compare row counts for every table, and check the HNSW index.
4. **Deploy B (cutover):**
   - Point the proxy at the new instance and swap the admin secret in its auth list.
   - Repoint `rdsInstanceId`, `instanceResourceId` and `secretPathAdminName` (ApiGatewayStack and DBFlowStack), keeping the old exports pinned. The initializer reruns here against the restored data.
   - Unfreeze, then smoke-test: sign in, a chat that uses course material, and an upload.
5. **Deploy C:** remove the old instance and the pinned exports. In prod, turn off its deletion protection first. CDK's default removal policy takes a final snapshot; keep it for about 30 days.
6. **Clean up** the temporary EC2 instance and security group. A previous `pg_dump` run left one behind in dev (D3).

**Downtime:** the freeze window only; a few GB dumps and restores in minutes.
**Rollback:** until Deploy C, point the proxy back at the untouched old instance. Writes made after the cutover would be lost.
**Side effect in dev:** the new instance matches the template, so dev's drift (section 9) goes away with the old instance.
**After it ships:** update [scaling-chat-capacity.md](docs/guides/scaling-chat-capacity.md), which still says dev runs `db.t3.micro` and prod is Multi-AZ.

**Backup storage after the shrink: low risk.**
- The free backup allowance equals provisioned storage, so it drops from 100 GB to 20 GB.
- October had no `ChargedBackupUsage` in either account.
- Snapshots copy only used blocks (~6 GB), and the 7 days of automated backups after the first are incremental.
- Point-in-time backups also archive the mostly empty 5-minute WAL files. Their size can't be measured here: the backup-storage metrics (`TotalBackupStorageBilled` and similar) exist only for Aurora.
- **Check Cost Explorer for `ChargedBackupUsage` in the month after.** Overage costs ~$0.095 per GB-month, so even 10 GB over is under $1. The old instance's final snapshot (~6 GB) costs cents while it's kept.

### P2.2 NAT Gateway → NAT instance (~$30/mo) · decided

The NAT Gateway costs $37.20 in hourly charges and processes under 5 cents of data. A NAT instance has neither charge.

**What uses NAT:** VPC Lambdas reach AppSync (the chatbot streams every chunk there, [streaming.py:57](cdk/chatbot_v2/src/streaming.py#L57)), SSM, SQS, Lambda invoke and Cognito through it. **Chat already depends on it**, and it's already a single point of failure: one NAT Gateway in one AZ (`natGateways: 1`).

**Change:** `ec2.NatProvider.instanceV2(...)` in [vpc-stack.ts](cdk/lib/vpc-stack.ts), which is built into CDK (no new dependency):
- **Size:** `t4g.micro` in prod (~$7 + ~$1 EBS; 64 Mbps baseline, bursts to 5 Gbps), `t4g.nano` in dev. Chat traffic is in kilobytes.
- **AMI:** Amazon Linux 2023, **pinned** through a context lookup. Otherwise a new AMI replaces the instance, and briefly cuts egress, on any deploy.
- **Hardening:** IMDSv2 required; patched by SSM Agent through Patch Manager, which the account already uses.
- **Alarms:** EC2 **recover** on `StatusCheckFailed_System` and **reboot** on `StatusCheckFailed_Instance`. Also alarm on low `CPUCreditBalance` or `NetworkOut` near baseline, with `t4g.small` as the upgrade path.

**Accepted trade-offs:**
- one EC2 instance to patch
- a few minutes to recover if it fails
- Security Hub EC2.9 (public IPv4 address, inherent to NAT), to be recorded as accepted

**Deploy:** the route-table switch interrupts outbound traffic for seconds to minutes. Deploy in the low-traffic window, then test one upload and one chat.
**Rollback:** `NatProvider.gateway()`.

### P2.3 Remove the Secrets Manager and Bedrock interface endpoints (~$33/mo)

Each endpoint costs ~$16 for its two AZs and carries very little traffic. Chat already depends on NAT for AppSync, so the Bedrock endpoint doesn't make chat independent of NAT. Removing it adds a few milliseconds to Bedrock calls that take 2–10 s.

- **Order:** do it **after P2.2 has run cleanly for a week.** First confirm that every Lambda and the proxy sit in `PRIVATE_WITH_EGRESS` subnets. CDK's default does this; only the database is in isolated subnets.
- Update [securityGuide.md](docs/guides/securityGuide.md).
- **Rollback:** add the endpoints back.

---

## 7. Phase 3: Conditional options

### P3.1 Prompt caching (~$8–12/mo now; ~$900/mo at 100× usage, per the hosting brief)

Sonnet input is 75% of the Sonnet bill ($34.62 for 10.49M tokens vs $11.57 for output). Cached input bills at about 10% of the normal price and lowers time to first token. **Today's layout prevents it:** [prompt_builder.py](cdk/chatbot_v2/src/prompt_builder.py) puts the per-turn mode instruction and RAG context in the system prompt, so the prefix changes every turn.

**Change:**
1. System prompt: only stable content (identity, rules, course and module guidance), then a `cachePoint`.
2. Conversation history, with a `cachePoint` after the previous turn.
3. The mode instruction and RAG context go in the new user message.

**Gate:** run the `track-a` evaluation set before and after, and check that Guardrails `guardContent` still covers only the student's text. If OCELIA moves to the UBC AI Gateway, first check whether it supports caching.

### P3.2 Remove RDS Proxy entirely (~$27/mo per environment)

At today's 29 connections, Lambdas can connect directly. **What's lost:** connection pooling. At 300+ concurrent chats, warm Lambdas could exhaust `max_connections` on a 2 GB instance, so reserved-concurrency caps would be needed. Do it in both environments together to keep them the same shape, and only if growth isn't expected.

**Why ~$27, not $23.81 (measured 19 November 2026):** each proxy polls its secrets about every 35 s. Every poll writes two CloudTrail events (`GetSecretValue` plus the KMS `Decrypt` that Secrets Manager makes for it), and GuardDuty and Security Lake bill on CloudTrail events.

- **Secrets Manager:** the proxies made **100%** of dev's calls (624 of 624 in 2 hours) and **91%** of prod's (649 of 715).
- **CloudTrail:** in a 30-minute sample of dev, the proxy produced **343 of 718 events (48%)**: 162 `GetSecretValue`, 162 KMS `Decrypt`, 16 `AssumeRole` and 3 `GenerateDataKey`.
- **GuardDuty:** its CloudTrail analysis cost **$2.69 in dev and $2.56 in prod** last month, so the traffic isn't user-driven.
- **Estimate:** about **$3/mo per account**: Secrets Manager API ~$1.20 (billed), GuardDuty ~$1.20–1.30, Security Lake ~$0.50–0.70 (both proportional estimates). The last two sit in the baseline lines, so they only reach OCELIA's budget if OCELIA pays the account bill.
- **What changes it:**
  - P1.1 probably doesn't, because one proxy still holds three secrets (check dev's count afterwards).
  - P1.1's security follow-up removes a third.
  - Removing the proxy removes all of it.

### P3.3 RDS Reserved Instance (~$8/mo)

A 1-year, no-upfront reservation saves about 30%.
- **When:** only after P2.1 has settled, and only if OCELIA stays on AWS for at least 12 months. First check whether UBC's consolidated billing already shares reservations.
- **Size flexibility:** reservations are size-flexible within `t4g`, so a later `t4g.small` ↔ `t4g.medium` change keeps the discount.
- **No Database Savings Plan:** they cover only generation-7+ instances (`t4g` is generation 4), and they're quoted at up to 20% off for RDS for PostgreSQL.

### P3.4 UBC AI Gateway

See [HOSTING_OPTIONS.md](HOSTING_OPTIONS.md): $58 → ~$31 (+$3–5 to keep Guardrails). It's a separate track, and approval takes time.

---

## 8. Phase 4: Dev hibernate switch (later)

*Revisit after Phases 1–2 are proven in both environments (rollout Stage C). Not scheduled yet.*

**Idea:** one command (for example `npm run dev:off` / `npm run dev:on`, wrapping `cdk deploy -c devPower=off|on`) removes dev's hourly-billed resources and brings them back on demand. Dev is identical to the sizing profile when on, and costs **~$5 a month when off**.

**What dev pays for just by existing (after Phases 1–2):**

| Hourly-billed resource | ~$/mo | Can it be paused? |
|---|---|---|
| RDS Proxy | 23.81 | **No**; delete only |
| WAF web ACL + rules | 8.00 | No; delete only |
| Database instance (`t4g.micro`) | 13.20 | Stop (RDS restarts it after 7 days), or snapshot and delete |
| NAT instance + public IP | ~7 | Stop |
| Alarms (43 critical + 2 composites) | ~5.30 | No; billed even when disabled |
| Storage (database, logs, images, secrets, snapshot) | ~5 | Stays either way |

Everything else (Lambda, API Gateway, AppSync, Cognito, S3, DynamoDB, SQS, Amplify) is pay-per-use and costs nothing idle. The account baseline (~$68, including the idle Transit Gateway) isn't affected.

**Options compared:**

| | A. Stop what can be stopped | **B. Hibernate switch (preferred)** | C. Full teardown |
|---|---|---|---|
| How | Script stops the DB and NAT instance | One command removes the hourly resources and keeps everything else | `cdk destroy --all` / `cdk deploy --all` |
| Cost while off | ~$45 (proxy, WAF and alarms keep billing) | **~$5** | ~$2 |
| Time to turn on | ~5–10 min | ~25–40 min (estimate) | 1 h+, with manual fixes |
| Users, data, URL | Kept | Kept | **Broken** |
| Effort | ~1 hour | ~3–5 days, largely shared with P1.1 and P2.1 | Low code, high fragility |

**Why not a full teardown:**
- [domains.ts](cdk/lib/constants/domains.ts) pins dev's Amplify app ID (`dbqfar7gbtstn`) for the redirect to `ocelia-dev.arts.ubc.ca`. A recreated app gets a new ID, which means updating the code, CORS and likely UBC's DNS.
- The Cognito user pool is retained by CDK's default, so a redeploy creates a new pool and every dev user has to re-register.
- Retained S3 buckets and DynamoDB tables collide on redeploy ("already exists").

**How B works:**
- **Off:**
  1. Snapshot the database under a fixed name, wait until it's `available`, and record the ID in SSM.
  2. Deploy with `devPower=off`. The database instance, proxy, NAT instance, WAF and alarms are left out, so CloudFormation deletes them.
  3. The SNS alarm topics stay, so email subscriptions don't need re-confirming.
- **On:** deploy with `devPower=on`. It restores the database from the recorded snapshot under the same identifier, then recreates the proxy (same name), NAT, WAF and alarms. Data is as of the last switch-off.
- **Prod guard:** synth refuses `devPower=off` in prod.

**Prerequisites** (mostly the same restructuring as P1.1 and P2.1):
- **A standalone proxy (P1.1).** One tied to the database construct is deleted along with it.
- **Fixed names for the proxy and the instance.** RDS endpoints are `<name>.<account-specific suffix>`, so recreated resources keep their endpoints and other stacks don't notice.
- **A standalone admin secret.** Today's is created inside the database construct.
- **No `instanceResourceId` IAM grants.** That ID changes on every restore; P2.1 already checks whether the grants are used.
- **No CloudFormation exports of anything deleted while off:** use stable names or SSM parameters instead.
- **Alarms switched off inside ObservabilityStack**, not by deleting the stack.

**While off:**
- The site loads and sign-in works, but anything that needs the database fails (chat, course pages, ingestion).
- Uploads land in S3 but aren't processed.
- The daily Lambda warm-ups keep running harmlessly, since they return before touching the database.

**Savings** (dev running costs ~$67/mo, about $0.09/h):

| How dev is used | OCELIA's dev cost / mo |
|---|---|
| Always on | ~$67 (~$58 with D4) |
| Switch, on ~40 h a month | **~$9** |
| Switch, on ~160 h a month | ~$20 |

That's roughly $45–58 a month less, and dev's total falls to ~$75–90 including the baseline. **It would replace D4**, and the weekend proxy test along with it, because the proxy is deleted while off.

**Risks:**
- **Turn-on time is an estimate:** restore (~10–15 min) plus proxy creation (~5–10 min). Measure it on the first run.
- **Someone has to remember to switch it off.** Switching off needs a CDK deploy, so it can't run on a timer without a CI runner. The dev budget alert (P1.4) catches "left on".
- **Old snapshots age.** A snapshot that outlives its minor version may be upgraded on restore.
- **It's another code path to keep working.** Exercise it regularly.

**Keep the option cheap:** P2.1 already replaces the instance, so give the new instance a **fixed identifier** and a **standalone admin secret**, and drop the `instanceResourceId` grants there. That costs nothing extra now. Adding a fixed identifier later would force another instance replacement.

---

## 9. Dev account: prod's infrastructure, smaller scale

### Today: $295.68 in October ($328.15 with tax), with almost no usage (Bedrock: $0.12)

| Billed line | Oct | Usage types |
|---|---|---|
| RDS | $126.59 | **`RDS:ProxyUsage` 4,464 vCPU-h, $71.42** (same as prod) · **`Multi-AZUsage:db.t3.micro`, $29.76** · `Multi-AZ-GP3-Storage` 100 GB, $25.40 |
| VPC | $81.10 | Transit Gateway (ca-west-1, idle) $44.64 · endpoints $32.74 · NAT IPv4 $3.72 |
| EC2 – Other | $37.20 | NAT Gateway hours |
| CloudWatch | $14.40 | **86 alarms, $8.59** · dashboard $3.00 · composite alarms $1.00 · logs ~$1.50 |
| WAF | $8.00 | Web ACL + 3 rules |
| Secrets Manager | $4.02 | 7 secrets, $2.80 · 243k API calls, $1.21 (all by the proxies) |
| Account baseline (Security Hub, Config, Security Lake, GuardDuty) | $22.99 | Not OCELIA's (plus the $44.64 Transit Gateway above) |
| Other | ~$1.40 | SQS polling, ECR, Amplify, EventBridge, Bedrock, S3 |
| **Total** | **$295.68** | **~$228 OCELIA-controllable**, ~$67.60 baseline |

**The dev database has drifted from CloudFormation** (drift detection, 19 November 2026; prod's `AILA-DatabaseStack` has none):

| Resource | Property | Template | Live |
|---|---|---|---|
| DB instance | `MultiAZ` | `false` | **`true`** |
| DB instance | `AvailabilityZone` | ca-central-1a | ca-central-1b (it has failed over) |
| DB instance | `EnableIAMDatabaseAuthentication` | `true` | `false` |
| DB instance | `EngineLifecycleSupport` | not set (RDS default: enrolled) | `…-disabled`. Not flagged as drift, because the template doesn't set it |
| DB security group | ingress | – | **port 5432 from `temp-pg-dump-sg`** ("Temporary SG for pg_dump EC2"): left over from the [data export procedure](docs/guides/data_export.md), attached to nothing |

CloudTrail has no `ModifyDBInstance` in its 90-day window, so these changes predate ~21 August 2026. The P2.1 rebuild clears all of it, and D1 and D3 fix the parts that cost money or affect security now.

### Sizing profile

Dev deploys the same stacks and constructs as prod; **only sizes differ.** Keep them in one per-environment profile (for example, `cdk/lib/constants/sizing.ts`, keyed by `environment`) rather than `isProduction` ternaries spread across files. That way a size difference can never become a missing resource.

| Setting | Prod | Dev |
|---|---|---|
| DB class | `db.t4g.small` (or `t4g.medium`, per the gate) | `db.t4g.micro` |
| DB storage | 20 GB gp3, autoscaling to 50 | 20 GB gp3, autoscaling to 30 |
| Multi-AZ | Off | Off |
| Engine | PostgreSQL 17, Extended Support disabled | Same |
| RDS Proxy | 1, with 3 secrets | Same |
| Backups | 7 days, deletion protection | 1 day (as today) |
| NAT instance | `t4g.micro` | `t4g.nano` |
| Interface endpoints | None | None |
| WAF | 3 rules | Same |
| Alarms | Critical tier and composites only (P1.3) | Same |
| Dashboard | ≤50 metrics, so it's free (P1.3) | Same |
| Log retention | 3 months | 1 month (as today) |
| Enhanced Monitoring | 60 s | Off (as today) |
| Lambda memory and timeouts | Same | Same (costs pennies; keeps behaviour identical) |

`t4g.micro` (1 GB) is too small for database load tests. Change dev's class to the prod class for the test, as the scaling guide describes, then change it back.

### Dev actions

| ID | Change | Saves / mo | Notes |
|---|---|---|---|
| D1 | Turn off Multi-AZ **now** | ~$28 | The template already says `false`, so CDK changes nothing. Run `aws rds modify-db-instance --db-instance-identifier <dev db> --no-multi-az --apply-immediately` (online). Don't set `AvailabilityZone` in CDK to match: that replaces the instance |
| D2 | Apply the sizing profile (class in P2.1, NAT in P2.2) | ~$5 beyond the shared changes | Dev is the rehearsal for each prod change |
| D3 | Remove the `temp-pg-dump-sg` rule, then the group | $0 | Security. Add a cleanup step to `data_export.md` |
| D4 | Stop the DB outside working hours with EventBridge Scheduler *(decided)* | ~$9, or ~$26 if the proxy stops billing too | See below. Starts after the dev gate so it doesn't interrupt testing. Phase 4 would replace it |

**D4: fewer hours, not a smaller size.**
- **Size floor:** dev is already at the minimum. `db.t4g.micro` is the smallest RDS for PostgreSQL class (there's no nano), and 20 GB is the gp3 minimum: ~$15.70 together after P2.1. The proxy ($23.81) costs more than that, and RDS Proxy's 2-vCPU minimum means a smaller instance doesn't reduce it.
- **Saving:** a stopped instance bills only storage and backups. At ~50 hours a week (weekdays, ~10 h a day), the instance falls from ~$13.20 to ~$4.
- **Open question:** AWS doesn't document whether RDS Proxy keeps billing while its target is stopped. If it doesn't, D4 saves ~$26 instead of ~$9.
- **Test it once:** stop the database Friday evening to Monday morning. Compare the weekend's daily `RDS:ProxyUsage` with a normal day (48 vCPU-h for one proxy), and check that the proxy reconnects after the start.
- **While stopped:**
  - dev uploads and chats fail until someone starts the database
  - the daily Lambda warm-ups don't touch the database, so they're unaffected
  - an 8:00 a.m. weekday start plus a "start now" command covers normal use
  - a daily schedule also handles RDS's automatic restart after 7 days
  - starting takes ~5–10 minutes
- **Not worth it:**
  - Removing the dev proxy ($23.81) conflicts with the same-infrastructure decision, and the P2.1 rehearsal needs it.
  - A `t4g.micro` reservation saves only ~$4.

### Dev total

After the shared changes (P1.1, P1.3, P2.1–P2.3) plus D1–D3:

| Item | Cost |
|---|---|
| RDS (`t4g.micro` $13.20 + 20 GB $2.54 + proxy $23.81) | ~$40 |
| Network (`t4g.nano` NAT + IPv4) | ~$8 |
| CloudWatch (43 critical alarms ~$4.30, composites $1, logs ~$1.50; dashboard free) | ~$7 |
| WAF | $8 |
| Secrets | ~$3 |
| Other | ~$1.40 |
| **OCELIA-controllable** | **~$67 (from ~$228)** |

- The total including baseline drops from ~$296 to **~$135**.
- With D4, the controllable cost is ~$58, or ~$41 if the proxy also stops billing.

---

## 10. Track B: Account baseline (not OCELIA's CDK)

From [AWS_BASELINE_COST_FINDINGS.md](AWS_BASELINE_COST_FINDINGS.md). These need Arts ISIT and UBC Hybrid Cloud:
- **B1 and B3 (closed):** the idle ca-west-1 Transit Gateway attachments in prod (`arts-isit-prod-services`, 0 bytes carried) and dev ($44.64/mo each) **can't be removed** (confirmed 19 November 2026). They stay in the baseline, which is ~$104 in prod and ~$68 in dev.
- **B2:** agree how the baseline is split. OCELIA causes about $10–17 of the $104.

OCELIA's own lever on the baseline is the proxy's secret polling (P3.2). Turning off API Gateway X-Ray was considered and dropped (section 11).

---

## 11. Considered and rejected

| Idea | Why not |
|---|---|
| RDS Blue/Green to shrink storage | Untested here with RDS Proxy and CloudFormation; the rebuild is simpler now that recreation is accepted |
| Full stack teardown to resize (CO-7's suggestion) | Destroys the Cognito user pool, buckets and other ApiGatewayStack resources; P2.1 replaces only the instance |
| Removing WAF, monitoring or the proxy from dev only | Conflicts with the same-infrastructure decision; dev uses smaller sizes instead |
| A smaller dev database | Already at the RDS minimum (D4) |
| Aurora Serverless v2 with auto-pause | ~15 s resume on the first chat after idle; the always-on minimum (0.5 ACU) costs more than `t4g.small` |
| Moving Lambdas out of the VPC | They need the database, and the RDS Data API is Aurora-only |
| Bedrock batch inference for enrichment | 50% cheaper, but jobs take hours, so uploads would stop being ready in minutes |
| Bedrock Flex tier for enrichment | The Haiku 4.5 model card lists it as unsupported (Standard and Reserved only). Revisit if that changes, since enrichment isn't latency-sensitive |
| Bedrock Reserved tier | A throughput commitment far beyond OCELIA's volume |
| Global cross-Region inference | Would save ~$5/mo (Geo-US is billed 10% above Global: $3.30 vs $3.00 per M Sonnet input tokens), but would send prompts outside the Geo-US Regions approved in ADR-006 |
| Haiku instead of Sonnet for chat | Answer quality; revisit only with evaluation data |
| Capping chat history | Already done (`get_bounded_history`, [history.py](cdk/chatbot_v2/src/history.py)) |
| Lambda arm64, memory tuning, provisioned concurrency | All Lambda compute costs $0.64. Provisioned concurrency would add cost, and the daily warm-up already handles the idle Inactive state |
| Interface endpoints in one AZ | Saves ~$16, but an AZ outage would break DNS for those services; P2.3 removes them instead |
| Turning off API Gateway detailed metrics or flow logs | They cost under $0.05 and $0.97 |
| Database Savings Plan | Doesn't cover `t4g` (P3.3) |
| CloudFront Free plan instead of regional WAF (~$8/env); trimming Haiku output (~$1–3) | Too small for the added complexity (team decision, 19 Nov 2026). The CloudFront option also needed bypass protection, a Security Hub exception and a privacy review |
| Turning off API Gateway stage X-Ray tracing (~$0.40 + ~$3 of baseline) | Team decision, 19 Nov 2026. It would raise Security Hub APIGateway.3 and need UBC security's agreement. Its sampling-rule polling causes about a third of the account's CloudTrail events, in case the baseline split (B2) makes that matter later |
| Caching DB secrets in the Python Lambdas | Team decision, 19 Nov 2026. $0 saving: Lambdas make only 9% of the Secrets Manager calls. The 10–50 ms it would save on some retrieval and enrichment calls ([retrieval/handler.py](cdk/multimodal_rag_v2/retrieval/handler.py) lines 954, 1058, 1171; [enrichment/handler.py](cdk/multimodal_rag_v2/enrichment/handler.py)) can be revisited as latency work |
| Pruning only some warning alarms | Team chose critical-only (P1.3) |
| PostgreSQL 18, or staying on 16, for the rebuild | Team chose 17 (P2.1) |

---

## 12. Rollout

**Order (decided 19 November 2026):**
1. **Stage A:** every Phase 1 and Phase 2 change goes to dev first.
2. **Stage B:** prod follows only once dev passes the validation gate.
3. **Stage C:** later options come after both environments are stable.

**Accepted trade-off:** prod savings start a few weeks later. Phase 1 alone is worth ~$128/mo in prod.

### Stage A: Dev (~3 weeks, late November to mid-December)

| # | Change | Verify |
|---|---|---|
Testing is **manual**, using the checklist in section 15. A tester runs the UI flows; an engineer runs the CLI checks. Dev has no other traffic, so **nothing is exercised unless someone runs the checklist.**

| # | Change | Verify |
|---|---|---|
| 0 | **Before any change:** a full checklist run in dev, plus the prod guardrail baselines (read-only) | Records what already passes or fails in dev, so pre-existing problems aren't blamed on the plan |
| 1 | P1.4 budgets in both accounts; **D1** (dev's counterpart of P1.2); **D3**; **F1** and **F3** in dev; confirm **F2**'s dev subscription | Dev `MultiAZ: false`; `cdk diff` shows only intended changes (`dev` has no undeployed CDK changes since the 27 Oct prod release); `cdk diff` against **prod** shows no Amplify change; checks E10–E12; quick checklist run |
| 2 | P1.1 standalone proxy (two deploys) | Full checklist run. It covers all three database users: app user (student, instructor, chat, RAG), table creator (sign-up, sign-in, admin), and master (instructor upload; orphan cleanup, engineer-checked). No auth errors in the logs |
| 3 | P1.3 critical-only alarms; dashboard ≤50 metrics | Synth and deploy pass; the composite references only critical alarms (engineer); quick checklist run |
| 4 | Sizing profile; **P2.1 rebuild rehearsal** (PostgreSQL 17 at `t4g.small`, pgbench, then `t4g.micro`) | The P2.1 checks (engineer): proxy registers the PostgreSQL 17 target; roles copied; row counts match; `vector` and HNSW index present; initializer rerun clean; pgbench passes; freeze-to-cutover time recorded. Then a **full checklist run**: data from before the rebuild (courses, chats, files) must still be there |
| 5 | P2.2 NAT instance (`t4g.nano`) | Full checklist run (chat streaming and ingestion depend on NAT); NAT reboot test and one SSM Patch Manager run (engineer) |
| 6 | P2.3 remove the endpoints, after step 5 has run cleanly for a few days | Quick checklist run (chat uses Bedrock through NAT) |

**Dev validation gate.** All of these must hold before Stage B:
- **The full checklist (section 15) passes after the last dev change**, with every failure either fixed or matched to the same failure in the step 0 run.
- **A 5-working-day soak with no critical alarms, DLQ messages or Lambda errors.** Run the full checklist at the start and the end of the soak. Between runs, only scheduled jobs exercise dev (orphan cleanup every 6 h, daily warm-ups, NAT patching), so the engineer checks their logs too.
- **`cdk diff` and drift detection show nothing unexpected.**
- **Dev's daily Cost Explorer shows the expected drops:**
  - `RDS:ProxyUsage` at 48 vCPU-h a day
  - no `Multi-AZUsage`, `NatGateway-Hours` or `VpcEndpoint-Hours`
  - ~43 alarms
- **Limit:** dev has no real load and manual tests are single-user, so this gate proves that **nothing breaks**, not that performance holds. Performance (the section 1 guardrails, and `t4g.small` with prod's data) is confirmed in Stage B, using the fallbacks: class change in place, Multi-AZ back on online, revert to the NAT Gateway.

### Stage B: Prod (after the gate; avoid the December exam period)

| # | Change | Verify |
|---|---|---|
**Before Stage B:** set up prod test accounts (student, instructor, admin) and a test course for the checklist, kept away from real students and course analytics. Clean up test sessions afterwards.

| # | Change | Verify |
|---|---|---|
| 1 | **F2** prod alarm email (re-subscribe and confirm); **F3** in prod; P1.2 single-AZ (online); P1.1 (two deploys); P1.3 | E11 and E12 in prod; quick checklist run after each deploy; same engineer checks as dev; guardrails for 3–7 days; `RDS:ProxyUsage` at 1,488 vCPU-h a month instead of 4,464; RDS bill drops the next day |
| 2 | **P2.1 rebuild** in the winter break (announced freeze) | P2.1 checks; **full checklist run before unfreezing**; for a week, watch `ReadIOPS`, `ReadLatency`, `SwapUsage` and retrieval p90 (fallback: `t4g.medium` in place) |
| 3 | P2.2 NAT instance (`t4g.micro`) | Full checklist run; guardrails |
| 4 | P2.3, after the NAT instance has run cleanly for a week | Quick checklist run; no Bedrock or Secrets Manager errors |

Real student traffic is what proves performance in prod, so the first days of term after Stage B count as part of the verification: watch the guardrails.

In parallel, once the gate has passed: **D4** in dev (the nightly stop, starting with the weekend proxy-billing test).

### Stage C: Later (after both environments are stable)
- Compare both bills with the targets in Cost Explorer, month over month.
- Decide on the Phase 3 options (prod).
- Revisit **Phase 4, the dev hibernate switch** (section 8). If adopted, it replaces D4.

Prod deploy notes from `CLAUDE_HISTORY.md` still apply:
- export credentials instead of using `AWS_PROFILE` with the pinned CLI
- `predeploy` runs the tests
- Docker is required

Record each change in `CLAUDE_HISTORY.md` when it ships.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Removing a proxy or instance export breaks the deploy | Standalone proxy (P1.1); pin old exports with `exportValue` and remove them in a later deploy |
| Data missed or mangled in the rebuild | Freeze writes; compare row counts for every table; keep the old instance until Deploy C and its snapshot for 30 days; rehearse in dev |
| Rebuild overruns the freeze window | Time the dev rehearsal; the old instance is untouched until cutover, so the window can be abandoned |
| HNSW index doesn't fit in 2 GB (dev can't test this with prod's data) | Index-size check (step 5); watch `ReadIOPS` and retrieval p90 after cutover; change the class to `t4g.medium` in place (~5–10 min) if needed |
| Leftover pre-ADR-017 roles own objects, so `pg_restore` fails | Copy the roles first (`pg_dumpall --roles-only`); step 5's owner query; the dev rehearsal |
| The DB initializer reruns against the empty new instance | Repoint DBFlowStack only in Deploy B, after the restore |
| 20 GB fills up | Size gate; autoscaling to 50 GB; `FreeStorageSpace` alarm |
| **Extended Support:** prod is enrolled, so from 1 March 2029 it would pay ~$150–160/mo, then $300+ | Rebuild on PostgreSQL 17 with Extended Support disabled; calendar the next upgrade for early 2029 |
| **CDK pin `VER_16_10` no longer offered**, so any new instance fails, including P2.1's | Set the version in the sizing profile; keep the pin current as minor versions retire |
| NAT instance fails, cutting chat and ingestion egress | EC2 recover and reboot alarms (minutes to recover); revert is one deploy |
| NAT instance replaced by an AMI change on deploy | Pin the AMI through a context lookup |
| Single-AZ outage during term | **Accepted** (section 0); Multi-AZ can be re-enabled online before exams |
| New Security Hub findings (RDS.5, EC2.9) | Record as accepted with UBC security |
| A problem goes unnoticed until it's critical (warning alarms removed) | Accepted. Critical alarms, email pages and the composite are unchanged; budgets (P1.4) catch cost anomalies |
| Live resources drift from CDK, as dev's did | Drift detection on `AILA-VpcStack` before Phase 2. Proxy target groups always report `DETECTION_FAILED` (a CloudFormation limitation with the `TargetGroupName` override), so check them by hand |
| Target-state prices are estimates | Pricing Calculator before Phase 2 (today's costs are billed figures) |
| Dev passes but prod behaves differently (real load, prod's data volume) | The dev gate is functional only; guardrails are watched in Stage B with in-place fallbacks for each change |

---

## 14. Decisions still needed

Engineering decisions are settled (section 0). Remaining:

| Decision | Who | Affects |
|---|---|---|
| Prod freeze window for the rebuild (date and announcement) | Project leads | P2.1 |
| Prod test accounts and test course for the checklist (dev is settled: Vincent tests, reusing dev's course) | Engineering / project leads | Stage B |
| Stay on AWS for at least 12 months | Project leads (hosting brief) | P3.1, P3.3 |
| How the account baseline is split (the Transit Gateway attachments stay) | Arts ISIT, UBC Hybrid Cloud | Which share of ~$104 (prod) and ~$68 (dev) OCELIA's budget pays |

---

## 15. Manual test checklist

**Setup (dev, before step 0):**
- **Tester: Vincent** (decided 19 Nov 2026).
- **Reuse dev's existing test accounts** (5 students, 5 instructors, 2 admins) **and the existing test course.** Dev holds 94 PDFs and 5 PPTX files (newest uploaded 26 Oct 2026), with ~600 extracted images, so pick a module whose material has a figure, and ideally a table and a formula. If it lacks one, mark rows 5–6 "N/A" for that item in every run, so runs stay comparable.
- Bring any small PDF for the upload test (row 10).

The prod equivalent is set up before Stage B.

**Runs:**
- **Full:** all rows, ~60–90 min.
- **Quick:** the rows marked ★, ~15 min.

For each run, record the date, environment, plan step, tester, pass/fail per row and notes. A copy of the table in the PR or a shared doc is enough.

### Tester (UI)

| # | Role | Steps | Expected | Exercises |
|---|---|---|---|---|
| 1 | New user | Sign up a new account and confirm it | Account works; lands on the student home | Cognito triggers; `addStudentOnSignUp` (table-creator user) |
| 2 ★ | Student, instructor, admin | Sign in as each | Each lands on the right home page | `adjustUserRoles` (table-creator user) |
| 3 ★ | Student | Open the course and module list | Courses, modules and progress load | `studentFunction` (app user) |
| 4 ★ | Student | Start a new chat in the test module and ask about its content; then reload the page | Answer streams in, **and clearly uses the module's material**; after the reload, the session history shows the messages (written to RDS by the chat projection) | chatbotV2 → retrieval → Bedrock; streaming via AppSync (needs NAT). **A retrieval failure still produces an answer, just without course material** (`retrieval_client.py` returns `None`), so check the content, not just that an answer appeared |
| 5 | Student | Ask about the figure, then the table | Answer describes them correctly | Multimodal retrieval; figure lookups |
| 6 | Student | Ask a question that needs a calculation | Correct worked answer | `mathComputeFunction` |
| 7 | Student | Delete the last message | Message removed; chat continues | `deleteLastMessage` (DynamoDB + DB) |
| 8 | Student | Open the reference PDF viewer | Document opens | Presigned S3 access |
| 9 | Student | Complete the module (progress button) | Progress updates and persists after reload | `studentFunction` |
| 10 ★ | Instructor | Create a module and upload the second PDF; time it from upload to "ready" | Wizard reaches ready; **record the time** (ingestion guardrail) | `generatePreSignedURL` (**master user**); S3 → ingestion → enrichment; progress events |
| 11 | Instructor | Edit the module prompt and save | Conflict check runs; prompt saves | `validatePrompt` (Bedrock Haiku) |
| 12 | Instructor | Generate or view suggested topics | Topics appear | `generateTopics` |
| 13 | Instructor | View student chat logs and analytics for the test course | Test student's sessions appear | `getChatLogsFunction`, `instructorFunction` |
| 14 | Instructor | Delete the uploaded file, then the test module | Both gone; no errors | `deleteFile`, `deleteModule` |
| 15 ★ | Admin | View courses and instructors; create a test course and assign an instructor; change a role | Changes save and show | `adminFunction` (table-creator user) |

### Engineer (CLI)

| # | Check | Expected |
|---|---|---|
| E1 | `orphanCleanupFunc` scheduled runs (every 6 h), or `aws lambda invoke` | Succeeds. This is the **master user**'s second path |
| E2 | Lambda `Errors` for all functions, DLQ depths and alarm states over the test window | Zero, or the same as the step 0 run |
| E3 | Logs for `no credentials for the role` or `password authentication failed` | None (proxy and secret wiring) |
| E4 | RDS Proxy `DatabaseConnectionsBorrowLatency` | No sustained rise |
| E5 | `cdk diff` and drift detection | Nothing unexpected |
| E6 | Cost Explorer daily usage types | The expected drops (section 12 gate) |
| E7 | Daily warm-up invocations | Return `{"warmup": true}` without errors |
| E8 | After P2.1: the data-export tunnel to the new instance endpoint ([data_export.md](docs/guides/data_export.md)) | Connects; guide updated |
| E9 | After P2.2: NAT reboot test and one Patch Manager run | Egress resumes; patch run succeeds |
| E10 | After F1 (dev only): a push to the `dev` branch builds dev; a push to `main` doesn't; `dev.<appId>.amplifyapp.com` redirects to `ocelia-dev.arts.ubc.ca`; Amplify drift clean | All true; `ocelia-dev.arts.ubc.ca` still serves the app |
| E11 | After F3: stage `methodSettings` show `loggingLevel: ERROR`, throttling 100/200, `metricsEnabled: false`; the log group exists with retention; Security Hub APIGateway.1 | Matches; APIGateway.1 PASSED (it can take up to a day to re-evaluate) |
| E12 | F2: `list-subscriptions-by-topic` on the critical topic | `email` subscription **confirmed**, not `PendingConfirmation` |

---

### Method and limits

- **Today's costs are billed figures:** read-only Cost Explorer queries of both accounts for October 2026, by usage type, pulled 19 November 2026. Prod was cross-checked with `cdk/cost_by_service.json` and the baseline report.
- **Target-state costs are estimates.** t4g and NAT-instance prices use us-east-1 list prices plus the ~11% ca-central-1 premium seen on the bill. RDS Proxy ($0.016 per vCPU-h), endpoints ($0.011 per AZ-h), gp3 ($0.127 per GB-month) and public IPv4 ($0.005/h) use October's billed rates.
- **Usage figures** (concurrency, CPU, connections) come from the hosting brief and the scaling guide.
- **Drift, storage, engine and CloudTrail findings** come from read-only CloudFormation, RDS, CloudWatch, CloudTrail and GuardDuty checks on 19 November 2026.
