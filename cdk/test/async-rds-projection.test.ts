import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * #8 async RDS projection: a dedicated SQS queue (+DLQ) and consumer Lambda do
 * the relational projection off the chatbot's response path. chatbotV2 enqueues
 * (ASYNC_RDS_PROJECTION, dev-on) instead of writing synchronously.
 */
let ragTemplate: Template;

beforeAll(() => {
  ragTemplate = createTestStacks().ragTemplate; // environment: 'dev'
});

describe('#8 async RDS projection infrastructure', () => {
  test('creates the RDS projection queue and its DLQ', () => {
    ragTemplate.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: Match.stringLikeRegexp('rdsProjectionQueue'),
    });
    ragTemplate.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: Match.stringLikeRegexp('rdsProjectionDlq'),
    });
  });

  test('creates the consumer Lambda (reusing the chatbot_v2 image, new CMD)', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('rdsProjectionConsumerFunction'),
    });
  });

  test('the consumer is triggered by an SQS event source mapping', () => {
    // Two SQS-driven mappings in this stack: enrichment + rds projection.
    ragTemplate.resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
  });

  test('chatbotV2 env carries the queue URL and ASYNC_RDS_PROJECTION (dev on)', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ASYNC_RDS_PROJECTION: 'true',
          RDS_PROJECTION_QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });
});
