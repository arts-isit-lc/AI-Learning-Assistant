import { Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * Scope B (per-stage processing_status): the ingestion Lambda now writes
 * processing_status='ingesting' at the start of a run so the instructor UI can
 * show the ingestion stage. That requires DB access (secret + RDS proxy + VPC),
 * mirroring the enrichment function. These assertions lock that wiring in.
 */
describe('ingestion Lambda DB access (per-stage status writes)', () => {
  const ragTemplate = createTestStacks().ragTemplate;

  test('ingestion function has DB env vars and runs in the VPC', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('ragIngestionFunction'),
      Environment: {
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          DB_PROXY_ENDPOINT: Match.anyValue(),
        }),
      },
      // A Lambda placed in a VPC synthesizes a VpcConfig (subnets + SGs).
      VpcConfig: Match.anyValue(),
    });
  });

  test('ingestion role can read the DB secret and connect to the RDS proxy (least privilege)', () => {
    ragTemplate.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.stringLikeRegexp('ragIngestionRole'),
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({ Action: 'secretsmanager:GetSecretValue' }),
              Match.objectLike({ Action: 'rds-db:connect' }),
            ]),
          },
        }),
      ]),
    });
  });
});
