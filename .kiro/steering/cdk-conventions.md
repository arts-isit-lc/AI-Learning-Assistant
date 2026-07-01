---
inclusion: fileMatch
fileMatchPattern: "cdk/**/*.ts"
---

# CDK Conventions

## Versions
TypeScript `~6.0.3` · `aws-cdk-lib ^2.249.0` · `constructs ^10.4.2`
Runtimes: `NODEJS_22_X` (zip) · `PYTHON_3_11` (Docker)

## Naming
- Stack: `${StackPrefix}-${StackName}` — never hardcode
- Resources: `${id}-resourceName` for both logical ID and physical name
- Lambda `functionName` must match construct ID suffix (IAM log groups scoped to it)

## Constructor Signature
Dependent stacks as positional args before `props`:
```typescript
constructor(scope: Construct, id: string, db: DatabaseStack, vpc: VpcStack, props?: cdk.StackProps & { environment?: string })
```

## Environment Config
```typescript
const environment = props?.environment || 'dev';
const isProd = environment === 'prod';
const logRetention = isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH;
```

## Lambda Required Properties
`runtime` · `tracing: Tracing.ACTIVE` · `logRetention` (env-derived) · `functionName: \`${id}-<name>\`` · scoped IAM role

## overrideLogicalId() — Never Remove
Pins CloudFormation logical ID. Removing = delete + recreate = downtime.

## Removal Policies
S3=`RETAIN` · RDS=`SNAPSHOT` · Cognito/SQS/Secrets=`DESTROY`

## Imports
Always `aws-cdk-lib/aws-*` — never deprecated `@aws-cdk/` packages.

## Cross-Stack References
`public readonly` properties + constructor args. Never SSM.

## Stack Dependency Order
See `project-overview.md` (always loaded) for the canonical stack dependency graph — not duplicated here.

## Testing
Jest 29 + ts-jest · `Template.fromStack()` assertions · Docker required · `createTestStacks()` for most stacks · `createObservabilityTemplate()` for ObservabilityStack (separate app)

## Adding a Bedrock Model
1. Bedrock console → Model catalog → confirm access (Anthropic FTU once per account)
2. Add model ARN to role's Bedrock policy resources in `api-gateway-stack.ts`
3. Add Marketplace permissions if third-party model (Anthropic, Cohere, AI21): `aws-marketplace:Subscribe/Unsubscribe/ViewSubscriptions` resources `'*'`
4. Add to Python constants (`text_generation/src/constants/llm_models.py`) + frontend (`frontend/src/constants/llmModels.js`)
5. Add model ARN assertion to `iam-policies.test.ts`

Amazon/Meta models skip step 3 (not Marketplace-sold).
