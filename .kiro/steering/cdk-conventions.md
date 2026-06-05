---
inclusion: always
---

# CDK Conventions

## Versions
- TypeScript `~6.0.3`, `aws-cdk-lib ^2.249.0`, `constructs ^10.4.2`
- Runtimes: `lambda.Runtime.NODEJS_22_X` (zip) · `lambda.Runtime.PYTHON_3_11` (Python)

## Stack Naming
Always `${StackPrefix}-${StackName}` — never hardcode the prefix.

## Constructor Signature
Dependent stacks are positional args before `props` — not inside props:
```typescript
constructor(scope: Construct, id: string, db: DatabaseStack, vpc: VpcStack, props?: cdk.StackProps & { environment?: string })
```

## Environment Config
Extract at the top of every constructor with a `'dev'` fallback — missing fallback causes silent differences between `cdk synth` and a real deploy:
```typescript
const environment = props?.environment || 'dev';
const isProd = environment === 'prod';
const logRetention = isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH;
```
Also drives: alarm thresholds, X-Ray sampling (`0.05` prod / `1.0` dev), SNS routing, SES account ID.

## Construct & Resource Naming
All logical IDs and physical names use `${id}-resourceName`:
```typescript
new iam.Role(this, `${id}-dbLambdaRole`, { roleName: `${id}-dbLambdaRole` });
```
Never hardcode `'AILA-...'` — `id` varies per deployment.

### Lambda `functionName` Must Match Construct ID Suffix
IAM log group ARNs are scoped to the exact function name. A mismatch silently breaks log delivery:
```typescript
new lambda.Function(this, `${id}-studentFunction`, { functionName: `${id}-studentFunction` });
// IAM scope: arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${id}-studentFunction:*
```

## Lambda Required Properties
Every Lambda must have:
- `runtime` — `NODEJS_22_X` or `PYTHON_3_11`
- `tracing: lambda.Tracing.ACTIVE`
- `logRetention` — environment-derived value
- `functionName: \`${id}-<name>\`` — matching construct ID suffix
- Scoped per-function-group IAM role (see IAM Security Policy)

## `overrideLogicalId()` — Do Not Remove
Pins the CloudFormation logical ID. Removing one causes CloudFormation to delete and recreate the resource — downtime and data loss:
```typescript
(lambdaFn.node.defaultChild as lambda.CfnFunction).overrideLogicalId("studentFunction");
```
Only add new ones when deliberately renaming an already-deployed resource.

## Removal Policies
| Resource | Policy | Reason |
|---|---|---|
| S3 buckets | `RETAIN` | Contains user data |
| RDS instance | `SNAPSHOT` | Data must be preserved |
| Cognito, SQS, Secrets Manager | `DESTROY` | Recreatable |

Always explicitly set and document `removalPolicy` on new stateful resources.

## Imports
Always use `aws-cdk-lib` sub-paths — never deprecated `@aws-cdk/` packages:
```typescript
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
```

## Cross-Stack References
Export as `public readonly` properties, pass as constructor args. Never use SSM for cross-stack refs:
```typescript
// DatabaseStack: public readonly secretPathUser: secretsmanager.Secret;
// ApiGatewayStack consumes: db.secretPathUser.secretArn
```

## Stack Dependency Order
```
VpcStack -> DatabaseStack -> ApiGatewayStack -+-> ObservabilityStack
                                              +-> DBFlowStack -> AmplifyStack
```
Call `stackB.addDependency(stackA)` when B consumes A's outputs.

## Testing
- Jest 29 + ts-jest in `cdk/test/` · `Template.fromStack()` assertions (not snapshots) · Docker required · No AWS credentials needed
- **`createTestStacks()`** — for VpcStack, DatabaseStack, ApiGatewayStack, DBFlowStack tests
- **`createObservabilityTemplate()`** — for ObservabilityStack (separate CDK app to avoid cross-stack ref issues; do not merge into `createTestStacks()`)

## Deploy & Synth
```bash
npx tsc --noEmit       # fast type-check during development (no Docker)
npx cdk synth          # full synthesis before PRs (requires Docker)
npm run deploy         # always use npm scripts — runs test gate first
npm run deploy:prod    # prod deploy with -c environment=prod
```
