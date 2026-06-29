# AILA Architecture Overview

This document provides a comprehensive view of the AI Learning Assistant (AILA) system architecture, incorporating the Multimodal RAG V2 pipeline and the Chatbot V2 structured learning engine.

---

## System Summary

AILA is a RAG-powered educational chatbot that helps students learn course materials through AI-guided conversations. Three user roles interact with the system:

- **Admin** — manages users, courses, and platform configuration
- **Instructor** — uploads course materials, configures modules, monitors student progress
- **Student** — engages with the AI chatbot to learn module content

The system processes uploaded course materials (PDF, PPTX, DOCX, LaTeX, CSV, HTML) into a searchable knowledge base using multimodal understanding, then delivers that knowledge through an adaptive learning conversation that tracks engagement, concepts, and progression.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                         │
│                     React 18 SPA (Vite + Tailwind)                           │
│                                                                              │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│   │  Admin Panel │  │  Instructor  │  │  Student     │                     │
│   │  (users,     │  │  (courses,   │  │  (chat,      │                     │
│   │   courses)   │  │   files,     │  │   modules,   │                     │
│   │              │  │   modules)   │  │   progress)  │                     │
│   └──────────────┘  └──────────────┘  └──────┬───────┘                     │
│                                               │                              │
│                        AppSync WebSocket ──────┤ (streaming chunks)          │
└───────────────────────────────────────────────┼──────────────────────────────┘
                                                │
                        ┌───────────────────────▼───────────────────────┐
                        │              API GATEWAY (REST)                │
                        │         WAF-protected + Cognito Auth          │
                        └───────────────────────┬───────────────────────┘
                                                │
              ┌─────────────────────────────────┼─────────────────────────────┐
              │                                 │                               │
              ▼                                 ▼                               ▼
┌─────────────────────┐   ┌────────────────────────────┐   ┌──────────────────────┐
│  ApiGatewayStack    │   │   MultimodalRagStack       │   │   DatabaseStack      │
│                     │   │                            │   │                      │
│ • Student Lambda    │   │ • ragIngestionFunction     │   │ • RDS PostgreSQL     │
│ • Instructor Lambda │   │ • ragEnrichmentFunction    │   │   (pgvector)         │
│ • Admin Lambda      │   │ • ragRetrievalFunction     │   │ • 3 RDS Proxies      │
│ • Authorizers (x3)  │   │ • chatbotV2Function        │   │ • DynamoDB tables    │
│ • text_generation   │   │ • Session_State_Table      │   │ • Secrets Manager    │
│                     │   │ • IR Bucket (S3)           │   │                      │
│ • SQS + triggers    │   │ • EmbeddingCache (DDB)     │   │                      │
│ • Cognito           │   │ • EnrichmentCache (DDB)    │   │                      │
│ • AppSync           │   │ • Enrichment Queue (SQS)   │   │                      │
└─────────────────────┘   └────────────────────────────┘   └──────────────────────┘
```

---

## CDK Stack Breakdown

| Stack | Purpose | Key Resources |
|-------|---------|---------------|
| **VpcStack** | Network foundation | VPC, subnets, security groups |
| **DatabaseStack** | Data persistence | RDS PostgreSQL (pgvector), 3 RDS Proxies, DynamoDB Chat_History_Table, Secrets Manager |
| **ApiGatewayStack** | API layer + original Lambdas | REST API (WAF), AppSync, student/instructor/admin Lambdas, text_generation, SQS trigger, S3 upload bucket, Cognito |
| **MultimodalRagStack** | V2 RAG + Chatbot V2 | Ingestion/Enrichment/Retrieval Lambdas, chatbotV2Function, IR Bucket, DynamoDB caches, Session_State_Table, SQS enrichment queue |
| **ObservabilityStack** | Monitoring | 30+ CloudWatch Alarms, SNS topics, Dashboard, X-Ray sampling |
| **DBFlowStack** | Schema migration | Initializer Lambda (DDL) |
| **AmplifyStack** | Frontend hosting | Amplify Hosting (React SPA) |

---

## Two Chatbot Paths

The system maintains two chatbot implementations, accessible via separate API routes:

### V1: Text Generation (`POST /student/text_generation`)

The original chatbot path. Uses LangChain with a configurable LLM (Claude 3 Sonnet or Llama 3 70B). Retrieves context via pgvector similarity search directly from the Lambda. Supports instructor-configured system prompts and model selection per course.

**Best for:** Open-ended Q&A without structured learning goals.

### V2: Chatbot V2 (`POST /student/chatbot-v2`)

The new structured learning chatbot. Combines the V2 multimodal retrieval pipeline with an application-controlled learning engine. Tracks per-concept progress, adapts conversation difficulty via learning stages, and determines module completion through engagement metrics.

**Best for:** Guided learning sessions where students work through module concepts with adaptive scaffolding.

Both paths share:
- The same Cognito authentication
- The same AppSync WebSocket streaming to the frontend
- The same Bedrock Guardrails integration
- The same DynamoDB chat history table

---

## Key AWS Services

| Service | Role in AILA |
|---------|-------------|
| **Amazon Bedrock** | LLM inference (Claude 3 Sonnet, Claude 3 Haiku, Llama 3 70B), embeddings (Titan Embed v2), guardrails |
| **Amazon Cognito** | User authentication, role-based access (admin/instructor/student groups) |
| **Amazon RDS (PostgreSQL + pgvector)** | Relational data (courses, modules, files, users) + vector search for RAG |
| **Amazon DynamoDB** | Chat history, session state, embedding cache, enrichment cache |
| **Amazon S3** | File storage (uploads bucket + IR persistence bucket) |
| **AWS AppSync** | Real-time WebSocket streaming of LLM responses to frontend |
| **Amazon SQS** | Async decoupling (enrichment queue, chat export queue) |
| **AWS Lambda** | All compute (13 zip + 7 Docker container functions) |
| **API Gateway** | REST API with WAF protection |
| **AWS X-Ray** | Distributed tracing across all Lambda functions |
| **CloudWatch** | Alarms, dashboards, structured logging via Powertools |

---

## LLM Models Used

| Model | Usage | Context |
|-------|-------|---------|
| **Claude 3 Sonnet** (`anthropic.claude-3-sonnet-20240229-v1:0`) | Response generation | V1 text_generation, V2 chatbotV2Function (Response_Generator) |
| **Claude 3 Haiku** (`anthropic.claude-3-haiku-20240307-v1:0`) | Evaluation, query analysis, topic extraction, vision | V2 chatbotV2Function (Evaluation_Engine), ragRetrievalFunction (QueryAnalyzer), ragEnrichmentFunction (image descriptions, topic extraction) |
| **Llama 3 70B** (`meta.llama3-70b-instruct-v1:0`) | Alternative response generation | V1 text_generation (instructor-selectable) |
| **Titan Embed v2** (`amazon.titan-embed-text-v2:0`) | Text embeddings (1024 dimensions) | ragEnrichmentFunction, ragRetrievalFunction |

---

## Data Stores

### PostgreSQL (via RDS Proxy)

| Table | Purpose |
|-------|---------|
| `Users` | User accounts and roles (admin/instructor/student) |
| `Courses` | Course metadata, LLM model config, system prompts |
| `Course_Concepts` | Concepts linked to courses |
| `Course_Modules` | Modules with `generated_topics` (concept vocabulary for V2) |
| `Module_Files` | File metadata, processing status, content hashes |
| `Enrolments` | User enrollment records (links users to courses) |
| `retrieval_units` | Multimodal RAG V2 retrieval units with vector embeddings (pgvector) |

### DynamoDB

| Table | Purpose | Key |
|-------|---------|-----|
| `Chat_History_Table` | Conversation message history | `SessionId` (partition) |
| `Session_State_Table` | Chatbot V2 learning session state | `session_id` (partition) |
| `EmbeddingCache` | Cached embeddings to avoid recomputation | `content_hash` + `embedding_version` |
| `EnrichmentCache` | Cached enrichment results (image descriptions, etc.) | `content_hash` + `sort_key` |

---

## Security Architecture

- **Cognito** authenticates all API requests via JWT tokens
- **3 dedicated authorizer Lambdas** validate tokens per role (admin, instructor, student)
- **WAF** protects API Gateway from common web attacks
- **IAM least-privilege** — one dedicated role per Lambda function group, no action wildcards, resource-scoped ARNs
- **RDS Proxy** with SSL (`sslmode=require`) for all database connections
- **Bedrock Guardrails** filter inappropriate content in both directions
- **Pre-signup Lambda** validates email domains against an SSM allowlist
- **S3 pre-signed URLs** for secure time-limited file uploads (never through the server)

---

## Observability

- **Structured logging** via AWS Lambda Powertools (correlation keys: session_id, course_id)
- **Distributed tracing** via X-Ray (active on all Lambdas)
- **30+ CloudWatch Alarms** covering: Lambda errors, API Gateway 5xx, DynamoDB throttles, SQS DLQ messages, RDS CPU/connections
- **CloudWatch Dashboard** with key metrics at a glance
- **SNS notifications** for alarm state changes (separate topics for prod/dev)

---

## Related Documentation

- [Chatbot V2 Flow](./chatbot-v2-flow.md) — detailed walkthrough of the structured learning pipeline
- [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md) — the 4-layer ingestion, enrichment, retrieval, and reasoning system
- [Data Flow](./data-flow.md) — end-to-end journey from file upload to student answer
