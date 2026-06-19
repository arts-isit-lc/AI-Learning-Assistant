import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createTestStacks, createObservabilityTemplate } from './helpers/stack-setup';
import { ObservabilityStack } from '../lib/observability-stack';

/**
 * Lambda X-Ray Tracing Tests
 *
 * These tests verify that:
 * - All Lambda functions have X-Ray active tracing enabled (TracingConfig.Mode: Active)
 * - API Gateway stage has TracingEnabled: true
 * - X-Ray sampling rule is configured correctly per environment
 *
 * Validates: Requirements 10.1, 11.1, 11.2, 13.1, 13.2
 */

let apiTemplate: Template;
let devObservabilityTemplate: Template;
let prodObservabilityTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;

  devObservabilityTemplate = createObservabilityTemplate();

  // Create prod ObservabilityStack template for sampling rule comparison
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
      { functionName: 'Test-ApiGatewayStack-TextGenLambdaDockerFunc', timeoutSeconds: 300, isContainer: true },
    ],
    rdsInstanceId: 'test-rds-instance',
    rdsAllocatedStorage: 100,
    rdsInstanceClass: 'db.t3.micro',
    messagesQueueName: 'test-messages-queue.fifo',
    messagesQueueArn: 'arn:aws:sqs:ca-central-1:123456789012:test-messages-queue.fifo',
    dlqName: 'test-messages-dlq.fifo',
    dlqArn: 'arn:aws:sqs:ca-central-1:123456789012:test-messages-dlq.fifo',
    appSyncApiId: 'test-appsync-api-id',
    containerLambdaNames: ['Test-ApiGatewayStack-TextGenLambdaDockerFunc'],
  });

  prodObservabilityTemplate = Template.fromStack(prodStack);
});

/**
 * Helper: collect all Lambda function resources from a template, including Docker image Lambdas.
 * Skips CDK-internal functions (BucketNotificationsHandler*).
 */
function collectAllLambdaFunctions(
  template: Template
): Array<{ logicalId: string; properties: Record<string, unknown> }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; properties: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::Lambda::Function') continue;
    // Skip CDK-internal functions (BucketNotificationsHandler, LogRetention)
    if (logicalId.startsWith('BucketNotificationsHandler')) continue;
    if (logicalId.startsWith('LogRetention')) continue;
    const props = (res.Properties as Record<string, unknown>) ?? {};
    results.push({ logicalId, properties: props });
  }

  return results;
}

describe('Lambda X-Ray Tracing Configuration', () => {
  /**
   * Validates: Requirements 11.1, 11.2
   * All Lambda functions (zip and Docker image) must have TracingConfig.Mode set to Active.
   */
  test('all Lambda functions have TracingConfig.Mode set to Active', () => {
    const functions = collectAllLambdaFunctions(apiTemplate);

    expect(functions.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of functions) {
      const tracingConfig = properties.TracingConfig as Record<string, unknown> | undefined;
      expect({
        function: logicalId,
        tracingConfig,
      }).toEqual(
        expect.objectContaining({
          tracingConfig: { Mode: 'Active' },
        })
      );
    }
  });

  test('Docker image Lambda functions also have TracingConfig.Mode Active', () => {
    const functions = collectAllLambdaFunctions(apiTemplate);
    const dockerFunctions = functions.filter(
      (f) => (f.properties.PackageType as string) === 'Image'
    );

    expect(dockerFunctions.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of dockerFunctions) {
      const tracingConfig = properties.TracingConfig as Record<string, unknown> | undefined;
      expect({
        function: logicalId,
        tracingConfig,
      }).toEqual(
        expect.objectContaining({
          tracingConfig: { Mode: 'Active' },
        })
      );
    }
  });
});

describe('API Gateway X-Ray Tracing', () => {
  /**
   * Validates: Requirement 10.1
   * API Gateway stage must have TracingEnabled set to true.
   */
  test('API Gateway stage has TracingEnabled set to true', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Stage', {
      TracingEnabled: true,
    });
  });
});

describe('X-Ray Sampling Rule Configuration', () => {
  /**
   * Validates: Requirement 13.1
   * Dev environment: fixedRate 1.0 (100%), reservoirSize 10
   */
  test('dev environment has fixedRate 1.0 and reservoirSize 10', () => {
    devObservabilityTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
      SamplingRule: Match.objectLike({
        FixedRate: 1.0,
        ReservoirSize: 10,
      }),
    });
  });

  /**
   * Validates: Requirement 13.2
   * Prod environment: fixedRate 0.05 (5%), reservoirSize 1
   */
  test('prod environment has fixedRate 0.05 and reservoirSize 1', () => {
    prodObservabilityTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
      SamplingRule: Match.objectLike({
        FixedRate: 0.05,
        ReservoirSize: 1,
      }),
    });
  });

  test('sampling rule is scoped to the application service name', () => {
    devObservabilityTemplate.hasResourceProperties('AWS::XRay::SamplingRule', {
      SamplingRule: Match.objectLike({
        ServiceName: Match.anyValue(),
        RuleName: Match.stringLikeRegexp('AILA-.*-SamplingRule'),
      }),
    });
  });
});
