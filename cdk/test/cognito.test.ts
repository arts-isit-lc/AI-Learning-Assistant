import { createTestStacks } from './helpers/stack-setup';
import { Template } from 'aws-cdk-lib/assertions';

/**
 * Cognito Security Tests
 *
 * These tests verify that the Cognito user pool enforces a strong password
 * policy: minimum length 10, requiring lowercase, uppercase, digits, and symbols.
 *
 * Validates: Requirement 24.3
 */

let apiTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
});

describe('Cognito Security', () => {
  /**
   * Validates: Requirement 24.3
   * The Cognito user pool password policy must require minimum length 10,
   * lowercase, uppercase, digits, and symbols.
   */
  test('Cognito user pool password policy requires min length 10, lowercase, uppercase, digits, and symbols', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    const userPools = Object.entries(resources).filter(
      ([, resource]) => (resource as Record<string, unknown>).Type === 'AWS::Cognito::UserPool'
    );

    expect(userPools.length).toBeGreaterThan(0);

    for (const [logicalId, resource] of userPools) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;
      const policies = props.Policies as Record<string, unknown> | undefined;
      const passwordPolicy = policies?.PasswordPolicy as Record<string, unknown> | undefined;

      expect({
        userPool: logicalId,
        hasPasswordPolicy: passwordPolicy !== undefined,
        minimumLength: passwordPolicy?.MinimumLength,
        requireLowercase: passwordPolicy?.RequireLowercase,
        requireUppercase: passwordPolicy?.RequireUppercase,
        requireNumbers: passwordPolicy?.RequireNumbers,
        requireSymbols: passwordPolicy?.RequireSymbols,
      }).toEqual(
        expect.objectContaining({
          hasPasswordPolicy: true,
          minimumLength: 10,
          requireLowercase: true,
          requireUppercase: true,
          requireNumbers: true,
          requireSymbols: true,
        })
      );
    }
  });
});
