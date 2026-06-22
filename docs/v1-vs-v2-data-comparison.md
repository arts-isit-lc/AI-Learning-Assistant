# Original System vs V2 — What Changed and Why Migration Isn't Needed

This document explains how data is stored and processed differently between the original system (V1) and the upgraded system (V2). It also explains why we can switch directly to V2 without migrating old data.

---

## At a Glance

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         V1 (Original System)                                 │
│                                                                              │
│   Upload PDF ──▶ Extract text only ──▶ Flat chunks ──▶ One search table     │
│                    (images lost)        (no types)      (langchain_pg_*)     │
│                                                                              │
│   Student asks ──▶ Search chunks ──▶ AI answers freely ──▶ No progress      │
│                                        (no guardrails      tracking          │
│                                         on teaching)                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            V2 (New System)                                    │
│                                                                              │
│   Upload PDF ──▶ Specialist readers ──▶ Typed elements ──▶ Rich search table│
│                   (text, images,        (text, image,      (retrieval_units) │
│                    tables, formulas)     table, formula)                      │
│                                                                              │
│   Student asks ──▶ Smart search ──▶ App controls teaching ──▶ Full progress │
│                    (reranking +      strategy (modes)          tracking       │
│                     type filtering)                            (concepts,     │
│                                                                engagement)   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. File Processing — How Course Materials Become Searchable

| | Original System (V1) | New System (V2) |
|---|---|---|
| **What it reads** | Text only — images, tables, and formulas are ignored | Text, images, tables, and formulas — each handled by a specialist reader |
| **How it breaks up content** | Splits text into chunks grouped by meaning (semantic chunking) | Splits into typed elements — knows "this is a paragraph", "this is a diagram", "this is a table with 3 columns" |
| **How it understands images** | Doesn't — images are skipped entirely | AI vision describes what's in each image (up to 30 per document, ~$0.001 each) |
| **Where searchable data is stored** | `langchain_pg_embedding` table — one flat table for all text chunks | `retrieval_units` table — separate columns for content type, metadata, and relationships between pieces |
| **How it searches for answers** | Vector similarity (70%) + keyword matching (30%), returns top 6 results | Same hybrid search + AI re-ranking for accuracy + type-aware filtering (ensures a mix of text, images, and tables in results) |
| **File types supported** | PDF, DOCX, PPTX (text extraction only) | PDF, DOCX, PPTX, HTML, LaTeX, CSV (full content extraction including visuals) |
| **Can re-process files without re-uploading?** | No — instructor must re-upload | Yes — the parsed structure is saved separately, so we can re-enrich anytime |
| **Caching** | None — re-processing identical content costs the same every time | Embedding cache + enrichment cache — avoids paying to re-process identical content |

**What this means:** V2 stores data in a completely different format. The old flat text chunks cannot be "converted" into the new rich format — they need to be re-processed from the original files. Re-processing produces much better results anyway because V2 understands images, tables, and formulas that V1 missed entirely.

### How Each System Processes a File

```
V1 — One tool reads everything:

  ┌──────────┐      ┌───────────────────┐      ┌─────────────────────────┐
  │  PDF /   │      │  PyMuPDF reads    │      │  langchain_pg_embedding │
  │  PPTX /  │─────▶│  text page by     │─────▶│  (flat text chunks      │
  │  DOCX    │      │  page             │      │   + number vectors)     │
  └──────────┘      │                   │      └─────────────────────────┘
                    │  Images? Skipped.  │
                    │  Tables? Flattened.│
                    │  Formulas? Garbled.│
                    └───────────────────┘


V2 — Specialist reader per content type:

  ┌──────────┐      ┌───────────────────┐      ┌──────────────┐      ┌─────────────────────┐
  │  PDF /   │      │  Adapter Registry │      │  Enrichment  │      │  retrieval_units    │
  │  PPTX /  │─────▶│  picks the right  │─────▶│  Pipeline    │─────▶│  (typed elements    │
  │  DOCX /  │      │  specialist:      │      │              │      │   with metadata,    │
  │  HTML /  │      │                   │      │  • Text:     │      │   relationships,    │
  │  LaTeX / │      │  • PDF reader     │      │    chunked   │      │   and vectors)      │
  │  CSV     │      │  • PPTX reader    │      │  • Images:   │      └─────────────────────┘
  └──────────┘      │  • DOCX reader    │      │    AI vision │
                    │  • HTML reader    │      │  • Tables:   │
                    │  • LaTeX reader   │      │    structured│
                    │  • CSV reader     │      │  • Formulas: │
                    └───────────────────┘      │    parsed    │
                             │                 └──────────────┘
                             ▼
                    ┌───────────────────┐
                    │  Document IR      │
                    │  (saved to S3 —   │
                    │   can re-enrich   │
                    │   later without   │
                    │   re-uploading)   │
                    └───────────────────┘
```

---

## 2. The Chatbot — How Students Get Answers

| | Original System (V1) | New System (V2) |
|---|---|---|
| **Teaching approach** | General Q&A — student asks, AI answers freely | Structured learning — AI evaluates understanding, adapts difficulty, tracks which concepts the student has learned |
| **Conversation memory** | Simple message log in DynamoDB | Same message history + a learning session record (tracks progress, concepts, and engagement) |
| **How it decides what to say** | The AI (LLM) decides everything on its own | The application controls the teaching strategy (greet, assess, give a hint, explain, advance to harder questions, congratulate completion) — the AI just writes natural language within those constraints |
| **Module completion** | Based on a single AI "verdict" (thumbs up or down) | Based on engagement metrics: did the student interact enough? Discuss enough concepts? Participate meaningfully? |
| **Concept tracking** | None — no record of which specific ideas a student understood | Tracks each concept through stages: exposed → discussed → demonstrated → mastery |
| **Where learning progress lives** | Nowhere — only raw chat messages exist | New `sessionStateTable` in DynamoDB stores: current stage, engagement score, concept progress map, and completion status |
| **What the API returns** | `session_name`, `llm_output`, `llm_verdict` | Same three fields + a `session_state` object with stage, module completion status, engagement score, and concepts demonstrated |

**What this means:** V2 tracks learning progress that V1 never recorded. There's nothing to migrate because this information simply didn't exist before.

### How Each Chatbot Handles a Conversation

```
V1 — AI decides everything:

  Student message
       │
       ▼
  ┌──────────────────────┐
  │  Search for relevant │
  │  text chunks         │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  Send everything to  │       No evaluation.
  │  the AI (LLM)       │       No concept tracking.
  │                      │       No adaptive difficulty.
  │  "Here's context,    │
  │   here's the question│
  │   — answer freely"   │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  AI response streams │
  │  back to student     │
  └──────────────────────┘


V2 — Application controls the teaching:

  Student message
       │
       ▼
  ┌──────────────────────┐
  │  1. EVALUATE answer  │──── Was it correct? Partial? Which concepts
  │     (Claude Haiku)   │     were demonstrated or misunderstood?
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  2. UPDATE state     │──── Increment interactions, update engagement
  │     (application)    │     score, track concepts, check stage
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  3. SELECT mode      │──── greet / assess / hint / explain /
  │     (decision table) │     advance / complete / post-completion
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  4. RETRIEVE context │──── Smart search with type-aware filtering
  │     (V2 RAG)         │     and AI reranking
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  5. GENERATE response│──── AI writes within the mode's constraints
  │     (Claude Sonnet)  │     (e.g., "give a hint" not "explain fully")
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  6. PERSIST state    │──── Save updated learning progress
  │     + chat history   │     for next interaction
  └──────────────────────┘
```

### Concept Tracking — New in V2

```
  A concept moves through stages as the student engages:

  ┌────────────┐     ┌────────────┐     ┌──────────────┐     ┌─────────┐
  │ INTRODUCED │────▶│  DISCUSSED │────▶│ DEMONSTRATED │────▶│ MASTERY │
  │            │     │            │     │              │     │         │
  │ Bot        │     │ Student    │     │ Student      │     │ Enough  │
  │ mentioned  │     │ engaged    │     │ showed       │     │ correct │
  │ the concept│     │ with it    │     │ understanding│     │ demos   │
  └────────────┘     └────────────┘     └──────────────┘     └─────────┘

  V1 had NONE of this. There's nothing to migrate.
```

---

## 3. Where Data Lives — Complete Inventory

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SHARED (both V1 and V2)                             │
│                                                                              │
│   ┌─────────────┐   ┌──────────────────────────────────────────────┐        │
│   │   Cognito   │   │  RDS PostgreSQL                               │        │
│   │  (accounts) │   │  ┌────────┐ ┌──────────────┐ ┌────────────┐ │        │
│   └─────────────┘   │  │ Users  │ │Course_Modules│ │  Sessions  │ │        │
│                      │  └────────┘ └──────────────┘ └────────────┘ │        │
│   ┌─────────────┐   │  ┌────────────────┐  ┌──────────────────┐   │        │
│   │  S3 Bucket  │   │  │ Module_Files   │  │    Messages      │   │        │
│   │(uploaded    │   │  └────────────────┘  └──────────────────┘   │        │
│   │ files)      │   └──────────────────────────────────────────────┘        │
│   └─────────────┘                                                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────┐  ┌───────────────────────────────────────┐
│       V1 ONLY (becomes idle)     │  │          V2 ONLY (new)                 │
│                                  │  │                                        │
│  PostgreSQL:                     │  │  PostgreSQL:                           │
│  ┌──────────────────────────┐   │  │  ┌──────────────────────────┐         │
│  │ langchain_pg_embedding   │   │  │  │ retrieval_units           │         │
│  │ langchain_pg_collection  │   │  │  │ (typed, enriched,         │         │
│  │ (flat text chunks)       │   │  │  │  with relationships)      │         │
│  └──────────────────────────┘   │  │  └──────────────────────────┘         │
│                                  │  │                                        │
│  DynamoDB:                       │  │  S3:                                   │
│  ┌──────────────────────────┐   │  │  ┌──────────────────────────┐         │
│  │ DynamoDB-Conversation-   │   │  │  │ irBucket (parsed docs)    │         │
│  │ Table (LangChain history)│   │  │  └──────────────────────────┘         │
│  └──────────────────────────┘   │  │                                        │
│                                  │  │  DynamoDB:                             │
│  SSM:                            │  │  ┌──────────────────────────┐         │
│  ┌──────────────────────────┐   │  │  │ embeddingCacheTable       │         │
│  │ Model IDs, table name    │   │  │  │ enrichmentCacheTable      │         │
│  └──────────────────────────┘   │  │  │ sessionStateTable         │         │
│                                  │  │  └──────────────────────────┘         │
│  Status: No longer queried.     │  │                                        │
│  Can be cleaned up later.       │  │  SQS:                                  │
│                                  │  │  ┌──────────────────────────┐         │
└──────────────────────────────────┘  │  │ enrichmentQueue           │         │
                                      │  └──────────────────────────┘         │
                                      └───────────────────────────────────────┘
```

### Shared Between V1 and V2 (unchanged, used by both)

| Data | Location | Notes |
|---|---|---|
| Student accounts and roles | Cognito + `Users` table (RDS) | Login, permissions — no change |
| Course and module structure | `Courses`, `Course_Concepts`, `Course_Modules` tables (RDS) | Course catalog — no change |
| Session list and messages | `Sessions` + `Messages` tables (RDS) | Managed by the student API — works with both V1 and V2 |
| File metadata and references | `Module_Files`, `Module_File_References` tables (RDS) | Tracks which files belong to which module — no change |
| Uploaded files | S3 bucket | Original files are preserved |

### V1 Only (becomes unused after switchover)

| Data | Location | What Happens After Switchover |
|---|---|---|
| Text chunks + number vectors | `langchain_pg_embedding` table (PostgreSQL) | Sits idle — no longer searched. Can be deleted later to reclaim space |
| Collection index | `langchain_pg_collection` table (PostgreSQL) | Sits idle alongside the embedding table |
| LangChain conversation history | `DynamoDB-Conversation-Table` | Old sessions remain readable; new sessions won't write here |
| SSM parameters (model IDs, table name) | AWS Systems Manager | Still referenced by V1 Lambda until it's removed |

### V2 Only (new infrastructure)

| Data | Location | Purpose |
|---|---|---|
| Parsed document structure (IR) | `irBucket` (S3) | Preserves the document's structure so we can re-enrich without re-uploading |
| Enriched content + embeddings | `retrieval_units` table (PostgreSQL) | The searchable content — includes type, metadata, and relationships |
| Embedding cache | `embeddingCacheTable` (DynamoDB) | Remembers computed embeddings — avoids paying for the same text twice |
| Enrichment cache | `enrichmentCacheTable` (DynamoDB) | Remembers AI vision results — avoids re-analyzing the same image twice |
| Learning session state | `sessionStateTable` (DynamoDB) | Stores each student's progress: stage, concepts, engagement score |
| Enrichment work queue | `enrichmentQueue` (SQS) | Coordinates the two-step pipeline: ingestion → enrichment |

---

## 4. Why No Data Migration Is Needed

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     DATA MIGRATION DECISION                                    │
│                                                                               │
│  Can we convert V1 data to V2 format?                                        │
│    ❌ No — completely different schema and content richness                    │
│                                                                               │
│  Would converting give us the same quality?                                   │
│    ❌ No — V1 data is missing images, tables, formulas, relationships         │
│                                                                               │
│  Do we lose anything by not migrating?                                        │
│    ❌ No — old conversations stay readable, files get re-processed better     │
│                                                                               │
│  CONCLUSION: Skip migration. Re-ingest files through V2. Switch over.        │
│              Keep V1 around as a safety net until confident.                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### The data formats are fundamentally different

V1 stores flat text chunks in a generic table designed for the LangChain library. V2 stores typed, enriched elements with metadata about content type (text vs image vs table vs formula), relationships to other elements, and source location within the document.

You cannot meaningfully convert one into the other — it would be like trying to turn a plain text file into a richly formatted spreadsheet. The structure and information simply aren't there.

### What a V1 record looks like vs a V2 record

```
V1 — langchain_pg_embedding (one flat row per text chunk):

  ┌──────────────────────────────────────────────────────────────────────┐
  │  id: "abc-123"                                                        │
  │  collection_id: "module-7"                                            │
  │  document: "Photosynthesis converts sunlight into chemical energy..." │
  │  embedding: [0.023, -0.841, 0.152, ... 1024 numbers]                 │
  │  cmetadata: { "file_id": "f-99", "page": 4 }                         │
  └──────────────────────────────────────────────────────────────────────┘

  That's it. Just text + numbers. No type info. No relationships.


V2 — retrieval_units (rich typed row):

  ┌──────────────────────────────────────────────────────────────────────┐
  │  retrieval_id: "ru-456"                                               │
  │  parent_element_id: "elem-789"                                        │
  │  element_type: "image"                           ← knows content type │
  │  embedding_text: "Flowchart showing the TCP/IP   ← AI-generated      │
  │                   4-layer model with data           description       │
  │                   flowing from Application..."                         │
  │  embedding: [0.045, -0.712, 0.331, ... 1024 numbers]                  │
  │  metadata: {                                                           │
  │    "file_id": "f-99",                                                  │
  │    "page_num": 12,                                                     │
  │    "image_s3_key": "courses/cs101/m7/img-003.png",                     │
  │    "topics": ["networking", "TCP/IP"],                                  │
  │    "is_document_summary": false                                        │
  │  }                                                                     │
  │  sibling_ids: ["ru-457", "ru-458"]              ← related elements    │
  │  ts_vector: 'tcp' 'ip' 'layer' 'model'...      ← keyword search      │
  └──────────────────────────────────────────────────────────────────────┘

  Type-aware. Relationship-aware. Searchable by meaning AND keywords.
  You can't get here from V1 data — it needs to be re-processed.
```

### Re-processing from the original files produces better results

Even if we could somehow convert the format, V1 data is missing everything that makes V2 valuable:
- No image descriptions (V1 skipped all images)
- No table structure (V1 flattened tables into jumbled text)
- No formula parsing (V1 garbled equations)
- No relationships between elements (V1 didn't track what's on the same page)

Running the original files through V2's pipeline gives students a dramatically better experience. It's not just a format change — it's fundamentally richer data.

### Old conversations remain accessible

The `Sessions` and `Messages` tables in the relational database are shared infrastructure managed by the student API (a separate Lambda). Past conversations are still viewable in the student's session history. Only **new** conversations will use the V2 chatbot and its structured learning features.

### Nothing is deleted

The V1 `langchain_pg_embedding` data stays in the database until we explicitly remove it. The V1 Lambda stays deployed (just disconnected from traffic). If something unexpected happens with V2 in production, we can reconnect V1 within minutes.

---

## 5. What the Switchover Looks Like

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BEFORE (V1 active):                                                         │
│                                                                              │
│  Student ──▶ Frontend ──▶ API Gateway ──▶ text_generation Lambda             │
│                              │                     │                         │
│                              │                     ▼                         │
│                              │            langchain_pg_embedding             │
│                              │            (text-only search)                 │
│                              │                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│  AFTER (V2 active):                                                          │
│                                                                              │
│  Student ──▶ Frontend ──▶ API Gateway ──▶ chatbotV2 Lambda                   │
│                              │                     │                         │
│                              │                     ▼                         │
│                              │            ragRetrieval Lambda                │
│                              │                     │                         │
│                              │                     ▼                         │
│                              │            retrieval_units                    │
│                              │            (multimodal search with            │
│                              │             reranking + type filtering)       │
│                              │                                               │
│  text_generation Lambda still deployed (safety net) but receives no traffic  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What changes for students
- Better answers — the AI can now understand and reference images, tables, and formulas from course materials
- Structured learning — the system tracks their progress and adapts question difficulty
- Module completion is based on genuine engagement, not a single AI judgement call

### What changes for instructors
- Nothing required — existing files will be automatically re-processed through V2
- No re-uploads needed
- Richer analytics available (which concepts students understood, which they struggled with)

### What changes in the database
- Old V1 tables remain but stop receiving new data
- New V2 tables get populated as files are re-ingested through the new pipeline
- Both sets of tables can coexist indefinitely without conflict

### Switchover timeline

```
  Day 0          Day 1              Day 2+             Day 14+
    │               │                  │                   │
    ▼               ▼                  ▼                   ▼
┌────────┐    ┌──────────┐     ┌────────────┐     ┌────────────────┐
│ Deploy │    │ Re-ingest│     │ Point      │     │ (Optional)     │
│ V2     │    │ existing │     │ frontend   │     │ Remove V1      │
│ infra  │    │ files    │     │ to V2      │     │ Lambdas +      │
│        │    │ through  │     │ route      │     │ drop old       │
│        │    │ V2       │     │            │     │ tables         │
└────────┘    │ pipeline │     │ Students   │     └────────────────┘
              └──────────┘     │ now on V2  │
                               └────────────┘
```

---

## 6. Summary

| Question | Answer |
|---|---|
| Do we need to migrate data? | **No** — the formats are incompatible and re-processing is better anyway |
| Will students lose their old conversations? | **No** — old sessions stay in the shared `Sessions`/`Messages` tables |
| Do instructors need to re-upload files? | **No** — we trigger re-ingestion on existing files automatically |
| Can we revert to V1 if something goes wrong? | **Yes** — V1 infrastructure stays deployed, just disconnected from traffic |
| What happens to the old V1 database tables? | They sit idle until we explicitly clean them up (just storage cost, no harm) |
| Is there any downtime during switchover? | **No** — we add the V2 route, point the frontend to it, and the old route remains functional |
