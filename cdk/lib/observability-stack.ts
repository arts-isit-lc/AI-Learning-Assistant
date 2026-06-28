import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as kms from "aws-cdk-lib/aws-kms";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as xray from "aws-cdk-lib/aws-xray";
import { Construct } from "constructs";
import { LambdaFunctionInfo } from "./api-gateway-stack";

export interface ObservabilityStackProps extends cdk.StackProps {
  environment: string;
  apiGatewayRestApiId: string;
  apiGatewayStageName: string;
  lambdaFunctions: LambdaFunctionInfo[];
  rdsInstanceId: string;
  rdsAllocatedStorage: number;
  rdsInstanceClass: string;
  messagesQueueName: string;
  messagesQueueArn: string;
  dlqName: string;
  dlqArn: string;
  appSyncApiId: string;
  containerLambdaNames: string[];
}

export class ObservabilityStack extends cdk.Stack {
  public readonly warningTopic: sns.Topic;
  public readonly criticalTopic: sns.Topic;
  public readonly appEnvironment: string;
  public readonly isProd: boolean;
  public readonly lambdaErrorWarningAlarms: cloudwatch.Alarm[] = [];
  public readonly lambdaErrorCriticalAlarms: cloudwatch.Alarm[] = [];
  public readonly apiGateway5xxCriticalAlarm: cloudwatch.Alarm;
  public readonly rdsCpuCriticalAlarm: cloudwatch.Alarm;
  public readonly dlqAlarm: cloudwatch.Alarm;
  public readonly sqsQueueDepthAlarm: cloudwatch.Alarm;
  public readonly sqsQueueAgeAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    this.appEnvironment = props.environment;
    this.isProd = props.environment === "prod";

    // --- Alarm threshold configuration (environment-aware) ---
    const thresholds = this.getAlarmThresholds();

    // --- SNS Topics with KMS encryption ---
    const snsKey = kms.Alias.fromAliasName(this, "SnsKmsKey", "alias/aws/sns");

    this.warningTopic = new sns.Topic(this, "WarningTopic", {
      topicName: `AILA-${this.appEnvironment}-Warning`,
      displayName: `AILA ${this.appEnvironment} Warning Notifications`,
      masterKey: snsKey,
    });

    this.criticalTopic = new sns.Topic(this, "CriticalTopic", {
      topicName: `AILA-${this.appEnvironment}-Critical`,
      displayName: `AILA ${this.appEnvironment} Critical Notifications`,
      masterKey: snsKey,
    });

    // --- Email subscriptions ---
    // Only the Critical topic emails on-call. The Warning topic intentionally has
    // NO subscription: warning-level alarms remain visible on the dashboard and in
    // the console for investigation, but do not generate email (avoids alert fatigue).
    this.criticalTopic.addSubscription(
      new snsSubscriptions.EmailSubscription("vincent.lam@ubc.ca")
    );

    // --- CloudFormation outputs ---
    new cdk.CfnOutput(this, "WarningTopicArn", {
      value: this.warningTopic.topicArn,
      description: "ARN of the SNS Warning Topic for non-urgent alarm notifications",
      exportName: `AILA-${this.appEnvironment}-WarningTopicArn`,
    });

    new cdk.CfnOutput(this, "CriticalTopicArn", {
      value: this.criticalTopic.topicArn,
      description: "ARN of the SNS Critical Topic for urgent alarm notifications",
      exportName: `AILA-${this.appEnvironment}-CriticalTopicArn`,
    });

    // --- Alarm collection arrays for dashboard ---
    const lambdaDurationAlarms: cloudwatch.Alarm[] = [];
    const lambdaThrottleAlarms: cloudwatch.Alarm[] = [];

    // --- Lambda function tiering for alarm granularity ---
    // Tier 1 (critical path): Full alarms (error rate warning + critical, duration, throttle)
    // Tier 2 (supporting): Error rate alarms only (warning + critical)
    // Tier 3 (low priority): No direct alarms — covered by API Gateway 5xx and composite alarms
    const tier1Suffixes = [
      'TextGenLambdaDockerFunc',
      'DataIngestLambdaDockerFunc',
      'SQSTriggerDockerFunc',
      'studentFunction',
      'instructorFunction',
    ];
    const tier3Suffixes = [
      'adminLambdaAuthorizer',
      'studentLambdaAuthorizer',
      'instructorLambdaAuthorizer',
      'preSignupLambda',
      'addStudentOnSignUp',
      'adjustUserRoles',
      'AuthHandler',
    ];

    function getFunctionTier(functionName: string): 1 | 2 | 3 {
      if (tier1Suffixes.some(s => functionName.endsWith(s))) return 1;
      if (tier3Suffixes.some(s => functionName.includes(s))) return 3;
      return 2;
    }

    // --- Lambda alarms (tiered per function) ---
    for (const fn of props.lambdaFunctions) {
      const sanitizedName = fn.functionName.replace(/[^a-zA-Z0-9]/g, "");
      const tier = getFunctionTier(fn.functionName);

      // Tier 3 functions get no direct alarms
      if (tier === 3) continue;

      const errorsMetric = new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: "Sum",
        period: cdk.Duration.minutes(1),
      });

      const invocationsMetric = new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: "Sum",
        period: cdk.Duration.minutes(1),
      });

      // Warning alarm
      const errorRateWarning = new cloudwatch.MathExpression({
        expression: "(errors / invocations) * 100",
        usingMetrics: {
          errors: errorsMetric,
          invocations: invocationsMetric,
        },
        period: cdk.Duration.minutes(1),
        label: `${fn.functionName} Error Rate %`,
      });

      const warningAlarm = errorRateWarning.createAlarm(this, `${sanitizedName}ErrorRateWarning`, {
        alarmName: `AILA-${this.appEnvironment}-${fn.functionName}-ErrorRate-Warning`,
        alarmDescription: [
          `Lambda function ${fn.functionName} error rate exceeded ${thresholds.lambdaErrorRateWarning}%.`,
          `Metric: (Errors / Invocations) * 100 over 1-minute periods.`,
          `Threshold: ${thresholds.lambdaErrorRateWarning}% (warning).`,
          `Investigation steps:`,
          `  - Check CloudWatch Logs group /aws/lambda/${fn.functionName}.`,
          `  - Review recent deployments.`,
          `  - Check downstream service health.`,
        ].join("\n"),
        threshold: thresholds.lambdaErrorRateWarning,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      warningAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));
      this.lambdaErrorWarningAlarms.push(warningAlarm);

      // Critical alarm
      const errorRateCritical = new cloudwatch.MathExpression({
        expression: "(errors / invocations) * 100",
        usingMetrics: {
          errors: errorsMetric,
          invocations: invocationsMetric,
        },
        period: cdk.Duration.minutes(1),
        label: `${fn.functionName} Error Rate % (Critical)`,
      });

      const criticalAlarm = errorRateCritical.createAlarm(this, `${sanitizedName}ErrorRateCritical`, {
        alarmName: `AILA-${this.appEnvironment}-${fn.functionName}-ErrorRate-Critical`,
        alarmDescription: [
          `Lambda function ${fn.functionName} error rate exceeded ${thresholds.lambdaErrorRateCritical}%.`,
          `Metric: (Errors / Invocations) * 100 over 1-minute periods.`,
          `Threshold: ${thresholds.lambdaErrorRateCritical}% (critical).`,
          `Investigation steps:`,
          `  - Check CloudWatch Logs group /aws/lambda/${fn.functionName}.`,
          `  - Review recent deployments.`,
          `  - Check downstream service health.`,
        ].join("\n"),
        threshold: thresholds.lambdaErrorRateCritical,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      // Only the TextGen (chatbot) critical error rate is page-worthy email. Every
      // other Lambda's critical failures surface via the API Gateway 5xx Critical
      // and composite alarms, so they route to the silent Warning topic (dashboard
      // and console only — no email).
      const isCriticalPathFn = fn.functionName.endsWith("TextGenLambdaDockerFunc");
      criticalAlarm.addAlarmAction(
        new cloudwatchActions.SnsAction(isCriticalPathFn ? this.criticalTopic : this.warningTopic)
      );
      this.lambdaErrorCriticalAlarms.push(criticalAlarm);

      // --- Lambda duration alarm (p99, 80% of timeout) — Tier 1 only ---
      if (tier === 1) {
        const durationThresholdMs = fn.timeoutSeconds * 1000 * 0.80;

      const durationMetric = new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Duration",
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: "p99",
        period: cdk.Duration.minutes(1),
      });

      const durationAlarm = durationMetric.createAlarm(this, `${sanitizedName}DurationWarning`, {
        alarmName: `AILA-${this.appEnvironment}-${fn.functionName}-Duration-Warning`,
        alarmDescription: [
          `Lambda function ${fn.functionName} p99 duration exceeded 80% of its ${fn.timeoutSeconds}s timeout (${durationThresholdMs}ms).`,
          `Metric: Duration p99 over 1-minute periods.`,
          `Threshold: ${durationThresholdMs}ms (80% of ${fn.timeoutSeconds}s timeout).`,
          `Investigation steps:`,
          `  - Check X-Ray traces for slow downstream calls.`,
          `  - Review memory allocation.`,
          `  - Check for cold start impact.`,
        ].join("\n"),
        threshold: durationThresholdMs,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      durationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));
      lambdaDurationAlarms.push(durationAlarm);
      } // end tier 1 duration alarm

      // --- Lambda throttle alarm (any throttle) — Tier 1 only ---
      if (tier === 1) {
      const throttleMetric = new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: "Sum",
        period: cdk.Duration.minutes(1),
      });

      const throttleAlarm = throttleMetric.createAlarm(this, `${sanitizedName}ThrottleAlarm`, {
        alarmName: `AILA-${this.appEnvironment}-${fn.functionName}-Throttle`,
        alarmDescription: [
          `Lambda function ${fn.functionName} is being throttled.`,
          `Metric: Throttles Sum over 1-minute periods.`,
          `Threshold: > 0 (any throttle event).`,
          `Investigation steps:`,
          `  - Check account-level concurrent execution limits.`,
          `  - Review reserved concurrency settings.`,
          `  - Check for invocation spikes.`,
        ].join("\n"),
        threshold: 0,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      // Throttles are not in the critical-email set — route to the silent Warning topic.
      throttleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));
      lambdaThrottleAlarms.push(throttleAlarm);
      } // end tier 1 throttle alarm
    }

    // --- API Gateway 5xx error rate alarms (Req 6.1, 6.2, 6.3, 6.4, 6.5) ---
    const apiGw5xxMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "5XXError",
      dimensionsMap: { ApiName: props.apiGatewayRestApiId },
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    });

    const apiGwRequestsMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensionsMap: { ApiName: props.apiGatewayRestApiId },
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    });

    // 5xx Warning alarm (1% threshold with minimum 50 requests)
    const apiGw5xxWarningExpression = new cloudwatch.MathExpression({
      expression: "IF(requests > 50, (errors5xx / requests) * 100, 0)",
      usingMetrics: {
        errors5xx: apiGw5xxMetric,
        requests: apiGwRequestsMetric,
      },
      period: cdk.Duration.minutes(5),
      label: "API Gateway 5xx Error Rate %",
    });

    const apiGw5xxWarningAlarm = apiGw5xxWarningExpression.createAlarm(this, "ApiGw5xxWarning", {
      alarmName: `AILA-${this.appEnvironment}-ApiGateway-5xx-Warning`,
      alarmDescription: [
        `API Gateway 5xx error rate exceeded ${thresholds.apiGateway5xxWarning}% (minimum ${thresholds.apiGatewayMinRequests} requests required).`,
        `Metric: IF(requests > ${thresholds.apiGatewayMinRequests}, (5XXError / Count) * 100, 0) over 5-minute periods.`,
        `Threshold: ${thresholds.apiGateway5xxWarning}% (warning).`,
        `Investigation steps:`,
        `  - Check backend Lambda error rates.`,
        `  - Review API Gateway execution logs.`,
        `  - Check authorizer Lambda health.`,
      ].join("\n"),
      threshold: thresholds.apiGateway5xxWarning,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    apiGw5xxWarningAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // 5xx Critical alarm (5% threshold with minimum 50 requests)
    const apiGw5xxCriticalExpression = new cloudwatch.MathExpression({
      expression: "IF(requests > 50, (errors5xx / requests) * 100, 0)",
      usingMetrics: {
        errors5xx: apiGw5xxMetric,
        requests: apiGwRequestsMetric,
      },
      period: cdk.Duration.minutes(5),
      label: "API Gateway 5xx Error Rate % (Critical)",
    });

    this.apiGateway5xxCriticalAlarm = apiGw5xxCriticalExpression.createAlarm(this, "ApiGw5xxCritical", {
      alarmName: `AILA-${this.appEnvironment}-ApiGateway-5xx-Critical`,
      alarmDescription: [
        `API Gateway 5xx error rate exceeded ${thresholds.apiGateway5xxCritical}% (minimum ${thresholds.apiGatewayMinRequests} requests required).`,
        `Metric: IF(requests > ${thresholds.apiGatewayMinRequests}, (5XXError / Count) * 100, 0) over 5-minute periods.`,
        `Threshold: ${thresholds.apiGateway5xxCritical}% (critical).`,
        `Investigation steps:`,
        `  - Check backend Lambda error rates.`,
        `  - Review API Gateway execution logs.`,
        `  - Check authorizer Lambda health.`,
      ].join("\n"),
      threshold: thresholds.apiGateway5xxCritical,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Critical: always emails (Critical topic) in every environment.
    this.apiGateway5xxCriticalAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // --- Missing traffic alarm (Req 22.1, 22.2, 22.3, 22.4, 22.5) ---
    const apiGwTrafficMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensionsMap: { ApiName: props.apiGatewayRestApiId },
      statistic: "Sum",
      period: cdk.Duration.minutes(1),
    });

    const missingTrafficAlarm = apiGwTrafficMetric.createAlarm(this, "ApiGwMissingTraffic", {
      alarmName: `AILA-${this.appEnvironment}-ApiGateway-MissingTraffic`,
      alarmDescription: [
        `API Gateway has received zero requests for ${thresholds.missingTrafficMinutes} consecutive minutes.`,
        `Metric: Count Sum over 1-minute periods.`,
        `Threshold: 0 requests for ${thresholds.missingTrafficMinutes} consecutive datapoints.`,
        `Investigation steps:`,
        `  - Verify DNS resolution.`,
        `  - Check WAF rules for blocks.`,
        `  - Verify API Gateway deployment.`,
        `  - Check upstream client health.`,
      ].join("\n"),
      threshold: 0,
      evaluationPeriods: thresholds.missingTrafficMinutes,
      datapointsToAlarm: thresholds.missingTrafficMinutes,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: this.isProd,
    });

    // Critical: always routes to the Critical (email) topic. Note actionsEnabled is
    // prod-only above, so a quiet dev environment never trips this on zero traffic.
    missingTrafficAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // --- RDS Database Alarms (Req 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 19.4, 23.2) ---

    // RDS instance class to max_connections lookup
    const maxConnectionsByInstanceClass: Record<string, number> = {
      "db.t3.micro": 70,
      "db.t3.medium": 120,
      "db.t3.large": 240,
    };
    const maxConnections = maxConnectionsByInstanceClass[props.rdsInstanceClass] ?? 120;

    const rdsDimensions = { DBInstanceIdentifier: props.rdsInstanceId };

    // --- RDS CPU Warning Alarm (Req 7.1, 19.4) ---
    const rdsCpuMetric = new cloudwatch.Metric({
      namespace: "AWS/RDS",
      metricName: "CPUUtilization",
      dimensionsMap: rdsDimensions,
      statistic: "Average",
      period: cdk.Duration.minutes(1),
    });

    const rdsCpuWarningAlarm = rdsCpuMetric.createAlarm(this, "RdsCpuWarning", {
      alarmName: `AILA-${this.appEnvironment}-RDS-CPU-Warning`,
      alarmDescription: [
        `RDS instance ${props.rdsInstanceId} CPU utilization exceeded ${thresholds.rdsCpuWarning}%.`,
        `Metric: CPUUtilization Average over 1-minute periods.`,
        `Threshold: ${thresholds.rdsCpuWarning}% (warning).`,
        `Investigation steps:`,
        `  - Check slow query logs.`,
        `  - Review active connections.`,
        `  - Check for long-running transactions.`,
      ].join("\n"),
      threshold: thresholds.rdsCpuWarning,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    rdsCpuWarningAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- RDS CPU Critical Alarm (Req 7.2) ---
    this.rdsCpuCriticalAlarm = rdsCpuMetric.createAlarm(this, "RdsCpuCritical", {
      alarmName: `AILA-${this.appEnvironment}-RDS-CPU-Critical`,
      alarmDescription: [
        `RDS instance ${props.rdsInstanceId} CPU utilization exceeded ${thresholds.rdsCpuCritical}%.`,
        `Metric: CPUUtilization Average over 1-minute periods.`,
        `Threshold: ${thresholds.rdsCpuCritical}% (critical).`,
        `Investigation steps:`,
        `  - Check slow query logs.`,
        `  - Review active connections.`,
        `  - Check for long-running transactions.`,
      ].join("\n"),
      threshold: thresholds.rdsCpuCritical,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Critical: always emails (Critical topic) in every environment.
    this.rdsCpuCriticalAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // --- RDS Storage Warning Alarm (Req 7.3) ---
    const storageWarningBytes = props.rdsAllocatedStorage * 1024 * 1024 * 1024 * 0.20;

    const rdsFreeStorageMetric = new cloudwatch.Metric({
      namespace: "AWS/RDS",
      metricName: "FreeStorageSpace",
      dimensionsMap: rdsDimensions,
      statistic: "Average",
      period: cdk.Duration.minutes(1),
    });

    const rdsStorageWarningAlarm = rdsFreeStorageMetric.createAlarm(this, "RdsStorageWarning", {
      alarmName: `AILA-${this.appEnvironment}-RDS-Storage-Warning`,
      alarmDescription: [
        `RDS instance ${props.rdsInstanceId} free storage space fell below 20% of ${props.rdsAllocatedStorage} GB allocated (${(storageWarningBytes / (1024 * 1024 * 1024)).toFixed(1)} GB).`,
        `Metric: FreeStorageSpace Average over 1-minute periods.`,
        `Threshold: ${storageWarningBytes} bytes (20% of allocated storage, warning).`,
        `Investigation steps:`,
        `  - Check slow query logs.`,
        `  - Review active connections.`,
        `  - Check for long-running transactions.`,
      ].join("\n"),
      threshold: storageWarningBytes,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });

    rdsStorageWarningAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- RDS Storage Critical Alarm (Req 7.4) ---
    const storageCriticalBytes = props.rdsAllocatedStorage * 1024 * 1024 * 1024 * 0.10;

    const rdsStorageCriticalAlarm = rdsFreeStorageMetric.createAlarm(this, "RdsStorageCritical", {
      alarmName: `AILA-${this.appEnvironment}-RDS-Storage-Critical`,
      alarmDescription: [
        `RDS instance ${props.rdsInstanceId} free storage space fell below 10% of ${props.rdsAllocatedStorage} GB allocated (${(storageCriticalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB).`,
        `Metric: FreeStorageSpace Average over 1-minute periods.`,
        `Threshold: ${storageCriticalBytes} bytes (10% of allocated storage, critical).`,
        `Investigation steps:`,
        `  - Check slow query logs.`,
        `  - Review active connections.`,
        `  - Check for long-running transactions.`,
      ].join("\n"),
      threshold: storageCriticalBytes,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });

    // Critical: always emails (Critical topic) in every environment.
    rdsStorageCriticalAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // --- RDS Connections Alarm (Req 7.5) ---
    const connectionsThreshold = Math.floor(maxConnections * (thresholds.rdsConnectionsPercent / 100));

    const rdsConnectionsMetric = new cloudwatch.Metric({
      namespace: "AWS/RDS",
      metricName: "DatabaseConnections",
      dimensionsMap: rdsDimensions,
      statistic: "Average",
      period: cdk.Duration.minutes(1),
    });

    const rdsConnectionsAlarm = rdsConnectionsMetric.createAlarm(this, "RdsConnectionsWarning", {
      alarmName: `AILA-${this.appEnvironment}-RDS-Connections-Warning`,
      alarmDescription: [
        `RDS instance ${props.rdsInstanceId} database connections exceeded 80% of max_connections (${connectionsThreshold} of ${maxConnections}).`,
        `Metric: DatabaseConnections Average over 1-minute periods.`,
        `Threshold: ${connectionsThreshold} connections (80% of ${maxConnections} max for ${props.rdsInstanceClass}).`,
        `Investigation steps:`,
        `  - Check slow query logs.`,
        `  - Review active connections.`,
        `  - Check for long-running transactions.`,
      ].join("\n"),
      threshold: connectionsThreshold,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    rdsConnectionsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- RDS Latency Alarm (Req 7.6) ---
    // RDS reports latency in seconds, so 100ms = 0.1 seconds
    const rdsReadLatencyMetric = new cloudwatch.Metric({
      namespace: "AWS/RDS",
      metricName: "ReadLatency",
      dimensionsMap: rdsDimensions,
      statistic: "p99",
      period: cdk.Duration.minutes(1),
    });

    const rdsWriteLatencyMetric = new cloudwatch.Metric({
      namespace: "AWS/RDS",
      metricName: "WriteLatency",
      dimensionsMap: rdsDimensions,
      statistic: "p99",
      period: cdk.Duration.minutes(1),
    });

    const rdsLatencyExpression = new cloudwatch.MathExpression({
      expression: "MAX([readLatency, writeLatency])",
      usingMetrics: {
        readLatency: rdsReadLatencyMetric,
        writeLatency: rdsWriteLatencyMetric,
      },
      period: cdk.Duration.minutes(1),
      label: "RDS Max Latency (Read/Write) p99",
    });

    const rdsLatencyAlarm = rdsLatencyExpression.createAlarm(this, "RdsLatencyWarning", {
      alarmName: `AILA-${this.appEnvironment}-RDS-Latency-Warning`,
      alarmDescription: [
        `RDS instance ${props.rdsInstanceId} read or write latency exceeded 100ms (0.1s).`,
        `Metric: MAX(ReadLatency p99, WriteLatency p99) over 1-minute periods.`,
        `Threshold: 0.1 seconds (100ms, warning).`,
        `Investigation steps:`,
        `  - Check slow query logs.`,
        `  - Review active connections.`,
        `  - Check for long-running transactions.`,
      ].join("\n"),
      threshold: 0.1,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    rdsLatencyAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- SQS and DLQ Alarms (Req 5.1, 5.2, 5.3, 8.3, 8.4, 8.5, 23.2) ---

    // --- DLQ Depth Alarm (Req 8.3) ---
    const dlqDepthMetric = new cloudwatch.Metric({
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensionsMap: { QueueName: props.dlqName },
      statistic: "Sum",
      period: cdk.Duration.minutes(1),
    });

    this.dlqAlarm = dlqDepthMetric.createAlarm(this, "DlqDepthAlarm", {
      alarmName: `AILA-${this.appEnvironment}-DLQ-Depth`,
      alarmDescription: [
        `Dead Letter Queue ${props.dlqName} has messages (> 0). Messages in the DLQ indicate repeated processing failures.`,
        `Metric: ApproximateNumberOfMessagesVisible Sum over 1-minute periods.`,
        `Threshold: > 0 messages (1 of 1 datapoints, critical).`,
        `Investigation steps:`,
        `  - Inspect DLQ messages for error patterns.`,
        `  - Check consumer Lambda logs.`,
        `  - Consider replaying messages after fix.`,
      ].join("\n"),
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Critical: DLQ messages mean permanent processing failure — always emails.
    this.dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // --- SQS Queue Depth Alarm (Req 8.4) ---
    const sqsQueueDepthMetric = new cloudwatch.Metric({
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensionsMap: { QueueName: props.messagesQueueName },
      statistic: "Sum",
      period: cdk.Duration.minutes(1),
    });

    this.sqsQueueDepthAlarm = sqsQueueDepthMetric.createAlarm(this, "SqsQueueDepthAlarm", {
      alarmName: `AILA-${this.appEnvironment}-SQS-QueueDepth-Warning`,
      alarmDescription: [
        `SQS queue ${props.messagesQueueName} depth exceeded ${thresholds.sqsQueueDepth} messages.`,
        `Metric: ApproximateNumberOfMessagesVisible Sum over 1-minute periods.`,
        `Threshold: > ${thresholds.sqsQueueDepth} messages (3 of 5 datapoints, warning).`,
        `Investigation steps:`,
        `  - Check consumer Lambda logs for processing errors.`,
        `  - Review consumer Lambda concurrency and throttling.`,
        `  - Check for upstream message spikes.`,
      ].join("\n"),
      threshold: thresholds.sqsQueueDepth,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    this.sqsQueueDepthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- SQS Queue Age Alarm (Req 8.5) ---
    const sqsQueueAgeMetric = new cloudwatch.Metric({
      namespace: "AWS/SQS",
      metricName: "ApproximateAgeOfOldestMessage",
      dimensionsMap: { QueueName: props.messagesQueueName },
      statistic: "Maximum",
      period: cdk.Duration.minutes(1),
    });

    this.sqsQueueAgeAlarm = sqsQueueAgeMetric.createAlarm(this, "SqsQueueAgeAlarm", {
      alarmName: `AILA-${this.appEnvironment}-SQS-QueueAge-Warning`,
      alarmDescription: [
        `SQS queue ${props.messagesQueueName} oldest message age exceeded ${thresholds.sqsQueueAgeSeconds} seconds.`,
        `Metric: ApproximateAgeOfOldestMessage Maximum over 1-minute periods.`,
        `Threshold: > ${thresholds.sqsQueueAgeSeconds} seconds (3 of 5 datapoints, warning).`,
        `Investigation steps:`,
        `  - Check consumer Lambda logs for processing errors.`,
        `  - Review consumer Lambda concurrency and throttling.`,
        `  - Check for stuck or poison messages.`,
      ].join("\n"),
      threshold: thresholds.sqsQueueAgeSeconds,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    this.sqsQueueAgeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- AppSync Alarms (Req 9.1, 9.2) ---

    // AppSync 5xx Error Alarm (Req 9.1)
    const appSync5xxMetric = new cloudwatch.Metric({
      namespace: "AWS/AppSync",
      metricName: "5XXError",
      dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
      statistic: "Sum",
      period: cdk.Duration.minutes(1),
    });

    const appSync5xxAlarm = appSync5xxMetric.createAlarm(this, "AppSync5xxAlarm", {
      alarmName: `AILA-${this.appEnvironment}-AppSync-5xx-Warning`,
      alarmDescription: [
        `AppSync GraphQL API 5xx error count exceeded ${thresholds.appSync5xxThreshold}.`,
        `Metric: 5XXError Sum over 1-minute periods.`,
        `Threshold: > ${thresholds.appSync5xxThreshold} errors (3 of 5 datapoints, warning).`,
        `Investigation steps:`,
        `  - Check AppSync resolver logs for error details.`,
        `  - Review backend Lambda error rates.`,
        `  - Check downstream service health.`,
      ].join("\n"),
      threshold: thresholds.appSync5xxThreshold,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    appSync5xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // AppSync Latency Alarm (Req 9.2)
    const appSyncLatencyMetric = new cloudwatch.Metric({
      namespace: "AWS/AppSync",
      metricName: "Latency",
      dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
      statistic: "p99",
      period: cdk.Duration.minutes(1),
    });

    const appSyncLatencyAlarm = appSyncLatencyMetric.createAlarm(this, "AppSyncLatencyAlarm", {
      alarmName: `AILA-${this.appEnvironment}-AppSync-Latency-Warning`,
      alarmDescription: [
        `AppSync GraphQL API p99 latency exceeded ${thresholds.appSyncLatencyMs}ms.`,
        `Metric: Latency p99 over 1-minute periods.`,
        `Threshold: > ${thresholds.appSyncLatencyMs}ms (3 of 5 datapoints, warning).`,
        `Investigation steps:`,
        `  - Check AppSync resolver performance.`,
        `  - Review backend Lambda duration metrics.`,
        `  - Check downstream service latency.`,
      ].join("\n"),
      threshold: thresholds.appSyncLatencyMs,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    appSyncLatencyAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.warningTopic));

    // --- Composite Alarms (Req 21.1, 21.2, 21.3, 21.4, 21.5) ---

    // SystemHealthCritical: ALARM when 2+ of (any Lambda critical, API GW critical 5xx, RDS CPU critical) are in ALARM
    // Express "2 of 3" as: (A AND B) OR (A AND C) OR (B AND C)
    const anyLambdaCritical = cloudwatch.AlarmRule.anyOf(
      ...this.lambdaErrorCriticalAlarms
    );

    const systemHealthRule = cloudwatch.AlarmRule.anyOf(
      cloudwatch.AlarmRule.allOf(anyLambdaCritical, cloudwatch.AlarmRule.fromAlarm(this.apiGateway5xxCriticalAlarm, cloudwatch.AlarmState.ALARM)),
      cloudwatch.AlarmRule.allOf(anyLambdaCritical, cloudwatch.AlarmRule.fromAlarm(this.rdsCpuCriticalAlarm, cloudwatch.AlarmState.ALARM)),
      cloudwatch.AlarmRule.allOf(
        cloudwatch.AlarmRule.fromAlarm(this.apiGateway5xxCriticalAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(this.rdsCpuCriticalAlarm, cloudwatch.AlarmState.ALARM),
      ),
    );

    const systemHealthCriticalAlarm = new cloudwatch.CompositeAlarm(this, "SystemHealthCritical", {
      compositeAlarmName: `AILA-${this.appEnvironment}-SystemHealthCritical`,
      alarmRule: systemHealthRule,
      alarmDescription: [
        `Composite alarm: 2 or more critical subsystems are in ALARM simultaneously.`,
        `Child alarms: Any Lambda critical error rate, API Gateway critical 5xx rate, RDS CPU critical.`,
        `This indicates a cascading or multi-component failure requiring immediate investigation.`,
        `Investigation steps:`,
        `  - Check the AILA CloudWatch Dashboard for detailed alarm states.`,
        `  - Identify which child alarms are active.`,
        `  - Prioritize the root cause (often the earliest alarm to fire).`,
      ].join("\n"),
    });

    // Critical: multi-subsystem failure — always emails (Critical topic).
    systemHealthCriticalAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // DataPipelineHealth: ALARM when DLQ alarm AND (queue depth OR queue age) are in ALARM
    const dataPipelineRule = cloudwatch.AlarmRule.allOf(
      cloudwatch.AlarmRule.fromAlarm(this.dlqAlarm, cloudwatch.AlarmState.ALARM),
      cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(this.sqsQueueDepthAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(this.sqsQueueAgeAlarm, cloudwatch.AlarmState.ALARM),
      ),
    );

    const dataPipelineHealthAlarm = new cloudwatch.CompositeAlarm(this, "DataPipelineHealth", {
      compositeAlarmName: `AILA-${this.appEnvironment}-DataPipelineHealth`,
      alarmRule: dataPipelineRule,
      alarmDescription: [
        `Composite alarm: Data pipeline is unhealthy — DLQ has messages AND the main queue is backing up.`,
        `Child alarms: DLQ depth, SQS queue depth, SQS queue age.`,
        `This indicates the SQS consumer is failing and the queue is growing, requiring immediate attention.`,
        `Investigation steps:`,
        `  - Check the AILA CloudWatch Dashboard for detailed alarm states.`,
        `  - Inspect DLQ messages for error patterns.`,
        `  - Check consumer Lambda logs for processing failures.`,
        `  - Consider pausing message production if the backlog is critical.`,
      ].join("\n"),
    });

    // Critical: data pipeline is dead (DLQ + backlog) — always emails (Critical topic).
    dataPipelineHealthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));

    // --- CloudWatch Dashboard (Req 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 18.3) ---

    // Widget 1: Lambda Errors (Req 20.1)
    const lambdaErrorsWidget = new cloudwatch.GraphWidget({
      title: "Lambda Errors",
      left: props.lambdaFunctions.map(
        (fn) =>
          new cloudwatch.Metric({
            namespace: "AWS/Lambda",
            metricName: "Errors",
            dimensionsMap: { FunctionName: fn.functionName },
            statistic: "Sum",
            period: cdk.Duration.minutes(1),
            label: fn.functionName,
          })
      ),
      width: 12,
    });

    // Widget 2: Lambda Duration (Req 20.1)
    const lambdaDurationWidget = new cloudwatch.GraphWidget({
      title: "Lambda Duration (p99)",
      left: props.lambdaFunctions.map(
        (fn) =>
          new cloudwatch.Metric({
            namespace: "AWS/Lambda",
            metricName: "Duration",
            dimensionsMap: { FunctionName: fn.functionName },
            statistic: "p99",
            period: cdk.Duration.minutes(1),
            label: fn.functionName,
          })
      ),
      width: 12,
    });

    // Widget 3: API Gateway Errors and Latency (Req 20.2)
    const apiGatewayWidget = new cloudwatch.GraphWidget({
      title: "API Gateway Errors & Latency",
      left: [
        new cloudwatch.Metric({
          namespace: "AWS/ApiGateway",
          metricName: "5XXError",
          dimensionsMap: { ApiName: props.apiGatewayRestApiId },
          statistic: "Sum",
          period: cdk.Duration.minutes(1),
          label: "5xx Errors",
        }),
        new cloudwatch.Metric({
          namespace: "AWS/ApiGateway",
          metricName: "4XXError",
          dimensionsMap: { ApiName: props.apiGatewayRestApiId },
          statistic: "Sum",
          period: cdk.Duration.minutes(1),
          label: "4xx Errors",
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: "AWS/ApiGateway",
          metricName: "Latency",
          dimensionsMap: { ApiName: props.apiGatewayRestApiId },
          statistic: "p99",
          period: cdk.Duration.minutes(1),
          label: "Latency p99",
        }),
      ],
      width: 12,
    });

    // Widget 4: RDS Metrics (Req 20.3)
    const rdsWidget = new cloudwatch.GraphWidget({
      title: "RDS Metrics",
      left: [
        new cloudwatch.Metric({
          namespace: "AWS/RDS",
          metricName: "CPUUtilization",
          dimensionsMap: { DBInstanceIdentifier: props.rdsInstanceId },
          statistic: "Average",
          period: cdk.Duration.minutes(1),
          label: "CPU Utilization %",
        }),
        new cloudwatch.Metric({
          namespace: "AWS/RDS",
          metricName: "FreeStorageSpace",
          dimensionsMap: { DBInstanceIdentifier: props.rdsInstanceId },
          statistic: "Average",
          period: cdk.Duration.minutes(1),
          label: "Free Storage Space",
        }),
        new cloudwatch.Metric({
          namespace: "AWS/RDS",
          metricName: "DatabaseConnections",
          dimensionsMap: { DBInstanceIdentifier: props.rdsInstanceId },
          statistic: "Average",
          period: cdk.Duration.minutes(1),
          label: "Database Connections",
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: "AWS/RDS",
          metricName: "ReadLatency",
          dimensionsMap: { DBInstanceIdentifier: props.rdsInstanceId },
          statistic: "p99",
          period: cdk.Duration.minutes(1),
          label: "Read Latency",
        }),
      ],
      width: 12,
    });

    // Widget 5: SQS Queue Depth (Req 20.4)
    const sqsWidget = new cloudwatch.GraphWidget({
      title: "SQS Queue Depth",
      left: [
        new cloudwatch.Metric({
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensionsMap: { QueueName: props.messagesQueueName },
          statistic: "Sum",
          period: cdk.Duration.minutes(1),
          label: "Messages Queue Depth",
        }),
        new cloudwatch.Metric({
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensionsMap: { QueueName: props.dlqName },
          statistic: "Sum",
          period: cdk.Duration.minutes(1),
          label: "DLQ Depth",
        }),
      ],
      width: 12,
    });

    // Widget 6: Alarm Status — split into two widgets to stay under CloudWatch's 100-alarm limit per widget
    const lambdaAlarms: cloudwatch.IAlarm[] = [
      ...this.lambdaErrorWarningAlarms,
      ...this.lambdaErrorCriticalAlarms,
      ...lambdaDurationAlarms,
      ...lambdaThrottleAlarms,
    ];

    const infrastructureAlarms: cloudwatch.IAlarm[] = [
      apiGw5xxWarningAlarm,
      this.apiGateway5xxCriticalAlarm,
      missingTrafficAlarm,
      rdsCpuWarningAlarm,
      this.rdsCpuCriticalAlarm,
      rdsStorageWarningAlarm,
      rdsStorageCriticalAlarm,
      rdsConnectionsAlarm,
      rdsLatencyAlarm,
      this.dlqAlarm,
      this.sqsQueueDepthAlarm,
      this.sqsQueueAgeAlarm,
      appSync5xxAlarm,
      appSyncLatencyAlarm,
      systemHealthCriticalAlarm,
      dataPipelineHealthAlarm,
    ];

    const lambdaAlarmStatusWidget = new cloudwatch.AlarmStatusWidget({
      title: "Lambda Alarm Status",
      alarms: lambdaAlarms,
      width: 24,
    });

    const infraAlarmStatusWidget = new cloudwatch.AlarmStatusWidget({
      title: "Infrastructure Alarm Status",
      alarms: infrastructureAlarms,
      width: 24,
    });

    // Widget 7: AppSync Errors and Latency (Req 20.6)
    const appSyncWidget = new cloudwatch.GraphWidget({
      title: "AppSync Errors & Latency",
      left: [
        new cloudwatch.Metric({
          namespace: "AWS/AppSync",
          metricName: "5XXError",
          dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
          statistic: "Sum",
          period: cdk.Duration.minutes(1),
          label: "5xx Errors",
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: "AWS/AppSync",
          metricName: "Latency",
          dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
          statistic: "p99",
          period: cdk.Duration.minutes(1),
          label: "Latency p99",
        }),
      ],
      width: 12,
    });

    // Widget 8: Lambda Init Duration for container functions (Req 20.7, 18.3)
    const lambdaInitDurationWidget = new cloudwatch.GraphWidget({
      title: "Lambda Init Duration (Container Functions)",
      left: props.containerLambdaNames.map(
        (name) =>
          new cloudwatch.Metric({
            namespace: "AWS/Lambda",
            metricName: "InitDuration",
            dimensionsMap: { FunctionName: name },
            statistic: "Average",
            period: cdk.Duration.minutes(1),
            label: name,
          })
      ),
      width: 12,
    });

    // Create the dashboard with widgets arranged in rows
    new cloudwatch.Dashboard(this, "OperationalDashboard", {
      dashboardName: `AILA-${this.appEnvironment}-Dashboard`,
      widgets: [
        // Row 1: Lambda Errors + Lambda Duration
        [lambdaErrorsWidget, lambdaDurationWidget],
        // Row 2: API Gateway + RDS
        [apiGatewayWidget, rdsWidget],
        // Row 3: SQS + AppSync
        [sqsWidget, appSyncWidget],
        // Row 4: Lambda Init Duration
        [lambdaInitDurationWidget],
        // Row 5: Alarm Status (split across two full-width widgets)
        [lambdaAlarmStatusWidget],
        [infraAlarmStatusWidget],
      ],
    });

    // --- Bedrock Guardrail Failure Alarm (Req 10.6, 10.7) ---
    // Detect guardrail service errors and SSM parameter retrieval failures in the text generation Lambda
    const textGenFunctionName = props.containerLambdaNames.find(
      (name) => name.includes("TextGen") || name.includes("textGen")
    ) || props.containerLambdaNames[0];

    const guardrailLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      "TextGenGuardrailLogGroup",
      `/aws/lambda/${textGenFunctionName}`
    );

    const guardrailMetricFilter = new logs.MetricFilter(
      this,
      "GuardrailFailureMetricFilter",
      {
        logGroup: guardrailLogGroup,
        filterPattern: logs.FilterPattern.any(
          logs.FilterPattern.all(
            logs.FilterPattern.stringValue("$.level", "=", "ERROR"),
            logs.FilterPattern.stringValue("$.message", "=", "*Bedrock Guardrails service error*")
          ),
          logs.FilterPattern.all(
            logs.FilterPattern.stringValue("$.level", "=", "WARNING"),
            logs.FilterPattern.stringValue("$.message", "=", "*Failed to retrieve guardrail SSM parameters*")
          )
        ),
        metricNamespace: "AILA/Guardrails",
        metricName: "GuardrailFailureCount",
        metricValue: "1",
        defaultValue: 0,
      }
    );

    const guardrailAlarm = new cloudwatch.Alarm(this, "GuardrailFailureAlarm", {
      alarmName: `AILA-${this.appEnvironment}-Guardrail-Failure`,
      alarmDescription: [
        `Bedrock Guardrails failure detected in ${textGenFunctionName}.`,
        `The text generation Lambda is operating without guardrail enforcement.`,
        `Investigation steps:`,
        `  - Check CloudWatch Logs group /aws/lambda/${textGenFunctionName}.`,
        `  - Look for ERROR logs with "Bedrock Guardrails service error".`,
        `  - Look for WARNING logs with "Failed to retrieve guardrail SSM parameters".`,
        `  - Verify SSM parameters exist and are accessible.`,
        `  - Check Bedrock service health in the region.`,
      ].join("\n"),
      metric: guardrailMetricFilter.metric({
        statistic: "Sum",
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    guardrailAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.criticalTopic)
    );

    // --- X-Ray Sampling Rule (Req 13.1, 13.2, 13.3) ---
    new xray.CfnSamplingRule(this, 'SamplingRule', {
      samplingRule: {
        ruleName: `AILA-${this.appEnvironment}-SamplingRule`,
        serviceName: `AILA-${this.appEnvironment}`,
        serviceType: '*',
        host: '*',
        httpMethod: '*',
        urlPath: '*',
        resourceArn: '*',
        fixedRate: this.isProd ? 0.05 : 1.0,
        reservoirSize: this.isProd ? 1 : 10,
        priority: 1000,
        version: 1,
      },
    });
  }

  /**
   * Returns environment-aware alarm thresholds.
   * Production uses tighter thresholds; dev uses relaxed values.
   */
  private getAlarmThresholds() {
    return {
      lambdaErrorRateWarning: this.isProd ? 5 : 10,
      lambdaErrorRateCritical: 25,
      lambdaDurationPercent: 80,
      lambdaThrottleThreshold: 0,
      apiGateway5xxWarning: 1,
      apiGateway5xxCritical: 5,
      apiGatewayMinRequests: 50,
      rdsCpuWarning: this.isProd ? 80 : 90,
      rdsCpuCritical: 95,
      rdsStorageWarningPercent: 20,
      rdsStorageCriticalPercent: 10,
      rdsConnectionsPercent: 80,
      rdsLatencyMs: 100,
      sqsQueueDepth: 100,
      sqsQueueAgeSeconds: 600,
      appSync5xxThreshold: 0,
      appSyncLatencyMs: 5000,
      missingTrafficMinutes: 15,
    };
  }
}
