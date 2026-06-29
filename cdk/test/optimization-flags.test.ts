import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * Optimization feature flags (Phases 0-3) must be wired onto the live-path
 * Lambdas as env vars defaulting to "false" — i.e. deploying the optimization
 * code is a functional no-op until an operator flips a flag and redeploys.
 * Only flags whose behavior is implemented are wired (deferred #4/#8 are not).
 */
let ragTemplate: Template;

beforeAll(() => {
  ragTemplate = createTestStacks().ragTemplate;
});

describe('optimization feature flags default to "false"', () => {
  test('ragRetrievalFunction wires the multimodal flags off by default', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          QUERY_EMBEDDING_CACHE: 'false', // #5
          RAG_RETURN_PASSAGES: 'false', // #1
          STRICT_IMAGE_ESCALATION: 'false', // #9
        }),
      },
    });
  });

  test('chatbotV2Function wires the chatbot flags off by default', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CACHE_MODULE_METADATA: 'false', // #10
          GUARDRAIL_FAIL_CLOSED: 'false', // #11
        }),
      },
    });
  });
});
