import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AmplifyStack } from "../lib/amplify-stack";
import type { ApiGatewayStack } from "../lib/api-gateway-stack";

/**
 * AmplifyStack only reads a few getters off ApiGatewayStack (build-time env
 * vars), so we stub them and skip synthesizing the Docker-backed API/RAG stacks.
 * AmplifyStack itself provisions no container assets, so this needs no Docker.
 */
function fakeApiStack(): ApiGatewayStack {
  return {
    getUserPoolId: () => "test-user-pool-id",
    getUserPoolClientId: () => "test-user-pool-client-id",
    getEndpointUrl: () => "https://api.example.com/",
    getIdentityPoolId: () => "test-identity-pool-id",
    getEventApiUrl: () => "wss://events.example.com/graphql",
  } as unknown as ApiGatewayStack;
}

function amplifyTemplate(environment = "dev"): Template {
  const app = new App({ context: { StackPrefix: "Test", environment } });
  const stack = new AmplifyStack(app, "Test-AmplifyStack", fakeApiStack(), {
    env: { account: "123456789012", region: "ca-central-1" },
    environment,
  });
  return Template.fromStack(stack);
}

/** Pull the single Amplify App's CustomRules array out of a synthesized template. */
function customRules(template: Template): Array<{ Status?: string; Target?: string }> {
  const apps = template.findResources("AWS::Amplify::App");
  const app = Object.values(apps)[0] as { Properties?: { CustomRules?: unknown } };
  return (app.Properties?.CustomRules ?? []) as Array<{ Status?: string; Target?: string }>;
}

describe("AmplifyStack caching headers", () => {
  it("revalidates index.html on every load (no-cache/no-store)", () => {
    amplifyTemplate().hasResourceProperties("AWS::Amplify::App", {
      CustomHeaders: Match.stringLikeRegexp("no-cache, no-store, must-revalidate"),
    });
  });

  it("caches the immutable, content-hashed /assets for a year", () => {
    amplifyTemplate().hasResourceProperties("AWS::Amplify::App", {
      CustomHeaders: Match.stringLikeRegexp("public, max-age=31536000, immutable"),
    });
  });

  it("scopes the headers to index.html and the /assets path", () => {
    const t = amplifyTemplate();
    t.hasResourceProperties("AWS::Amplify::App", {
      CustomHeaders: Match.stringLikeRegexp("/index\\.html"),
    });
    t.hasResourceProperties("AWS::Amplify::App", {
      CustomHeaders: Match.stringLikeRegexp("/assets"),
    });
  });

  it("keeps the SPA rewrite rule (404 -> index.html) alongside the caching headers", () => {
    // Regression guard: the caching headers must not displace the deep-link rewrite.
    amplifyTemplate().hasResourceProperties("AWS::Amplify::App", {
      CustomRules: Match.arrayWith([Match.objectLike({ Target: "/", Status: "404-200" })]),
    });
  });
});

describe("AmplifyStack canonical-domain redirect", () => {
  it("301-redirects the default domain to the dev custom domain", () => {
    amplifyTemplate("dev").hasResourceProperties("AWS::Amplify::App", {
      CustomRules: Match.arrayWith([
        Match.objectLike({ Status: "301", Target: "https://ocelia-dev.arts.ubc.ca" }),
      ]),
    });
  });

  it("301-redirects the default domain to the prod custom domain", () => {
    amplifyTemplate("prod").hasResourceProperties("AWS::Amplify::App", {
      CustomRules: Match.arrayWith([
        Match.objectLike({ Status: "301", Target: "https://ocelia.arts.ubc.ca" }),
      ]),
    });
  });

  it("evaluates the 301 redirect before the SPA rewrite (order matters)", () => {
    // Amplify applies rules top-down. The host redirect must come first so
    // default-domain traffic is bounced before the catch-all SPA rewrite runs.
    const rules = customRules(amplifyTemplate("dev"));
    const redirectIdx = rules.findIndex((r) => r.Status === "301");
    const spaIdx = rules.findIndex((r) => r.Status === "404-200");
    expect(redirectIdx).toBeGreaterThanOrEqual(0);
    expect(spaIdx).toBeGreaterThanOrEqual(0);
    expect(redirectIdx).toBeLessThan(spaIdx);
  });

  it("omits the redirect for an environment with no configured canonical origin", () => {
    // Ad-hoc envs (e.g. 'staging') have no canonical domain — we skip the
    // redirect rather than inventing a target, but keep the SPA rewrite.
    const rules = customRules(amplifyTemplate("staging"));
    expect(rules.some((r) => r.Status === "301")).toBe(false);
    expect(rules.some((r) => r.Status === "404-200")).toBe(true);
  });
});
