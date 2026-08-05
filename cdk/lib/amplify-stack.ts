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

export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

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

    amplifyApp.addCustomRule({
      source: "</^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
      target: "/",
      status: RedirectStatus.NOT_FOUND_REWRITE,
    });

    amplifyApp.addBranch("main");
  }
}