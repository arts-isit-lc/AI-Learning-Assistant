import { createTestStacks } from './helpers/stack-setup';
import { Template, Match } from 'aws-cdk-lib/assertions';

/**
 * CDK wiring for duplicate_course file duplication (adminFunction):
 *  - the IR BUCKET name is injected as an env var (so the handler can CopyObject)
 *  - the timeout is raised from the 60s default to 300s to cover the synchronous
 *    S3 copies + Module_Files inserts across a large course.
 * (The scoped S3 IAM grant is asserted in iam-policies.test.ts.)
 */
let apiTemplate: Template;

beforeAll(() => {
  apiTemplate = createTestStacks().apiTemplate;
});

describe('adminFunction duplicate_course wiring', () => {
  test('adminFunction has a BUCKET env var and a 300s timeout', () => {
    apiTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Test-ApiGatewayStack-adminFunction',
      Timeout: 300,
      Environment: {
        Variables: Match.objectLike({
          BUCKET: Match.anyValue(),
          REGION: Match.anyValue(),
        }),
      },
    });
  });
});
