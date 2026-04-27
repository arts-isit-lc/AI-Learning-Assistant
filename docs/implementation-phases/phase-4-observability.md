# Phase 4 — Observability & Reliability (Low Risk, Medium Impact)

## 4.1 Add CloudWatch Alarms

No alarms are configured. At minimum:
- Lambda error rate > 5% over 5 minutes
- Lambda duration > 80% of timeout
- API Gateway 5xx error rate > 1%
- RDS CPU > 80%
- RDS free storage < 20%
- SQS dead letter queue depth > 0

## 4.2 Enable X-Ray Tracing

X-Ray is enabled on AppSync but not on Lambda functions or API Gateway. Enable it across the stack to trace requests end-to-end (API Gateway → Lambda → RDS/Bedrock/DynamoDB).

## 4.3 Structured Logging

Python Lambdas use basic `logging.basicConfig()`. Adopt AWS Lambda Powertools structured logging (already installed via the Powertools layer) for consistent JSON log output with correlation IDs, which makes CloudWatch Insights queries much easier.
