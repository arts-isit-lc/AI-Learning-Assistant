import {
  App,
  BasicAuth,
  GitHubSourceCodeProvider,
  RedirectStatus, // Import RedirectStatus
} from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Construct } from "constructs";
import * as yaml from "yaml";
import { ApiGatewayStack } from "./api-gateway-stack";
import {
  resolveAmplifyDefaultOrigin,
  resolveCanonicalOrigin,
} from "./constants/domains";

export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props?: cdk.StackProps & { environment?: string }
  ) {
    super(scope, id, props);

    const environment = props?.environment || "dev";

    // Define the GitHub repository name as a parameter
    const githubRepoName = new cdk.CfnParameter(this, "githubRepoName", {
      type: "String",
      description: "The name of the GitHub repository",
    }).valueAsString;

    const amplifyYaml = yaml.parse(` 
      version: 1
      applications:
        - appRoot: frontend
          frontend:
            phases:
              preBuild:
                commands:
                  - pwd
                  # Vite 8 + React Router 8 require Node >= 22.22. Pin the build
                  # image to Node 22 (the Amplify image ships nvm) so the cloud
                  # build matches local and npm engine checks pass.
                  - nvm install 22
                  - nvm use 22
                  - node --version
                  - npm ci
              build:
                commands:
                  - npm run build
            artifacts:
              baseDirectory: dist
              files:
                - '**/*'
            cache:
              paths:
                - 'node_modules/**/*'
    `);

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "aila-owner-name"
    );

    const amplifyApp = new App(this, `${id}-amplifyApp`, {
      appName: `${id}-amplify`,
      sourceCodeProvider: new GitHubSourceCodeProvider({
        owner: username,
        repository: githubRepoName,
        oauthToken: cdk.SecretValue.secretsManager(
          "github-personal-access-token",
          {
            jsonField: "my-github-token",
          }
        ),
      }),
      environmentVariables: {
        VITE_AWS_REGION: this.region,
        VITE_COGNITO_USER_POOL_ID: apiStack.getUserPoolId(),
        VITE_COGNITO_USER_POOL_CLIENT_ID: apiStack.getUserPoolClientId(),
        VITE_API_ENDPOINT: apiStack.getEndpointUrl(),
        VITE_IDENTITY_POOL_ID: apiStack.getIdentityPoolId(),
        VITE_GRAPHQL_WS_URL: apiStack.getEventApiUrl(),
      },
      buildSpec: BuildSpec.fromObjectToYaml(amplifyYaml),
      // Cache-Control so a redeploy never strands an open tab on stale,
      // content-hashed chunks: the entry point is revalidated every load while
      // the immutable (hashed) assets cache for a year. This pairs with the
      // SPA's RouteError auto-reload — the fresh index.html it fetches must not
      // itself be served from cache, or the reload wouldn't pick up the new
      // chunk hashes. (Amplify default hosting caching is left otherwise.)
      customResponseHeaders: [
        {
          pattern: "/index.html",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        },
        {
          pattern: "/assets/*",
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        },
      ],
    });

    // Canonical URL per environment: 301-redirect the auto-generated Amplify
    // default domain (`https://main.<appId>.amplifyapp.com`) to the custom
    // domain so each environment is reachable at exactly one origin. This
    // shrinks the auth/CORS surface (a single origin to allow-list) and avoids
    // split cookie jars across two live hostnames.
    //
    // Amplify constraints that shape this rule:
    //   - Domain-source redirects must NOT include a path; Amplify appends the
    //     request path and forwards query strings automatically, so `/login`
    //     is preserved without an explicit wildcard.
    //   - Rules are evaluated top-down, so this must precede the SPA rewrite
    //     below. The source matches only the default host, so custom-domain
    //     traffic falls through to the SPA rule — no redirect loop.
    //   - The source is a literal (see AMPLIFY_DEFAULT_ORIGIN): referencing
    //     `amplifyApp.defaultDomain` here would be a self-reference on this same
    //     App resource and fail synth with a circular dependency.
    // Skipped when the environment has no configured origins (e.g. an ad-hoc
    // `staging` deploy) rather than inventing a target.
    const canonicalOrigin = resolveCanonicalOrigin(environment);
    const amplifyDefaultOrigin = resolveAmplifyDefaultOrigin(environment);
    if (canonicalOrigin && amplifyDefaultOrigin) {
      amplifyApp.addCustomRule({
        source: amplifyDefaultOrigin,
        target: canonicalOrigin,
        status: RedirectStatus.PERMANENT_REDIRECT,
      });
    }

    amplifyApp.addCustomRule({
      source: "</^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
      target: "/",
      status: RedirectStatus.NOT_FOUND_REWRITE,
    });

    amplifyApp.addBranch("main");
  }
}