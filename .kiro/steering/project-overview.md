---
inclusion: always
---

# Project Overview

RAG chatbot for personalized education. Roles: Admin, Instructor, Student. LangChain + LLMs (Claude, Llama) grounded in course materials.

## Repo Structure
```
frontend/              # React 18 SPA (Vite + Tailwind + shadcn/ui — OCELIA; MUI fully removed in the Phase 8 purge)
cdk/
├── bin/cdk.ts         # CDK app entrypoint
├── lib/               # 7 CDK stacks
├── lambda/            # zip Lambda handler sources (Node.js 22 + Python 3.11)
├── text_generation/   # Docker Lambda (Python, LangChain)
├── multimodal_rag_v2/ # Docker Lambda (Python, RAG pipeline)
├── chatbot_v2/        # Docker Lambda (Python, structured learning)
├── math_compute/      # Docker Lambda (Python, SymPy)
├── sqsTrigger/        # Docker Lambda (Python)
├── layers/            # Lambda layers (jwt-verify, psycopg2, postgres)
├── graphql/           # AppSync schema
└── test/              # Jest CDK assertion tests
```

## Stack Dependency Order
```
VpcStack -> DatabaseStack -> MultimodalRagStack -> ApiGatewayStack -+-> ObservabilityStack
                                                                    +-> DBFlowStack -> AmplifyStack
```
Naming: `${StackPrefix}-${StackName}` | Context: `StackPrefix`, `environment` (`dev`|`prod`)

## Commands
```bash
# CDK (from cdk/)
npm test             # Jest (requires Docker)
npm run deploy       # test + cdk deploy --all
npx tsc --noEmit     # type-check only (no Docker)

# Frontend (from frontend/)
npm run dev          # Vite dev server
npm run build        # production build
npm run lint         # ESLint
npm run test         # Vitest unit/component (added in OCELIA rebuild Phase 1)
npm run test:e2e     # Playwright E2E smoke (added in OCELIA rebuild Phase 1)
```

## Hard Constraints
- Docker required for CDK tests/synth (5 container images -> 7 Lambda functions)
- Frontend is no longer ESLint-only: Vitest + RTL + Playwright per `testing-policy` (harness lands in OCELIA rebuild Phase 1)
- `predeploy` hook runs `npm test` before every deploy; never bypass

## Engineering Log
Operational memory (decisions, deploy gotchas, workarounds, env/Bedrock/DB notes): `engineering-log.md` (manual — load it before deploys, incident triage, or architecture/Bedrock/schema changes). Knowledge ownership: steering = rules · engineering-log = decisions/scars · specs = current work. Don't duplicate across them.
