# Documentation

## Structure

```
docs/
├── guides/              # User-facing reference documentation
├── architecture/        # System design and code-level documentation
├── completed-work/      # Implemented plans archived by YYYY-feature-name
├── images/              # Screenshots and diagrams referenced by guides
└── api-documentation.pdf
```

## System Documentation

| File | Purpose |
|------|---------|
| `architecture-overview.md` | Full system architecture (all 7 CDK stacks, V1 + V2 paths) |
| `multimodal-rag-pipeline.md` | 4-layer RAG pipeline (Ingestion → Enrichment → Retrieval → Reasoning) |
| `multimodal-rag-v2-explained.md` | Non-technical explanation of the V2 system |
| `chatbot-v2-flow.md` | Structured learning engine (state machine, modes, evaluation) |
| `data-flow.md` | End-to-end data journey from file upload to student answer |
| `v1-vs-v2-data-comparison.md` | V1 vs V2 data formats and migration rationale |

## Guides

| File | Purpose |
|------|---------|
| `guides/deploymentGuide.md` | Full deployment walkthrough |
| `guides/userGuide.md` | End-user guide (Admin, Instructor, Student) |
| `guides/securityGuide.md` | Security posture and configuration |
| `guides/troubleshootingGuide.md` | Common issues and fixes |
| `guides/debugging-guide.md` | Developer debugging workflows |
| `guides/data_export.md` | Database export procedures |
| `guides/full-data-wipe.md` | Complete data reset runbook |
| `guides/ExistingVPCDeployment.md` | Deploying into a pre-existing VPC |
| `guides/optionalModifications.md` | Optional configuration tweaks |

## Architecture

| File | Purpose |
|------|---------|
| `architecture/architectureDeepDive.md` | Database schema, Lambda interactions, V1 architecture reference |
| `architecture/learning_prompt_template.md` | Prompt design principles for the learning engine |

## Completed Work

Archive of planning documents for features that have been implemented.

| Folder | Feature |
|--------|---------|
| `2025-chatbot-performance` | Streaming, query optimization, architecture improvements |
| `2025-cost-optimization` | VPC endpoints, Lambda right-sizing, log retention |
| `2025-dependency-upgrades` | MUI v9, TypeScript 6, langchain-aws 1.4, Node 22 |
| `2025-frontend-improvements` | Code splitting, API client, toast consolidation, image display |
| `2025-infrastructure-hardening` | IAM scoping, removal policies, security hardening |
| `2025-math-compute` | Verified math computation with SymPy |
| `2025-observability` | CloudWatch alarms, X-Ray, structured logging, dashboard |
| `2025-v1-architecture` | Archived V1 text_generation module docs |
