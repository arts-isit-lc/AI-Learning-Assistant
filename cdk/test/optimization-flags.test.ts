import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';
import { createTestStacks } from './helpers/stack-setup';

/**
 * Optimization feature flags are enabled in EVERY environment (operator
 * decision). This locks in that all flags are "true" in both dev and prod;
 * each remains revertible by flipping its value in multimodal-rag-stack.ts.
 */
let devRagTemplate: Template;

beforeAll(() => {
  devRagTemplate = createTestStacks().ragTemplate; // environment: 'dev'
});

function prodRagTemplate(): Template {
  const app = new cdk.App({ context: { StackPrefix: 'TestProd', environment: 'prod' } });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpc = new VpcStack(app, 'TestProd-VpcStack', { env, environment: 'prod' });
  const db = new DatabaseStack(app, 'TestProd-DatabaseStack', vpc, { env, environment: 'prod' });
  const rag = new MultimodalRagStack(app, 'TestProd-MultimodalRagStack', db, vpc, { env, environment: 'prod' });
  return Template.fromStack(rag);
}

function expectAllFlagsOn(t: Template) {
  // ragRetrievalFunction flags
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        QUERY_EMBEDDING_CACHE: 'true', // #5
        RAG_RETURN_PASSAGES: 'true', // #1
        STRICT_IMAGE_ESCALATION: 'true', // #9
      }),
    },
  });
  // chatbotV2Function flags
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        CACHE_MODULE_METADATA: 'true', // #10
        PARALLEL_EVAL_RETRIEVAL: 'true', // #7
        GUARDRAIL_FAIL_CLOSED: 'true', // #11
        ASYNC_RDS_PROJECTION: 'true', // #8
      }),
    },
  });
}

describe('optimization feature flags (all enabled, all environments)', () => {
  test('all flags are "true" in dev', () => {
    expectAllFlagsOn(devRagTemplate);
  });

  test('all flags are "true" in prod (no environment gating)', () => {
    expectAllFlagsOn(prodRagTemplate());
  });
});
