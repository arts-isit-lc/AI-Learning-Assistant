import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

// API Gateway stage settings (fix F3 in AWS_COST_OPTIMIZATION_PLAN.md).
//
// The stage once carried two `*/*` MethodSettings (one from deployOptions with
// logging, one from methodOptions with throttling). API Gateway kept only the
// throttling entry, so execution-error logging was silently off. These tests
// pin a single merged entry and an explicit execution log group.

let apiTemplate: Template;

beforeAll(() => {
  apiTemplate = createTestStacks().apiTemplate;
});

function stageMethodSettings(): Array<Record<string, unknown>> {
  const stages = apiTemplate.findResources('AWS::ApiGateway::Stage');
  const stageList = Object.values(stages);
  expect(stageList).toHaveLength(1);
  return (stageList[0] as { Properties: { MethodSettings: Array<Record<string, unknown>> } })
    .Properties.MethodSettings;
}

describe('API Gateway stage method settings', () => {
  test('there is exactly one */* method setting', () => {
    const wildcard = stageMethodSettings().filter(
      (s) => s.HttpMethod === '*' && s.ResourcePath === '/*'
    );
    expect(wildcard).toHaveLength(1);
  });

  test('the single entry carries throttling, ERROR logging and no detailed metrics', () => {
    expect(stageMethodSettings()).toEqual([
      expect.objectContaining({
        HttpMethod: '*',
        ResourcePath: '/*',
        LoggingLevel: 'ERROR',
        MetricsEnabled: false,
        DataTraceEnabled: false,
        ThrottlingRateLimit: 100,
        ThrottlingBurstLimit: 200,
      }),
    ]);
  });
});

describe('API Gateway execution log group', () => {
  test('is created with the stage-specific name and dev retention', () => {
    apiTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith(['API-Gateway-Execution-Logs_', '/prod']),
        ]),
      }),
      RetentionInDays: 30,
    });
  });

  test('the stage depends on the log group, so it exists before logging starts', () => {
    const logGroups = apiTemplate.findResources('AWS::Logs::LogGroup', {
      Properties: {
        LogGroupName: Match.objectLike({
          'Fn::Join': Match.arrayWith([Match.arrayWith(['API-Gateway-Execution-Logs_'])]),
        }),
      },
    });
    const logGroupIds = Object.keys(logGroups);
    expect(logGroupIds).toHaveLength(1);

    const stage = Object.values(apiTemplate.findResources('AWS::ApiGateway::Stage'))[0] as {
      DependsOn?: string[];
    };
    expect(stage.DependsOn).toEqual(expect.arrayContaining(logGroupIds));
  });
});
