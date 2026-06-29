# Multimodal RAG V2 Pipeline

This document details the four-layer Retrieval-Augmented Generation pipeline that processes course materials and answers student questions. V2 replaces the original single-tool text extraction approach with specialized adapters per content type, AI-powered enrichment, hybrid search with cross-encoder reranking, and image escalation for visual content.

---

## Why V2?

The V1 pipeline treated all files the same: extract raw text page by page via PyMuPDF and store it as flat chunks. This had significant limitations:

| V1 Problem | Impact |
|-----------|--------|
| Images, diagrams, charts ignored | AI can't answer "What does the diagram on slide 5 show?" |
| Tables lose structure | Rows and columns become jumbled text |
| Math formulas garbled or lost | "Explain the equation on page 3" produces nonsense |
| PowerPoint slides lose formatting | Bullet points and headings become flat text |
| One page failure kills entire document | A corrupted page prevents all pages from processing |
| No re-processing without re-upload | Bug fixes require instructors to re-upload everything |

V2 fixes all of these by processing each content type differently, understanding images via vision AI, and making search multimodal-aware.

---

## The Four Layers

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   LAYER 1   │     │   LAYER 2   │     │   LAYER 3   │     │   LAYER 4   │
│             │     │             │     │             │     │             │
│  INGESTION  │────▶│ ENRICHMENT  │────▶│  RETRIEVAL  │────▶│  REASONING  │
│             │     │             │     │             │     │             │
│ "Read the   │     │ "Understand │     │ "Find the   │     │ "Write the  │
│  file"      │     │  the content│     │  right       │     │  answer"    │
│             │     │  deeply"    │     │  pieces"    │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘

ragIngestion         ragEnrichment        ragRetrieval         ragRetrieval
Function             Function             Function             Function
(S3 event trigger)   (SQS trigger)        (Lambda invoke)      (same function)
```

---

## Layer 1: Ingestion — "Read the File"

**Lambda:** `ragIngestionFunction`
**Trigger:** S3 event (object created in `courses/` prefix of the IR bucket)
**Output:** Structured Document IR persisted to S3, enrichment message sent to SQS

### How It Works

Instead of one generic reader, V2 uses an **Adapter Registry** that routes each file to a specialist:

```
┌────────────────────────────────────────────────────────────────┐
│                      ADAPTER REGISTRY                            │
│                                                                  │
│   File arrives → detect type → dispatch to specialist reader    │
│                                                                  │
│   ┌───────┐  ┌───────┐  ┌───────┐  ┌───────┐  ┌───────┐      │
│   │  PDF  │  │ PPTX  │  │ DOCX  │  │ LaTeX │  │  CSV  │      │
│   │Reader │  │Reader │  │Reader │  │Reader │  │Reader │      │
│   └───┬───┘  └───┬───┘  └───┬───┘  └───┬───┘  └───┬───┘      │
│       └──────────┴──────────┴──────────┴──────────┘            │
│                             │                                    │
│                             ▼                                    │
│              Structured Document IR (intermediate               │
│              representation) containing:                         │
│              • Text paragraphs (with page/slide location)       │
│              • Images (binary + page location)                  │
│              • Tables (structured rows, columns, headers)       │
│              • Formulas (LaTeX notation + context)              │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

### Supported File Types

| Format | Adapter | Content Extracted |
|--------|---------|-------------------|
| PDF | PDF Reader | Text, images, tables, formulas (OCR fallback for scanned pages) |
| PPTX | PowerPoint Reader | Slides with text, images, speaker notes, tables |
| DOCX | Word Reader | Paragraphs, images, tables, headings hierarchy |
| LaTeX | LaTeX Reader | Text, math environments, figures |
| CSV/JSON | Data Reader | Structured data with column headers |
| HTML | HTML Reader | Semantic content extraction |

### Key Improvement: Document IR

The parsed result is saved as an intermediate representation (Document IR) in S3. This means:
- If enrichment processing improves later, files can be re-enriched without re-uploading
- Each element knows its location: page number, slide number, position on page
- Failed pages don't kill the whole document — other pages process normally

### Graceful Degradation

```
Scenario: Page 5 of a PDF is corrupted
V1: ❌ Entire document fails to process
V2: ✅ Pages 1-4 and 6+ process normally. Page 5 is logged as failed and skipped.
```

---

## Layer 2: Enrichment — "Understand the Content Deeply"

**Lambda:** `ragEnrichmentFunction`
**Trigger:** SQS message from enrichment queue (decoupled from ingestion)
**Resources:** Bedrock (Haiku for vision, Titan for embeddings), DynamoDB caches, pgvector

### Content-Type-Specific Processing

Each element type receives specialized enrichment:

```
┌───────────────────────────────────────────────────────────────────────┐
│                         ENRICHMENT PIPELINE                             │
│                                                                         │
│  TEXT PARAGRAPHS                                                       │
│  → Semantic chunking (groups related sentences)                        │
│  → Embedding generation (Titan Embed v2, 1024 dimensions)             │
│  → Store in pgvector                                                   │
│                                                                         │
│  IMAGES / DIAGRAMS                                                     │
│  → Claude 3 Haiku vision: generates natural language description       │
│    "This flowchart shows the TCP/IP 4-layer model..."                  │
│  → Description is chunked and embedded alongside text                  │
│  → Original image reference stored for escalation                      │
│                                                                         │
│  FORMULAS                                                              │
│  → LaTeX parsed into readable explanation + concept identification     │
│    "E = mc² — relates energy, mass, and the speed of light"            │
│  → Explanation embedded for semantic search                            │
│                                                                         │
│  TABLES                                                                │
│  → Structured into headers + rows + auto-generated summary             │
│    "Comparison table of 5 sorting algorithms by time complexity"        │
│  → Summary embedded; full table preserved for context building         │
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘
```

### Vision Processing (Images)

- First 30 images per document get full AI vision processing (Claude 3 Haiku)
- Remaining images get a basic positional description
- Results are cached in `EnrichmentCache` (DynamoDB) — same image reused across courses or semesters won't be re-processed
- Cost per image: ~$0.001 (Haiku is lightweight)

### Embedding Generation

- Model: Amazon Titan Embed Text v2 (1024 dimensions)
- Cached in `EmbeddingCache` (DynamoDB) — identical content produces identical embeddings
- Version tracked: when the embedding model changes, only modified content is re-embedded

### Cost Optimizations

| Optimization | Mechanism |
|-------------|-----------|
| Vision cap (30/doc) | Limits expensive Haiku vision calls per document |
| Enrichment cache | Same content across courses/semesters reuses cached descriptions |
| Embedding cache | Same text = same vector, no redundant Bedrock calls |
| Version tracking | Model upgrades only re-embed changed content |
| SQS decoupling | Enrichment runs asynchronously, doesn't block ingestion |

---

## Layer 3: Retrieval — "Find the Right Pieces"

**Lambda:** `ragRetrievalFunction`
**Trigger:** Synchronous Lambda invoke from chatbotV2Function or direct API call
**Output:** Answer string + source attribution list

### Step 1: Query Analysis

The `QueryAnalyzer` classifies what the student is asking for:

```
┌───────────────────────────────────────────────────────────────────┐
│                       QUERY ANALYZER                                │
│                                                                     │
│  "Show me the diagram of the water cycle"                          │
│   → needs_image_escalation = true                                  │
│   → requires_image = true                                          │
│   → lecture_number = null                                          │
│                                                                     │
│  "What topics were covered in lecture 5?"                          │
│   → needs_summary = true                                           │
│   → lecture_number = 5                                             │
│                                                                     │
│  "Explain the quadratic formula"                                   │
│   → requires_formula = true                                        │
│   → needs_image_escalation = false                                 │
│                                                                     │
│  Implementation: 70-80% classified by keyword rules (free)         │
│  Remaining 20-30%: quick Claude 3 Haiku call (~$0.0001)            │
└───────────────────────────────────────────────────────────────────┘
```

### Step 2: Query Embedding

The student's query is converted to a 1024-dimensional vector using Titan Embed v2 (no caching for queries — they're unique each time).

### Step 3: Hybrid Search

Two search strategies run in parallel and merge:

```
┌──────────────────────────────────────────────────────────────────┐
│                        HYBRID SEARCH                               │
│                                                                    │
│   ┌─────────────────────────┐    ┌─────────────────────────┐     │
│   │    VECTOR SEARCH        │    │    BM25 KEYWORD SEARCH   │     │
│   │    (pgvector)           │    │    (text matching)       │     │
│   │                         │    │                          │     │
│   │  Cosine similarity on   │    │  Term frequency + IDF    │     │
│   │  1024-dim embeddings    │    │  scoring on text content │     │
│   │                         │    │                          │     │
│   │  Catches: conceptual    │    │  Catches: exact terms,   │     │
│   │  matches, paraphrases   │    │  proper nouns, formulas  │     │
│   └────────────┬────────────┘    └────────────┬─────────────┘     │
│                └────────────┬─────────────────┘                    │
│                             │                                      │
│                             ▼                                      │
│                  ┌─────────────────────┐                          │
│                  │   MERGED RESULTS    │                          │
│                  │   (RRF fusion)      │                          │
│                  └─────────────────────┘                          │
│                                                                    │
│   Fallback: If BM25 is unavailable, vector-only search proceeds  │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Step 4: Cross-Encoder Reranking (New in V2)

A second-pass reranker reads each result alongside the query and scores true relevance:

```
Query: "How does quicksort partition?"
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
┌────────┐    ┌────────┐    ┌────────┐
│Result 1│    │Result 2│    │Result 3│    ...top 30 results
│+ Query │    │+ Query │    │+ Query │
└───┬────┘    └───┬────┘    └───┬────┘
    │             │             │
    ▼             ▼             ▼
  0.94          0.23          0.87     ← true relevance scores

Reranked order: Result 1, Result 3, ... (Result 2 drops)
```

This is significantly more accurate than vector similarity scores alone because the cross-encoder sees the full text of both query and result together.

### Step 5: Type-Aware Filtering (New in V2)

Ensures diversity in results by applying content-type caps:

| Content Type | Default Cap | Adjusts When... |
|-------------|-------------|-----------------|
| Text passages | 8 | — |
| Image descriptions | 4 | Query `requires_image` → cap increases |
| Formula results | 3 | Query `requires_formula` → cap increases |
| Table results | 2 | Query `requires_table` → cap increases |

This prevents the common V1 problem where asking about a formula returns 6 text chunks that mention it but not the formula itself.

---

## Layer 4: Reasoning — "Write the Answer"

**Lambda:** Same `ragRetrievalFunction` (retrieval + reasoning are co-located)
**Output:** Natural language answer with source references

### Context Building

The `ContextBuilder` assembles retrieved results into coherent context for the LLM:

```
┌───────────────────────────────────────────────────────────────────────┐
│                        CONTEXT BUILDER                                  │
│                                                                         │
│  1. GROUP by source                                                    │
│     "These 3 chunks are from the same page — keep them together"       │
│                                                                         │
│  2. EXPAND siblings                                                    │
│     "This chunk is relevant but partial — grab surrounding sentences   │
│      (capped at 500 extra words to avoid dilution)"                    │
│                                                                         │
│  3. BUILD clusters                                                     │
│     "Group: diagram + its caption + the paragraph referencing it"      │
│                                                                         │
│  4. MANAGE token budget                                                │
│     "Prioritize best clusters, trim lowest-scored if over budget"      │
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘
```

### Image Escalation (New in V2)

When the QueryAnalyzer determines the student needs to see/understand an image:

```
┌───────────────────────────────────────────────────────────────────────┐
│                      IMAGE ESCALATION                                   │
│                                                                         │
│  Student: "What does the flowchart on page 7 show?"                    │
│                                                                         │
│  1. QueryAnalyzer flags: requires_image_escalation = true              │
│  2. Search results include image description chunks                    │
│  3. Fetch the actual image file from S3 (IR bucket)                    │
│  4. Send to Claude 3 Haiku vision with the student's specific question │
│  5. Vision AI: "This flowchart shows a decision tree for               │
│     diagnosing network issues. It starts with..."                      │
│  6. Include this targeted analysis in the final answer context         │
│                                                                         │
│  Result: The AI can LOOK at images and describe them in detail,        │
│          specific to what the student asked about.                      │
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘
```

Key difference from Layer 2 enrichment: enrichment generates a generic description once at ingestion time. Escalation generates a targeted description at query time, specific to what the student asked.

### Answer Generation

The ReasoningEngine passes the assembled context to Claude 3 Haiku for final answer synthesis:

```python
Response: {
    "statusCode": 200,
    "body": {
        "answer": "The flowchart on page 7 shows a decision tree for...",
        "sources": ["ret-id-1", "ret-id-2"],
        "escalation_used": true,
        "image_analyses": ["Detailed analysis of figure 7.1..."]
    }
}
```

### Graceful Degradation

| Failure | Behavior |
|---------|----------|
| pgvector unavailable | HTTP 503 (cannot proceed without vector search) |
| BM25 unavailable | Vector-only fallback (slightly lower recall) |
| Cross-encoder down | Skip reranking, use raw merged scores |
| Vision AI overloaded | Basic fallback description + 3 retries |
| LLM failure | Graceful fallback message to caller |

---

## Infrastructure (MultimodalRagStack)

### Lambda Functions

| Function | Runtime | Memory | Timeout | Trigger |
|----------|---------|--------|---------|---------|
| `ragIngestionFunction` | Python 3.11 (Docker) | 1024 MB | 300s | S3 event (courses/ prefix) |
| `ragEnrichmentFunction` | Python 3.11 (Docker) | 2048 MB | 900s | SQS (enrichment queue) |
| `ragRetrievalFunction` | Python 3.11 (Docker) | 1024 MB | 60s | Lambda invoke (sync) |

### Supporting Resources

| Resource | Purpose |
|----------|---------|
| IR Bucket (S3) | Stores Document IR + original images for escalation |
| EmbeddingCache (DynamoDB) | Caches embedding vectors by content_hash + version |
| EnrichmentCache (DynamoDB) | Caches vision descriptions by content_hash |
| Enrichment Queue (SQS) | Decouples ingestion from enrichment (with DLQ, max 3 retries) |

### IAM Roles (Per-Function, Least-Privilege)

- `ragIngestionRole` — S3 GetObject/PutObject, SQS SendMessage, CloudWatch Logs, X-Ray
- `ragEnrichmentRole` — S3 GetObject, Bedrock InvokeModel (Haiku + Titan), DynamoDB caches, Secrets Manager, VPC networking, RDS Proxy, SQS Receive/Delete, CloudWatch Logs, X-Ray
- `ragRetrievalRole` — Bedrock InvokeModel (Haiku + Titan), DynamoDB EmbeddingCache (read), Secrets Manager, VPC networking, RDS Proxy, S3 GetObject (escalation), CloudWatch Logs, X-Ray

---

## V1 vs V2 Comparison

| Capability | V1 (data_ingestion + text_generation) | V2 (Multimodal RAG) |
|-----------|--------------------------------------|---------------------|
| File parsing | PyMuPDF only (raw text) | Adapter per file type (structured elements) |
| Image understanding | None | Vision AI descriptions + query-time escalation |
| Formula handling | Garbled/lost | LaTeX parsing + concept explanation |
| Table handling | Flat text | Structured rows/columns + summary |
| Search | Vector only (pgvector + LangChain) | Hybrid (vector + BM25) + cross-encoder reranking |
| Result diversity | No guarantee | Type-aware caps ensure mix of content types |
| Context assembly | Flat concatenation | Source-grouped clusters with sibling expansion |
| Caching | None | Embedding cache + enrichment cache |
| Error handling | One failure kills document | Per-element graceful degradation |
| Re-processing | Requires re-upload | Re-enrich from saved Document IR |
| Supported formats | PDF, DOCX, PPTX, TXT, XLSX | + LaTeX, CSV, JSON, HTML |

---

## Module Source Files

```
cdk/multimodal_rag_v2/
├── Dockerfile           # Shared Docker image for all 3 Lambda functions
├── requirements.txt     # Python dependencies
├── __init__.py
├── ingestion/           # Layer 1 — file parsing + Document IR
│   └── handler.py
├── enrichment/          # Layer 2 — vision, chunking, embedding
│   └── handler.py
├── retrieval/           # Layer 3+4 — search, rerank, reason
│   ├── handler.py       # Main retrieval handler
│   ├── query_analyzer.py
│   ├── hybrid_search_engine.py
│   ├── cross_encoder_reranker.py
│   └── production_ranker.py
├── reasoning/           # Layer 4 support modules
│   ├── context_builder.py
│   ├── image_escalation.py
│   └── reasoning_engine.py
├── cache/               # Caching layer
│   └── embedding_cache.py
├── models/              # Shared data models
│   └── data_models.py
└── persistence/         # Storage abstractions
```

---

## Performance & Cost Notes

The retrieval + reasoning layers carry several optimizations: an HNSW ANN index
on `retrieval_units.embedding`, batched sibling expansion (one query, not N),
per-call `bedrock_call` cost/latency logging, and two flag-gated changes
(default off) — `RAG_RETURN_PASSAGES` (return passages and skip the reasoning
LLM to eliminate double generation) and `STRICT_IMAGE_ESCALATION` (gate vision
on explicit figure references). `QUERY_EMBEDDING_CACHE` reuses cached query
embeddings. See [Performance & Cost Optimizations](./architecture-overview.md#performance--cost-optimizations).

---

## Related Documentation

- [Architecture Overview](./architecture-overview.md) — system-wide architecture
- [Chatbot V2 Flow](./chatbot-v2-flow.md) — how the structured learning chatbot uses retrieval
- [Data Flow](./data-flow.md) — end-to-end from file upload to student answer
- [Multimodal RAG V2 Explained](./multimodal-rag-v2-explained.md) — non-technical explanation with visual diagrams
