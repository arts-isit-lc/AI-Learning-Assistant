import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ApiGatewayStack } from '../lib/api-gateway-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';

/**
 * Bedrock Guardrail Infrastructure Tests
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 5.1, 5.2, 9.1, 9.2, 9.3, 9.4
 */

let apiTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
});

describe('Bedrock Guardrail Resource', () => {
  /**
   * Validates: Requirements 1.1
   * CfnGuardrail exists with correct name pattern.
   */
  test('CfnGuardrail resource exists with correct name', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      Name: Match.stringLikeRegexp('.*-TextGenGuardrail'),
    });
  });

  /**
   * Validates: Requirements 1.3, 1.4
   * CfnGuardrail has correct blocked messaging.
   */
  test('CfnGuardrail has correct blocked input and output messaging', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      BlockedInputMessaging: "I'm not able to help with that topic. Let's focus on your course material.",
      BlockedOutputsMessaging: "I'm not able to provide that response. Let me redirect our discussion back to the course material.",
    });
  });

  /**
   * Validates: Requirements 2.1, 9.2 (dev environment uses MEDIUM)
   * Content filter policies present for all harm categories with correct strengths.
   */
  test('content filter policies include all harm categories with MEDIUM strength (dev)', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: {
        FiltersConfig: Match.arrayWith([
          Match.objectLike({ Type: 'HATE', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' }),
          Match.objectLike({ Type: 'INSULTS', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' }),
          Match.objectLike({ Type: 'SEXUAL', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' }),
          Match.objectLike({ Type: 'VIOLENCE', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' }),
          Match.objectLike({ Type: 'MISCONDUCT', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' }),
        ]),
      },
    });
  });

  /**
   * Validates: Requirements 2.2, 9.4
   * Prompt attack filter is HIGH regardless of environment.
   */
  test('prompt attack filter is HIGH on input regardless of environment', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: {
        FiltersConfig: Match.arrayWith([
          Match.objectLike({ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH', OutputStrength: 'NONE' }),
        ]),
      },
    });
  });

  /**
   * Validates: Requirements 3.1, 3.2, 3.3
   * Three denied topics are configured with correct names and type DENY.
   */
  test('denied topics include MedicalLegalPsychologicalAdvice, PersonalInformationRequests, and PromptDisclosure', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      TopicPolicyConfig: {
        TopicsConfig: Match.arrayWith([
          Match.objectLike({ Name: 'MedicalLegalPsychologicalAdvice', Type: 'DENY' }),
          Match.objectLike({ Name: 'PersonalInformationRequests', Type: 'DENY' }),
          Match.objectLike({ Name: 'PromptDisclosure', Type: 'DENY' }),
        ]),
      },
    });
  });

  /**
   * Validates: Requirements 3.1
   * Each denied topic has at least 5 example phrases.
   */
  test('each denied topic has at least 5 examples', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::Bedrock::Guardrail') continue;
      const props = res.Properties as Record<string, unknown>;
      const topicPolicy = props.TopicPolicyConfig as Record<string, unknown>;
      const topics = topicPolicy.TopicsConfig as Array<Record<string, unknown>>;

      for (const topic of topics) {
        const examples = topic.Examples as string[];
        expect(examples.length).toBeGreaterThanOrEqual(5);
      }
    }
  });

  /**
   * Validates: Requirements 4.1
   * Word filter includes managed PROFANITY list.
   */
  test('word filter includes managed PROFANITY list', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      WordPolicyConfig: {
        ManagedWordListsConfig: Match.arrayWith([
          Match.objectLike({ Type: 'PROFANITY' }),
        ]),
      },
    });
  });

  /**
   * Validates: Requirements 4.2
   * Word filter includes custom words.
   */
  test('word filter includes custom words list', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      WordPolicyConfig: {
        WordsConfig: Match.arrayWith([
          Match.objectLike({ Text: 'cheat code' }),
          Match.objectLike({ Text: 'answer key' }),
        ]),
      },
    });
  });

  /**
   * Validates: Requirements 5.1, 5.2
   * Contextual grounding filter with GROUNDING and RELEVANCE at 0.7.
   */
  test('contextual grounding filter configured with 0.7 thresholds', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContextualGroundingPolicyConfig: {
        FiltersConfig: Match.arrayWith([
          Match.objectLike({ Type: 'GROUNDING', Threshold: 0.7 }),
          Match.objectLike({ Type: 'RELEVANCE', Threshold: 0.7 }),
        ]),
      },
    });
  });

  /**
   * Validates: Requirements 1.2
   * CfnGuardrailVersion resource exists and references the guardrail.
   */
  test('CfnGuardrailVersion exists and references the guardrail', () => {
    apiTemplate.hasResourceProperties('AWS::Bedrock::GuardrailVersion', {
      GuardrailIdentifier: Match.anyValue(),
    });
  });

  /**
   * Validates: Requirements 1.5
   * SSM parameters created at correct paths for GuardrailId and GuardrailVersion.
   */
  test('SSM parameters created for GuardrailId and GuardrailVersion', () => {
    apiTemplate.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/AILA/GuardrailId'),
      Type: 'String',
    });
    apiTemplate.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/AILA/GuardrailVersion'),
      Type: 'String',
    });
  });
});

describe('Environment-aware Guardrail Configuration', () => {
  /**
   * Validates: Requirements 9.1
   * Production uses HIGH filter strengths.
   */
  test('prod environment uses HIGH filter strengths', () => {
    const app = new cdk.App({
      context: { StackPrefix: 'Test', environment: 'prod' },
    });
    const env = { account: '123456789012', region: 'ca-central-1' };
    const vpcStack = new VpcStack(app, 'Prod-VpcStack', { env, environment: 'prod' });
    const dbStack = new DatabaseStack(app, 'Prod-DatabaseStack', vpcStack, { env, environment: 'prod' });
    const ragStack = new MultimodalRagStack(app, 'Prod-MultimodalRagStack', dbStack, vpcStack, { env, environment: 'prod' });
    const apiStack = new ApiGatewayStack(app, 'Prod-ApiGatewayStack', dbStack, vpcStack, ragStack, { env, environment: 'prod' });
    const prodTemplate = Template.fromStack(apiStack);

    prodTemplate.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: {
        FiltersConfig: Match.arrayWith([
          Match.objectLike({ Type: 'HATE', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
          Match.objectLike({ Type: 'INSULTS', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
          Match.objectLike({ Type: 'SEXUAL', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
          Match.objectLike({ Type: 'VIOLENCE', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
          Match.objectLike({ Type: 'MISCONDUCT', InputStrength: 'HIGH', OutputStrength: 'HIGH' }),
        ]),
      },
    });
  });
});
