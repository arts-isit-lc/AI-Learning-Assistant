import { createTestStacks } from './helpers/stack-setup';
import { Template } from 'aws-cdk-lib/assertions';

/**
 * Network Security Tests
 *
 * These tests verify that a WAF WebACL is associated with the API Gateway
 * and that the WAF includes the AWSManagedRulesCommonRuleSet and
 * AWSManagedRulesSQLiRuleSet managed rule groups.
 *
 * Validates: Requirements 24.4, 24.5
 */

let apiTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
});

describe('Network Security', () => {
  /**
   * Validates: Requirement 24.4
   * A WAF WebACL must be associated with the API Gateway.
   */
  test('WAF WebACL is associated with API Gateway', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    const associations = Object.entries(resources).filter(
      ([, resource]) =>
        (resource as Record<string, unknown>).Type === 'AWS::WAFv2::WebACLAssociation'
    );

    expect(associations.length).toBeGreaterThan(0);

    // Verify at least one association targets an API Gateway stage
    const hasApiGatewayAssociation = associations.some(([, resource]) => {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;
      const resourceArn = props?.ResourceArn;

      if (typeof resourceArn === 'string') {
        return resourceArn.includes('apigateway');
      }

      // Handle Fn::Join or Fn::Sub intrinsic functions
      if (resourceArn && typeof resourceArn === 'object') {
        const arnStr = JSON.stringify(resourceArn);
        return arnStr.includes('apigateway') || arnStr.includes('restapis');
      }

      return false;
    });

    expect(hasApiGatewayAssociation).toBe(true);
  });

  /**
   * Validates: Requirement 24.5
   * The WAF must include AWSManagedRulesCommonRuleSet and AWSManagedRulesSQLiRuleSet rules.
   */
  test('WAF includes AWSManagedRulesCommonRuleSet and AWSManagedRulesSQLiRuleSet', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    const webAcls = Object.entries(resources).filter(
      ([, resource]) =>
        (resource as Record<string, unknown>).Type === 'AWS::WAFv2::WebACL'
    );

    expect(webAcls.length).toBeGreaterThan(0);

    const requiredRuleSets = [
      'AWSManagedRulesCommonRuleSet',
      'AWSManagedRulesSQLiRuleSet',
    ];

    for (const [logicalId, resource] of webAcls) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;
      const rules = props?.Rules as Array<Record<string, unknown>> | undefined;

      expect(rules).toBeDefined();
      expect(rules!.length).toBeGreaterThan(0);

      for (const requiredRuleSet of requiredRuleSets) {
        const hasRule = rules!.some((rule) => {
          const statement = rule.Statement as Record<string, unknown> | undefined;
          const managedRuleGroup = statement?.ManagedRuleGroupStatement as
            | Record<string, unknown>
            | undefined;
          return managedRuleGroup?.Name === requiredRuleSet;
        });

        expect({
          webAcl: logicalId,
          ruleSet: requiredRuleSet,
          found: hasRule,
        }).toEqual(
          expect.objectContaining({
            ruleSet: requiredRuleSet,
            found: true,
          })
        );
      }
    }
  });
});
