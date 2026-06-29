# End-to-End Data Flow

This document traces the complete journey of data through AILA — from an instructor uploading a file, through multimodal processing and storage, to a student receiving an AI-generated answer in real-time. It connects all the pieces across the system.

---

## Overview

```
INSTRUCTOR                    SYSTEM                           STUDENT
    │                            │                                │
    │  1. Upload file            │                                │
    │──────────────────────────▶│                                │
    │                            │  2. Parse (Ingestion)          │
    │                            │  3. Enrich (Vision + Embed)    │
    │                            │  4. Store (pgvector + caches)  │
    │                            │                                │
    │                            │◀──────────────────────────────│
    │                            │  5. Ask question               │
    │                            │  6. Evaluate previous answer   │
    │                            │  7. Retrieve context           │
    │                            │  8. Generate + stream answer   │
    │                            │──────────────────────────────▶│
    │                            │  9. Answer appears in chat     │
```

---

## Phase 1: File Upload

### Actors: Instructor → Frontend → API Gateway → S3

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Instructor  │     │   Frontend   │     │ API Gateway  │     │   S3 Bucket  │
│  Browser     │     │   React App  │     │ + Lambda     │     │              │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                     │                     │                     │
       │  Select file        │                     │                     │
       │────────────────────▶│                     │                     │
       │                     │  Request upload URL │                     │
       │                     │────────────────────▶│                     │
       │                     │                     │  Generate pre-signed│
       │                     │                     │  PUT URL            │
       │                     │  Return signed URL  │                     │
       │                     │◀────────────────────│                     │
       │                     │                     │                     │
       │                     │  PUT file directly ─────────────────────▶│
       │                     │  (bypasses server)  │                     │
       │                     │                     │                     │
       │                     │  Register file in DB│                     │
       │                     │────────────────────▶│                     │
       │                     │                     │  INSERT Course_Files│
       │                     │                     │                     │
```

**Key points:**
- File never passes through the application server — direct S3 upload via pre-signed URL
- Pre-signed URLs are time-limited (security)
- File lands at path: `courses/{course_id}/{module_id}/{filename}`
- File metadata registered in PostgreSQL `Course_Files` table

---

## Phase 2: Automatic Processing (Async)

### Actors: S3 Event → Ingestion Lambda → SQS → Enrichment Lambda → pgvector

The moment the file lands in S3, processing begins automatically:

```
┌───────────┐     ┌────────────────┐     ┌─────────┐     ┌─────────────────┐
│  S3 Event │     │  Ingestion     │     │   SQS   │     │  Enrichment     │
│  (create) │     │  Lambda        │     │  Queue  │     │  Lambda         │
└─────┬─────┘     └───────┬────────┘     └────┬────┘     └────────┬────────┘
      │                    │                    │                    │
      │  Object created    │                    │                    │
      │───────────────────▶│                    │                    │
      │                    │                    │                    │
      │                    │  Download file     │                    │
      │                    │  from S3           │                    │
      │                    │                    │                    │
      │                    │  Detect file type  │                    │
      │                    │  Route to adapter  │                    │
      │                    │                    │                    │
      │                    │  Parse into        │                    │
      │                    │  Document IR:      │                    │
      │                    │  • text elements   │                    │
      │                    │  • images          │                    │
      │                    │  • tables          │                    │
      │                    │  • formulas        │                    │
      │                    │                    │                    │
      │                    │  Save IR to S3     │                    │
      │                    │                    │                    │
      │                    │  Send message ────▶│                    │
      │                    │                    │                    │
      │                    │                    │  Trigger ─────────▶│
      │                    │                    │                    │
      │                    │                    │                    │  Load Document IR
      │                    │                    │                    │  from S3
      │                    │                    │                    │
      │                    │                    │                    │  For each element:
      │                    │                    │                    │
      │                    │                    │                    │  TEXT:
      │                    │                    │                    │  → Semantic chunk
      │                    │                    │                    │  → Generate embedding
      │                    │                    │                    │     (Titan Embed v2)
      │                    │                    │                    │  → Store in pgvector
      │                    │                    │                    │
      │                    │                    │                    │  IMAGE:
      │                    │                    │                    │  → Claude Haiku vision
      │                    │                    │                    │  → Description text
      │                    │                    │                    │  → Embed description
      │                    │                    │                    │  → Store in pgvector
      │                    │                    │                    │
      │                    │                    │                    │  TABLE:
      │                    │                    │                    │  → Generate summary
      │                    │                    │                    │  → Embed summary
      │                    │                    │                    │  → Store in pgvector
      │                    │                    │                    │
      │                    │                    │                    │  FORMULA:
      │                    │                    │                    │  → Parse explanation
      │                    │                    │                    │  → Embed explanation
      │                    │                    │                    │  → Store in pgvector
```

**Timing:**
- Ingestion (parse + save IR): 10–30 seconds for a typical PDF
- Enrichment (vision + embedding + store): 30–120 seconds depending on image count
- Total time from upload to searchable: ~1–3 minutes

**Caching flow:**
```
Before embedding a chunk:
  1. Compute content_hash
  2. Check EmbeddingCache (DynamoDB): hash + version → cached vector?
     YES → use cached vector, skip Bedrock call
     NO  → call Titan Embed v2, store result in cache

Before describing an image:
  1. Compute content_hash of image binary
  2. Check EnrichmentCache (DynamoDB): hash → cached description?
     YES → use cached description
     NO  → call Claude Haiku vision, store result in cache
```

---

## Phase 3: Student Asks a Question (V2 Path)

### Actors: Frontend → API Gateway → chatbotV2Function → ragRetrievalFunction → Bedrock → AppSync → Frontend

```
┌──────────┐  ┌───────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────┐
│ Student  │  │   API     │  │  chatbotV2   │  │ ragRetrieval │  │ Bedrock │
│ Browser  │  │  Gateway  │  │  Function    │  │  Function    │  │  (LLMs) │
└────┬─────┘  └─────┬─────┘  └──────┬───────┘  └──────┬───────┘  └────┬────┘
     │               │               │                  │               │
     │  POST /chatbot-v2             │                  │               │
     │  + message    │               │                  │               │
     │──────────────▶│               │                  │               │
     │               │  Cognito auth │                  │               │
     │               │──────────────▶│                  │               │
     │               │               │                  │               │
     │  Subscribe to │               │                  │               │
     │  AppSync WS   │               │                  │               │
     │─ ─ ─ ─ ─ ─ ─▶│(WebSocket)    │                  │               │
     │               │               │                  │               │
     │               │               │  Load state      │               │
     │               │               │  (DynamoDB)      │               │
     │               │               │                  │               │
     │               │               │  Evaluate answer │               │
     │               │               │─────────────────────────────────▶│
     │               │               │  (Claude Haiku)  │               │
     │               │               │◀─────────────────────────────────│
     │               │               │  { correct, concepts }           │
     │               │               │                  │               │
     │               │               │  Update state    │               │
     │               │               │  Select mode     │               │
     │               │               │                  │               │
     │               │               │  Invoke retrieval│               │
     │               │               │─────────────────▶│               │
     │               │               │                  │  Query embed  │
     │               │               │                  │──────────────▶│
     │               │               │                  │  (Titan)      │
     │               │               │                  │◀──────────────│
     │               │               │                  │               │
     │               │               │                  │  Hybrid search│
     │               │               │                  │  (pgvector +  │
     │               │               │                  │   BM25)       │
     │               │               │                  │               │
     │               │               │                  │  Cross-encoder│
     │               │               │                  │  rerank       │
     │               │               │                  │               │
     │               │               │                  │  Type-aware   │
     │               │               │                  │  filter       │
     │               │               │                  │               │
     │               │               │                  │  Context build│
     │               │               │                  │               │
     │               │               │                  │  Image escal? │
     │               │               │                  │──────────────▶│
     │               │               │                  │  (Haiku vis.) │
     │               │               │                  │◀──────────────│
     │               │               │                  │               │
     │               │               │  { answer, src } │               │
     │               │               │◀─────────────────│               │
     │               │               │                  │               │
     │               │               │  Build prompt    │               │
     │               │               │  (mode + RAG +   │               │
     │               │               │   guardrails)    │               │
     │               │               │                  │               │
     │               │               │  Stream response │               │
     │               │               │─────────────────────────────────▶│
     │               │               │  (Claude Sonnet) │               │
     │               │               │                  │               │
     │  ◀─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│  AppSync chunks  │               │
     │  (words appear in real-time)  │◀─────────────────────────────────│
     │               │               │                  │               │
     │               │               │  Persist state   │               │
     │               │               │  + history       │               │
     │               │               │  (DynamoDB)      │               │
     │               │               │                  │               │
     │  HTTP response│               │                  │               │
     │◀──────────────│◀──────────────│                  │               │
     │  (full text + │               │                  │               │
     │   session_state)              │                  │               │
```

---

## Data Transformation at Each Stage

### Upload → Storage
```
instructor's file (PDF, PPTX, etc.)
    → S3 object (raw binary)
    → Course_Files row (metadata: filename, module_id, status)
```

### Storage → Document IR
```
S3 object
    → Adapter-parsed elements:
        TextElement { content, page, position }
        ImageElement { binary, page, position, alt_text }
        TableElement { headers, rows, page }
        FormulaElement { latex, page, context }
    → Document IR (JSON, saved to S3 IR bucket)
```

### Document IR → Searchable Vectors
```
TextElement
    → Semantic chunks (overlapping, meaning-grouped)
    → Titan Embed v2 → [1024 floats]
    → pgvector row { embedding, text, file_id, page, type="text" }

ImageElement
    → Claude Haiku vision → description string
    → Titan Embed v2 → [1024 floats]
    → pgvector row { embedding, description, file_id, page, type="image", s3_key }

TableElement
    → Auto-summary → summary string
    → Titan Embed v2 → [1024 floats]
    → pgvector row { embedding, summary + full_table, file_id, page, type="table" }

FormulaElement
    → Explanation → explanation string
    → Titan Embed v2 → [1024 floats]
    → pgvector row { embedding, explanation + latex, file_id, page, type="formula" }
```

### Student Query → Retrieved Context
```
"How does quicksort partition?"
    → Titan Embed v2 → [1024 floats] (query vector)
    → pgvector cosine similarity → top N by meaning
    → BM25 term matching → top N by keywords
    → RRF merge → combined candidates
    → Cross-encoder rerank → scored by true relevance
    → Type-aware filter → diverse result set
    → Context builder → grouped clusters with source attribution
```

### Retrieved Context → Streamed Answer
```
Context clusters + mode template + guardrail tags
    → System prompt assembly
    → Claude 3 Sonnet (streaming)
    → Buffer (80 chars)
    → AppSync sendChatChunk mutation
    → WebSocket
    → Student's browser (words appear progressively)
```

---

## Database Writes Per Interaction

Each student message triggers these writes:

| Store | What's Written | Timing |
|-------|---------------|--------|
| DynamoDB (Session_State_Table) | Updated session state (stage, scores, concepts, version) | After response generation |
| DynamoDB (Chat_History_Table) | User message + assistant response pair | After response generation |

Both are best-effort: if writes fail, the response is still returned to the student.

---

## Parallel Operations

The frontend fires multiple requests in parallel for responsiveness:

```
Student clicks "Send"
    │
    ├── POST /student/create_message (persist user message)     ← fire-and-forget
    ├── POST /chatbot-v2 (trigger AI pipeline)                  ← main flow
    └── WebSocket subscribe to onChatChunk(session_id)          ← streaming
```

This means:
- The typing indicator shows immediately
- Streaming text appears as soon as the LLM starts generating
- The persisted message display replaces streaming text seamlessly when the HTTP response arrives

---

## Security at Every Boundary

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SECURITY CHECKPOINTS                              │
│                                                                          │
│  1. Cognito JWT ─── Every API request authenticated                     │
│  2. Authorizer Lambda ─── Role verified (student can't hit admin routes)│
│  3. WAF ─── API Gateway protected from web attacks                      │
│  4. Pre-signed URL ─── Time-limited, per-object upload permission       │
│  5. Module isolation ─── Search filtered to enrolled module files only  │
│  6. Bedrock Guardrails ─── Input/output content filtering               │
│  7. RDS Proxy + SSL ─── Encrypted database connections                  │
│  8. VPC isolation ─── Lambdas in private subnets                        │
│  9. IAM least-privilege ─── Per-function roles, scoped ARNs             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Data Flow Diagram

```
    INSTRUCTOR                                                  STUDENT
        │                                                          │
        │  Upload PDF/PPTX/DOCX                                    │
        ▼                                                          │
  ┌───────────┐                                                    │
  │   S3      │◀── Pre-signed URL ◀── API Gateway                  │
  │  (uploads)│                                                    │
  └─────┬─────┘                                                    │
        │ S3 Event                                                 │
        ▼                                                          │
  ┌─────────────────┐                                              │
  │  ragIngestion   │  Parse → Document IR                         │
  │  Lambda         │  Save IR to S3                               │
  └────────┬────────┘                                              │
           │ SQS Message                                           │
           ▼                                                       │
  ┌─────────────────┐       ┌────────────────┐                    │
  │  ragEnrichment  │──────▶│   pgvector DB  │                    │
  │  Lambda         │       │   (vectors +   │                    │
  │                 │       │    text +      │                    │
  │  • Vision (img) │       │    metadata)   │                    │
  │  • Embed (text) │       └───────┬────────┘                    │
  │  • Chunk (all)  │              │                               │
  └─────────────────┘              │                               │
                                   │ Search                        │
                    ┌──────────────┘                               │
                    │                                               │
                    ▼                                               │
  ┌─────────────────────────┐                                      │
  │  ragRetrieval Lambda    │◀─── Invoke ◀── chatbotV2Function ◀──┘
  │                         │                      │
  │  • Query analysis       │                      │ Also:
  │  • Hybrid search        │                      │ • State load
  │  • Cross-encoder rerank │                      │ • Evaluation (Haiku)
  │  • Type-aware filter    │                      │ • State update
  │  • Context building     │                      │ • Mode selection
  │  • Image escalation     │                      │ • Prompt build
  │  • Answer synthesis     │                      │ • Stream (Sonnet)
  └─────────────────────────┘                      │ • Persist state
                                                   │
                                                   ▼
                                          ┌────────────────┐
                                          │  AppSync WS    │
                                          │  (real-time    │
                                          │   chunks)      │
                                          └───────┬────────┘
                                                  │
                                                  ▼
                                          Student sees answer
                                          word by word
```

---

## Timing (Typical Interaction)

| Phase | Duration | Notes |
|-------|----------|-------|
| Frontend → API Gateway | ~50ms | Network latency |
| Cognito auth check | ~20ms | JWT validation |
| State load (DynamoDB) | ~10ms | Single GetItem |
| Evaluation (Haiku) | ~800ms | Separate Bedrock call |
| State + mode logic | <5ms | Pure computation |
| RAG retrieval invoke | ~2–4s | Embedding + search + rerank + context build |
| Prompt assembly | <5ms | String concatenation |
| First streaming token | ~500ms | Claude Sonnet cold start |
| Full response stream | 3–8s | Depends on answer length |
| State persistence | ~20ms | DynamoDB PutItem |
| **Total time to first word** | **~3–5s** | Student sees typing, then words |
| **Total time to complete** | **~6–12s** | Full answer delivered |

---

## Related Documentation

- [Architecture Overview](./architecture-overview.md) — system-wide architecture
- [Chatbot V2 Flow](./chatbot-v2-flow.md) — detailed structured learning pipeline
- [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md) — the 4-layer retrieval system
