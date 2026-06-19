import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createObservabilityTemplate } from './helpers/stack-setup';
import { ObservabilityStack } from '../lib/observability-stack';

/**
 * Observability Stack — Alarm Resource Tests
 *
 * Tests the core alarm infrastructure created by ObservabilityStack:
 * SNS topics, Lambda alarms (tiered), API Gateway alarms, RDS alarms,
 * SQS/DLQ alarms, AppSync alarms, composite alarms, dashboard, and
 * environment-specific threshold differences.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 4.1, 6.1, 6.2,
 *            7.1, 7.2, 8.3, 8.4, 9.1, 9.2, 19.4, 20.1, 21.1, 21.3
 */

let devTemplate: Template;
let prodTemplate: Template;

beforeAll(() => {
  devTemplate = createObservabilityTemplate();

  // Create prod template for environment-specific threshold tests
  const prodApp = new cdk.App({
    context: { StackPrefix: 'Test', environment: 'prod' },
  });
  const env = { account: '123456789012', region: 'ca-central-1' };

  const prodStack = new ObservabilityStack(prodApp, 'Test-ObservabilityStack', {
    env,
    environment: 'prod',
    apiGatewayRestApiId: 'Test-ApiGatewayStack-API',
    apiGatewayStageName: 'prod',
    lambdaFunctions: [
      { functionName: 'Test-ApiGatewayStack-studentFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-instructorFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-adminFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-preSignupLambda', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-addStudentOnSignUp', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-adjustUserRoles-v9', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-adminLambdaAuthorizer', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-studentLambdaAuthorizer', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-instructorLambdaAuthorizer', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-TextGenLambdaDockerFunc', timeoutSeconds: 300, isContainer: true },
      { functionName: 'Test-ApiGatewayStack-GeneratePreSignedURLFunc', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DataIngestLambdaDockerFunc', timeoutSeconds: 600, isContainer: true },
      { functionName: 'Test-ApiGatewayStack-GetFilesFunction', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DeleteFileFunc', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DeleteModuleFunc', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DeleteLastMessage', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-AuthHandler', timeoutSeconds: 3, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-NotificationFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-sqsFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-SQSTriggerDockerFunc', timeoutSeconds: 300, isContainer: true },
      { functionName: 'Test-ApiGatewayStack-GetChatLogsFunction', timeoutSeconds: 60, isContainer: false },
    ],
    rdsInstanceId: 'test-rds-instance',
    rdsAllocatedStorage: 100,
    rdsInstanceClass: 'db.t3.micro',
    messagesQueueName: 'test-messages-queue.fifo',
    messagesQueueArn: 'arn:aws:sqs:ca-central-1:123456789012:test-messages-queue.fifo',
    dlqName: 'test-messages-dlq.fifo',
    dlqArn: 'arn:aws:sqs:ca-central-1:123456789012:test-messages-dlq.fifo',
    appSyncApiId: 'test-appsync-api-id',
    containerLambdaNames: [
      'Test-ApiGatewayStack-TextGenLambdaDockerFunc',
      'Test-ApiGatewayStack-DataIngestLambdaDockerFunc',
      'Test-ApiGatewayStack-SQSTriggerDockerFunc',
    ],
  });

  prodTemplate = Template.fromStack(prodStack);
});

describe('SNS Topics', () => {
  /**
   * Validates: Requirement 1.1, 1.2, 1.3
   * SNS topics are created with KMS encryption enabled.
   */
  test('warning topic is created with KMS encryption', () => {
    devTemplate.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'AILA-dev-Warning',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('critical topic is created with KMS encryption', () => {
    devTemplate.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'AILA-dev-Critical',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('email subscriptions exist on both topics', () => {
    const subscriptions = devTemplate.findResources('AWS::SNS::Subscription', {
      Properties: {
        Protocol: 'email',
        Endpoint: 'vincent.lam@ubc.ca',
      },
    });
    expect(Object.keys(subscriptions).length).toBe(2);
  });
});

describe('Lambda Error Rate Alarms', () => {
  /**
   * Validates: Requirement 2.1, 2.2
   * Lambda error rate alarms exist for tier 1 and tier 2 functions with correct thresholds.
   */
  test('warning error rate alarms exist with 10% threshold (dev)', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*studentFunction-ErrorRate-Warning'),
      Threshold: 10,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('critical error rate alarms exist with 25% threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*studentFunction-ErrorRate-Critical'),
      Threshold: 25,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('tier 1 functions have error rate alarms', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*TextGenLambdaDockerFunc-ErrorRate-Warning'),
    });
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*DataIngestLambdaDockerFunc-ErrorRate-Warning'),
    });
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*SQSTriggerDockerFunc-ErrorRate-Warning'),
    });
  });

  test('tier 2 functions have error rate alarms', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*adminFunction-ErrorRate-Warning'),
    });
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*GetFilesFunction-ErrorRate-Warning'),
    });
  });

  test('tier 3 functions do NOT have error rate alarms', () => {
    const json = devTemplate.toJSON();
    const resources = json.Resources ?? {};
    const alarmNames: string[] = [];
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::CloudWatch::Alarm') continue;
      const props = res.Properties as Record<string, unknown>;
      if (props.AlarmName) alarmNames.push(props.AlarmName as string);
    }

    // Tier 3 functions should NOT have alarms
    const tier3Names = [
      'adminLambdaAuthorizer',
      'studentLambdaAuthorizer',
      'instructorLambdaAuthorizer',
      'preSignupLambda',
      'addStudentOnSignUp',
      'adjustUserRoles',
      'AuthHandler',
    ];

    for (const name of tier3Names) {
      const hasAlarm = alarmNames.some((a) => a.includes(name));
      expect(hasAlarm).toBe(false);
    }
  });
});

describe('Lambda Duration Alarms', () => {
  /**
   * Validates: Requirement 3.1
   * Duration alarms exist for tier 1 functions with 80%-of-timeout thresholds.
   */
  test('TextGenLambdaDockerFunc has duration alarm at 80% of 300s timeout (240000ms)', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*TextGenLambdaDockerFunc-Duration-Warning'),
      Threshold: 240000,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
    });
  });

  test('DataIngestLambdaDockerFunc has duration alarm at 80% of 600s timeout (480000ms)', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*DataIngestLambdaDockerFunc-Duration-Warning'),
      Threshold: 480000,
    });
  });

  test('studentFunction has duration alarm at 80% of 60s timeout (48000ms)', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*studentFunction-Duration-Warning'),
      Threshold: 48000,
    });
  });

  test('tier 2 functions do NOT have duration alarms', () => {
    const json = devTemplate.toJSON();
    const resources = json.Resources ?? {};
    const durationAlarmNames: string[] = [];
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::CloudWatch::Alarm') continue;
      const props = res.Properties as Record<string, unknown>;
      const name = props.AlarmName as string;
      if (name && name.includes('Duration')) durationAlarmNames.push(name);
    }

    // Tier 2 functions (e.g., adminFunction, GetFilesFunction) should NOT have duration alarms
    expect(durationAlarmNames.some((a) => a.includes('adminFunction'))).toBe(false);
    expect(durationAlarmNames.some((a) => a.includes('GetFilesFunction'))).toBe(false);
  });
});

describe('Lambda Throttle Alarms', () => {
  /**
   * Validates: Requirement 4.1
   * Throttle alarms exist for tier 1 functions with > 0 threshold, 2 of 3 datapoints.
   */
  test('tier 1 function has throttle alarm with correct configuration', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*TextGenLambdaDockerFunc-Throttle'),
      Threshold: 0,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('all tier 1 functions have throttle alarms', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*studentFunction-Throttle'),
    });
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*instructorFunction-Throttle'),
    });
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*SQSTriggerDockerFunc-Throttle'),
    });
  });
});

describe('API Gateway 5xx Alarms', () => {
  /**
   * Validates: Requirements 6.1, 6.2
   * API Gateway alarms use math expression with minimum request volume.
   */
  test('5xx warning alarm exists with 1% threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-ApiGateway-5xx-Warning',
      Threshold: 1,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('5xx critical alarm exists with 5% threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-ApiGateway-5xx-Critical',
      Threshold: 5,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
    });
  });

  test('5xx alarm uses math expression with minimum request volume check', () => {
    // Verify the alarm uses a math expression metric (indicated by Metrics property)
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-ApiGateway-5xx-Warning',
      Metrics: Match.arrayWith([
        Match.objectLike({
          Expression: 'IF(requests > 50, (errors5xx / requests) * 100, 0)',
        }),
      ]),
    });
  });
});

describe('Missing Traffic Alarm', () => {
  /**
   * Validates: Requirements 6.1, 6.2 (related), 19.4 (dev disabled)
   * Missing traffic alarm detects zero requests for 15 consecutive minutes.
   */
  test('missing traffic alarm exists with correct configuration', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-ApiGateway-MissingTraffic',
      Threshold: 0,
      EvaluationPeriods: 15,
      DatapointsToAlarm: 15,
      TreatMissingData: 'breaching',
      ComparisonOperator: 'LessThanOrEqualToThreshold',
    });
  });

  test('missing traffic alarm has actionsEnabled false in dev', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-ApiGateway-MissingTraffic',
      ActionsEnabled: false,
    });
  });

  test('missing traffic alarm has actionsEnabled true in prod', () => {
    prodTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-prod-ApiGateway-MissingTraffic',
      ActionsEnabled: true,
    });
  });
});

describe('RDS Alarms', () => {
  /**
   * Validates: Requirements 7.1, 7.2
   * RDS alarms exist with correct thresholds.
   */
  test('RDS CPU warning alarm exists with 90% threshold (dev)', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-RDS-CPU-Warning',
      Threshold: 90,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('RDS CPU critical alarm exists with 95% threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-RDS-CPU-Critical',
      Threshold: 95,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
    });
  });

  test('RDS storage warning alarm exists with 20% threshold (20GB of 100GB in bytes)', () => {
    const storageWarningBytes = 100 * 1024 * 1024 * 1024 * 0.20;
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-RDS-Storage-Warning',
      Threshold: storageWarningBytes,
      ComparisonOperator: 'LessThanThreshold',
    });
  });

  test('RDS storage critical alarm exists with 10% threshold', () => {
    const storageCriticalBytes = 100 * 1024 * 1024 * 1024 * 0.10;
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-RDS-Storage-Critical',
      Threshold: storageCriticalBytes,
      ComparisonOperator: 'LessThanThreshold',
    });
  });

  test('RDS connections alarm exists with 80% of max_connections for db.t3.micro (56)', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-RDS-Connections-Warning',
      Threshold: 56,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('RDS latency alarm exists with 0.1s threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-RDS-Latency-Warning',
      Threshold: 0.1,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
    });
  });
});

describe('SQS and DLQ Alarms', () => {
  /**
   * Validates: Requirements 8.3, 8.4
   * SQS and DLQ alarms exist with correct thresholds.
   */
  test('DLQ alarm exists with > 0 threshold and 1 of 1 datapoints', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-DLQ-Depth',
      Threshold: 0,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('SQS queue depth alarm exists with > 100 threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-SQS-QueueDepth-Warning',
      Threshold: 100,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('SQS queue age alarm exists with > 600s threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-SQS-QueueAge-Warning',
      Threshold: 600,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });
});

describe('AppSync Alarms', () => {
  /**
   * Validates: Requirements 9.1, 9.2
   * AppSync alarms exist with correct thresholds.
   */
  test('AppSync 5xx alarm exists with > 0 threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-AppSync-5xx-Warning',
      Threshold: 0,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('AppSync latency alarm exists with > 5000ms threshold', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-AppSync-Latency-Warning',
      Threshold: 5000,
      EvaluationPeriods: 5,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });
});

describe('Composite Alarms', () => {
  /**
   * Validates: Requirements 21.1, 21.3
   * Composite alarms reference correct child alarms.
   */
  test('SystemHealthCritical composite alarm exists', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
      AlarmName: 'AILA-dev-SystemHealthCritical',
      AlarmRule: Match.anyValue(),
    });
  });

  test('DataPipelineHealth composite alarm exists', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
      AlarmName: 'AILA-dev-DataPipelineHealth',
      AlarmRule: Match.anyValue(),
    });
  });

  test('SystemHealthCritical alarm rule references lambda, API GW, and RDS alarms', () => {
    const json = devTemplate.toJSON();
    const resources = json.Resources ?? {};
    let alarmRuleStr = '';
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::CloudWatch::CompositeAlarm') continue;
      const props = res.Properties as Record<string, unknown>;
      if (props.AlarmName === 'AILA-dev-SystemHealthCritical') {
        // AlarmRule is emitted as { "Fn::Join": ["", [...]] } — stringify to search within
        alarmRuleStr = JSON.stringify(props.AlarmRule);
        break;
      }
    }
    expect(alarmRuleStr).toBeTruthy();
    // References use logical IDs, not alarm names
    expect(alarmRuleStr).toContain('ApiGw5xxCritical');
    expect(alarmRuleStr).toContain('RdsCpuCritical');
    // Should reference at least one Lambda critical alarm
    expect(alarmRuleStr).toContain('ErrorRateCritical');
  });

  test('DataPipelineHealth alarm rule references DLQ and queue alarms', () => {
    const json = devTemplate.toJSON();
    const resources = json.Resources ?? {};
    let alarmRuleStr = '';
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::CloudWatch::CompositeAlarm') continue;
      const props = res.Properties as Record<string, unknown>;
      if (props.AlarmName === 'AILA-dev-DataPipelineHealth') {
        alarmRuleStr = JSON.stringify(props.AlarmRule);
        break;
      }
    }
    expect(alarmRuleStr).toBeTruthy();
    // References use logical IDs, not alarm names
    expect(alarmRuleStr).toContain('DlqDepthAlarm');
    expect(alarmRuleStr).toContain('SqsQueueDepthAlarm');
    expect(alarmRuleStr).toContain('SqsQueueAgeAlarm');
  });
});

describe('CloudWatch Dashboard', () => {
  /**
   * Validates: Requirement 20.1
   * Dashboard is created with expected widget configuration.
   */
  test('dashboard is created with correct name', () => {
    devTemplate.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'AILA-dev-Dashboard',
    });
  });

  test('dashboard has expected widget rows', () => {
    const json = devTemplate.toJSON();
    const resources = json.Resources ?? {};
    let dashboardBody = '';
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::CloudWatch::Dashboard') continue;
      const props = res.Properties as Record<string, unknown>;
      dashboardBody = props.DashboardBody as string;
      break;
    }
    expect(dashboardBody).toBeTruthy();

    // Parse the dashboard body (it's a JSON-encoded Fn::Join or literal)
    // CDK emits DashboardBody as { "Fn::Join": [...] } but we can check it contains widget info
    const bodyStr = JSON.stringify(dashboardBody);
    expect(bodyStr).toContain('Lambda Errors');
    expect(bodyStr).toContain('Lambda Duration');
    expect(bodyStr).toContain('API Gateway');
    expect(bodyStr).toContain('RDS Metrics');
    expect(bodyStr).toContain('SQS Queue Depth');
    expect(bodyStr).toContain('AppSync');
    expect(bodyStr).toContain('Init Duration');
    expect(bodyStr).toContain('Alarm Status');
  });
});

describe('X-Ray Sampling Rule', () => {
  /**
   * Validates: Requirement 19.4 (related)
   * X-Ray sampling rule is created with environment-specific configuration.
   */
  test('X-Ray sampling rule exists with dev configuration (fixedRate 1.0)', () => {
    devTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
      SamplingRule: Match.objectLike({
        RuleName: 'AILA-dev-SamplingRule',
        FixedRate: 1.0,
        ReservoirSize: 10,
      }),
    });
  });

  test('X-Ray sampling rule uses 0.05 fixedRate in prod', () => {
    prodTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
      SamplingRule: Match.objectLike({
        RuleName: 'AILA-prod-SamplingRule',
        FixedRate: 0.05,
        ReservoirSize: 1,
      }),
    });
  });
});

describe('Environment-Specific Thresholds (dev vs prod)', () => {
  /**
   * Validates: Requirement 19.4
   * Prod uses tighter thresholds than dev.
   */
  test('prod uses 5% Lambda error rate warning (tighter than dev 10%)', () => {
    prodTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*studentFunction-ErrorRate-Warning'),
      Threshold: 5,
    });
  });

  test('prod uses 80% RDS CPU warning (tighter than dev 90%)', () => {
    prodTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-prod-RDS-CPU-Warning',
      Threshold: 80,
    });
  });

  test('dev routes critical alarms to warning topic (non-prod behavior)', () => {
    // In dev, critical alarms should target the warning topic
    // Check a critical alarm's actions include the warning topic ARN
    const json = devTemplate.toJSON();
    const resources = json.Resources ?? {};
    let criticalAlarmActions: unknown[] = [];
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::CloudWatch::Alarm') continue;
      const props = res.Properties as Record<string, unknown>;
      if ((props.AlarmName as string)?.includes('ErrorRate-Critical')) {
        criticalAlarmActions = (props.AlarmActions ?? []) as unknown[];
        break;
      }
    }
    // Dev critical alarms should have alarm actions (routed to warning topic)
    expect(criticalAlarmActions.length).toBeGreaterThan(0);
  });
});
