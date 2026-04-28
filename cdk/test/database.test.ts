import { createTestStacks } from './helpers/stack-setup';
import { Template } from 'aws-cdk-lib/assertions';

/**
 * Database Security Tests
 *
 * These tests verify that the Database stack enforces SSL, requires TLS on
 * all RDS proxies, and keeps the RDS instance private and encrypted at rest.
 *
 * Validates: Requirements 23.1, 23.2, 23.3, 23.4
 */

let dbTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  dbTemplate = stacks.dbTemplate;
});

describe('Database Security', () => {
  /**
   * Validates: Requirement 23.1
   * The RDS parameter group must set rds.force_ssl to '1'.
   */
  test('RDS parameter group sets rds.force_ssl to 1', () => {
    const json = dbTemplate.toJSON();
    const resources = json.Resources ?? {};

    const parameterGroups = Object.entries(resources).filter(
      ([, resource]) => (resource as Record<string, unknown>).Type === 'AWS::RDS::DBParameterGroup'
    );

    expect(parameterGroups.length).toBeGreaterThan(0);

    for (const [logicalId, resource] of parameterGroups) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;
      const parameters = props.Parameters as Record<string, unknown> | undefined;

      expect({
        parameterGroup: logicalId,
        hasForceSSL: parameters?.['rds.force_ssl'] !== undefined,
        forceSSLValue: parameters?.['rds.force_ssl'],
      }).toEqual(
        expect.objectContaining({
          hasForceSSL: true,
          forceSSLValue: '1',
        })
      );
    }
  });

  /**
   * Validates: Requirement 23.2
   * All three RDS proxies must have RequireTLS set to true.
   */
  test('all RDS proxies have RequireTLS set to true', () => {
    const json = dbTemplate.toJSON();
    const resources = json.Resources ?? {};

    const dbProxies = Object.entries(resources).filter(
      ([, resource]) => (resource as Record<string, unknown>).Type === 'AWS::RDS::DBProxy'
    );

    expect(dbProxies.length).toBe(3);

    for (const [logicalId, resource] of dbProxies) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;

      expect({
        proxy: logicalId,
        requireTLS: props.RequireTLS,
      }).toEqual(
        expect.objectContaining({
          requireTLS: true,
        })
      );
    }
  });

  /**
   * Validates: Requirement 23.3
   * The RDS instance must have PubliclyAccessible set to false.
   */
  test('RDS instance has PubliclyAccessible set to false', () => {
    const json = dbTemplate.toJSON();
    const resources = json.Resources ?? {};

    const dbInstances = Object.entries(resources).filter(
      ([, resource]) => (resource as Record<string, unknown>).Type === 'AWS::RDS::DBInstance'
    );

    expect(dbInstances.length).toBeGreaterThan(0);

    for (const [logicalId, resource] of dbInstances) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;

      expect({
        instance: logicalId,
        publiclyAccessible: props.PubliclyAccessible,
      }).toEqual(
        expect.objectContaining({
          publiclyAccessible: false,
        })
      );
    }
  });

  /**
   * Validates: Requirement 23.4
   * The RDS instance must have StorageEncrypted set to true.
   */
  test('RDS instance has StorageEncrypted set to true', () => {
    const json = dbTemplate.toJSON();
    const resources = json.Resources ?? {};

    const dbInstances = Object.entries(resources).filter(
      ([, resource]) => (resource as Record<string, unknown>).Type === 'AWS::RDS::DBInstance'
    );

    expect(dbInstances.length).toBeGreaterThan(0);

    for (const [logicalId, resource] of dbInstances) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;

      expect({
        instance: logicalId,
        storageEncrypted: props.StorageEncrypted,
      }).toEqual(
        expect.objectContaining({
          storageEncrypted: true,
        })
      );
    }
  });
});
