# Future Work — Split the API Gateway Stack

> **Deferred from Phase 3**: This was originally section 3.4 of the infrastructure hardening plan. It was moved here because it's the highest-effort, highest-risk item and doesn't fix any security or correctness issues — it's purely a maintainability improvement. Tackle this after Phase 3 sections 3.1–3.3 and 3.5 are complete and stable.

## Summary

`api-gateway-stack.ts` is a 1781-line monolith that creates Cognito, Lambda functions, S3 buckets, SQS queues, AppSync, SES, WAF, IAM roles, and SSM parameters all in one CloudFormation stack. After mapping every cross-resource dependency, the original recommendation to split into 5 stacks is **not practical** due to a fundamental architectural constraint: the OpenAPI spec (`OpenAPI_Swagger_Definition.yaml`) uses `Fn::Sub` with CloudFormation logical IDs to reference Lambda functions and authorizers, which forces all referenced Lambda functions to live in the same stack as the API Gateway.

## Findings

### The OpenAPI Logical ID Constraint — CRITICAL BLOCKER

The API Gateway is created using `SpecRestApi` with an OpenAPI definition loaded via `Fn::Transform("AWS::Include")`. The OpenAPI spec references Lambda functions by their CloudFormation logical IDs:

```yaml
# In OpenAPI_Swagger_Definition.yaml
x-amazon-apigateway-integration:
  uri:
    Fn::Sub: "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${studentFunction.Arn}/invocations"
```

These `Fn::Sub` references (`${studentFunction.Arn}`, `${instructorFunction.Arn}`, etc.) resolve to CloudFormation logical IDs **within the same stack**. They cannot reference resources in other stacks. The CDK code explicitly overrides logical IDs to match:

```typescript
cfnLambda_student.overrideLogicalId("studentFunction");
```

**Lambda functions referenced by the OpenAPI spec** (must stay in the same stack as the API Gateway):

| Logical ID | CDK Variable | Purpose |
|---|---|---|
| `studentFunction` | `lambdaStudentFunction` | Student API endpoints |
| `instructorFunction` | `lambdaInstructorFunction` | Instructor API endpoints |
| `adminFunction` | `lambdaAdminFunction` | Admin API endpoints |
| `TextGenLambdaDockerFunc` | `textGenLambdaDockerFunc` | Text generation (RAG) |
| `DeleteLastMessage` | `deleteLastMessage` | Delete last chat message |
| `NotificationFunction` | `notificationFunction` | Event notifications |
| `sqsFunction` | `sqsFunction` | SQS job submission |
| `GeneratePreSignedURLFunc` | `generatePreSignedURL` | Presigned URL generation |
| `GetFilesFunction` | `getFilesFunction` | List files |
| `GetChatLogsFunction` | `getChatLogsFunction` | Get chat logs |
| `DeleteFileFunc` | `deleteFile` | Delete file |
| `DeleteModuleFunc` | `deleteModuleFunction` | Delete module |
| `adminLambdaAuthorizer` | `authorizationFunction` | Admin authorizer |
| `studentLambdaAuthorizer` | `authorizationFunction_student` | Student authorizer |
| `instructorLambdaAuthorizer` | `authorizationFunction_instructor` | Instructor authorizer |

That's **15 Lambda functions** that must remain in the same stack as the API Gateway. This eliminates the proposed `lambda-stack.ts` split entirely.

### What CAN Be Extracted

Despite the OpenAPI constraint, some resources are not referenced by the OpenAPI spec and can be moved:

**Resources that can move to separate stacks:**

| Resource | Current location | Can move? | Depends on |
|---|---|---|---|
| Cognito User Pool + Identity Pool | api-gateway-stack | Yes — `auth-stack.ts` | Nothing in this stack |
| Cognito groups + roles | api-gateway-stack | Yes — `auth-stack.ts` | User Pool, Identity Pool, API Gateway (for execute-api ARNs) |
| Cognito secrets | api-gateway-stack | Yes — `auth-stack.ts` | User Pool, App Client, Identity Pool |
| SES domain identity | api-gateway-stack | Yes — `messaging-stack.ts` | Nothing |
| SQS queue | api-gateway-stack | Partially | Lambda functions send to it; `sqsTrigger` consumes from it |
| AppSync API | api-gateway-stack | Partially | `notificationFunction` and `textGenLambdaDockerFunc` reference it |
| S3 buckets (×3) | api-gateway-stack | Partially | Multiple Lambda functions reference them |
| SSM parameters | api-gateway-stack | Yes — `config-stack.ts` | Nothing |
| WAF | api-gateway-stack | Yes — `api-stack.ts` | API Gateway stage ARN |
| Lambda layers | api-gateway-stack | Yes — `layers-stack.ts` | Nothing |
| `DataIngestLambdaDockerFunc` | api-gateway-stack | Yes | Not in OpenAPI spec (triggered by S3 event) |
| `SQSTriggerDockerFunc` | api-gateway-stack | Yes | Not in OpenAPI spec (triggered by SQS event) |

**Resources that CANNOT move** (referenced by OpenAPI `Fn::Sub`):
- All 15 Lambda functions listed above
- The API Gateway itself

### Revised Stack Split Recommendation

Given the OpenAPI constraint, here's a realistic 3-stack split:

**`auth-stack.ts`** — Cognito + Identity (can be extracted, but with caveats)
- Cognito User Pool, App Client, Identity Pool
- Cognito groups (student, instructor, admin, techadmin)
- Identity Pool roles (student, instructor, admin, techadmin, unauthenticated)
- Cognito secrets (Secret Manager)
- SES domain identity (referenced by Cognito email configuration)
- **Exports**: `userPool`, `appClient`, `identityPool`, `secret`, `userPoolId`, `userPoolClientId`
- **Depends on**: Nothing (if identity pool role policies are moved to api-stack)
- **Circular dependency risk**: The identity pool roles reference `api.restApiId` for execute-api permissions. This creates a circular dependency (auth-stack needs api-stack, api-stack needs auth-stack for user pool). **Resolution**: Move the identity pool role policies to the api-stack, or use `CfnOutput`/`Fn::ImportValue` with the API ID.
- **Cognito trigger Lambdas — CANNOT move here**: `addStudentOnSignUp` and `adjustUserRoles` depend on `vpcStack.vpc`, `db.secretPathTableCreator`, `db.rdsProxyEndpointTableCreator`, the `postgres` layer, and `coglambdaRole`. Moving them here would make auth-stack depend on vpc-stack, database-stack, and layers from api-stack — defeating the purpose of the split. These Lambdas must stay in api-stack and be attached to the User Pool via a cross-stack reference (`userPool.addTrigger()` called from api-stack after importing the User Pool). `preSignupLambda` could move (it only needs SSM), but splitting the three Cognito triggers across two stacks adds complexity for little benefit — keep all three in api-stack.
- **AmplifyStack impact**: Currently consumes `getUserPoolId()`, `getUserPoolClientId()`, `getIdentityPoolId()` from ApiGatewayStack. After the split, AmplifyStack would need to consume these from auth-stack instead. The `cdk/bin/cdk.ts` wiring must be updated to pass both auth-stack and api-stack to AmplifyStack.

**`storage-stack.ts`** — S3 Buckets + SSM Parameters (can be extracted, moderate cross-stack wiring)
- `dataIngestionBucket`, `embeddingStorageBucket`, `chatlogsBucket`
- SSM parameters (`BedrockLLMId`, `EmbeddingModelId`, `TableName`)
- **Exports**: bucket references (ARN, name), parameter ARNs and names
- **Depends on**: Nothing
- **No circular dependency risk**
- **Cross-stack wiring required**: All three buckets are heavily referenced by Lambda functions in api-stack — via `grantRead()`, `grantReadWrite()`, `grantDelete()`, `bucketName` in environment variables, and `bucketArn` in IAM policies. These CDK grant methods work across stacks (CDK generates the necessary `Fn::ImportValue` references), but the number of cross-stack references is high (~20+). CloudFormation has a limit of 200 outputs per stack, which won't be an issue here, but each cross-stack reference creates a deployment coupling — you can't delete or rename an exported value while another stack imports it.

**`api-stack.ts`** — API Gateway + All API Lambda Functions (the remaining monolith)
- API Gateway (`SpecRestApi`) + OpenAPI spec
- All 15 Lambda functions referenced by the OpenAPI spec
- Lambda layers (jwt, postgres, psycopg2, powertools)
- IAM roles for Lambda functions
- Cognito trigger Lambda functions (`preSignupLambda`, `addStudentOnSignUp`, `adjustUserRoles`) — must stay here due to VPC/DB/layer dependencies, attached to User Pool via cross-stack reference
- SQS queue (referenced by `sqsFunction`)
- AppSync API (referenced by `notificationFunction` and `textGenLambdaDockerFunc`)
- WAF
- `DataIngestLambdaDockerFunc` (triggered by S3 event from `dataIngestionBucket`)
- `SQSTriggerDockerFunc` (triggered by SQS event from `messagesQueue`)
- Identity pool role policies (moved here from auth-stack to break circular dependency)
- **Depends on**: `auth-stack` (user pool ID for authorizers and triggers), `storage-stack` (bucket refs, parameter ARNs), `database-stack` (proxy endpoints, secret names), `vpc-stack`
- **DBFlowStack impact**: Currently consumes `apiStack.getLayers()['psycopg2']`. If layers stay in api-stack, no change needed. If layers move to a separate stack, DBFlowStack wiring must be updated.

### Alternative: Eliminate the OpenAPI Logical ID Constraint

To achieve the original 5-stack split, you'd need to change how the API Gateway references Lambda functions. Options:

**Option A: Replace `Fn::Sub` with hardcoded Lambda ARNs using `Fn::ImportValue`**
- Each Lambda stack exports its function ARNs
- The OpenAPI spec uses `Fn::ImportValue` instead of `Fn::Sub` with logical IDs
- **Problem**: `Fn::ImportValue` inside `Fn::Sub` inside a YAML template loaded via `AWS::Include` is fragile and may not resolve correctly. AWS documentation is unclear on this nesting.

**Option B: Switch from `SpecRestApi` to programmatic API Gateway definition**
- Define routes, methods, and integrations in CDK code instead of the OpenAPI spec
- Use `RestApi` with `addResource`/`addMethod` and pass Lambda function ARNs as cross-stack references
- **Problem**: This is a complete rewrite of the API Gateway definition. The 4450-line OpenAPI spec would need to be translated to CDK code. High effort, high risk.

**Option C: Use `CfnParameter` to pass Lambda ARNs into the API stack**
- Create Lambda functions in separate stacks, export their ARNs
- Pass ARNs as `CfnParameter` values to the API stack
- Modify the OpenAPI spec to use `Fn::Sub` with parameter references instead of logical IDs
- **Problem**: Moderate effort, but more reliable than Option A. Requires changing every `${logicalId.Arn}` reference in the OpenAPI spec to `${ParameterName}`.

**Recommendation**: Option C is the most practical path to a full split, but it's a significant refactor. The 3-stack split (auth + storage + api) described above provides most of the maintainability benefits with much less risk.

### Impact Assessment of the 3-Stack Split

**Benefits**:
- Auth changes (new Cognito groups, password policies) deploy independently
- Storage changes (lifecycle policies, bucket configs) deploy independently
- SSM parameter changes deploy independently
- The api-stack is still large (~1400 lines) but reduced from 1781

**Risks**:
- Cross-stack references create deployment ordering dependencies — you cannot update an exported value while another stack imports it, which can block deployments
- The circular dependency between auth-stack and api-stack (identity pool roles need API Gateway ID) must be resolved by moving role policies to api-stack
- Cognito trigger Lambdas must stay in api-stack (not auth-stack) due to VPC/DB/layer dependencies — the User Pool must be imported into api-stack to attach triggers, which adds complexity
- AmplifyStack must be updated to consume from both auth-stack and api-stack instead of just api-stack
- DBFlowStack consumes `apiStack.getLayers()['psycopg2']` — this reference must be preserved or rerouted
- Existing CloudFormation resources will need `retain` policies during migration to avoid deletion
- The high number of cross-stack references from S3 buckets (~20+) creates tight deployment coupling between storage-stack and api-stack

**Migration approach**:
1. Create new stacks with the extracted resources
2. Use `CfnOutput`/`Fn::ImportValue` for cross-stack references
3. Remove the resources from `api-gateway-stack.ts`
4. Deploy in order: storage-stack → auth-stack → api-stack
5. **Critical**: Resources with `RemovalPolicy.RETAIN` (S3 buckets, Cognito) must be imported into the new stacks using `aws cloudformation import` or CDK's resource importing, not recreated
6. Update `cdk/bin/cdk.ts` to pass auth-stack to both api-stack and AmplifyStack
7. Attach Cognito triggers in api-stack after importing the User Pool from auth-stack

### Recommended Implementation Order

| Phase | Action | Risk | Effort |
|---|---|---|---|
| **1. Extract storage-stack** | Move S3 buckets + SSM parameters | Low | Medium |
| **2. Extract auth-stack** | Move Cognito + identity pool + triggers | Medium (circular dep) | Medium |
| **3. Resolve circular dependency** | Move identity pool role policies to api-stack | Low | Low |
| **4. (Optional) Full split via Option C** | Parameterize Lambda ARNs in OpenAPI spec | Medium | High |
