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

function amplifyTemplate(): Template {
  const app = new App({ context: { StackPrefix: "Test", environment: "dev" } });
  const stack = new AmplifyStack(app, "Test-AmplifyStack", fakeApiStack(), {
    env: { account: "123456789012", region: "ca-central-1" },
  });
  return Template.fromStack(stack);
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
