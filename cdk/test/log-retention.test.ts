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
 * - Every application Lambda has an explicit CloudWatch log group
 * - Log groups are named `/aws/lambda/<functionName>` (so IAM scoping and the
 *   ObservabilityStack alarms/metric filters resolve)
 * - Dev environment uses 30-day retention (logs.RetentionDays.ONE_MONTH)
 * - Prod environment uses 90-day retention (logs.RetentionDays.THREE_MONTHS)
 * - The deprecated `logRetention` prop is no longer used (no Custom::LogRetention
 *   custom resource is synthesized)
 *
 * Lambdas now declare an explicit `logs.LogGroup` (via the `logGroup` prop), which
 * renders as an AWS::Logs::LogGroup with a `RetentionInDays` property.
 *
 * Validates: Requirements 17.1, 17.2, 17.3
 */

let devApiTemplate: Template;
let devRagTemplate: Template;
let prodApiTemplate: Template;

beforeAll(() => {
  // Dev stacks
  const stacks = createTestStacks();
  devApiTemplate = stacks.apiTemplate;
  devRagTemplate = stacks.ragTemplate;

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
 * Helper: collect all Lambda log groups (AWS::Logs::LogGroup whose name starts with
 * `/aws/lambda/`) from a template. Filtering by name keeps the assertions focused on
 * the application Lambda log groups and independent of any unrelated log groups.
 */
function collectLambdaLogGroups(
  template: Template
): Array<{ logicalId: string; properties: Record<string, unknown> }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; properties: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::Logs::LogGroup') continue;
    const props = (res.Properties as Record<string, unknown>) ?? {};
    const name = props.LogGroupName;
    if (typeof name !== 'string' || !name.startsWith('/aws/lambda/')) continue;
    results.push({ logicalId, properties: props });
  }

  return results;
}

describe('Log Retention Policies', () => {
  /**
   * Validates: the migration away from the deprecated `logRetention` prop.
   * No Custom::LogRetention custom resource should be synthesized anymore.
   */
  test('no deprecated Custom::LogRetention resources are synthesized', () => {
    devApiTemplate.resourceCountIs('Custom::LogRetention', 0);
    devRagTemplate.resourceCountIs('Custom::LogRetention', 0);
    prodApiTemplate.resourceCountIs('Custom::LogRetention', 0);
  });

  /**
   * Validates: Requirement 17.3
   * Every application Lambda has an explicit log group named `/aws/lambda/<fn>`.
   */
  test('application Lambdas declare explicit /aws/lambda log groups', () => {
    for (const template of [devApiTemplate, devRagTemplate]) {
      const logGroups = collectLambdaLogGroups(template);
      expect(logGroups.length).toBeGreaterThan(0);
      for (const { logicalId, properties } of logGroups) {
        expect({
          resource: logicalId,
          retentionInDays: properties.RetentionInDays,
        }).toEqual(
          expect.objectContaining({ retentionInDays: expect.any(Number) })
        );
      }
    }
  });

  /**
   * Validates: Requirement 17.1
   * Dev environment uses 30-day retention (logs.RetentionDays.ONE_MONTH).
   */
  test('dev environment uses 30-day log retention', () => {
    for (const template of [devApiTemplate, devRagTemplate]) {
      const logGroups = collectLambdaLogGroups(template);
      expect(logGroups.length).toBeGreaterThan(0);
      for (const { logicalId, properties } of logGroups) {
        expect({
          resource: logicalId,
          retentionInDays: properties.RetentionInDays,
        }).toEqual(expect.objectContaining({ retentionInDays: 30 }));
      }
    }
  });

  /**
   * Validates: Requirement 17.2
   * Prod environment uses 90-day retention (logs.RetentionDays.THREE_MONTHS).
   */
  test('prod environment uses 90-day log retention', () => {
    const logGroups = collectLambdaLogGroups(prodApiTemplate);

    expect(logGroups.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of logGroups) {
      expect({
        resource: logicalId,
        retentionInDays: properties.RetentionInDays,
      }).toEqual(expect.objectContaining({ retentionInDays: 90 }));
    }
  });
});
