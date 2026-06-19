import { Match, Template } from 'aws-cdk-lib/assertions';
import { createTestStacks, createObservabilityTemplate } from './helpers/stack-setup';

/**
 * DLQ Configuration Tests
 *
 * Tests the Dead Letter Queue infrastructure:
 * - DLQ is created as a FIFO queue in ApiGatewayStack
 * - messagesQueue has deadLetterQueue configured with maxReceiveCount 3
 * - DLQ alarm fires on > 0 messages in ObservabilityStack
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.6
 */

let apiTemplate: Template;
let observabilityTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
  observabilityTemplate = createObservabilityTemplate();
});

describe('DLQ Configuration', () => {
  /**
   * Validates: Requirement 8.1
   * The DLQ is created as a FIFO queue.
   */
  test('DLQ is created as a FIFO queue', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    let foundDlq = false;
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::SQS::Queue') continue;
      const props = (res.Properties as Record<string, unknown>) ?? {};
      const queueName = props.QueueName as string | undefined;
      if (queueName && queueName.toLowerCase().includes('dlq') && props.FifoQueue === true) {
        foundDlq = true;
        break;
      }
    }

    expect(foundDlq).toBe(true);
  });

  /**
   * Validates: Requirement 8.2
   * The messagesQueue has a dead letter queue configured with maxReceiveCount 3.
   */
  test('messagesQueue has deadLetterQueue configured with maxReceiveCount 3', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    let foundRedrivePolicy = false;
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::SQS::Queue') continue;
      const props = (res.Properties as Record<string, unknown>) ?? {};
      const redrivePolicy = props.RedrivePolicy as Record<string, unknown> | undefined;
      if (redrivePolicy && redrivePolicy.maxReceiveCount === 3) {
        foundRedrivePolicy = true;
        break;
      }
    }

    expect(foundRedrivePolicy).toBe(true);
  });

  /**
   * Validates: Requirement 8.3
   * The DLQ alarm fires on > 0 messages (threshold 0, GreaterThanThreshold, 1 of 1 datapoints).
   */
  test('DLQ alarm fires on > 0 messages', () => {
    observabilityTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'AILA-dev-DLQ-Depth',
      Threshold: 0,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: 'notBreaching',
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });
});
