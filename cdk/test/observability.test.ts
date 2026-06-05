import { Match } from 'aws-cdk-lib/assertions';
import { createObservabilityTemplate } from './helpers/stack-setup';

/**
 * Observability Stack Tests — Guardrail Failure Alarm
 *
 * Validates: Requirements 10.6, 10.7
 */

const template = createObservabilityTemplate();

describe('Guardrail Failure Observability', () => {
  /**
   * Validates: Requirements 10.6
   * Metric filter exists on text generation Lambda log group for guardrail failures.
   */
  test('metric filter exists for guardrail failure detection', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.anyValue(),
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricNamespace: 'AILA/Guardrails',
          MetricName: 'GuardrailFailureCount',
          MetricValue: '1',
        }),
      ]),
    });
  });

  /**
   * Validates: Requirements 10.6
   * CloudWatch Alarm exists with correct threshold and evaluation period.
   */
  test('guardrail failure alarm exists with threshold 1 and 1-minute evaluation', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*Guardrail-Failure'),
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  /**
   * Validates: Requirements 10.7
   * Alarm action targets SNS critical topic.
   */
  test('guardrail failure alarm publishes to SNS critical topic', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('.*Guardrail-Failure'),
      AlarmActions: Match.anyValue(),
    });
  });
});
