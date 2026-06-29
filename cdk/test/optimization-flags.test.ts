import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';
import { createTestStacks } from './helpers/stack-setup';

/**
 * Optimization feature flags (Phases 0-3) are wired onto the live-path Lambdas
 * as env vars. Behavior-preserving flags are enabled in every environment;
 * behavioral flags (#1 RAG_RETURN_PASSAGES, #9 STRICT_IMAGE_ESCALATION) are
 * enabled in dev but GATED OFF in prod until the offline eval harness validates
 * them. This test locks in both halves of that contract.
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

describe('optimization feature flags', () => {
  test('behavior-preserving flags are enabled in dev', () => {
    devRagTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ QUERY_EMBEDDING_CACHE: 'true' }) }, // #5
    });
    devRagTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ CACHE_MODULE_METADATA: 'true' }) }, // #10
    });
  });

  test('behavioral flags are ON in dev', () => {
    devRagTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RAG_RETURN_PASSAGES: 'true', // #1
          STRICT_IMAGE_ESCALATION: 'true', // #9
        }),
      },
    });
  });

  test('GUARDRAIL_FAIL_CLOSED stays off (safety change, enabled deliberately)', () => {
    devRagTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ GUARDRAIL_FAIL_CLOSED: 'false' }) },
    });
  });

  test('behavioral flags are GATED OFF in prod (until eval-validated)', () => {
    const prod = prodRagTemplate();
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RAG_RETURN_PASSAGES: 'false',
          STRICT_IMAGE_ESCALATION: 'false',
        }),
      },
    });
    // ...but the behavior-preserving ones remain on in prod.
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ QUERY_EMBEDDING_CACHE: 'true' }) },
    });
  });
});
