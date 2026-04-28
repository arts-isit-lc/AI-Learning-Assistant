import { createTestStacks } from './helpers/stack-setup';
import { Template } from 'aws-cdk-lib/assertions';

/**
 * Lambda Configuration Tests
 *
 * These tests verify that all Lambda functions use the correct runtimes:
 * Node.js functions must use nodejs22.x and Python functions must use python3.11.
 * Docker image functions (PackageType: 'Image') are excluded since they don't
 * have a Runtime property.
 *
 * Validates: Requirements 24.1, 24.2
 */

let apiTemplate: Template;
let dbFlowTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
  dbFlowTemplate = stacks.dbFlowTemplate;
});

/**
 * Helper: collect all application Lambda function resources from a template.
 * Skips functions with PackageType 'Image' (Docker) since they don't have a Runtime property.
 * Skips CDK-internal functions (e.g., BucketNotificationsHandler) since their runtime
 * is managed by CDK, not the application.
 */
function collectLambdaFunctions(
  template: Template
): Array<{ logicalId: string; properties: Record<string, unknown> }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; properties: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::Lambda::Function') continue;
    const props = (res.Properties as Record<string, unknown>) ?? {};
    // Skip Docker image functions — they don't have a Runtime property
    if (props.PackageType === 'Image') continue;
    // Skip CDK-internal functions (e.g., BucketNotificationsHandler) — their runtime
    // is managed by CDK itself, not the application
    if (logicalId.startsWith('BucketNotificationsHandler')) continue;
    results.push({ logicalId, properties: props });
  }

  return results;
}

const allTemplates = () => [
  { name: 'ApiGatewayStack', template: apiTemplate },
  { name: 'DBFlowStack', template: dbFlowTemplate },
];

describe('Lambda Configuration', () => {
  /**
   * Validates: Requirement 24.1
   * All Node.js Lambda functions must use the nodejs22.x runtime.
   */
  test('all Node.js Lambda functions use nodejs22.x runtime', () => {
    let nodeJsFunctionCount = 0;

    for (const { name, template } of allTemplates()) {
      const functions = collectLambdaFunctions(template);

      for (const { logicalId, properties } of functions) {
        const runtime = properties.Runtime as string | undefined;
        if (!runtime || !runtime.startsWith('nodejs')) continue;

        nodeJsFunctionCount++;

        expect({
          stack: name,
          function: logicalId,
          runtime,
        }).toEqual(
          expect.objectContaining({
            runtime: 'nodejs22.x',
          })
        );
      }
    }

    expect(nodeJsFunctionCount).toBeGreaterThan(0);
  });

  /**
   * Validates: Requirement 24.2
   * All Python Lambda functions must use the python3.11 runtime.
   */
  test('all Python Lambda functions use python3.11 runtime', () => {
    let pythonFunctionCount = 0;

    for (const { name, template } of allTemplates()) {
      const functions = collectLambdaFunctions(template);

      for (const { logicalId, properties } of functions) {
        const runtime = properties.Runtime as string | undefined;
        if (!runtime || !runtime.startsWith('python')) continue;

        pythonFunctionCount++;

        expect({
          stack: name,
          function: logicalId,
          runtime,
        }).toEqual(
          expect.objectContaining({
            runtime: 'python3.11',
          })
        );
      }
    }

    expect(pythonFunctionCount).toBeGreaterThan(0);
  });
});
