import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * chatbot-v2-integration: guardrail + AppSync wiring.
 *
 * The chatbotV2Function lives in MultimodalRagStack but the guardrail SSM params
 * and AppSync API live in ApiGatewayStack (which depends on the rag stack). To
 * avoid a circular cross-stack dependency, those values are referenced by
 * deterministic SSM parameter name (/AILA/${environment}/...) and resolved at
 * runtime. These tests assert that wiring is in place (environment = 'dev').
 */

let apiTemplate: Template;
let ragTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
  ragTemplate = stacks.ragTemplate;
});

/** Collect IAM policy statements from a template (inline role policies + AWS::IAM::Policy). */
function collectStatements(template: Template): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const json = template.toJSON();
  for (const resource of Object.values(json.Resources ?? {})) {
    const res = resource as Record<string, any>;
    if (res.Type === 'AWS::IAM::Policy') {
      const stmts = res.Properties?.PolicyDocument?.Statement ?? [];
      out.push(...stmts);
    } else if (res.Type === 'AWS::IAM::Role') {
      for (const p of res.Properties?.Policies ?? []) {
        out.push(...(p.PolicyDocument?.Statement ?? []));
      }
    }
  }
  return out;
}

function hasAction(stmt: Record<string, any>, action: string): boolean {
  const a = stmt.Action;
  return a === action || (Array.isArray(a) && a.includes(action));
}

describe('chatbot-v2 guardrail + AppSync wiring', () => {
  test('chatbotV2Function env references the deterministic SSM param names', () => {
    ragTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GUARDRAIL_ID_PARAM: '/AILA/dev/GuardrailId',
          GUARDRAIL_VERSION_PARAM: '/AILA/dev/GuardrailVersion',
          APPSYNC_API_URL_PARAM: '/AILA/dev/AppSyncApiUrl',
        }),
      },
    });
  });

  test('ApiGatewayStack publishes the AppSync URL to the AppSyncApiUrl SSM parameter', () => {
    apiTemplate.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/AILA/dev/AppSyncApiUrl',
      Type: 'String',
    });
  });

  test('chatbot role ssm:GetParameter is scoped to /AILA/${environment}/* (not the broad /AILA/*)', () => {
    const ssmStatements = collectStatements(ragTemplate).filter((s) => hasAction(s, 'ssm:GetParameter'));
    expect(ssmStatements.length).toBeGreaterThanOrEqual(1);

    for (const stmt of ssmStatements) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const r of resources) {
        if (typeof r === 'string' && r.includes(':parameter/AILA/')) {
          // must be environment-scoped, never the broad wildcard
          expect(r).toContain('parameter/AILA/dev/');
          expect(r.endsWith('parameter/AILA/*')).toBe(false);
        }
      }
    }
  });

  test('chatbot AppSync GraphQL permission is field-scoped to sendChatChunk', () => {
    const appsyncStatements = collectStatements(ragTemplate).filter((s) => hasAction(s, 'appsync:GraphQL'));
    expect(appsyncStatements.length).toBeGreaterThanOrEqual(1);

    for (const stmt of appsyncStatements) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const r of resources) {
        if (typeof r === 'string') {
          expect(r).not.toBe('*');
          expect(r).toContain('Mutation/fields/sendChatChunk');
        }
      }
    }
  });
});
