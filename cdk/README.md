# CDK Infrastructure

AWS CDK (TypeScript) infrastructure for the AI Learning Assistant. Deploys 7 stacks.

## Stacks

| Stack | Purpose |
|-------|---------|
| VpcStack | VPC, subnets, security groups |
| DatabaseStack | RDS PostgreSQL (pgvector), 3 RDS Proxies, DynamoDB, Secrets Manager |
| MultimodalRagStack | RAG pipeline (ingestion/enrichment/retrieval), chatbot V2, math compute |
| ApiGatewayStack | REST API (WAF), AppSync, zip Lambdas, text_generation, SQS, S3, Cognito |
| ObservabilityStack | 30+ CloudWatch Alarms, SNS, Dashboard, X-Ray sampling |
| DBFlowStack | Schema initializer Lambda |
| AmplifyStack | Frontend hosting |

## Commands

```bash
npx tsc --noEmit       # Type-check (no Docker needed)
npm test               # Jest assertion tests (requires Docker)
npm run deploy         # Test + cdk deploy --all (dev)
npm run deploy:prod    # Test + cdk deploy --all -c environment=prod
npx cdk synth          # Full synthesis (requires Docker)
```

## Requirements

- Node.js 20+, npm
- Docker (running) — required for container Lambda image builds
- AWS CLI configured with appropriate credentials
- No AWS credentials needed for `npm test` (Jest uses mock templates)

## Container Lambdas (Docker)

| Directory | Lambda Functions | Runtime |
|-----------|-----------------|---------|
| `text_generation/` | TextGenLambdaDockerFunc | Python 3.11 |
| `multimodal_rag_v2/` | ragIngestion, ragEnrichment, ragRetrieval | Python 3.11 |
| `chatbot_v2/` | chatbotV2Function | Python 3.11 |
| `math_compute/` | mathComputeFunction | Python 3.11 |
| `sqsTrigger/` | SQSTriggerDockerFunc | Python 3.11 |

## Zip Lambdas

Located in `lambda/`. Runtime: Node.js 22. Includes student, instructor, admin functions, authorizers, Cognito triggers, file operations, and notifications.

## Testing

Jest 29 + ts-jest. All tests use `Template.fromStack()` assertions against synthesized CloudFormation.

```bash
npm test                    # Full suite
npx jest --testPathPattern="iam"  # Run specific test file
```

Test helpers: `test/helpers/stack-setup.ts` provides `createTestStacks()` and `createObservabilityTemplate()`.
