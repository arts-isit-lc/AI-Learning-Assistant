import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';
import { DatabaseRebuildStage, sizingFor } from '../lib/constants/sizing';

/**
 * P2.1 in AWS_COST_OPTIMIZATION_PLAN.md: rebuild the database on PostgreSQL 17
 * at the sizing profile's class and storage, one deploy per stage.
 */

const REBUILT_ID = 'test-databasestack-postgres';

function build(rebuild: DatabaseRebuildStage, environment: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App({ context: { StackPrefix: 'Test', environment } });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpc = new VpcStack(app, 'Test-VpcStack', { env, environment });
  const db = new DatabaseStack(app, 'Test-DatabaseStack', vpc, { env, environment, database: { rebuild } });
  const rag = new MultimodalRagStack(app, 'Test-MultimodalRagStack', db, vpc, { env, environment });
  return { db, template: Template.fromStack(db), rag: Template.fromStack(rag) };
}

function instances(template: Template) {
  return Object.entries(template.findResources('AWS::RDS::DBInstance'));
}

function rebuilt(template: Template) {
  const found = instances(template).filter(([, r]) => r.Properties.DBInstanceIdentifier === REBUILT_ID);
  expect(found).toHaveLength(1);
  return found[0];
}

function original(template: Template) {
  return instances(template).filter(([, r]) => r.Properties.DBInstanceIdentifier !== REBUILT_ID);
}

function proxyTargets(template: Template): unknown {
  const [group] = Object.values(template.findResources('AWS::RDS::DBProxyTargetGroup'));
  return group.Properties.DBInstanceIdentifiers;
}

function rdsDbConnectCount(template: Template): number {
  return (JSON.stringify(template.toJSON()).match(/rds-db:connect/g) ?? []).length;
}

describe('Profiles', () => {
  test('prod stays on its original instance until Stage B', () => {
    expect(sizingFor('prod').database.rebuild).toBe('none');
  });

  test('the legacy proxies (P1.1 deploy 1) and the rebuild cannot coexist', () => {
    // The legacy proxies are children of the original instance.
    expect(sizingFor('prod').legacyProxies && sizingFor('prod').database.rebuild !== 'none').toBe(false);
    expect(() => build('created', 'prod')).toThrow(/P1.1 deploy 2/);
  });
});

describe('none: original instance only', () => {
  const { template, rag } = build('none');

  test('one PostgreSQL 16 instance, used by the proxy', () => {
    expect(instances(template)).toHaveLength(1);
    const [[id, instance]] = instances(template);
    expect(instance.Properties.EngineVersion).toMatch(/^16\./);
    expect(proxyTargets(template)).toEqual([{ Ref: id }]);
  });

  test('keeps the rds-db:connect grants', () => {
    expect(rdsDbConnectCount(template)).toBeGreaterThan(0);
    expect(rdsDbConnectCount(rag)).toBe(6);
  });
});

describe('created (Deploy A): rebuilt instance next to the original', () => {
  const { db, template, rag } = build('created');

  test('the app still uses the original instance and admin secret', () => {
    const [[originalId]] = original(template);
    expect(proxyTargets(template)).toEqual([{ Ref: originalId }]);
    expect(db.secretPathAdminName).toBe('Test-DatabaseStack-AILA/credentials/rdsDbCredential');
    expect(rdsDbConnectCount(rag)).toBe(6);
  });

  test('the rebuilt instance has the target engine, size and protections', () => {
    const [, instance] = rebuilt(template);
    expect(instance.Properties).toEqual(expect.objectContaining({
      Engine: 'postgres',
      EngineVersion: '17',
      DBInstanceClass: `db.${sizingFor('dev').database.instanceType}`,
      AllocatedStorage: '20',
      StorageType: 'gp3',
      MultiAZ: false,
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
      EnableIAMDatabaseAuthentication: true,
      EnableCloudwatchLogsExports: ['postgresql', 'upgrade'],
      EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
      PreferredMaintenanceWindow: sizingFor('dev').database.preferredMaintenanceWindow,
    }));
  });

  test('its parameter group requires TLS on the postgres17 family', () => {
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Family: 'postgres17',
      Parameters: { 'rds.force_ssl': '1' },
    });
  });

  test('its admin secret is standalone, under a new name', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'Test-DatabaseStack-AILA/credentials/rdsDbCredential-v2',
    });
  });
});

describe('cutover (Deploy B): the app moves to the rebuilt instance', () => {
  const { db, template, rag } = build('cutover');

  test('the proxy targets the rebuilt instance, with its admin secret and security group', () => {
    const [rebuiltId] = rebuilt(template);
    expect(proxyTargets(template)).toEqual([{ Ref: rebuiltId }]);
    const [proxy] = Object.values(template.findResources('AWS::RDS::DBProxy'));
    const auth = JSON.stringify(proxy.Properties.Auth);
    expect(auth).toContain('TestDatabaseStackadminSecret');
    expect(auth).not.toContain('credentials/rdsDbCredential-??????');
    expect(JSON.stringify(proxy.Properties.VpcSecurityGroupIds)).toContain('dbSecurityGroup');
  });

  test('consumers get the rebuilt instance by plain values', () => {
    expect(db.dbInstanceIdentifier).toBe(REBUILT_ID);
    expect(db.dbInstanceClass).toBe(`db.${sizingFor('dev').database.instanceType}`);
    expect(db.dbAllocatedStorageGb).toBe(20);
    expect(db.secretPathAdminName).toBe('Test-DatabaseStack-AILA/credentials/rdsDbCredential-v2');
  });

  test('the original stays as the rollback target, with its exports pinned', () => {
    expect(original(template)).toHaveLength(1);
    const outputs = JSON.stringify(template.toJSON().Outputs ?? {});
    expect(outputs).toMatch(/ExportsOutputRefTestDatabaseStackdatabase/);
    expect(outputs).toMatch(/ExportsOutputFnGetAttTestDatabaseStackdatabase\w*DbiResourceId/);
  });

  test('the unused rds-db:connect grants are gone', () => {
    expect(rdsDbConnectCount(template)).toBe(0);
    expect(rdsDbConnectCount(rag)).toBe(0);
  });
});

describe('done (Deploy C): the original instance is gone', () => {
  const { template } = build('done');

  test('only the rebuilt instance and its parameter group remain', () => {
    expect(instances(template)).toHaveLength(1);
    rebuilt(template);
    template.resourceCountIs('AWS::RDS::DBParameterGroup', 1);
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', { Family: 'postgres17' });
  });

  test('no exports of the original are left', () => {
    const outputs = JSON.stringify(template.toJSON().Outputs ?? {});
    expect(outputs).not.toMatch(/TestDatabaseStackdatabase5/);
  });

  test('the proxy still requires TLS', () => {
    template.hasResourceProperties('AWS::RDS::DBProxy', { RequireTLS: true, Auth: Match.anyValue() });
  });
});
