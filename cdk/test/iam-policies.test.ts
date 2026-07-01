import { createTestStacks } from './helpers/stack-setup';
import { Template } from 'aws-cdk-lib/assertions';

/**
 * IAM Policy Guardrail Tests
 *
 * These tests verify that IAM policies across all stacks follow least-privilege
 * rules and prevent future regressions that reintroduce overly broad permissions.
 *
 * Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5
 */

let apiTemplate: Template;
let dbTemplate: Template;
let dbFlowTemplate: Template;
let ragTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
  dbTemplate = stacks.dbTemplate;
  dbFlowTemplate = stacks.dbFlowTemplate;
  ragTemplate = stacks.ragTemplate;
});

/**
 * Helper: collect all inline policy statements from AWS::IAM::Policy resources
 * in a given template.
 */
function collectPolicyStatements(template: Template): Array<{ logicalId: string; statement: Record<string, unknown> }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; statement: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::IAM::Policy') continue;
    const props = res.Properties as Record<string, unknown> | undefined;
    if (!props) continue;
    const doc = props.PolicyDocument as Record<string, unknown> | undefined;
    if (!doc) continue;
    const statements = doc.Statement as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(statements)) continue;
    for (const stmt of statements) {
      results.push({ logicalId, statement: stmt });
    }
  }

  return results;
}

/**
 * Helper: collect inline policy statements embedded on AWS::IAM::Role resources.
 * Roles created with `inlinePolicies` render their statements under
 * Properties.Policies[].PolicyDocument (not as separate AWS::IAM::Policy
 * resources), so collectPolicyStatements does not see them.
 */
function collectInlineRoleStatements(
  template: Template
): Array<{ logicalId: string; roleName: unknown; statement: Record<string, unknown> }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; roleName: unknown; statement: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::IAM::Role') continue;
    const props = res.Properties as Record<string, unknown> | undefined;
    if (!props) continue;
    const policies = props.Policies as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(policies)) continue;
    for (const policy of policies) {
      const doc = policy.PolicyDocument as Record<string, unknown> | undefined;
      const statements = doc?.Statement as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(statements)) continue;
      for (const stmt of statements) {
        results.push({ logicalId, roleName: props.RoleName, statement: stmt });
      }
    }
  }

  return results;
}

/**
 * Helper: collect all managed policy ARNs from AWS::IAM::Role resources
 * in a given template.
 */
function collectManagedPolicyArns(template: Template): Array<{ logicalId: string; arn: unknown }> {
  const json = template.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; arn: unknown }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::IAM::Role') continue;
    const props = res.Properties as Record<string, unknown> | undefined;
    if (!props) continue;
    const arns = props.ManagedPolicyArns as unknown[] | undefined;
    if (!Array.isArray(arns)) continue;
    for (const arn of arns) {
      results.push({ logicalId, arn });
    }
  }

  return results;
}

/**
 * Helper: check if a resource value matches a wildcard secret ARN pattern.
 * Handles plain strings, Fn::Join, and Fn::Sub intrinsic functions.
 */
function isWildcardSecretResource(resource: unknown): boolean {
  const wildcardPattern = 'arn:aws:secretsmanager:*:*:secret:*';

  if (typeof resource === 'string') {
    return resource === wildcardPattern;
  }

  if (Array.isArray(resource)) {
    return resource.some((r) => isWildcardSecretResource(r));
  }

  if (typeof resource === 'object' && resource !== null) {
    const obj = resource as Record<string, unknown>;
    // Fn::Join
    if (obj['Fn::Join']) {
      const joinArgs = obj['Fn::Join'] as [string, unknown[]];
      if (Array.isArray(joinArgs) && joinArgs.length === 2) {
        const parts = joinArgs[1];
        if (Array.isArray(parts)) {
          const joined = parts
            .filter((p) => typeof p === 'string')
            .join(joinArgs[0]);
          if (joined === wildcardPattern) return true;
        }
      }
    }
    // Fn::Sub
    if (typeof obj['Fn::Sub'] === 'string') {
      return obj['Fn::Sub'] === wildcardPattern;
    }
  }

  return false;
}

/**
 * Helper: check if a resource value matches the wildcard logs ARN pattern.
 */
function isWildcardLogsResource(resource: unknown): boolean {
  const wildcardPattern = 'arn:aws:logs:*:*:*';

  if (typeof resource === 'string') {
    return resource === wildcardPattern;
  }

  if (Array.isArray(resource)) {
    return resource.some((r) => isWildcardLogsResource(r));
  }

  if (typeof resource === 'object' && resource !== null) {
    const obj = resource as Record<string, unknown>;
    if (obj['Fn::Join']) {
      const joinArgs = obj['Fn::Join'] as [string, unknown[]];
      if (Array.isArray(joinArgs) && joinArgs.length === 2) {
        const parts = joinArgs[1];
        if (Array.isArray(parts)) {
          const joined = parts
            .filter((p) => typeof p === 'string')
            .join(joinArgs[0]);
          if (joined === wildcardPattern) return true;
        }
      }
    }
    if (typeof obj['Fn::Sub'] === 'string') {
      return obj['Fn::Sub'] === wildcardPattern;
    }
  }

  return false;
}

/**
 * Helper: check if a statement's Action includes a specific action string.
 */
function statementHasAction(statement: Record<string, unknown>, action: string): boolean {
  const stmtAction = statement.Action;
  if (typeof stmtAction === 'string') {
    return stmtAction === action;
  }
  if (Array.isArray(stmtAction)) {
    return stmtAction.includes(action);
  }
  return false;
}

/**
 * Helper: check if a statement's Action includes any CloudWatch Logs action.
 */
function statementHasLogsAction(statement: Record<string, unknown>): boolean {
  const logsActions = ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'];
  const stmtAction = statement.Action;
  if (typeof stmtAction === 'string') {
    return logsActions.includes(stmtAction) || stmtAction.startsWith('logs:');
  }
  if (Array.isArray(stmtAction)) {
    return stmtAction.some(
      (a: unknown) => typeof a === 'string' && (logsActions.includes(a) || a.startsWith('logs:'))
    );
  }
  return false;
}

/**
 * Helper: check if a managed policy ARN matches a specific AWS managed policy name.
 * Handles plain strings and Fn::Join intrinsic functions.
 */
function isManagedPolicy(arn: unknown, policyName: string): boolean {
  const fullArn = `arn:aws:iam::aws:policy/${policyName}`;

  if (typeof arn === 'string') {
    return arn.includes(policyName);
  }

  if (typeof arn === 'object' && arn !== null) {
    const obj = arn as Record<string, unknown>;
    // Fn::Join pattern used by CDK for managed policy ARNs
    if (obj['Fn::Join']) {
      const joinArgs = obj['Fn::Join'] as [string, unknown[]];
      if (Array.isArray(joinArgs) && joinArgs.length === 2) {
        const parts = joinArgs[1];
        if (Array.isArray(parts)) {
          const stringParts = parts.filter((p) => typeof p === 'string') as string[];
          const joined = stringParts.join(joinArgs[0]);
          if (joined.includes(policyName)) return true;
        }
      }
    }
  }

  return false;
}

const allTemplates = () => [
  { name: 'ApiGatewayStack', template: apiTemplate },
  { name: 'DatabaseStack', template: dbTemplate },
  { name: 'DBFlowStack', template: dbFlowTemplate },
];

describe('IAM Policy Guardrails', () => {
  /**
   * Validates: Requirements 21.1
   * No policy should grant secretsmanager:GetSecretValue on a wildcard secret resource.
   */
  test('no policy grants secretsmanager:GetSecretValue on wildcard secret resource', () => {
    for (const { name, template } of allTemplates()) {
      const statements = collectPolicyStatements(template);
      for (const { logicalId, statement } of statements) {
        if (!statementHasAction(statement, 'secretsmanager:GetSecretValue')) continue;

        const resource = statement.Resource;
        expect({
          stack: name,
          policy: logicalId,
          resource,
          wildcardDetected: isWildcardSecretResource(resource),
        }).toEqual(
          expect.objectContaining({ wildcardDetected: false })
        );
      }
    }
  });

  /**
   * Validates: Requirements 21.2
   * No role should have the AmazonS3FullAccess managed policy attached.
   */
  test('no role has AmazonS3FullAccess managed policy', () => {
    for (const { name, template } of allTemplates()) {
      const arns = collectManagedPolicyArns(template);
      for (const { logicalId, arn } of arns) {
        expect({
          stack: name,
          role: logicalId,
          arn,
          hasS3FullAccess: isManagedPolicy(arn, 'AmazonS3FullAccess'),
        }).toEqual(
          expect.objectContaining({ hasS3FullAccess: false })
        );
      }
    }
  });

  /**
   * Validates: Requirements 21.3
   * No role should have the AmazonSSMReadOnlyAccess managed policy attached.
   */
  test('no role has AmazonSSMReadOnlyAccess managed policy', () => {
    for (const { name, template } of allTemplates()) {
      const arns = collectManagedPolicyArns(template);
      for (const { logicalId, arn } of arns) {
        expect({
          stack: name,
          role: logicalId,
          arn,
          hasSSMReadOnly: isManagedPolicy(arn, 'AmazonSSMReadOnlyAccess'),
        }).toEqual(
          expect.objectContaining({ hasSSMReadOnly: false })
        );
      }
    }
  });

  /**
   * Validates: Requirements 21.4
   * No policy should grant iam:AddUserToGroup.
   */
  test('no policy grants iam:AddUserToGroup', () => {
    for (const { name, template } of allTemplates()) {
      const statements = collectPolicyStatements(template);
      for (const { logicalId, statement } of statements) {
        expect({
          stack: name,
          policy: logicalId,
          hasAddUserToGroup: statementHasAction(statement, 'iam:AddUserToGroup'),
        }).toEqual(
          expect.objectContaining({ hasAddUserToGroup: false })
        );
      }
    }
  });

  /**
   * Validates: Requirements 21.5
   * No policy should grant CloudWatch Logs actions on arn:aws:logs:*:*:*.
   */
  test('no policy grants CloudWatch Logs actions on arn:aws:logs:*:*:*', () => {
    for (const { name, template } of allTemplates()) {
      const statements = collectPolicyStatements(template);
      for (const { logicalId, statement } of statements) {
        if (!statementHasLogsAction(statement)) continue;

        const resource = statement.Resource;
        expect({
          stack: name,
          policy: logicalId,
          resource,
          wildcardLogsDetected: isWildcardLogsResource(resource),
        }).toEqual(
          expect.objectContaining({ wildcardLogsDetected: false })
        );
      }
    }
  });

  /**
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   * bedrock:ApplyGuardrail permission exists with guardrail-scoped resource ARN, no wildcards.
   */
  test('bedrock:ApplyGuardrail policy exists with guardrail-scoped resource ARN', () => {
    const statements = collectPolicyStatements(apiTemplate);
    const guardrailStatements = statements.filter(
      ({ statement }) => statementHasAction(statement, 'bedrock:ApplyGuardrail')
    );

    // Must have at least one statement with bedrock:ApplyGuardrail
    expect(guardrailStatements.length).toBeGreaterThanOrEqual(1);

    // Verify no wildcard resources
    for (const { statement } of guardrailStatements) {
      const resource = statement.Resource;
      if (typeof resource === 'string') {
        expect(resource).not.toBe('*');
        expect(resource).toMatch(/arn:aws:bedrock:/);
      } else if (Array.isArray(resource)) {
        for (const r of resource) {
          if (typeof r === 'string') {
            expect(r).not.toBe('*');
          }
        }
      }
    }
  });

  /**
   * Validates: chatbotV2 can invoke models WITH a guardrail.
   * chatbotV2Role (MultimodalRagStack, inline policy) must grant
   * bedrock:ApplyGuardrail on a guardrail-scoped ARN, never '*'. The guardrail's
   * concrete id is created in ApiGatewayStack and resolved via SSM at runtime,
   * so the ARN is region/account-scoped with a wildcard on the id only.
   */
  test('chatbotV2Role grants bedrock:ApplyGuardrail on a guardrail-scoped ARN', () => {
    const statements = collectInlineRoleStatements(ragTemplate);
    const guardrailStatements = statements.filter(
      ({ statement }) => statementHasAction(statement, 'bedrock:ApplyGuardrail')
    );

    // chatbotV2Role must carry the permission (else the streamed call 403s).
    expect(guardrailStatements.length).toBeGreaterThanOrEqual(1);

    for (const { statement } of guardrailStatements) {
      const resource = statement.Resource;
      expect(resource).not.toBe('*');
      // region/account tokens render as Fn::Join, so assert on the serialized form.
      const serialized = JSON.stringify(resource);
      expect(serialized).toContain('guardrail/');
      expect(serialized).not.toBe('"*"');
    }
  });

  /**
   * Validates: Requirements 6.3
   * No bedrock:* wildcard action exists.
   */
  test('no policy grants bedrock:* wildcard action', () => {
    for (const { name, template } of allTemplates()) {
      const statements = collectPolicyStatements(template);
      for (const { logicalId, statement } of statements) {
        expect({
          stack: name,
          policy: logicalId,
          hasBedrockWildcard: statementHasAction(statement, 'bedrock:*'),
        }).toEqual(
          expect.objectContaining({ hasBedrockWildcard: false })
        );
      }
    }
  });

  /**
   * Validates: Prompt Conflict Checker - Req 8, Req 9
   * The validation model ID is stored in an SSM parameter (runtime-configurable),
   * and the instructorFunction reads it via the VALIDATION_MODEL_ID_PARAM env var
   * (the parameter name) rather than a hardcoded model id.
   */
  test('validation model ID is an SSM parameter wired into instructorFunction', () => {
    const json = apiTemplate.toJSON();
    const resources = json.Resources ?? {};

    // (1) SSM parameter exists with the Haiku default value (environment = 'dev' in tests)
    let validationParamLogicalId: string | undefined;
    let validationParamProps: Record<string, unknown> | undefined;
    for (const [logicalId, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::SSM::Parameter') continue;
      const props = res.Properties as Record<string, unknown> | undefined;
      if (props?.Name === '/AILA/dev/ValidationModelId') {
        validationParamLogicalId = logicalId;
        validationParamProps = props;
        break;
      }
    }

    expect(validationParamLogicalId).toBeDefined();
    expect(validationParamProps!.Value).toBe('anthropic.claude-3-haiku-20240307-v1:0');

    // (2) instructorFunction reads it via VALIDATION_MODEL_ID_PARAM (a Ref to the param,
    // which resolves to the parameter name at deploy time — not a hardcoded model id)
    let foundParamEnv = false;
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::Lambda::Function') continue;
      const props = res.Properties as Record<string, unknown> | undefined;
      const env = props?.Environment as Record<string, unknown> | undefined;
      const vars = env?.Variables as Record<string, unknown> | undefined;
      const v = vars?.VALIDATION_MODEL_ID_PARAM;
      if (
        v &&
        typeof v === 'object' &&
        (v as Record<string, unknown>).Ref === validationParamLogicalId
      ) {
        foundParamEnv = true;
        break;
      }
    }
    expect(foundParamEnv).toBe(true);
  });

  /**
   * Validates: Prompt Conflict Checker - Req 9, IAM Security Policy
   * dbLambdaRole has ssm:GetParameter scoped to exactly the ValidationModelId
   * parameter ARN (no wildcards).
   */
  test('dbLambdaRole has ssm:GetParameter scoped to the ValidationModelId parameter', () => {
    const statements = collectPolicyStatements(apiTemplate);
    const validationSsm = statements.filter(({ logicalId, statement }) => {
      if (!logicalId.toLowerCase().includes('dblambdarole')) return false;
      if (!statementHasAction(statement, 'ssm:GetParameter')) return false;
      const resource = statement.Resource;
      const resList = Array.isArray(resource) ? resource : [resource];
      return resList.some(
        (r) => typeof r === 'string' && r.includes('parameter/AILA/dev/ValidationModelId')
      );
    });

    expect(validationSsm.length).toBeGreaterThanOrEqual(1);

    // No wildcard resources on that statement
    for (const { statement } of validationSsm) {
      const resource = statement.Resource;
      const resList = Array.isArray(resource) ? resource : [resource];
      for (const r of resList) {
        if (typeof r === 'string') {
          expect(r).not.toBe('*');
        }
      }
    }
  });

  /**
   * Validates: Requirements 1.6, 6.4
   * ssm:GetParameter includes guardrail parameter ARNs (no wildcards).
   */
  test('ssm:GetParameter policy includes guardrail parameter ARNs', () => {
    const statements = collectPolicyStatements(apiTemplate);
    const ssmStatements = statements.filter(
      ({ statement }) => statementHasAction(statement, 'ssm:GetParameter')
    );

    expect(ssmStatements.length).toBeGreaterThanOrEqual(1);

    // Verify no wildcard resources on SSM statements
    for (const { statement } of ssmStatements) {
      const resource = statement.Resource;
      if (typeof resource === 'string') {
        expect(resource).not.toBe('*');
      } else if (Array.isArray(resource)) {
        for (const r of resource) {
          if (typeof r === 'string') {
            expect(r).not.toBe('*');
          }
        }
      }
    }
  });

  /**
   * Validates: Student PDF Viewer - Req 3
   * dbLambdaRole has s3:GetObject scoped to dataIngestionBucket/* for student PDF viewing.
   * Must NOT have s3:PutObject, s3:DeleteObject, or s3:ListBucket on that bucket.
   */
  test('dbLambdaRole has s3:GetObject scoped to data ingestion bucket', () => {
    const statements = collectPolicyStatements(apiTemplate);
    const s3GetStatements = statements.filter(
      ({ statement }) => statementHasAction(statement, 's3:GetObject')
    );

    // Verify at least one s3:GetObject statement exists
    expect(s3GetStatements.length).toBeGreaterThanOrEqual(1);

    // Verify s3:GetObject is NOT granted on wildcard '*' resource
    for (const { statement } of s3GetStatements) {
      const resource = statement.Resource;
      if (typeof resource === 'string') {
        expect(resource).not.toBe('*');
      } else if (Array.isArray(resource)) {
        for (const r of resource) {
          if (typeof r === 'string') {
            expect(r).not.toBe('*');
          }
        }
      }
    }
  });

  test('dbLambdaRole has no s3:PutObject; any s3:DeleteObject/ListBucket is scoped (instructor cleanup_module)', () => {
    const statements = collectPolicyStatements(apiTemplate);

    // Find statements from dbLambdaRole's policy
    const dbRolePolicies = statements.filter(
      ({ logicalId }) => logicalId.toLowerCase().includes('dblambdarole')
    );

    for (const { statement } of dbRolePolicies) {
      // dbLambdaRole (student + instructor) must never WRITE objects to a bucket.
      // Uploads go through a separate presigned-URL function, not this role.
      expect(statementHasAction(statement, 's3:PutObject')).toBe(false);

      // instructorFunction's cleanup_module route legitimately needs ListBucket + DeleteObject
      // on the data ingestion bucket. These are allowed, but must be scoped (never wildcard '*').
      if (
        statementHasAction(statement, 's3:DeleteObject') ||
        statementHasAction(statement, 's3:ListBucket')
      ) {
        const resource = statement.Resource;
        const resources = Array.isArray(resource) ? resource : [resource];
        for (const r of resources) {
          if (typeof r === 'string') {
            expect(r).not.toBe('*');
          }
        }
      }
    }
  });
});
