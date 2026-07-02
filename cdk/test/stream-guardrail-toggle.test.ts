import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';

/**
 * STREAM_GUARDRAIL_DISABLED is a DEV-ONLY diagnostic toggle on chatbotV2Function
 * used to measure the guardrail's time-to-first-token cost. While on, streamed
 * output is UNFILTERED, so the wiring in multimodal-rag-stack.ts hard-gates it:
 *   - default (no context)  -> "false"
 *   - dev + `-c streamGuardrailDisabled=true`  -> "true"
 *   - prod + the same flag  -> "false"  (context ignored; NEVER unfiltered in prod)
 *
 * These tests lock in that contract, above all the prod safety gate.
 */

function ragTemplate(environment: string, context: Record<string, unknown> = {}): Template {
  const app = new cdk.App({
    context: { StackPrefix: 'Test', environment, ...context },
  });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpc = new VpcStack(app, 'Test-VpcStack', { env, environment });
  const db = new DatabaseStack(app, 'Test-DatabaseStack', vpc, { env, environment });
  const rag = new MultimodalRagStack(app, 'Test-MultimodalRagStack', db, vpc, { env, environment });
  return Template.fromStack(rag);
}

/** All STREAM_GUARDRAIL_DISABLED env values across every Lambda in the template. */
function streamGuardrailValues(t: Template): string[] {
  const fns = t.findResources('AWS::Lambda::Function');
  const values: string[] = [];
  for (const fn of Object.values(fns)) {
    const v = (fn as any).Properties?.Environment?.Variables?.STREAM_GUARDRAIL_DISABLED;
    if (v !== undefined) values.push(v);
  }
  return values;
}

describe('STREAM_GUARDRAIL_DISABLED dev-only diagnostic toggle', () => {
  test('defaults to "false" in dev when no context flag is set', () => {
    const t = ragTemplate('dev');
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ STREAM_GUARDRAIL_DISABLED: 'false' }) },
    });
    // Exactly one Lambda (chatbotV2Function) carries the flag, and it is off.
    expect(streamGuardrailValues(t)).toEqual(['false']);
  });

  test('is "true" in dev when -c streamGuardrailDisabled=true (string form, CLI)', () => {
    const t = ragTemplate('dev', { streamGuardrailDisabled: 'true' });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ STREAM_GUARDRAIL_DISABLED: 'true' }) },
    });
  });

  test('accepts a boolean context value in dev', () => {
    const t = ragTemplate('dev', { streamGuardrailDisabled: true });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ STREAM_GUARDRAIL_DISABLED: 'true' }) },
    });
  });

  test('is FORCED "false" in prod even when the context flag is set (safety gate)', () => {
    const t = ragTemplate('prod', { streamGuardrailDisabled: 'true' });
    // The chatbot flag is off...
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ STREAM_GUARDRAIL_DISABLED: 'false' }) },
    });
    // ...and NO Lambda in prod is ever "true" (guardrail is never detached).
    expect(streamGuardrailValues(t)).not.toContain('true');
  });
});
