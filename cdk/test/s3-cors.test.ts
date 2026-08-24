import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';
import { DEFAULT_ALLOWED_ORIGINS, resolveAllowedOrigins } from '../lib/constants/cors';

/**
 * S3 CORS Configuration Tests
 *
 * Verifies that the browser-facing presigned-URL buckets do NOT allow all
 * origins ("*") and instead use the resolved per-environment origin list.
 * Guards against a regression of audit finding #11.
 */

let apiTemplate: Template;
let ragTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
  ragTemplate = stacks.ragTemplate;
});

/** Collect every AllowedOrigins array from every S3 bucket CORS rule in a template. */
function collectAllowedOrigins(template: Template): string[][] {
  const buckets = template.findResources('AWS::S3::Bucket');
  const origins: string[][] = [];

  for (const bucket of Object.values(buckets)) {
    const cors = (bucket.Properties as Record<string, unknown> | undefined)
      ?.CorsConfiguration as { CorsRules?: Array<{ AllowedOrigins?: string[] }> } | undefined;
    if (!cors?.CorsRules) continue;
    for (const rule of cors.CorsRules) {
      if (rule.AllowedOrigins) origins.push(rule.AllowedOrigins);
    }
  }

  return origins;
}

describe('S3 CORS configuration', () => {
  const allTemplates = () => [
    { name: 'ApiGatewayStack', template: apiTemplate },
    { name: 'MultimodalRagStack', template: ragTemplate },
  ];

  test('at least one CORS-enabled bucket exists (sanity)', () => {
    const total = allTemplates().reduce(
      (n, { template }) => n + collectAllowedOrigins(template).length,
      0
    );
    // 3 buckets in ApiGatewayStack + 1 in MultimodalRagStack = 4 CORS rules.
    expect(total).toBeGreaterThanOrEqual(4);
  });

  test('no bucket allows all origins ("*")', () => {
    for (const { name, template } of allTemplates()) {
      for (const origins of collectAllowedOrigins(template)) {
        expect({ stack: name, origins }).toEqual({
          stack: name,
          origins: expect.not.arrayContaining(['*']),
        });
      }
    }
  });

  test('every CORS-enabled bucket uses the dev default origin list', () => {
    for (const { template } of allTemplates()) {
      for (const origins of collectAllowedOrigins(template)) {
        expect(origins).toEqual(DEFAULT_ALLOWED_ORIGINS.dev);
      }
    }
  });

  test('dev origins point at the live Amplify app, not the retired one', () => {
    // Regression guard for the CORS-403 upload failure: the allow-list once
    // hardcoded a since-replaced Amplify domain, so the live SPA's preflight
    // was rejected. Keep the allow-list pinned to the current app id and never
    // reintroduce the dead domain.
    expect(DEFAULT_ALLOWED_ORIGINS.dev).toEqual(
      expect.arrayContaining([
        // The SPA is served from a custom domain — this is the origin the
        // browser actually sends, so it MUST be in the allow-list.
        'https://ocelia-dev.arts.ubc.ca',
        'https://dev.dbqfar7gbtstn.amplifyapp.com',
        'https://main.dbqfar7gbtstn.amplifyapp.com',
      ])
    );
    for (const origin of DEFAULT_ALLOWED_ORIGINS.dev) {
      expect(origin).not.toContain('d35ufva5r2ltvd');
    }
  });

  test('prod origins cover the custom domain + live Amplify app, and never "*"', () => {
    // Prod must not fall back to "*" (audit #11) and must include both the
    // origins the browser actually sends: the custom domain users hit and the
    // Amplify default for the main branch (appId d21r345xhq29at).
    expect(DEFAULT_ALLOWED_ORIGINS.prod).toEqual(
      expect.arrayContaining([
        'https://ocelia.arts.ubc.ca',
        'https://main.d21r345xhq29at.amplifyapp.com',
      ])
    );
    expect(DEFAULT_ALLOWED_ORIGINS.prod.length).toBeGreaterThan(0);
    expect(DEFAULT_ALLOWED_ORIGINS.prod).not.toContain('*');
  });
});

describe('resolveAllowedOrigins', () => {
  test('returns per-environment defaults when no context override is set', () => {
    const app = new cdk.App({ context: { StackPrefix: 'Test', environment: 'dev' } });
    const stack = new cdk.Stack(app, 'S1');
    expect(resolveAllowedOrigins(stack, 'dev')).toEqual(DEFAULT_ALLOWED_ORIGINS.dev);
  });

  test('context override (comma-separated string) takes precedence over defaults', () => {
    const app = new cdk.App({
      context: { allowedOrigins: 'https://a.example.com, https://b.example.com' },
    });
    const stack = new cdk.Stack(app, 'S2');
    expect(resolveAllowedOrigins(stack, 'dev')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  test('context override (array) is honored and empties are dropped', () => {
    const app = new cdk.App({
      context: { allowedOrigins: ['https://a.example.com', ''] },
    });
    const stack = new cdk.Stack(app, 'S3');
    expect(resolveAllowedOrigins(stack, 'prod')).toEqual(['https://a.example.com']);
  });

  test('returns prod defaults for the prod environment when no context override is set', () => {
    const app = new cdk.App({ context: { StackPrefix: 'Test', environment: 'prod' } });
    const stack = new cdk.Stack(app, 'S4');
    expect(resolveAllowedOrigins(stack, 'prod')).toEqual(DEFAULT_ALLOWED_ORIGINS.prod);
  });

  test('falls back to "*" with a synth warning when an env has no configured origins', () => {
    const app = new cdk.App({ context: { StackPrefix: 'Test' } });
    const stack = new cdk.Stack(app, 'S5');
    // 'staging' has no baked-in defaults and no context override here
    expect(resolveAllowedOrigins(stack, 'staging')).toEqual(['*']);
    const warnings = stack.node.metadata.filter(
      (m) => m.type === 'aws:cdk:warning'
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});
