import { Match, Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

// Security Hub (AWS Foundational Security Best Practices) controls fixed in code,
// 2026-11-20. Each test names the control it keeps passing. Controls that were
// deliberately NOT fixed (cost, team decisions, UBC-owned) are listed in
// CLAUDE_HISTORY.md.

let apiTemplate: Template;
let ragTemplate: Template;
let dbTemplate: Template;

beforeAll(() => {
  ({ apiTemplate, ragTemplate, dbTemplate } = createTestStacks());
});

describe('Cognito', () => {
  test('Cognito.6: the user pool has deletion protection', () => {
    apiTemplate.hasResourceProperties('AWS::Cognito::UserPool', { DeletionProtection: 'ACTIVE' });
  });

  test('Cognito.2: the identity pool allows no guest identities', () => {
    apiTemplate.hasResourceProperties('AWS::Cognito::IdentityPool', {
      AllowUnauthenticatedIdentities: false,
    });
    apiTemplate.hasResourceProperties('AWS::Cognito::IdentityPoolRoleAttachment', {
      Roles: Match.not(Match.objectLike({ unauthenticated: Match.anyValue() })),
    });
  });
});

describe('DynamoDB', () => {
  test.each([
    ['ApiGatewayStack', () => apiTemplate],
    ['MultimodalRagStack', () => ragTemplate],
  ])('DynamoDB.6: every table in %s has deletion protection', (_name, template) => {
    const tables = Object.values(template().findResources('AWS::DynamoDB::Table'));
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect((table as { Properties: { DeletionProtectionEnabled?: boolean } }).Properties.DeletionProtectionEnabled).toBe(true);
    }
  });
});

describe('AppSync', () => {
  test('AppSync.2: the Event API logs resolver errors without verbose content', () => {
    apiTemplate.hasResourceProperties('AWS::AppSync::GraphQLApi', {
      LogConfig: Match.objectLike({ FieldLogLevel: 'ERROR', ExcludeVerboseContent: true }),
    });
  });

  test('its log group is explicit, with retention, and no Custom::LogRetention is added', () => {
    apiTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['/aws/appsync/apis/'])]) }),
      RetentionInDays: 30,
    });
    apiTemplate.resourceCountIs('Custom::LogRetention', 0);
  });
});

describe('RDS', () => {
  test('RDS.9 / RDS.36: PostgreSQL and upgrade logs are exported to CloudWatch', () => {
    dbTemplate.hasResourceProperties('AWS::RDS::DBInstance', {
      EnableCloudwatchLogsExports: ['postgresql', 'upgrade'],
    });
  });

  test('RDS.11: automated backups are kept for at least 7 days', () => {
    const instance = Object.values(dbTemplate.findResources('AWS::RDS::DBInstance'))[0] as {
      Properties: { BackupRetentionPeriod: number };
    };
    expect(instance.Properties.BackupRetentionPeriod).toBeGreaterThanOrEqual(7);
  });

  test('RDS.8: deletion protection is on (dev included)', () => {
    dbTemplate.hasResourceProperties('AWS::RDS::DBInstance', { DeletionProtection: true });
  });

  test('RDS.10: IAM database authentication stays on in the template', () => {
    dbTemplate.hasResourceProperties('AWS::RDS::DBInstance', { EnableIAMDatabaseAuthentication: true });
  });
});
