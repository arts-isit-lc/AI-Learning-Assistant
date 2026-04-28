# CloudWatch Observability Infrastructure

This document describes all CloudWatch resources created by the ObservabilityStack (`cdk/lib/observability-stack.ts`), including alarms, the operational dashboard, SNS notification topics, and the X-Ray sampling rule.

## SNS Notification Topics

| Topic | Name Pattern | Encryption | Subscriber |
|-------|-------------|------------|------------|
| Warning | `AILA-{env}-Warning` | KMS (`aws/sns`) | `vincent.lam@ubc.ca` |
| Critical | `AILA-{env}-Critical` | KMS (`aws/sns`) | `vincent.lam@ubc.ca` |

**Routing rules:**
- **Production**: Warning alarms → Warning Topic, Critical alarms → Critical Topic
- **Non-production**: All alarms → Warning Topic only (avoids off-hours noise)

---

## CloudWatch Alarms

### Lambda Alarms (per function, 21 functions × 4 alarms = 84 total)

#### Error Rate — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-{functionName}-ErrorRate-Warning` |
| Metric | `(Errors / Invocations) * 100` (Math Expression) |
| Namespace | `AWS/Lambda` |
| Threshold | **5%** (prod) / **10%** (dev) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |
| Runbook | Check CloudWatch Logs `/aws/lambda/{function-name}`. Review recent deployments. Check downstream service health. |

#### Error Rate — Critical

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-{functionName}-ErrorRate-Critical` |
| Metric | `(Errors / Invocations) * 100` (Math Expression) |
| Threshold | **25%** (both environments) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Runbook | Check CloudWatch Logs `/aws/lambda/{function-name}`. Review recent deployments. Check downstream service health. |

#### Duration — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-{functionName}-Duration-Warning` |
| Metric | `Duration` p99 |
| Threshold | **80% of configured timeout** (varies per function) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |
| Runbook | Check X-Ray traces for slow downstream calls. Review memory allocation. Check for cold start impact. |

**Duration thresholds per function:**

| Function | Timeout | Alarm Threshold (80%) |
|----------|---------|----------------------|
| studentFunction | 60s | 48,000ms |
| instructorFunction | 60s | 48,000ms |
| adminFunction | 60s | 48,000ms |
| preSignupLambda | 30s | 24,000ms |
| addStudentOnSignUp | 30s | 24,000ms |
| adjustUserRoles-v9 | 60s | 48,000ms |
| adminLambdaAuthorizer | 30s | 24,000ms |
| studentLambdaAuthorizer | 30s | 24,000ms |
| instructorLambdaAuthorizer | 30s | 24,000ms |
| TextGenLambdaDockerFunc | 300s | 240,000ms |
| GeneratePreSignedURLFunc | 30s | 24,000ms |
| DataIngestLambdaDockerFunc | 600s | 480,000ms |
| GetFilesFunction | 30s | 24,000ms |
| DeleteFileFunc | 30s | 24,000ms |
| DeleteModuleFunc | 60s | 48,000ms |
| DeleteLastMessage | 30s | 24,000ms |
| AuthHandler | 3s | 2,400ms |
| NotificationFunction | 60s | 48,000ms |
| sqsFunction | 60s | 48,000ms |
| SQSTriggerDockerFunc | 300s | 240,000ms |
| GetChatLogsFunction | 60s | 48,000ms |

#### Throttle

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-{functionName}-Throttle` |
| Metric | `Throttles` Sum |
| Threshold | **> 0** (any throttle event) |
| Evaluation | 2 of 3 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Runbook | Check account-level concurrent execution limits. Review reserved concurrency settings. Check for invocation spikes. |

---

### API Gateway Alarms (3 total)

#### 5xx Error Rate — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-ApiGateway-5xx-Warning` |
| Metric | `IF(requests > 50, (5XXError / Count) * 100, 0)` |
| Namespace | `AWS/ApiGateway` |
| Threshold | **1%** (requires minimum 50 requests) |
| Evaluation | 3 of 5 datapoints, 5-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |
| Runbook | Check backend Lambda error rates. Review API Gateway execution logs. Check authorizer Lambda health. |

#### 5xx Error Rate — Critical

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-ApiGateway-5xx-Critical` |
| Metric | `IF(requests > 50, (5XXError / Count) * 100, 0)` |
| Threshold | **5%** (requires minimum 50 requests) |
| Evaluation | 3 of 5 datapoints, 5-minute period |
| Missing Data | Not Breaching |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Runbook | Check backend Lambda error rates. Review API Gateway execution logs. Check authorizer Lambda health. |

#### Missing Traffic

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-ApiGateway-MissingTraffic` |
| Metric | `Count` Sum |
| Threshold | **= 0** for 15 consecutive minutes |
| Evaluation | 15 of 15 datapoints, 1-minute period |
| Missing Data | **Breaching** (absence of data triggers alarm) |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Actions Enabled | **Prod only** (disabled in dev to avoid false positives) |
| Runbook | Verify DNS resolution. Check WAF rules for blocks. Verify API Gateway deployment. Check upstream client health. |

---

### RDS Database Alarms (6 total)

#### CPU Utilization — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-RDS-CPU-Warning` |
| Metric | `CPUUtilization` Average |
| Namespace | `AWS/RDS` |
| Threshold | **80%** (prod) / **90%** (dev) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

#### CPU Utilization — Critical

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-RDS-CPU-Critical` |
| Metric | `CPUUtilization` Average |
| Threshold | **95%** (both environments) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |

#### Free Storage — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-RDS-Storage-Warning` |
| Metric | `FreeStorageSpace` Average |
| Threshold | **< 20%** of allocated storage (20 GB of 100 GB = 21,474,836,480 bytes) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

#### Free Storage — Critical

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-RDS-Storage-Critical` |
| Metric | `FreeStorageSpace` Average |
| Threshold | **< 10%** of allocated storage (10 GB of 100 GB = 10,737,418,240 bytes) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |

#### Database Connections — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-RDS-Connections-Warning` |
| Metric | `DatabaseConnections` Average |
| Threshold | **80% of max_connections** (56 for db.t3.micro, 96 for db.t3.medium) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

#### Latency — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-RDS-Latency-Warning` |
| Metric | `MAX(ReadLatency p99, WriteLatency p99)` (Math Expression) |
| Threshold | **> 0.1 seconds** (100ms) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |
| Runbook | Check slow query logs. Review active connections. Check for long-running transactions. |

---

### SQS / DLQ Alarms (4 total)

#### DLQ Depth — Critical

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-DLQ-Depth` |
| Metric | `ApproximateNumberOfMessagesVisible` Sum |
| Namespace | `AWS/SQS` |
| Dimension | DLQ queue name |
| Threshold | **> 0** messages |
| Evaluation | 1 of 1 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Runbook | Inspect DLQ messages for error patterns. Check consumer Lambda logs. Consider replaying messages after fix. |

#### Queue Depth — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-SQS-QueueDepth-Warning` |
| Metric | `ApproximateNumberOfMessagesVisible` Sum |
| Dimension | messagesQueue name |
| Threshold | **> 100** messages |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

#### Queue Age — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-SQS-QueueAge-Warning` |
| Metric | `ApproximateAgeOfOldestMessage` Maximum |
| Dimension | messagesQueue name |
| Threshold | **> 600 seconds** (10 minutes) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

#### Consumer Delay — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-SQS-ConsumerDelay-Warning` |
| Metric | `ApproximateAgeOfOldestMessage` Maximum |
| Dimension | messagesQueue name |
| Threshold | **> 300 seconds** (5 minutes) |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

---

### AppSync Alarms (2 total)

#### 5xx Errors — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-AppSync-5xx-Warning` |
| Metric | `5XXError` Sum |
| Namespace | `AWS/AppSync` |
| Threshold | **> 0** errors |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

#### Latency — Warning

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-AppSync-Latency-Warning` |
| Metric | `Latency` p99 |
| Threshold | **> 5,000ms** |
| Evaluation | 3 of 5 datapoints, 1-minute period |
| Missing Data | Not Breaching |
| SNS Target | Warning Topic |

---

### Composite Alarms (2 total)

#### SystemHealthCritical

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-SystemHealthCritical` |
| Rule | ALARM when **2 or more** of: any Lambda critical error rate, API Gateway critical 5xx, RDS CPU critical |
| Logic | `(A AND B) OR (A AND C) OR (B AND C)` |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Purpose | Reduces alert storms during cascading failures |

#### DataPipelineHealth

| Field | Value |
|-------|-------|
| Name | `AILA-{env}-DataPipelineHealth` |
| Rule | ALARM when DLQ depth **AND** (queue depth **OR** queue age) are in ALARM |
| Logic | `DLQ AND (QueueDepth OR QueueAge)` |
| SNS Target | Critical Topic (prod) / Warning Topic (dev) |
| Purpose | Detects consumer failures combined with queue backlog |

---

## Alarm Count Summary

| Category | Warning | Critical | Total |
|----------|---------|----------|-------|
| Lambda Error Rate | 21 | 21 | 42 |
| Lambda Duration | 21 | — | 21 |
| Lambda Throttle | — | 21 | 21 |
| API Gateway 5xx | 1 | 1 | 2 |
| API Gateway Traffic | — | 1 | 1 |
| RDS CPU | 1 | 1 | 2 |
| RDS Storage | 1 | 1 | 2 |
| RDS Connections | 1 | — | 1 |
| RDS Latency | 1 | — | 1 |
| SQS DLQ | — | 1 | 1 |
| SQS Queue Depth | 1 | — | 1 |
| SQS Queue Age | 1 | — | 1 |
| SQS Consumer Delay | 1 | — | 1 |
| AppSync 5xx | 1 | — | 1 |
| AppSync Latency | 1 | — | 1 |
| Composite | — | 2 | 2 |
| **Total** | **52** | **49** | **101** |

---

## CloudWatch Dashboard

**Name**: `AILA-{env}-Dashboard`

### Widget Layout

| Row | Widget | Width | Metrics Displayed |
|-----|--------|-------|-------------------|
| 1 | Lambda Errors | 12 | `Errors` Sum for all 21 functions |
| 1 | Lambda Duration (p99) | 12 | `Duration` p99 for all 21 functions |
| 2 | API Gateway Errors & Latency | 12 | `5XXError` Sum, `4XXError` Sum (left axis), `Latency` p99 (right axis) |
| 2 | RDS Metrics | 12 | `CPUUtilization`, `FreeStorageSpace`, `DatabaseConnections` (left), `ReadLatency` (right) |
| 3 | SQS Queue Depth | 12 | `ApproximateNumberOfMessagesVisible` for messagesQueue and DLQ |
| 3 | AppSync Errors & Latency | 12 | `5XXError` Sum (left), `Latency` p99 (right) |
| 4 | Lambda Init Duration | 12 | `InitDuration` Average for 3 container functions |
| 5 | Lambda Alarm Status | 24 | Status of all 84 Lambda alarms |
| 6 | Infrastructure Alarm Status | 24 | Status of all 17 infrastructure + composite alarms |

---

## X-Ray Tracing

### Tracing Configuration

| Resource | Setting |
|----------|---------|
| API Gateway | `tracingEnabled: true` on deployment stage |
| All Lambda Functions (21) | `tracing: lambda.Tracing.ACTIVE` |
| Lambda Execution Roles | `xray:PutTraceSegments`, `xray:PutTelemetryRecords` |
| Container Lambdas (3) | X-Ray SDK patches `boto3` and `httpx` at module level |
| AppSync | `xrayEnabled: true` |

### X-Ray Sampling Rule

| Field | Dev | Prod |
|-------|-----|------|
| Rule Name | `AILA-dev-SamplingRule` | `AILA-prod-SamplingRule` |
| Service Name | `AILA-dev` | `AILA-prod` |
| Fixed Rate | **1.0** (100%) | **0.05** (5%) |
| Reservoir Size | 10 | 1 |
| Priority | 1000 | 1000 |

---

## Log Retention

| Environment | Retention Period | CDK Property |
|-------------|-----------------|--------------|
| Dev | 30 days | `logs.RetentionDays.ONE_MONTH` |
| Prod | 90 days | `logs.RetentionDays.THREE_MONTHS` |

Applied to all 21 Lambda functions via the `logRetention` property.

---

## Dead Letter Queue

| Field | Value |
|-------|-------|
| Queue Name | `{StackPrefix}-ApiGatewayStack-messages-queue-dlq.fifo` |
| Type | FIFO |
| Associated Queue | `{StackPrefix}-ApiGatewayStack-messages-queue.fifo` |
| Max Receive Count | 3 (messages move to DLQ after 3 failed processing attempts) |
| Encryption | Same as messagesQueue (default) |

---

## Environment-Specific Threshold Differences

| Setting | Dev | Prod |
|---------|-----|------|
| Lambda error rate warning | 10% | 5% |
| RDS CPU warning | 90% | 80% |
| Missing traffic alarm | Disabled | Enabled |
| Critical alarm routing | Warning Topic | Critical Topic |
| X-Ray sampling rate | 100% | 5% |
| Log retention | 30 days | 90 days |
