---
inclusion: always
---

# AI Learning Assistant — Project Overview

RAG chatbot for personalized education. Three user roles: Admin, Instructor, Student. Uses LangChain + LLMs (Claude, Llama) grounded in course materials.

## Repository Structure
```
AI-Learning-Assistant/
├── frontend/              # React 18 SPA (Vite + Tailwind + MUI v9)
├── cdk/
│   ├── bin/cdk.ts         # CDK app entrypoint
│   ├── lib/               # 6 CDK stack definitions
│   ├── lambda/            # 13 zip Lambda functions (Node.js 22 + Python 3.11)
│   ├── text_generation/   # Docker container Lambda (Python, LangChain)
│   ├── data_ingestion/    # Docker container Lambda (Python, LangChain)
│   ├── sqsTrigger/        # Docker container Lambda (Python)
│   ├── layers/            # Lambda layers (jwt-verify, psycopg2, postgres)
│   ├── graphql/           # AppSync schema
│   └── test/              # Jest CDK assertion tests
├── docs/
└── .kiro/specs/
```

## CDK Stack Deployment Order
1. **VpcStack** — VPC, subnets, security groups
2. **DatabaseStack** — RDS PostgreSQL (pgvector), 3 RDS proxies, DynamoDB, Secrets Manager
3. **ApiGatewayStack** — REST API (WAF), AppSync, all Lambdas, SQS, S3, Cognito
4. **ObservabilityStack** — CloudWatch Alarms (30+), SNS topics, Dashboard, X-Ray sampling
5. **DBFlowStack** — initializer Lambda (schema migration)
6. **AmplifyStack** — Amplify Hosting (frontend)

Stack naming: `${StackPrefix}-${StackName}` | Context vars: `StackPrefix`, `environment` (`dev`|`prod`)

## Development Commands
```bash
# CDK — run from cdk/
npm test               # Jest assertion tests (requires Docker)
npm run deploy         # runs npm test then cdk deploy --all
npm run deploy:prod    # same with -c environment=prod
npx tsc --noEmit       # type-check only (no Docker)
npx cdk synth          # full synthesis (requires Docker)

# Frontend — run from frontend/
npm run dev            # Vite dev server
npm run build          # production build
npm run lint           # ESLint
```

## Hard Constraints
- **Docker required** for CDK tests/synth (`textGenLambdaDockerFunc`, `dataIngestLambdaDockerFunc`)
- **No frontend test framework** — ESLint is the only frontend quality gate
- **Pre-deploy gate** — `predeploy` npm hook runs `npm test` before every deploy; never bypass

## Active Specs
- `infrastructure-hardening` — ✅ Complete
- `observability-reliability` — 🔄 In progress (CDK assertion tests 9.2–9.5 pending)
