# Implementation Plan: Observability & Reliability

## Overview

This plan implements observability and reliability infrastructure across four pillars: alarm infrastructure, distributed tracing, structured logging, and an operational dashboard. The implementation follows the design's component structure — starting with API Gateway Stack modifications (tracing, log retention, DLQ), then container image changes (X-Ray SDK + Powertools Logger), zip Lambda changes, and finally the new ObservabilityStack (alarms, SNS topics, dashboard, sampling rules). CDK assertion tests validate each component.

## Tasks

- [x] 1. Modify API Gateway Stack for tracing, log retention, and DLQ
  - [x] 1.1 Enable X-Ray tracing on API Gateway and all Lambda functions
    - Add `tracingEnabled: true` to the `deployOptions` in the SpecRestApi definition
    - Add `tracing: lambda.Tracing.ACTIVE` to every Lambda function definition (zip and container)
    - Add `xray:PutTraceSegments` and `xray:PutTelemetryRecords` permissions to all Lambda execution roles
    - _Requirements: 10.1, 10.2, 11.1, 11.2, 11.3_

  - [x] 1.2 Add log retention policies to all Lambda functions
    - Add `logRetention: logs.RetentionDays.ONE_MONTH` (30 days) for non-production environments
    - Add `logRetention: logs.RetentionDays.THREE_MONTHS` (90 days) for production environments
    - Use the existing `environment` variable to select the retention period
    - Import `aws-cdk-lib/aws-logs` if not already imported
    - _Requirements: 17.1, 17.2, 17.3_

  - [x] 1.3 Create Dead Letter Queue for messagesQueue
    - Create a FIFO DLQ (`sqs.Queue` with `fifo: true`) associated with the existing `messagesQueue`
    - Configure `messagesQueue` with `deadLetterQueue: { queue: dlq, maxReceiveCount: 3 }`
    - Ensure DLQ has the same encryption configuration as the messagesQueue
    - Export the DLQ as a public property for the ObservabilityStack to reference
    - _Requirements: 8.1, 8.2, 8.6_

  - [x] 1.4 Export Lambda function metadata for ObservabilityStack
    - Create a public `lambdaFunctionInfos: LambdaFunctionInfo[]` property on ApiGatewayStack
    - Populate it with each Lambda's `functionName`, `timeoutSeconds`, and `isContainer` flag
    - Export `messagesQueueDlq` and `messagesQueue` references as public properties
    - Export `appSyncApiId` as a public property
    - _Requirements: 2.5, 3.3, 4.3_

  - [x] 1.5 Add Powertools layer to eventNotification Lambda
    - Attach the existing `powertoolsLayer` to the eventNotification Lambda function definition
    - _Requirements: 15.3_

- [x] 2. Checkpoint - Verify API Gateway Stack changes compile
  - Ensure `npx tsc --noEmit` passes in the cdk directory, ask the user if questions arise.

- [x] 3. Update container images with X-Ray SDK and Powertools Logger
  - [x] 3.1 Add dependencies to all container requirements.txt files
    - Add `aws-xray-sdk` and `aws-lambda-powertools` to `cdk/text_generation/requirements.txt`
    - Add `aws-xray-sdk` and `aws-lambda-powertools` to `cdk/data_ingestion/requirements.txt`
    - Add `aws-xray-sdk` and `aws-lambda-powertools` to `cdk/sqsTrigger/requirements.txt`
    - _Requirements: 12.1, 14.1_

  - [x] 3.2 Migrate text_generation/src/main.py to Powertools Logger + X-Ray SDK
    - Replace `logging.basicConfig(level=logging.INFO)` and `logging.getLogger()` with `from aws_lambda_powertools import Logger` and `logger = Logger(service="text-generation")`
    - Add X-Ray SDK patching at module level: `from aws_xray_sdk.core import patch_all; patch_all()` wrapped in try/except
    - Configure `xray_recorder` with `context_missing='LOG_ERROR'`
    - Add `@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)` decorator to the handler
    - Add `logger.append_keys(session_id=..., course_id=...)` for request-scoped correlation
    - Remove all bare `print()` statements (replace with logger calls if needed)
    - _Requirements: 12.2, 14.2, 14.3, 14.4, 14.5, 16.1, 16.2, 16.3, 16.4, 18.1, 18.2_

  - [x] 3.3 Migrate data_ingestion/src/main.py to Powertools Logger + X-Ray SDK
    - Replace `logging.basicConfig(level=logging.INFO)` and `logging.getLogger()` with Powertools Logger (service="data-ingestion")
    - Add X-Ray SDK patching at module level wrapped in try/except
    - Configure `xray_recorder` with `context_missing='LOG_ERROR'`
    - Add `@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)` decorator to the handler
    - Replace all bare `print()` statements with logger calls
    - _Requirements: 12.2, 14.2, 14.3, 14.4, 14.5, 16.1, 16.3, 18.1, 18.2_

  - [x] 3.4 Migrate sqsTrigger/src/main.py to Powertools Logger + X-Ray SDK
    - Replace `logging.basicConfig(level=logging.INFO)` and `logging.getLogger()` with Powertools Logger (service="sqs-trigger")
    - Add X-Ray SDK patching at module level wrapped in try/except
    - Configure `xray_recorder` with `context_missing='LOG_ERROR'`
    - Add `@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)` decorator to the handler
    - Replace all bare `print()` statements with logger calls
    - Add `logger.append_keys(course_id=..., request_id=...)` for request-scoped correlation
    - _Requirements: 12.2, 14.2, 14.3, 14.4, 14.5, 16.1, 16.3, 16.4, 18.1, 18.2_

- [x] 4. Migrate zip Lambda functions to Powertools Logger
  - [x] 4.1 Migrate deleteLastMessage.py to Powertools Logger
    - Replace `logging.getLogger()` and `logger.setLevel(logging.INFO)` with `from aws_lambda_powertools import Logger` and `logger = Logger(service="delete-last-message")`
    - Add `@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)` decorator to `lambda_handler`
    - Add `logger.append_keys(session_id=session_id)` after extracting session_id
    - _Requirements: 15.1, 15.4, 16.1, 16.4, 18.1, 18.2_

  - [x] 4.2 Migrate eventNotification.py to Powertools Logger
    - Replace all `print()` statements with Powertools Logger calls (service="event-notification")
    - Add `from aws_lambda_powertools import Logger` and `logger = Logger(service="event-notification")`
    - Add `@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)` decorator to `lambda_handler`
    - _Requirements: 15.2, 15.5, 16.1, 16.3, 18.1, 18.2_

- [x] 5. Checkpoint - Verify container and Lambda changes
  - Ensure all Python files have valid syntax (`python -m py_compile` on each modified file), ask the user if questions arise.

- [x] 6. Create ObservabilityStack with SNS topics and alarm infrastructure
  - [x] 6.1 Create the ObservabilityStack file with constructor and SNS topics
    - Create `cdk/lib/observability-stack.ts`
    - Define `ObservabilityStackProps` interface with all required references (apiGatewayRestApiId, lambdaFunctions, rdsInstanceId, etc.)
    - Create SNS Warning Topic and Critical Topic with KMS server-side encryption
    - Export topic ARNs as CloudFormation outputs
    - Create an email subscription for `vincent.lam@ubc.ca` on both the Warning and Critical SNS topics
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 6.2 Implement Lambda error rate alarms (warning + critical per function)
    - Create math expression alarms using `(errors / invocations) * 100`
    - Warning threshold: 5% prod / 10% dev, Critical threshold: 25%
    - Evaluation: 3 of 5 datapoints, 1-minute period
    - Treat missing data as "notBreaching"
    - Route warning to SNS_Warning_Topic, critical to SNS_Critical_Topic (prod) or both to warning (dev)
    - Include runbook-style alarm descriptions per Requirement 23
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 19.1, 19.2, 19.4, 23.1, 23.2_

  - [x] 6.3 Implement Lambda duration alarms (per function)
    - Create p99 duration alarm with threshold at 80% of configured timeout
    - Evaluation: 3 of 5 datapoints, 1-minute period
    - Treat missing data as "notBreaching"
    - Route to SNS_Warning_Topic
    - Include runbook-style alarm description
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 23.2_

  - [x] 6.4 Implement Lambda throttle alarms (per function)
    - Create throttle alarm with threshold > 0
    - Evaluation: 2 of 3 datapoints, 1-minute period
    - Route to SNS_Critical_Topic (prod) or SNS_Warning_Topic (dev)
    - Include runbook-style alarm description
    - _Requirements: 4.1, 4.2, 4.3, 19.1, 23.2_

  - [x] 6.5 Implement API Gateway 5xx alarms (warning + critical) and missing traffic alarm
    - Create 5xx rate alarms using math expressions with minimum request volume threshold of 50
    - Warning: 1% threshold, Critical: 5% threshold, 5-minute evaluation period, 3 of 5 datapoints
    - Treat missing data as "notBreaching" on 5xx alarms
    - Create missing traffic alarm: Count == 0 for 15 consecutive 1-minute datapoints
    - Missing traffic alarm uses treatMissingDataAs "breaching"
    - Disable missing traffic alarm in non-production environments
    - Include runbook-style alarm descriptions
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 22.1, 22.2, 22.3, 22.4, 22.5, 19.1, 23.2_

  - [x] 6.6 Implement RDS database alarms
    - CPU alarms: warning at 80% prod / 90% dev, critical at 95%
    - Storage alarms: warning at 20% free, critical at 10% free (calculated from allocatedStorage)
    - Connections alarm: warning at 80% of max_connections (based on instance class lookup)
    - Latency alarm: ReadLatency or WriteLatency > 100ms
    - All use 3 of 5 datapoints, 1-minute period, treatMissingDataAs "notBreaching"
    - Include runbook-style alarm descriptions
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 19.4, 23.2_

  - [x] 6.7 Implement SQS and DLQ alarms
    - DLQ depth alarm: > 0 messages, 1 of 1 datapoints, route to critical
    - Queue depth alarm: > 100 messages, 3 of 5 datapoints, route to warning
    - Queue age alarm: > 600 seconds, 3 of 5 datapoints, route to warning
    - Consumer delay alarm: ApproximateAgeOfOldestMessage > 300 seconds, 3 of 5 datapoints, route to warning
    - Treat missing data as "notBreaching" on consumer delay alarm
    - Include runbook-style alarm descriptions
    - _Requirements: 5.1, 5.2, 5.3, 8.3, 8.4, 8.5, 23.2_

  - [x] 6.8 Implement AppSync alarms
    - 5xx error alarm: count > 0, 3 of 5 datapoints, route to warning
    - Latency alarm: p99 > 5000ms, 3 of 5 datapoints, route to warning
    - _Requirements: 9.1, 9.2_

  - [x] 6.9 Implement composite alarms
    - Create "SystemHealthCritical" composite alarm: ALARM when 2+ of (any Lambda critical error, API Gateway critical 5xx, RDS CPU critical) are in ALARM
    - Create "DataPipelineHealth" composite alarm: ALARM when DLQ alarm AND (queue depth OR queue age) are in ALARM
    - Route both to SNS_Critical_Topic
    - Include descriptions summarizing child alarms and suggesting dashboard check
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5_

  - [x] 6.10 Implement CloudWatch Dashboard
    - Lambda error counts and duration metrics widget for all Lambda functions
    - API Gateway 5xx, 4xx error counts and latency widget
    - RDS CPUUtilization, FreeStorageSpace, DatabaseConnections, ReadLatency widget
    - SQS messagesQueue depth and DLQ depth widget
    - Alarm status widget showing all alarm states
    - AppSync error counts and latency widget
    - Lambda Init Duration widget for container Lambda functions
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 18.3_

  - [x] 6.11 Implement X-Ray sampling rule
    - Create X-Ray sampling rule as a CDK resource scoped to the application service name
    - Dev: fixedRate 1.0, reservoirSize 10
    - Prod: fixedRate 0.05, reservoirSize 1
    - _Requirements: 13.1, 13.2, 13.3_

- [x] 7. Wire ObservabilityStack into the CDK app
  - [x] 7.1 Instantiate ObservabilityStack in the CDK app entry point
    - Import ObservabilityStack in `cdk/bin/` entry point file
    - Pass required props from ApiGatewayStack and DatabaseStack to ObservabilityStack
    - Add stack dependency so ObservabilityStack deploys after ApiGatewayStack
    - _Requirements: 19.3_

- [x] 8. Checkpoint - Verify full CDK synthesis
  - Run `npx cdk synth` to ensure all stacks synthesize without errors, ask the user if questions arise.

- [ ] 9. Write CDK assertion tests
  - [x] 9.1 Update test helper to include ObservabilityStack
    - Modify `cdk/test/helpers/stack-setup.ts` to instantiate ObservabilityStack with test props
    - Export the ObservabilityStack template for use in test files
    - _Requirements: 2.5, 3.3, 4.3_

  - [ ] 9.2 Write alarm resource tests (`cdk/test/observability-stack.test.ts`)
    - Test SNS topics are created with encryption enabled
    - Test Lambda error rate alarms exist for each function with correct thresholds
    - Test Lambda duration alarms exist with correct percentage-of-timeout thresholds
    - Test Lambda throttle alarms exist
    - Test API Gateway 5xx alarms exist with minimum request volume
    - Test missing traffic alarm exists with correct configuration
    - Test RDS alarms exist with correct thresholds
    - Test SQS/DLQ alarms exist
    - Test AppSync alarms exist
    - Test composite alarms reference correct child alarms
    - Test dashboard is created with expected widget count
    - Test environment-specific threshold differences (dev vs prod)
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 4.1, 6.1, 6.2, 7.1, 7.2, 8.3, 8.4, 9.1, 9.2, 19.4, 20.1, 21.1, 21.3_

  - [ ] 9.3 Write X-Ray tracing tests (`cdk/test/lambda-tracing.test.ts`)
    - Test all Lambda functions have `TracingConfig.Mode: Active`
    - Test API Gateway stage has `TracingEnabled: true`
    - Test X-Ray sampling rule is created with correct fixedRate per environment
    - _Requirements: 10.1, 11.1, 11.2, 13.1, 13.2_

  - [ ] 9.4 Write log retention tests (`cdk/test/log-retention.test.ts`)
    - Test all Lambda functions have logRetention set
    - Test dev environment uses 30-day retention
    - Test prod environment uses 90-day retention
    - _Requirements: 17.1, 17.2, 17.3_

  - [ ] 9.5 Write DLQ configuration tests (`cdk/test/dlq-configuration.test.ts`)
    - Test DLQ is created as a FIFO queue
    - Test messagesQueue has deadLetterQueue configured with maxReceiveCount 3
    - Test DLQ alarm fires on > 0 messages
    - _Requirements: 8.1, 8.2, 8.3, 8.6_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Run `npx jest` in the cdk directory to ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- No property-based tests are included — this is IaC/configuration work where CDK assertion tests are the appropriate testing strategy
- The existing `powertoolsLayer` in ApiGatewayStack is reused for zip Lambdas; container Lambdas install the package directly via requirements.txt
- The design specifies TypeScript for CDK code and Python for Lambda handler modifications
