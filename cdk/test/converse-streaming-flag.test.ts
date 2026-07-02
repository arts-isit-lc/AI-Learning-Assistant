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
 * Rollout state: dev-first — ON in dev (validating the win), OFF in prod until
 * validated. These tests lock that in, especially that prod is NOT flipped on
 * by accident (async lets a few chunks stream before an output block lands).
 */
function prodRagTemplate(): Template {
  const app = new cdk.App({ context: { StackPrefix: 'TestProd', environment: 'prod' } });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpc = new VpcStack(app, 'TestProd-VpcStack', { env, environment: 'prod' });
  const db = new DatabaseStack(app, 'TestProd-DatabaseStack', vpc, { env, environment: 'prod' });
  const rag = new MultimodalRagStack(app, 'TestProd-MultimodalRagStack', db, vpc, { env, environment: 'prod' });
  return Template.fromStack(rag);
}

describe('USE_CONVERSE_STREAMING rollout flag (dev-first)', () => {
  test('chatbotV2Function has USE_CONVERSE_STREAMING "true" in dev', () => {
    createTestStacks().ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ USE_CONVERSE_STREAMING: 'true' }) },
    });
  });

  test('chatbotV2Function stays "false" in prod until validated', () => {
    prodRagTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ USE_CONVERSE_STREAMING: 'false' }) },
    });
  });
});
