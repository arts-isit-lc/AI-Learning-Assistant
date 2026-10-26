import { Template } from 'aws-cdk-lib/assertions';
import { createObservabilityTemplate, createTestStacks } from './helpers/stack-setup';

/**
 * RAG pipeline observability (MultimodalRagStack functions and DLQs).
 *
 * Retrieval is Tier 1: the chatbot swallows retrieval failures and answers
 * without course material, so its errors are otherwise invisible. Other RAG
 * functions are Tier 2 (error-rate alarms only). RAG DLQs get the same
 * critical, emailing depth alarm as the messages DLQ.
 */

const template = createObservabilityTemplate();

function topicId(topicName: string): string {
  return Object.keys(
    template.findResources('AWS::SNS::Topic', { Properties: { TopicName: topicName } })
  )[0];
}

function alarm(alarmName: string): { AlarmActions?: unknown[] } | undefined {
  const found = template.findResources('AWS::CloudWatch::Alarm', {
    Properties: { AlarmName: alarmName },
  });
  const values = Object.values(found);
  return values.length ? (values[0].Properties as { AlarmActions?: unknown[] }) : undefined;
}

describe('RAG Lambda alarms', () => {
  test('ragRetrievalFunction is Tier 1: error rate, duration and throttle alarms', () => {
    for (const suffix of ['ErrorRate-Warning', 'ErrorRate-Critical', 'Duration-Warning', 'Throttle']) {
      expect(alarm(`AILA-dev-Test-MultimodalRagStack-ragRetrievalFunction-${suffix}`)).toBeDefined();
    }
  });

  test('ragIngestionFunction is Tier 2: error rate alarms only', () => {
    expect(alarm('AILA-dev-Test-MultimodalRagStack-ragIngestionFunction-ErrorRate-Warning')).toBeDefined();
    expect(alarm('AILA-dev-Test-MultimodalRagStack-ragIngestionFunction-ErrorRate-Critical')).toBeDefined();
    expect(alarm('AILA-dev-Test-MultimodalRagStack-ragIngestionFunction-Duration-Warning')).toBeUndefined();
  });

  test('RAG Lambda critical error rates stay on the silent Warning topic (only the chatbot emails)', () => {
    const actions = alarm('AILA-dev-Test-MultimodalRagStack-ragRetrievalFunction-ErrorRate-Critical')!.AlarmActions;
    expect(actions).toContainEqual({ Ref: topicId('AILA-dev-Warning') });
    expect(actions).not.toContainEqual({ Ref: topicId('AILA-dev-Critical') });
  });
});

describe('RAG DLQ alarms', () => {
  test.each([
    'Test-MultimodalRagStack-enrichmentDlq',
    'Test-MultimodalRagStack-rdsProjectionDlq',
  ])('%s has a depth alarm that emails via the Critical topic', (queueName) => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `AILA-dev-DLQ-Depth-${queueName}`,
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Dimensions: [{ Name: 'QueueName', Value: queueName }],
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    expect(alarm(`AILA-dev-DLQ-Depth-${queueName}`)!.AlarmActions).toContainEqual({
      Ref: topicId('AILA-dev-Critical'),
    });
  });
});

describe('ApiGatewayStack exports every RAG function to observability', () => {
  test('lambdaFunctionInfos covers every MultimodalRagStack container function', () => {
    const stacks = createTestStacks();
    const ragImageNames = Object.values(
      stacks.ragTemplate.findResources('AWS::Lambda::Function', { Properties: { PackageType: 'Image' } })
    ).map((r) => r.Properties.FunctionName as string);
    const monitored = stacks.lambdaFunctionInfos.map((fn) => fn.functionName);

    expect(ragImageNames.length).toBeGreaterThan(0);
    expect(ragImageNames.filter((name) => !monitored.includes(name))).toEqual([]);
  });
});
