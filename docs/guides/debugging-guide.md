# Debugging Guide

After the cost optimization changes (CO-8, CO-9), some logging is reduced or retention-limited. This guide covers how to effectively debug issues in both environments.

## What Changed

| Log Source | Before | After (Dev) | After (Prod) |
|---|---|---|---|
| RDS logs | Infinite retention | 14-day retention | 6-month retention |
| VPC Flow Logs | Infinite retention | 7-day retention | 6-month retention |
| API Gateway data trace | Full request/response bodies logged | Disabled | Disabled |
| RDS Enhanced Monitoring | 60s interval | Disabled | 60s interval |

## Debugging API Issues (Prod + Dev)

With `dataTraceEnabled: false`, API Gateway no longer logs full request/response bodies for successful requests. It still logs full details for errors (`loggingLevel: ERROR`).

**For error debugging:**
- Go to CloudWatch → Log Groups → `/aws/apigateway/AILA-ApiGatewayStack-API`
- Error responses (4xx, 5xx) still include full request context

**For non-error debugging (unexpected responses, wrong data):**
- Go to CloudWatch → Log Groups → pick the relevant Lambda function log group
- Lambda functions already have `console.log` / `console.error` statements that log business logic details (query parameters, user emails, response data)
- Use CloudWatch Logs Insights for fast searching:

```
# Find all invocations for a specific user
filter @message like "user@example.com"
| sort @timestamp desc
| limit 50
```

```
# Find errors in a specific Lambda
filter @message like "Error" or @message like "error"
| sort @timestamp desc
| limit 50
```

```
# Find slow invocations (over 5 seconds)
filter @type = "REPORT"
| filter @duration > 5000
| sort @duration desc
| limit 20
```

**If you need full request/response logging temporarily:**
- Set `dataTraceEnabled: true` in `api-gateway-stack.ts`
- Deploy to the target environment
- Reproduce the issue
- Set it back to `false` and redeploy

## Debugging Network/Connectivity Issues

VPC Flow Logs are still active in both environments — just retention-limited. For connectivity issues (Lambda can't reach RDS, Bedrock calls timing out):

- Go to CloudWatch → Log Groups → look for the VPC flow log group
- Filter for REJECT entries to find blocked connections:

```
filter action = "REJECT"
| sort @timestamp desc
| limit 50
```

- Check security group rules if you see unexpected REJECTs
- For dev, flow logs are retained for 7 days — investigate connectivity issues promptly

## Debugging Database Issues

RDS logs (slow queries, connection errors) are retained for 14 days (dev) / 6 months (prod).

- Go to CloudWatch → Log Groups → `/aws/rds/instance/AILA-DatabaseStack-...`
- For slow query analysis, enable `log_min_duration_statement` in the RDS parameter group if not already set

**RDS Enhanced Monitoring (prod only):**
- Go to RDS → select the instance → Monitoring → Enhanced Monitoring
- Shows OS-level metrics: CPU per process, memory breakdown, disk I/O, network
- Useful for diagnosing resource contention (e.g., is the DB CPU-bound or I/O-bound?)

For dev, Enhanced Monitoring is disabled. Use standard CloudWatch RDS metrics instead:
- RDS → Monitoring tab → shows CPU, connections, read/write IOPS, freeable memory at 5-minute granularity

## Lambda Memory/Performance Debugging

To check if a Lambda is running close to its memory limit:

```
# Run in CloudWatch Logs Insights against the function's log group
filter @type = "REPORT"
| stats max(@maxMemoryUsed / 1048576) as peakMemoryMB,
        avg(@maxMemoryUsed / 1048576) as avgMemoryMB,
        max(@memorySize / 1048576) as allocatedMB
| limit 1
```

If `peakMemoryMB` is approaching `allocatedMB`, the function needs more memory.
