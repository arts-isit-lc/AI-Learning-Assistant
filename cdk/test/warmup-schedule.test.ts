import { Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * Daily keep-warm pings for container-image Lambdas (lib/warmup.ts).
 *
 * Lambda marks functions Inactive after weeks without invocations, and the
 * first real request after that fails while the function reactivates. Each
 * container function gets its own daily EventBridge rule that sends
 * {"warmup": true}, which the handler returns on before doing any I/O.
 */

let apiTemplate: Template;
let ragTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
  ragTemplate = stacks.ragTemplate;
});

/** Logical ID of the Lambda function with the given FunctionName. */
function functionLogicalId(template: Template, functionName: string): string {
  const fns = template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: functionName },
  });
  const ids = Object.keys(fns);
  expect(ids).toHaveLength(1);
  return ids[0];
}

/** Daily warm-up rules targeting the given function logical ID. */
function warmupRulesFor(template: Template, logicalId: string): Array<Record<string, any>> {
  const rules = template.findResources('AWS::Events::Rule');
  return Object.values(rules)
    .map((r) => r.Properties as Record<string, any>)
    .filter((p) =>
      (p.Targets ?? []).some(
        (t: Record<string, any>) => t.Arn?.['Fn::GetAtt']?.[0] === logicalId
      )
    );
}

const CASES: Array<{ stack: 'rag' | 'api'; functionName: string }> = [
  { stack: 'rag', functionName: 'Test-MultimodalRagStack-ragIngestionFunction' },
  { stack: 'rag', functionName: 'Test-MultimodalRagStack-ragEnrichmentFunction' },
  { stack: 'rag', functionName: 'Test-MultimodalRagStack-ragRetrievalFunction' },
  { stack: 'rag', functionName: 'Test-MultimodalRagStack-chatbotV2Function' },
  { stack: 'rag', functionName: 'Test-MultimodalRagStack-mathComputeFunction' },
  { stack: 'rag', functionName: 'Test-MultimodalRagStack-rdsProjectionConsumerFunction' },
  { stack: 'api', functionName: 'Test-ApiGatewayStack-SQSTriggerDockerFunc' },
];

describe('Container Lambda warm-up schedules', () => {
  test.each(CASES)('$functionName has a daily {"warmup": true} rule', ({ stack, functionName }) => {
    const template = stack === 'rag' ? ragTemplate : apiTemplate;
    const rules = warmupRulesFor(template, functionLogicalId(template, functionName));

    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.ScheduleExpression).toBe('rate(1 day)');
    expect(rule.State).toBe('ENABLED');
    expect(rule.Targets).toHaveLength(1);
    expect(JSON.parse(rule.Targets[0].Input)).toEqual({ warmup: true });
  });

  test.each(CASES)('EventBridge may invoke $functionName', ({ stack, functionName }) => {
    const template = stack === 'rag' ? ragTemplate : apiTemplate;
    const logicalId = functionLogicalId(template, functionName);
    const perms = template.findResources('AWS::Lambda::Permission', {
      Properties: {
        Principal: 'events.amazonaws.com',
        FunctionName: { 'Fn::GetAtt': [logicalId, 'Arn'] },
      },
    });
    expect(Object.keys(perms)).toHaveLength(1);
  });

  test('every container-image function in the rag and api stacks is covered', () => {
    for (const template of [ragTemplate, apiTemplate]) {
      const images = template.findResources('AWS::Lambda::Function', {
        Properties: { PackageType: 'Image' },
      });
      const covered = Object.entries(images)
        .filter(([logicalId]) => warmupRulesFor(template, logicalId).length > 0)
        .map(([, r]) => r.Properties.FunctionName as string);
      const uncovered = Object.values(images)
        .map((r) => r.Properties.FunctionName as string)
        .filter((name) => !covered.includes(name));
      expect(uncovered).toEqual([]);
    }
  });
});
