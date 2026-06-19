# Requirements Document

## Introduction

This feature adds observability and reliability infrastructure to the AI Learning Assistant (AILA) application. The application is an AWS CDK-based system with ~15 Lambda functions (Node.js and Python), an API Gateway REST API, an AppSync GraphQL API, an RDS PostgreSQL database with RDS Proxy, SQS FIFO queues, and S3 buckets. Currently, the application has no CloudWatch alarms, incomplete X-Ray tracing (only on AppSync), inconsistent logging practices across Lambda functions, no dead letter queue on the SQS FIFO queue, and no log retention policies on Lambda functions. This feature addresses these gaps to enable proactive incident detection, end-to-end request tracing, consistent structured logging, and cost-controlled log retention.

## Glossary

- **Alarm_Infrastructure**: The set of CloudWatch Alarms, SNS Topics, and associated configurations that detect and notify operators of anomalous system behavior.
- **Tracing_Infrastructure**: The AWS X-Ray tracing configuration applied to API Gateway, Lambda functions, and container-based Lambda functions to enable end-to-end distributed tracing.
- **Logging_Infrastructure**: The structured logging configuration using AWS Lambda Powertools Logger across all Python Lambda functions, replacing basic `logging.basicConfig()` and bare `print()` statements.
- **CDK_Stack**: The AWS CDK TypeScript infrastructure-as-code definitions in `cdk/lib/` that define all AWS resources for the application.
- **Operator**: A system administrator or DevOps engineer responsible for monitoring and maintaining the AILA application.
- **Container_Lambda**: A Lambda function deployed using Docker container images (TextGenLambdaDockerFunc, DataIngestLambdaDockerFunc, SQSTriggerDockerFunc).
- **Zip_Lambda**: A Lambda function deployed using inline code or zip archives with Python 3.11 or Node.js 22.x runtime.
- **Dead_Letter_Queue**: An SQS queue that receives messages that could not be successfully processed by the primary consumer after a configured number of retries.
- **Powertools_Logger**: The AWS Lambda Powertools for Python `Logger` class that produces structured JSON log output with correlation IDs and Lambda context injection.
- **SNS_Warning_Topic**: An Amazon SNS topic that receives warning-level alarm notifications for non-urgent issues requiring attention during business hours.
- **SNS_Critical_Topic**: An Amazon SNS topic that receives critical-level alarm notifications for urgent issues requiring immediate response.
- **Log_Retention_Policy**: A CloudWatch Logs configuration that automatically deletes log data after a specified number of days.
- **CloudWatch_Dashboard**: A CloudWatch Dashboard that provides a consolidated view of key operational metrics and alarm states across the application.
- **Sampling_Rule**: An X-Ray sampling rule that controls the percentage of requests traced to balance observability with cost.
- **Log_Schema**: The standardized set of fields that every structured log entry must contain for consistent querying and correlation.
- **Composite_Alarm**: A CloudWatch Composite Alarm that combines multiple individual alarm states using boolean logic to reduce alert noise during cascading failures.
- **Traffic_Baseline_Alarm**: A CloudWatch Alarm that detects unexpected absence of traffic, indicating potential DNS, routing, or upstream failures.

## Requirements

### Requirement 1: SNS Alarm Notification Topics with Severity Levels

**User Story:** As an Operator, I want alarm notifications routed to separate topics by severity, so that I can configure different notification channels for warnings versus critical alerts.

#### Acceptance Criteria

1. THE CDK_Stack SHALL create an SNS_Warning_Topic for non-urgent alarm notifications.
2. THE CDK_Stack SHALL create an SNS_Critical_Topic for urgent alarm notifications requiring immediate response.
3. THE SNS_Warning_Topic and SNS_Critical_Topic SHALL be configured with server-side encryption enabled.
4. THE CDK_Stack SHALL export the SNS_Warning_Topic ARN and SNS_Critical_Topic ARN as CloudFormation outputs for external subscription configuration.
5. THE CDK_Stack SHALL create an email subscription for `vincent.lam@ubc.ca` on both the SNS_Warning_Topic and the SNS_Critical_Topic so that all alarm notifications are delivered to that address.

### Requirement 2: Lambda Error Rate Alarms with Noise Control

**User Story:** As an Operator, I want to be alerted when any Lambda function's error rate exceeds a threshold with noise-resistant evaluation, so that I receive reliable alerts without false positives from transient spikes.

#### Acceptance Criteria

1. WHEN the error rate of any Lambda function exceeds 5% for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the corresponding warning alarm to the ALARM state.
2. WHEN the error rate of any Lambda function exceeds 25% for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the corresponding critical alarm to the ALARM state.
3. WHEN a Lambda error rate warning alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Warning_Topic.
4. WHEN a Lambda error rate critical alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Critical_Topic.
5. THE Alarm_Infrastructure SHALL create one warning and one critical error rate alarm per Lambda function deployed in the CDK_Stack.
6. THE Alarm_Infrastructure SHALL use the Math Expression `(errors / invocations) * 100` to calculate the error rate percentage.
7. THE Alarm_Infrastructure SHALL treat missing data as "notBreaching" on all Lambda error rate alarms to avoid false alarms during periods of zero invocations.
8. THE Alarm_Infrastructure SHALL include a descriptive alarm description on each alarm that identifies the function name and the metric being monitored, following the runbook guidance patterns defined in Requirement 23.

### Requirement 3: Lambda Duration Alarms

**User Story:** As an Operator, I want to be alerted when any Lambda function's execution duration approaches its configured timeout, so that I can investigate performance degradation before timeouts occur.

#### Acceptance Criteria

1. WHEN the p99 duration of any Lambda function exceeds 80% of its configured timeout for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the corresponding alarm to the ALARM state.
2. WHEN a Lambda duration alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Warning_Topic.
3. THE Alarm_Infrastructure SHALL create one duration alarm per Lambda function deployed in the CDK_Stack.
4. THE Alarm_Infrastructure SHALL treat missing data as "notBreaching" on all Lambda duration alarms.

### Requirement 4: Lambda Throttle and Concurrency Alarms

**User Story:** As an Operator, I want to be alerted when Lambda functions are being throttled, so that I can request concurrency limit increases or investigate runaway invocations before they impact availability.

#### Acceptance Criteria

1. WHEN the Throttles metric for any Lambda function exceeds 0 for 2 out of 3 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the corresponding alarm to the ALARM state.
2. WHEN a Lambda throttle alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Critical_Topic.
3. THE Alarm_Infrastructure SHALL create one throttle alarm per Lambda function deployed in the CDK_Stack.

### Requirement 5: SQS Consumer Processing Delay Alarm

**User Story:** As an Operator, I want to be alerted when the SQS-triggered Lambda falls behind in processing messages, so that I can investigate consumer performance before the backlog becomes unmanageable.

#### Acceptance Criteria

1. WHEN the difference between the ApproximateAgeOfOldestMessage on the messagesQueue and the expected processing time exceeds 300 seconds (5 minutes) for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the alarm to the ALARM state.
2. WHEN the consumer delay alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Warning_Topic.
3. THE Alarm_Infrastructure SHALL treat missing data as "notBreaching" on the consumer delay alarm.

### Requirement 6: API Gateway 5xx Error Rate Alarm

**User Story:** As an Operator, I want to be alerted when the API Gateway returns an elevated rate of server errors, so that I can investigate backend failures affecting API consumers.

#### Acceptance Criteria

1. WHEN the API Gateway 5xx error rate exceeds 1% of total requests AND the total request count exceeds 50 over a 5-minute evaluation period for 3 out of 5 consecutive datapoints, THE Alarm_Infrastructure SHALL transition the warning alarm to the ALARM state.
2. WHEN the API Gateway 5xx error rate exceeds 5% of total requests AND the total request count exceeds 50 over a 5-minute evaluation period for 3 out of 5 consecutive datapoints, THE Alarm_Infrastructure SHALL transition the critical alarm to the ALARM state.
3. WHEN an API Gateway alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the corresponding severity SNS topic.
4. THE Alarm_Infrastructure SHALL treat missing data as "notBreaching" on all API Gateway alarms to avoid false alarms during periods of zero traffic.
5. THE Alarm_Infrastructure SHALL use a minimum request volume threshold of 50 requests per evaluation period to prevent percentage-based alarms from firing on statistically insignificant sample sizes.

### Requirement 7: RDS Database Alarms

**User Story:** As an Operator, I want to be alerted when the RDS database shows signs of resource pressure including high CPU, low storage, high connection count, or elevated latency, so that I can take corrective action before the database becomes unresponsive.

#### Acceptance Criteria

1. WHEN the RDS instance CPUUtilization exceeds 80% for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the CPU warning alarm to the ALARM state and publish to the SNS_Warning_Topic.
2. WHEN the RDS instance CPUUtilization exceeds 95% for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the CPU critical alarm to the ALARM state and publish to the SNS_Critical_Topic.
3. WHEN the RDS instance FreeStorageSpace falls below 20% of the allocated storage for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the storage warning alarm to the ALARM state and publish to the SNS_Warning_Topic.
4. WHEN the RDS instance FreeStorageSpace falls below 10% of the allocated storage for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the storage critical alarm to the ALARM state and publish to the SNS_Critical_Topic.
5. WHEN the RDS instance DatabaseConnections exceeds 80% of the instance class max_connections limit (calculated based on the deployed instance type: 70 for db.t3.micro, 120 for db.t3.medium) for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the connections alarm to the ALARM state and publish to the SNS_Warning_Topic.
6. WHEN the RDS instance ReadLatency or WriteLatency exceeds 100 milliseconds for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the latency alarm to the ALARM state and publish to the SNS_Warning_Topic.

### Requirement 8: SQS Dead Letter Queue and Alarms

**User Story:** As an Operator, I want failed SQS messages to be moved to a dead letter queue and be alerted when messages arrive there or the main queue backs up, so that I can investigate failures and prevent silent processing delays.

#### Acceptance Criteria

1. THE CDK_Stack SHALL create a Dead_Letter_Queue as a FIFO queue associated with the existing messagesQueue.
2. THE CDK_Stack SHALL configure the messagesQueue to send messages to the Dead_Letter_Queue after 3 failed processing attempts.
3. WHEN the ApproximateNumberOfMessagesVisible in the Dead_Letter_Queue exceeds 0 for 1 out of 1 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the DLQ alarm to the ALARM state and publish to the SNS_Critical_Topic.
4. WHEN the ApproximateNumberOfMessagesVisible in the main messagesQueue exceeds 100 for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the queue depth alarm to the ALARM state and publish to the SNS_Warning_Topic.
5. WHEN the ApproximateAgeOfOldestMessage in the main messagesQueue exceeds 600 seconds for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the queue age alarm to the ALARM state and publish to the SNS_Warning_Topic.
6. THE Dead_Letter_Queue SHALL have the same encryption configuration as the messagesQueue.

### Requirement 9: AppSync Alarms

**User Story:** As an Operator, I want to be alerted when the AppSync GraphQL API experiences errors or elevated latency, so that I can investigate issues in the real-time notification and chat streaming layer independently of API Gateway.

#### Acceptance Criteria

1. WHEN the AppSync 5xx error count exceeds 0 for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the AppSync error alarm to the ALARM state and publish to the SNS_Warning_Topic.
2. WHEN the AppSync Latency p99 exceeds 5000 milliseconds for 3 out of 5 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the AppSync latency alarm to the ALARM state and publish to the SNS_Warning_Topic.

### Requirement 10: X-Ray Tracing on API Gateway

**User Story:** As an Operator, I want API Gateway requests traced with X-Ray, so that I can visualize the full request path from API Gateway through Lambda to downstream services.

#### Acceptance Criteria

1. THE CDK_Stack SHALL enable X-Ray tracing on the API Gateway deployment stage by setting `tracingEnabled: true` in the deployOptions.
2. WHEN a request passes through the API Gateway, THE Tracing_Infrastructure SHALL generate X-Ray trace segments for the API Gateway stage.

### Requirement 11: X-Ray Tracing on Lambda Functions

**User Story:** As an Operator, I want all Lambda functions to have X-Ray active tracing enabled, so that I can trace individual function invocations and their downstream calls.

#### Acceptance Criteria

1. THE CDK_Stack SHALL set `tracing: lambda.Tracing.ACTIVE` on every Zip_Lambda function definition.
2. THE CDK_Stack SHALL set `tracing: lambda.Tracing.ACTIVE` on every Container_Lambda function definition.
3. THE CDK_Stack SHALL grant each Lambda function's execution role the `xray:PutTraceSegments` and `xray:PutTelemetryRecords` permissions.

### Requirement 12: X-Ray SDK in Container Lambda Images

**User Story:** As an Operator, I want container-based Lambda functions to instrument downstream calls with the X-Ray SDK, so that database queries, S3 operations, and HTTP calls appear as subsegments in X-Ray traces.

#### Acceptance Criteria

1. THE Container_Lambda Docker images for TextGenLambdaDockerFunc, DataIngestLambdaDockerFunc, and SQSTriggerDockerFunc SHALL include the `aws-xray-sdk` Python package in their requirements.txt files.
2. THE Container_Lambda handler modules SHALL patch the `boto3` and `requests`/`httpx` libraries using the X-Ray SDK to capture downstream call traces.

### Requirement 13: X-Ray Sampling Strategy

**User Story:** As an Operator, I want X-Ray sampling rates configured per environment, so that I get full trace visibility in development without excessive cost in production.

#### Acceptance Criteria

1. WHILE the application is deployed in a non-production environment, THE CDK_Stack SHALL configure an X-Ray sampling rule with a fixed rate of 1.0 (100% of requests traced).
2. WHILE the application is deployed in a production environment, THE CDK_Stack SHALL configure an X-Ray sampling rule with a fixed rate of 0.05 (5% of requests traced) and a reservoir of 1 request per second.
3. THE CDK_Stack SHALL create the X-Ray sampling rule as a CDK resource scoped to the application's service name.

### Requirement 14: Structured Logging Migration for Container Lambdas

**User Story:** As an Operator, I want all Python container-based Lambda functions to use Powertools_Logger structured logging with a standardized schema, so that log output is consistent JSON with correlation IDs and queryable fields across the entire application.

#### Acceptance Criteria

1. THE Container_Lambda Docker images for TextGenLambdaDockerFunc, DataIngestLambdaDockerFunc, and SQSTriggerDockerFunc SHALL include the `aws-lambda-powertools` Python package in their requirements.txt files.
2. THE Container_Lambda handler modules (text_generation/src/main.py, data_ingestion/src/main.py, sqsTrigger/src/main.py) SHALL replace `logging.basicConfig()` and `logging.getLogger()` with Powertools_Logger instantiation.
3. THE Container_Lambda handler functions SHALL use the `@logger.inject_lambda_context` decorator to automatically include Lambda context in log output.
4. THE Container_Lambda handler modules SHALL remove all bare `print()` statements and replace them with appropriate Powertools_Logger method calls.
5. THE Powertools_Logger SHALL be configured with a `service` name parameter matching the Lambda function's logical purpose (e.g., "text-generation", "data-ingestion", "sqs-trigger").

### Requirement 15: Structured Logging Migration for Remaining Zip Lambdas

**User Story:** As an Operator, I want the remaining Python zip-deployed Lambda functions to use Powertools_Logger structured logging, so that all Python functions produce consistent structured log output.

#### Acceptance Criteria

1. THE Zip_Lambda function deleteLastMessage.py SHALL replace `logging.getLogger()` and `logger.setLevel()` with Powertools_Logger instantiation and use the `@logger.inject_lambda_context` decorator on its handler.
2. THE Zip_Lambda function eventNotification.py SHALL replace all bare `print()` statements with Powertools_Logger method calls and use the `@logger.inject_lambda_context` decorator on its handler.
3. THE CDK_Stack SHALL add the Powertools Lambda layer to the deleteLastMessage and eventNotification Lambda function definitions if not already present.
4. THE Powertools_Logger in deleteLastMessage.py SHALL be configured with the service name "delete-last-message".
5. THE Powertools_Logger in eventNotification.py SHALL be configured with the service name "event-notification".

### Requirement 16: Standardized Log Schema

**User Story:** As an Operator, I want all structured log entries to contain a consistent set of fields, so that I can write CloudWatch Insights queries that work across all functions without per-function customization.

#### Acceptance Criteria

1. THE Logging_Infrastructure SHALL ensure every Powertools_Logger instance is configured with a `service` name field identifying the function's purpose.
2. THE Logging_Infrastructure SHALL ensure every log entry automatically includes the `correlation_id` field derived from the X-Ray trace ID or API Gateway request ID when available.
3. THE Logging_Infrastructure SHALL ensure every log entry includes the `level`, `timestamp`, `service`, `function_name`, and `message` fields through Powertools_Logger default behavior and Lambda context injection.
4. WHEN a Lambda function processes a request with identifiable user context, THE Logging_Infrastructure SHALL append a `user_id` or `session_id` key to log entries using Powertools_Logger `append_keys()` for request-scoped correlation.

### Requirement 17: Lambda Log Retention Policies

**User Story:** As an Operator, I want Lambda function log groups to have retention policies, so that logs are automatically deleted after a defined period to control CloudWatch Logs storage costs.

#### Acceptance Criteria

1. THE CDK_Stack SHALL configure a log retention policy of 30 days on every Lambda function's CloudWatch log group in non-production environments.
2. THE CDK_Stack SHALL configure a log retention policy of 90 days on every Lambda function's CloudWatch log group in production environments.
3. THE CDK_Stack SHALL set the `logRetention` property on each Lambda function definition to enforce the retention policy.

### Requirement 18: Cold Start Logging

**User Story:** As an Operator, I want visibility into Lambda cold start occurrences and durations, so that I can identify functions with slow initialization and optimize container image sizes or provisioned concurrency.

#### Acceptance Criteria

1. THE Logging_Infrastructure SHALL configure Powertools_Logger with `log_event=False` and `log_uncaught_exceptions=True` on all Python Lambda functions to capture unhandled errors.
2. THE Powertools_Logger `@logger.inject_lambda_context` decorator SHALL be configured with `clear_state=True` on all Python Lambda functions to ensure clean state between invocations.
3. THE CloudWatch_Dashboard SHALL include a widget displaying the Init Duration metric for Container_Lambda functions to visualize cold start frequency and duration.

### Requirement 19: Environment-Specific Alarm Configuration

**User Story:** As an Operator, I want alarm thresholds and notification behavior to differ between environments, so that development alarms do not trigger off-hours notifications and production alarms have tighter thresholds.

#### Acceptance Criteria

1. WHILE the application is deployed in a non-production environment, THE Alarm_Infrastructure SHALL only publish alarm notifications to the SNS_Warning_Topic regardless of alarm severity.
2. WHILE the application is deployed in a production environment, THE Alarm_Infrastructure SHALL publish warning alarms to the SNS_Warning_Topic and critical alarms to the SNS_Critical_Topic.
3. THE CDK_Stack SHALL accept an `environment` context parameter that controls alarm threshold selection and notification routing.
4. WHILE the application is deployed in a non-production environment, THE Alarm_Infrastructure SHALL use relaxed thresholds: Lambda error rate warning at 10% (instead of 5%), RDS CPU warning at 90% (instead of 80%).

### Requirement 20: CloudWatch Dashboard

**User Story:** As an Operator, I want a consolidated CloudWatch Dashboard showing key metrics and alarm states, so that I can quickly determine whether something is broken and identify the source of issues from a single view.

#### Acceptance Criteria

1. THE CDK_Stack SHALL create a CloudWatch_Dashboard with widgets displaying Lambda error counts and duration metrics for all Lambda functions.
2. THE CloudWatch_Dashboard SHALL include a widget displaying API Gateway 5xx and 4xx error counts and latency.
3. THE CloudWatch_Dashboard SHALL include a widget displaying RDS CPUUtilization, FreeStorageSpace, DatabaseConnections, and ReadLatency metrics.
4. THE CloudWatch_Dashboard SHALL include a widget displaying the SQS messagesQueue ApproximateNumberOfMessagesVisible and the Dead_Letter_Queue depth.
5. THE CloudWatch_Dashboard SHALL include an alarm status widget showing the current state of all alarms created by the Alarm_Infrastructure.
6. THE CloudWatch_Dashboard SHALL include a widget displaying AppSync error counts and latency metrics.
7. THE CloudWatch_Dashboard SHALL include a widget displaying Lambda Init Duration metrics for Container_Lambda functions.

### Requirement 21: Composite Alarms for Alert Storm Reduction

**User Story:** As an Operator, I want composite alarms that aggregate related individual alarms, so that during a cascading failure I receive a single high-level alert instead of dozens of individual notifications.

#### Acceptance Criteria

1. THE Alarm_Infrastructure SHALL create a Composite_Alarm named "SystemHealthCritical" that enters the ALARM state when two or more of the following conditions are simultaneously in ALARM: any Lambda critical error rate alarm, the API Gateway critical 5xx alarm, or the RDS CPU critical alarm.
2. WHEN the SystemHealthCritical Composite_Alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Critical_Topic.
3. THE Alarm_Infrastructure SHALL create a Composite_Alarm named "DataPipelineHealth" that enters the ALARM state when the DLQ alarm AND either the SQS queue depth alarm or the SQS queue age alarm are simultaneously in ALARM.
4. WHEN the DataPipelineHealth Composite_Alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Critical_Topic.
5. THE Composite_Alarm descriptions SHALL include a summary of which child alarms are aggregated and suggest checking the CloudWatch_Dashboard for detailed alarm states.

### Requirement 22: Missing Traffic Alarm

**User Story:** As an Operator, I want to be alerted when the API Gateway stops receiving traffic unexpectedly, so that I can detect DNS failures, upstream routing issues, or WAF misconfigurations that silently prevent users from reaching the application.

#### Acceptance Criteria

1. WHEN the API Gateway request Count metric equals 0 for 15 consecutive 1-minute datapoints, THE Alarm_Infrastructure SHALL transition the missing traffic alarm to the ALARM state.
2. THE Alarm_Infrastructure SHALL treat missing data as "breaching" on the missing traffic alarm so that the absence of metric data itself triggers the alarm.
3. WHEN the missing traffic alarm transitions to the ALARM state, THE Alarm_Infrastructure SHALL publish a notification to the SNS_Critical_Topic.
4. THE missing traffic alarm description SHALL suggest checking DNS resolution, WAF rules, API Gateway deployment status, and upstream client health as potential root causes.
5. WHILE the application is deployed in a non-production environment, THE Alarm_Infrastructure SHALL disable the missing traffic alarm to avoid false positives from expected periods of zero traffic in development.

### Requirement 23: Alarm Descriptions with Runbook Guidance

**User Story:** As an Operator, I want every alarm to include actionable next-step guidance in its description, so that when I receive an alert I immediately know what to investigate without searching for documentation.

#### Acceptance Criteria

1. THE Alarm_Infrastructure SHALL include a runbook-style description on every alarm that contains: the alarm purpose, the metric being monitored, the threshold that was breached, and specific investigation steps.
2. THE Alarm_Infrastructure SHALL include the following guidance patterns in alarm descriptions:
   - Lambda error alarms: "Check CloudWatch Logs group /aws/lambda/{function-name}. Review recent deployments. Check downstream service health."
   - Lambda duration alarms: "Check X-Ray traces for slow downstream calls. Review memory allocation. Check for cold start impact."
   - Lambda throttle alarms: "Check account-level concurrent execution limits. Review reserved concurrency settings. Check for invocation spikes."
   - RDS alarms: "Check slow query logs. Review active connections. Check for long-running transactions."
   - SQS DLQ alarms: "Inspect DLQ messages for error patterns. Check consumer Lambda logs. Consider replaying messages after fix."
   - API Gateway alarms: "Check backend Lambda error rates. Review API Gateway execution logs. Check authorizer Lambda health."
   - Missing traffic alarms: "Verify DNS resolution. Check WAF rules for blocks. Verify API Gateway deployment. Check upstream client health."
