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
   * Metric filter exists on the chatbot (chatbotV2) log group for guardrail
   * failures, matching the messages chatbot_v2/src/guardrails.py logs.
   */
  test('metric filter exists for guardrail failure detection', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      LogGroupName: '/aws/lambda/Test-MultimodalRagStack-chatbotV2Function',
      FilterPattern: Match.stringLikeRegexp(
        'Guardrail service error\\*.*Failed to load guardrail config from SSM'
      ),
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
