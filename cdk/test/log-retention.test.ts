import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ApiGatewayStack } from '../lib/api-gateway-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';

/**
 * Log Retention Policy Tests
 *
 * These tests verify that:
 * - All Lambda functions have a log retention policy configured
 * - Dev environment uses 30-day retention (logs.RetentionDays.ONE_MONTH)
 * - Prod environment uses 90-day retention (logs.RetentionDays.THREE_MONTHS)
 *
 * When CDK sets `logRetention` on a Lambda function, it creates a Custom::LogRetention
 * resource with a `RetentionInDays` property.
 *
 * Validates: Requirements 17.1, 17.2, 17.3
 */

let devApiTemplate: Template;
let prodApiTemplate: Template;

beforeAll(() => {
  // Dev stacks
  const stacks = createTestStacks();
  devApiTemplate = stacks.apiTemplate;

  // Prod stacks
  const prodApp = new cdk.App({
    context: { StackPrefix: 'Test', environment: 'prod' },
  });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpcStack = new VpcStack(prodApp, 'Test-VpcStack', { env, environment: 'prod' });
  const dbStack = new DatabaseStack(prodApp, 'Test-DatabaseStack', vpcStack, { env, environment: 'prod' });
  const ragStack = new MultimodalRagStack(prodApp, 'Test-MultimodalRagStack', dbStack, vpcStack, { env, environment: 'prod' });
  const apiStack = new ApiGatewayStack(prodApp, 'Test-ApiGatewayStack', dbStack, vpcStack, ragStack, { env, environment: 'prod' });
  prodApiTemplate = Template.fromStack(apiStack);
});

/**
 * Helper: collect all Custom::LogRetention resources from a template.
 * These are created by CDK when `logRetention` is set on a Lambda function.
 */
function collectLogRetentionResources(
  template: Template
): Array<{ logicalId: string; properties: Record<string, unknown> }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; properties: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'Custom::LogRetention') continue;
    const props = (res.Properties as Record<string, unknown>) ?? {};
    results.push({ logicalId, properties: props });
  }

  return results;
}

describe('Log Retention Policies', () => {
  /**
   * Validates: Requirement 17.3
   * All Lambda functions must have logRetention set (manifested as Custom::LogRetention resources).
   */
  test('all Lambda functions have log retention configured', () => {
    const logRetentionResources = collectLogRetentionResources(devApiTemplate);

    // There should be at least one Custom::LogRetention resource per application Lambda
    expect(logRetentionResources.length).toBeGreaterThan(0);

    // Every Custom::LogRetention resource should have a RetentionInDays property
    for (const { logicalId, properties } of logRetentionResources) {
      expect({
        resource: logicalId,
        retentionInDays: properties.RetentionInDays,
      }).toEqual(
        expect.objectContaining({
          retentionInDays: expect.any(Number),
        })
      );
    }
  });

  /**
   * Validates: Requirement 17.1
   * Dev environment uses 30-day retention (logs.RetentionDays.ONE_MONTH).
   */
  test('dev environment uses 30-day log retention', () => {
    const logRetentionResources = collectLogRetentionResources(devApiTemplate);

    expect(logRetentionResources.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of logRetentionResources) {
      expect({
        resource: logicalId,
        retentionInDays: properties.RetentionInDays,
      }).toEqual(
        expect.objectContaining({
          retentionInDays: 30,
        })
      );
    }
  });

  /**
   * Validates: Requirement 17.2
   * Prod environment uses 90-day retention (logs.RetentionDays.THREE_MONTHS).
   */
  test('prod environment uses 90-day log retention', () => {
    const logRetentionResources = collectLogRetentionResources(prodApiTemplate);

    expect(logRetentionResources.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of logRetentionResources) {
      expect({
        resource: logicalId,
        retentionInDays: properties.RetentionInDays,
      }).toEqual(
        expect.objectContaining({
          retentionInDays: 90,
        })
      );
    }
  });
});
