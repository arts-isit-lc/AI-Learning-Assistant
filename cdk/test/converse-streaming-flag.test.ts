import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';
import { createTestStacks } from './helpers/stack-setup';

/**
 * USE_CONVERSE_STREAMING routes chatbotV2 generation through ConverseStream with
 * the guardrail in async mode (cuts the measured guardrail TTFT overhead).
 *
 * Rollout state: dev-first rollout COMPLETE — validated in dev and promoted to
 * prod (2026-07-13), so the flag is now "true" in every environment. These tests
 * lock in that it is ON in both dev and prod. (Reverting is a deliberate flip to
 * "false" + redeploy — back to InvokeModel + synchronous guardrail.)
 */
function prodRagTemplate(): Template {
  const app = new cdk.App({ context: { StackPrefix: 'TestProd', environment: 'prod' } });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpc = new VpcStack(app, 'TestProd-VpcStack', { env, environment: 'prod' });
  const db = new DatabaseStack(app, 'TestProd-DatabaseStack', vpc, { env, environment: 'prod' });
  const rag = new MultimodalRagStack(app, 'TestProd-MultimodalRagStack', db, vpc, { env, environment: 'prod' });
  return Template.fromStack(rag);
}

describe('USE_CONVERSE_STREAMING rollout flag (promoted to prod)', () => {
  test('chatbotV2Function has USE_CONVERSE_STREAMING "true" in dev', () => {
    createTestStacks().ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ USE_CONVERSE_STREAMING: 'true' }) },
    });
  });

  test('chatbotV2Function has USE_CONVERSE_STREAMING "true" in prod (rollout complete)', () => {
    prodRagTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ USE_CONVERSE_STREAMING: 'true' }) },
    });
  });
});
