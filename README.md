# AI Learning Assistant

A RAG-powered educational chatbot that provides personalized, adaptive learning experiences. The system processes course materials (PDF, PPTX, DOCX, LaTeX, CSV, HTML) into a multimodal knowledge base and delivers that knowledge through AI-guided conversations that track engagement, evaluate understanding, and adapt difficulty.

Three user roles: **Admin** (platform management), **Instructor** (course materials, analytics), **Student** (AI chat, learning sessions).

| Index | Description |
|:------|:------------|
| [Architecture](#architecture) | System overview and component interactions |
| [Deployment](#deployment) | How to deploy the project |
| [User Guide](#user-guide) | Working solution walkthrough |
| [Security](#security) | Network architecture and security |
| [Troubleshooting](#troubleshooting) | Common issues and fixes |
| [Directories](#directories) | Project directory structure |
| [API Documentation](#api-documentation) | REST API reference |
| [Credits](#credits) | Team behind the solution |

---

## Architecture

The system uses a 4-layer Multimodal RAG pipeline (Ingestion → Enrichment → Retrieval → Reasoning) paired with a structured learning engine that controls teaching strategy, concept tracking, and progression.

![Architecture Diagram](docs/images/architecture.png)

For detailed documentation:
- [Architecture Overview](docs/architecture-overview.md) — full system design with all CDK stacks
- [Multimodal RAG Pipeline](docs/multimodal-rag-pipeline.md) — 4-layer processing pipeline
- [Chatbot V2 Flow](docs/chatbot-v2-flow.md) — structured learning engine
- [End-to-End Data Flow](docs/data-flow.md) — complete data journey from upload to answer
- [V1 vs V2 Comparison](docs/v1-vs-v2-data-comparison.md) — what changed and why

## Deployment

See the [Deployment Guide](docs/guides/deploymentGuide.md) for full instructions.

**Requirements:** git, AWS Account, AWS CLI, AWS CDK v2, npm, Node.js 20+, Docker

## User Guide

See the [User Guide](docs/guides/userGuide.md) for navigating the web app interface.

## Security

See the [Security Guide](docs/guides/securityGuide.md) for network architecture and security analysis.

## Troubleshooting

See the [Troubleshooting Guide](docs/guides/troubleshootingGuide.md) for common issues and debugging.

## Directories

```
├── cdk/
│   ├── bin/                # CDK app entrypoint
│   ├── lib/                # 7 CDK stack definitions
│   ├── lambda/             # 13 zip Lambda functions (Node.js 22 + Python 3.11)
│   ├── text_generation/    # Docker Lambda — LangChain text generation (V1 path)
│   ├── multimodal_rag_v2/  # Docker Lambda — 4-layer RAG pipeline (V2)
│   ├── chatbot_v2/         # Docker Lambda — structured learning engine (V2)
│   ├── math_compute/       # Docker Lambda — verified math computation (SymPy)
│   ├── sqsTrigger/         # Docker Lambda — async processing
│   ├── layers/             # Lambda layers (jwt-verify, psycopg2, powertools)
│   ├── graphql/            # AppSync schema
│   └── test/               # Jest CDK assertion tests
├── docs/                   # Project documentation
└── frontend/               # React 18 SPA (Vite + Tailwind + MUI v9)
    ├── src/
    │   ├── components/     # Shared components (AIMessage, chat, file viewers)
    │   ├── pages/          # Role-based pages (admin, instructor, student)
    │   ├── services/       # API client
    │   └── utils/          # Auth, formatters
    └── public/
```

## API Documentation

See the [OpenAPI definition](cdk/OpenAPI_Swagger_Definition.yaml) or the [API PDF](docs/api-documentation.pdf).

## Optional Modifications

See [Optional Modifications](docs/guides/optionalModifications.md) for configuration tweaks (email domain restrictions, course creation settings).

## Credits

This application was architected and developed by [Sean Woo](https://www.linkedin.com/in/seanwoo4/), [Aurora Cheng](https://www.linkedin.com/in/aurora-cheng04/), [Harshinee Sriram](https://www.linkedin.com/in/harshineesriram/), and [Aman Prakash](https://www.linkedin.com/in/aman-prakash-aa48b421b/), with project assistance by [Miranda Newell](https://www.linkedin.com/in/miranda-newell-7669b01b2/). Thanks to the UBC Cloud Innovation Centre Technical and Project Management teams for their guidance and support.

## License

This project is distributed under the [MIT License](LICENSE).

Licenses of libraries and tools used by the system:
- [PostgreSQL License](https://www.postgresql.org/about/licence/) — PostgreSQL and pgvector
- [LLaMa 3 Community License](https://llama.meta.com/llama3/license/) — Llama 3 70B Instruct model
