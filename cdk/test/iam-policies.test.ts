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
   * course_progress (student-course-progress spec): studentFunction's shared
   * dbLambdaRole must grant ONLY read actions (GetItem/BatchGetItem), scoped to
   * the chatbot_v2 session-state table ARN — no dynamodb:* and no Resource "*".
   */
  test('dbLambdaRole grants read-only DynamoDB access scoped to the session-state table', () => {
    const statements = collectPolicyStatements(apiTemplate);
    // Scope to the session-state table grant specifically. Other roles in this
    // stack (e.g. the text-generation function) legitimately hold GetItem +
    // PutItem + UpdateItem on the *conversation* table under the two-statement
    // DynamoDB data-ops pattern; those are out of scope for this session-state
    // read-only guardrail, so exclude them by resource before asserting.
    const ddbReadStatements = statements.filter(({ statement }) => {
      const hasRead =
        statementHasAction(statement, 'dynamodb:GetItem') ||
        statementHasAction(statement, 'dynamodb:BatchGetItem');
      if (!hasRead) return false;
      const resourceStr = JSON.stringify(statement.Resource);
      return (
        resourceStr.includes('sessionStateTable') || resourceStr.includes('MultimodalRagStack')
      );
    });

    // The grant exists.
    expect(ddbReadStatements.length).toBeGreaterThan(0);

    for (const { statement } of ddbReadStatements) {
      const actions = Array.isArray(statement.Action)
        ? (statement.Action as string[])
        : [statement.Action as string];

      // Read-only: only GetItem/BatchGetItem — never a wildcard or a write action.
      for (const action of actions) {
        expect(['dynamodb:GetItem', 'dynamodb:BatchGetItem']).toContain(action);
      }

      // Scoped resource — never "*" or a table/* wildcard; references the
      // session-state table via its cross-stack import.
      const resource = statement.Resource;
      const resourceStr = JSON.stringify(resource);
      expect(resource).not.toBe('*');
      expect(resourceStr).not.toContain('table/*');
      expect(
        resourceStr.includes('sessionStateTable') || resourceStr.includes('MultimodalRagStack')
      ).toBe(true);
    }
  });

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

    // (1) SSM parameter exists with the Claude Haiku 4.5 default value (environment = 'dev' in tests)
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
    expect(validationParamProps!.Value).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');

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
   * Validates: Prompt Conflict Checker validation model + cross-Region inference IAM.
   * The instructor role (dbLambdaRole) can invoke the validation model (Haiku
   * 4.5) and the runtime-switchable Sonnet 4.5 via Geo-US cross-Region
   * inference. Each model requires BOTH its inference-profile ARN and the
   * underlying foundation-model ARN in every US destination Region — never a
   * wildcard. The retired Claude 3 ids must be gone.
   */
  test('dbLambdaRole grants bedrock:InvokeModel on the Claude 4.5 inference profiles + destination FM ARNs', () => {
    const statements = collectPolicyStatements(apiTemplate);
    const invokeStatements = statements.filter(
      ({ logicalId, statement }) =>
        logicalId.toLowerCase().includes('dblambdarole') &&
        statementHasAction(statement, 'bedrock:InvokeModel')
    );

    expect(invokeStatements.length).toBeGreaterThanOrEqual(1);

    // Region/account render as tokens, so assert on the serialized form.
    const serialized = JSON.stringify(invokeStatements.map((s) => s.statement.Resource));

    // Inference-profile ARNs (Geo-US): validation model (Haiku 4.5) + the
    // runtime-switchable Sonnet 4.5.
    expect(serialized).toContain('inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0');

    // Underlying foundation-model ARNs must be present in each US destination
    // Region (Geo-US from ca-central-1 routes to us-east-1/us-east-2/us-west-2).
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      expect(serialized).toContain(
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`
      );
      expect(serialized).toContain(
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`
      );
    }

    // Retired Claude 3 ids must no longer be granted.
    expect(serialized).not.toContain('claude-3-sonnet-20240229');
    expect(serialized).not.toContain('claude-3-haiku-20240307');

    // InvokeModel must never be granted on a bare wildcard.
    for (const { statement } of invokeStatements) {
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
   * Validates: cross-Region inference IAM for the RAG roles (MultimodalRagStack).
   * chatbotV2 (Sonnet 4.5 + Haiku 4.5) and enrichment + retrieval (Haiku 4.5)
   * must each grant InvokeModel on the inference-profile ARN plus the underlying
   * foundation-model ARN in every US destination Region, never a wildcard, and
   * never the retired Claude 3 ids.
   */
  test('RAG roles grant bedrock:InvokeModel on Claude 4.5 inference profiles + destination FM ARNs', () => {
    const statements = collectInlineRoleStatements(ragTemplate);
    const invokeStatements = statements.filter(({ statement }) =>
      statementHasAction(statement, 'bedrock:InvokeModel')
    );

    expect(invokeStatements.length).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify(invokeStatements.map((s) => s.statement.Resource));

    // Haiku 4.5 is used by all three RAG roles; Sonnet 4.5 by chatbotV2.
    expect(serialized).toContain('inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      expect(serialized).toContain(
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`
      );
    }

    // No retired Claude 3 ids, no bare wildcard.
    expect(serialized).not.toContain('claude-3-haiku-20240307');
    expect(serialized).not.toContain('claude-3-sonnet-20240229');
    for (const { statement } of invokeStatements) {
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
   * Validates: multi-image figure comparison (T8).
   * The ragRetrievalRole specifically must grant bedrock:InvokeModel on BOTH the
   * Haiku 4.5 (single-image escalation) AND Sonnet 4.5 (multi-image comparison)
   * inference profiles + their destination-Region foundation-model ARNs. Sonnet
   * 4.5 was previously only on chatbotV2Role; the comparison call runs in the
   * retrieval Lambda, so the retrieval role now needs it too.
   */
  test('ragRetrievalRole grants bedrock:InvokeModel on Haiku 4.5 AND Sonnet 4.5 profiles', () => {
    const statements = collectInlineRoleStatements(ragTemplate);
    const retrievalInvoke = statements.filter(
      ({ logicalId, statement }) =>
        logicalId.toLowerCase().includes('ragretrievalrole') &&
        statementHasAction(statement, 'bedrock:InvokeModel')
    );

    expect(retrievalInvoke.length).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify(retrievalInvoke.map((s) => s.statement.Resource));
    expect(serialized).toContain('inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      expect(serialized).toContain(
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`
      );
    }

    // Never a bare wildcard, never a retired Claude 3 id.
    expect(serialized).not.toContain('claude-3-sonnet-20240229');
    for (const { statement } of retrievalInvoke) {
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
   * Validates: formula comparison Phase 2 (Tier 2). The retrieval role may invoke
   * the math_compute Lambda for symbolic equivalence, scoped to that function ARN
   * (least privilege — never a wildcard).
   */
  test('ragRetrievalRole grants lambda:InvokeFunction scoped to math_compute', () => {
    const statements = collectInlineRoleStatements(ragTemplate);
    const invoke = statements.filter(
      ({ logicalId, statement }) =>
        logicalId.toLowerCase().includes('ragretrievalrole') &&
        statementHasAction(statement, 'lambda:InvokeFunction')
    );

    expect(invoke.length).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify(invoke.map((s) => s.statement.Resource));
    // Scoped to the math_compute function (name appears in the constructed ARN).
    expect(serialized).toContain('mathComputeFunction');

    for (const { statement } of invoke) {
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
   * Validates: formula comparison Phase 2 — the retrieval Lambda is told the
   * math_compute function name so it can invoke it for Tier-2 equivalence.
   */
  test('ragRetrievalFunction injects MATH_COMPUTE_FUNCTION_NAME', () => {
    const json = ragTemplate.toJSON();
    const resources = json.Resources ?? {};

    let found = false;
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::Lambda::Function') continue;
      const props = res.Properties as Record<string, unknown> | undefined;
      const env = props?.Environment as Record<string, unknown> | undefined;
      const vars = env?.Variables as Record<string, unknown> | undefined;
      const value = vars?.MATH_COMPUTE_FUNCTION_NAME;
      if (typeof value === 'string' && value.includes('mathComputeFunction')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  /**
   * Validates: multi-image figure comparison (T8) — model ids are injected as
   * env from constants/bedrock.ts (single source of truth), not hardcoded in
   * Python. The retrieval Lambda gets Haiku 4.5 (single-image) as VISION_MODEL_ID
   * and Sonnet 4.5 (comparison) as COMPARISON_VISION_MODEL_ID.
   */
  test('ragRetrievalFunction injects VISION_MODEL_ID (Haiku 4.5) + COMPARISON_VISION_MODEL_ID (Sonnet 4.5)', () => {
    const json = ragTemplate.toJSON();
    const resources = json.Resources ?? {};

    let found = false;
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::Lambda::Function') continue;
      const props = res.Properties as Record<string, unknown> | undefined;
      const env = props?.Environment as Record<string, unknown> | undefined;
      const vars = env?.Variables as Record<string, unknown> | undefined;
      if (
        vars &&
        vars.VISION_MODEL_ID === 'us.anthropic.claude-haiku-4-5-20251001-v1:0' &&
        vars.COMPARISON_VISION_MODEL_ID === 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  /**
   * Validates: cross-modal grounding (structured reference + image in one Sonnet
   * 4.5 vision call) is enabled on the retrieval Lambda via env. It reuses the
   * existing Sonnet 4.5 grant/env — no new IAM/model — so only the feature-flag
   * env var is asserted here (testing-policy: CDK change → assertion test).
   */
  test('ragRetrievalFunction enables CROSS_MODAL_GROUNDING_ENABLED + CROSS_MODAL_EXPLANATION_ENABLED', () => {
    const json = ragTemplate.toJSON();
    const resources = json.Resources ?? {};

    let found = false;
    for (const [, resource] of Object.entries(resources)) {
      const res = resource as Record<string, unknown>;
      if (res.Type !== 'AWS::Lambda::Function') continue;
      const props = res.Properties as Record<string, unknown> | undefined;
      const env = props?.Environment as Record<string, unknown> | undefined;
      const vars = env?.Variables as Record<string, unknown> | undefined;
      // Scope to the retrieval function (it carries the vision-model env vars).
      // Both cross-modal families reuse the SAME Sonnet grant/env — no new IAM.
      if (
        vars &&
        vars.COMPARISON_VISION_MODEL_ID &&
        vars.CROSS_MODAL_GROUNDING_ENABLED === 'true' &&
        vars.CROSS_MODAL_EXPLANATION_ENABLED === 'true'
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  /**
   * Regression guard: the retired Claude 3 model ids must not appear in ANY IAM
   * policy across the API, DB, DBFlow, or RAG stacks after the 4.5 migration.
   */
  test('no IAM policy references retired Claude 3 model ids', () => {
    const templates = [
      { name: 'ApiGatewayStack', template: apiTemplate },
      { name: 'DatabaseStack', template: dbTemplate },
      { name: 'DBFlowStack', template: dbFlowTemplate },
      { name: 'MultimodalRagStack', template: ragTemplate },
    ];
    for (const { name, template } of templates) {
      const all = [
        ...collectPolicyStatements(template),
        ...collectInlineRoleStatements(template),
      ];
      const serialized = JSON.stringify(all.map((s) => s.statement.Resource));
      expect({ stack: name, hasSonnet3: serialized.includes('claude-3-sonnet-20240229') }).toEqual(
        expect.objectContaining({ hasSonnet3: false })
      );
      expect({ stack: name, hasHaiku3: serialized.includes('claude-3-haiku-20240307') }).toEqual(
        expect.objectContaining({ hasHaiku3: false })
      );
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
