import { Match, Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';
import { sizingFor } from '../lib/constants/sizing';

// rds-db:connect was never used; DatabaseStack drops it at the P2.1 cutover.
const CUT_OVER = ['cutover', 'done'].includes(sizingFor('dev').database.rebuild);

/**
 * Ingestion failures reach the UI (CLAUDE_HISTORY.md, 2026-11-24).
 *
 * A 140 MB PDF ran the 1024 MB ingestion Lambda out of memory on every
 * attempt. The crash skipped the handler's error handling, so the file stayed
 * 'ingesting' and the wizard showed "Timed out". Ingestion now has more memory,
 * and an async on-failure destination marks the file 'failed' once Lambda's
 * retries are used up.
 */
describe('ingestion failure handling', () => {
  let ragTemplate: Template;

  beforeAll(() => {
    ragTemplate = createTestStacks().ragTemplate;
  });

  function logicalId(functionName: string): string {
    const ids = Object.keys(
      ragTemplate.findResources('AWS::Lambda::Function', { Properties: { FunctionName: functionName } })
    );
    expect(ids).toHaveLength(1);
    return ids[0];
  }

  test('ingestion function has 2048 MB', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Test-MultimodalRagStack-ragIngestionFunction',
      MemorySize: 2048,
      Timeout: 300,
    });
  });

  test('exhausted ingestion events go to the failure function after 2 retries', () => {
    const ingestion = logicalId('Test-MultimodalRagStack-ragIngestionFunction');
    const failure = logicalId('Test-MultimodalRagStack-ragIngestionFailureFunction');

    ragTemplate.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
    ragTemplate.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: ingestion },
      Qualifier: '$LATEST',
      MaximumRetryAttempts: 2,
      DestinationConfig: {
        OnFailure: { Destination: { 'Fn::GetAtt': [failure, 'Arn'] } },
      },
    });
  });

  test('ingestion role may invoke the failure function', () => {
    const failure = logicalId('Test-MultimodalRagStack-ragIngestionFailureFunction');
    const policies = ragTemplate.findResources('AWS::IAM::Policy');
    const grants = Object.values(policies).filter((p) =>
      (p.Properties.PolicyDocument.Statement as Array<Record<string, any>>).some(
        (s) =>
          s.Action === 'lambda:InvokeFunction' &&
          JSON.stringify(s.Resource).includes(failure)
      )
    );
    expect(grants).toHaveLength(1);
    expect(JSON.stringify(grants[0].Properties.Roles)).toContain('ragIngestionRole');
  });

  test('failure function runs the failure handler with DB access in the VPC', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Test-MultimodalRagStack-ragIngestionFailureFunction',
      PackageType: 'Image',
      ImageConfig: { Command: ['multimodal_rag_v2.ingestion.failure_handler.handler'] },
      MemorySize: 256,
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          DB_PROXY_ENDPOINT: Match.anyValue(),
        }),
      },
      VpcConfig: Match.anyValue(),
    });
  });

  test('failure role is scoped to its own log group, the DB secret and the proxy', () => {
    const roles = Object.values(
      ragTemplate.findResources('AWS::IAM::Role', {
        Properties: { RoleName: 'Test-MultimodalRagStack-ragIngestionFailureRole' },
      })
    );
    expect(roles).toHaveLength(1);
    const statements = roles[0].Properties.Policies[0].PolicyDocument.Statement as Array<Record<string, any>>;

    const logs = statements.find((s) => [].concat(s.Action).includes('logs:PutLogEvents' as never));
    expect(JSON.stringify(logs?.Resource)).toContain(
      '/aws/lambda/Test-MultimodalRagStack-ragIngestionFailureFunction:*'
    );
    const actions = statements.map((s) => s.Action);
    expect(actions).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue']));
    expect(actions.includes('rds-db:connect')).toBe(!CUT_OVER);
  });
});
