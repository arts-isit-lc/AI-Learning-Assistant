import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * USE_CONVERSE_STREAMING is a rollout flag on chatbotV2Function. Default "false"
 * = the current InvokeModel + synchronous-guardrail path; flipping to "true"
 * routes generation through ConverseStream with the guardrail in async mode
 * (cuts the measured guardrail TTFT overhead). This locks in the default-off
 * state so shipping the migration is a no-op until it is explicitly enabled.
 */
describe('USE_CONVERSE_STREAMING rollout flag', () => {
  test('chatbotV2Function ships with USE_CONVERSE_STREAMING "false" (no-op default)', () => {
    const ragTemplate = createTestStacks().ragTemplate;
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ USE_CONVERSE_STREAMING: 'false' }) },
    });
  });
});
