# The Upgraded System: Multimodal RAG V2 — Explained Simply

This document explains the planned upgrade to how AILA processes course materials and answers questions. It's written for anyone — no programming background required.

---

## Why Upgrade?

The current system treats every file the same way: open it with one tool (PyMuPDF), extract raw text page by page, and store it. This works, but has real limitations:

| Current Problem | Impact on Students |
|----------------|-------------------|
| Images, diagrams, and charts are ignored | "What does the diagram on slide 5 show?" → AI can't answer |
| Tables lose their structure | Rows and columns become jumbled text |
| Math formulas are lost or garbled | "Explain the equation on page 3" → AI sees nonsense |
| PowerPoint slides lose formatting | Bullet points and headings become flat text |
| One file failure = entire processing fails | A bad page kills the whole document |
| No way to re-process without re-uploading | Fixing a bug requires instructors to re-upload everything |

**V2 fixes all of these** by processing each type of content differently, understanding images, and making search much smarter.

---

## The Four Layers

Think of it like a factory assembly line with four stations. Each station has one job and passes its work to the next.

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
```

---

## Layer 1: Ingestion — "Read the File"

**Current system:** One tool reads everything.
**V2:** A specialist reader for each file type.

```
┌────────────────────────────────────────────────────────┐
│                  ADAPTER REGISTRY                        │
│                                                         │
│   "What type of file is this? Let me send it to        │
│    the right specialist."                               │
│                                                         │
│   ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐  │
│   │  PDF  │ │ PPTX  │ │ DOCX  │ │ LaTeX │ │  CSV  │  │
│   │Reader │ │Reader │ │Reader │ │Reader │ │Reader │  │
│   └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘  │
│       │         │         │         │         │        │
│       └─────────┴─────────┴─────────┴─────────┘       │
│                           │                             │
│                           ▼                             │
│              Structured list of elements:               │
│              • Text paragraphs                          │
│              • Images (with page location)              │
│              • Tables (with rows & columns)             │
│              • Formulas (with LaTeX notation)           │
│                                                         │
└────────────────────────────────────────────────────────┘
```

**The key improvement:** Instead of "here's all the text mashed together from page 4", the system now says "here's a paragraph, here's an image, here's a table with 3 columns, here's a math equation — and I know where each one lives in the document."

**Bonus: The parsed result is saved.** If we improve our AI processing later, we can re-enrich all files without asking instructors to re-upload anything.

---

## Layer 2: Enrichment — "Understand the Content Deeply"

This is where V2 gets genuinely intelligent. Each type of content is enriched differently:

```
┌──────────────────────────────────────────────────────────────────┐
│                        ENRICHMENT                                  │
│                                                                    │
│  ┌──────────────────┐                                             │
│  │   TEXT            │  → Split into meaningful chunks             │
│  │   (paragraphs)   │    (groups related sentences together)      │
│  └──────────────────┘                                             │
│                                                                    │
│  ┌──────────────────┐                                             │
│  │   IMAGES         │  → AI vision describes what's in the image  │
│  │   (diagrams,     │    "This is a flowchart showing the water   │
│  │    charts)       │     cycle with 4 stages: evaporation..."    │
│  └──────────────────┘                                             │
│                                                                    │
│  ┌──────────────────┐                                             │
│  │   FORMULAS       │  → Parsed into readable form + concepts     │
│  │   (equations)    │    "E = mc² — relates energy, mass, and     │
│  │                  │     the speed of light"                      │
│  └──────────────────┘                                             │
│                                                                    │
│  ┌──────────────────┐                                             │
│  │   TABLES         │  → Structured into headers + rows + summary │
│  │   (data grids)   │    "Comparison table of 5 sorting           │
│  │                  │     algorithms by time complexity"           │
│  └──────────────────┘                                             │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### What this means in practice:

**Today:** A student asks "What does the diagram on slide 12 show?" → AI says "I don't have information about that."

**V2:** The same question → AI says "The diagram on slide 12 shows the TCP/IP 4-layer model with data flowing from Application through Transport, Internet, and Network Access layers. Each layer adds a header as data moves down the stack."

### Cost control:

- Only the first 30 images per document get AI vision processing (the rest get a basic description)
- Text chunking is free (no AI calls needed)
- A lightweight AI (Claude Haiku, ~$0.001 per image) handles vision — not the expensive model
- Results are cached — if the same slide is reused next semester, it won't be re-processed

---

## Layer 3: Retrieval — "Find the Right Pieces"

When a student asks a question, V2 is much smarter about finding relevant content.

### Step 1: Understand what the student is asking for

```
┌──────────────────────────────────────────────────────────────┐
│                    QUERY ANALYZER                              │
│                                                               │
│  Student: "Show me the diagram of the water cycle"           │
│                                                               │
│  Rules check (instant, free):                                │
│    ✓ "show me" → needs image escalation                      │
│    ✓ "diagram" → prioritize image results                    │
│                                                               │
│  Result: "Look for images/diagrams, and be ready to          │
│           actually show the image to the AI for analysis"    │
│                                                               │
│  ─────────────────────────────────────────────────────       │
│                                                               │
│  Student: "What topics were covered in lecture 5?"            │
│                                                               │
│  Rules check (instant, free):                                │
│    ✓ "covered" → needs document summary                      │
│    ✓ "lecture 5" → filter to lecture #5 specifically          │
│                                                               │
│  Result: "Find the summary for lecture 5 specifically"       │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**The magic:** 70-80% of questions can be classified instantly using simple keyword rules (zero cost). Only ambiguous questions need a quick AI call (~$0.0001).

### Step 2: Search with multiple strategies

```
┌─────────────────────────────────────────────────────────────────┐
│                        IMPROVED SEARCH                            │
│                                                                   │
│                    ┌─────────────────────┐                       │
│                    │  1. Vector Search    │                       │
│                    │  (meaning-based)     │                       │
│                    └─────────┬───────────┘                       │
│                              │                                    │
│                    ┌─────────┴───────────┐                       │
│                    │  2. Keyword Search   │                       │
│                    │  (word-matching)     │                       │
│                    └─────────┬───────────┘                       │
│                              │                                    │
│                              ▼                                    │
│                    ┌─────────────────────┐                       │
│                    │  3. Merge results    │  ← Same as today      │
│                    └─────────┬───────────┘                       │
│                              │                                    │
│                              ▼                                    │
│              ┌───────────────────────────────┐                   │
│              │  4. Cross-Encoder Reranking    │  ← NEW            │
│              │                                │                   │
│              │  A second AI model reads each  │                   │
│              │  result + the question together │                   │
│              │  and scores how relevant each  │                   │
│              │  one truly is. Much more       │                   │
│              │  accurate than vector scores   │                   │
│              │  alone.                        │                   │
│              └───────────────┬───────────────┘                   │
│                              │                                    │
│                              ▼                                    │
│              ┌───────────────────────────────┐                   │
│              │  5. Type-Aware Filtering       │  ← NEW            │
│              │                                │                   │
│              │  Ensures diversity:            │                   │
│              │  • Up to 8 text passages       │                   │
│              │  • Up to 4 image descriptions  │                   │
│              │  • Up to 3 formula results     │                   │
│              │  • Up to 2 table results       │                   │
│              │                                │                   │
│              │  (Caps adjust based on what    │                   │
│              │   the student is asking for)   │                   │
│              └───────────────────────────────┘                   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Why this matters:** Today, if a student asks about a formula, they might get 6 text chunks that mention the formula but not the formula itself. V2 guarantees a mix of relevant content types.

---

## Layer 4: Reasoning — "Write the Answer"

The final layer assembles everything and generates the response.

### New capabilities:

```
┌──────────────────────────────────────────────────────────────────┐
│                      CONTEXT BUILDER                               │
│                                                                    │
│  1. GROUP by source                                               │
│     "These 3 chunks are all from the same page — keep them       │
│      together so the AI sees the full picture"                    │
│                                                                    │
│  2. EXPAND siblings                                               │
│     "This chunk is relevant, but it's part of a larger           │
│      paragraph. Grab the sentences before and after it too,      │
│      but stop at 500 extra words to avoid diluting relevance"    │
│                                                                    │
│  3. BUILD clusters                                                │
│     "Group related pieces: the diagram + its caption +           │
│      the paragraph that references it = one cluster"             │
│                                                                    │
│  4. MANAGE token budget                                           │
│     "We have room for 128,000 tokens. Prioritize the best       │
│      clusters, trim the lowest-scored ones if needed"            │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Image Escalation (new):

```
┌──────────────────────────────────────────────────────────────────┐
│                    IMAGE ESCALATION                                │
│                                                                    │
│  Student: "What does the flowchart on page 7 show?"              │
│                                                                    │
│  Query Analyzer: "This needs image escalation"                   │
│                                                                    │
│  1. Find the image(s) from the search results                    │
│  2. Fetch the actual image file from S3                          │
│  3. Send it to a Vision AI that can SEE the image               │
│  4. Vision AI: "This flowchart shows a decision tree for         │
│     diagnosing network issues. It starts with 'Can you           │
│     ping the gateway?' and branches into..."                     │
│  5. Include this analysis in the final answer                    │
│                                                                    │
│  Result: The AI can now LOOK at images and describe them         │
│          in detail, specific to what the student asked about.    │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## What Changes for Users?

### For Students:

| Capability | Today | After V2 |
|-----------|-------|----------|
| Ask about text content | ✅ Works | ✅ Works (better chunking) |
| Ask about diagrams/charts | ❌ Can't answer | ✅ AI describes what it sees |
| Ask about formulas | ❌ Usually fails | ✅ Understands equations |
| Ask about tables/data | ❌ Loses structure | ✅ Knows rows, columns, headers |
| "What's in Lecture 5?" | ❌ Guesses | ✅ Retrieves exact document summary |
| "Show me the figure on slide 3" | ❌ Can't | ✅ AI looks at the actual image |
| Follow-up questions | ✅ Works | ✅ Works (smarter context) |

### For Instructors:

| Change | Impact |
|--------|--------|
| No action required | Files are automatically re-processed with V2 |
| More file types supported | HTML, LaTeX, CSV, JSON added |
| Image-heavy slides work | Diagrams, charts, and figures are now understood |
| Better answers from same materials | Smarter search + richer understanding |

---

## How It Saves Money

| Optimization | How It Works |
|-------------|-------------|
| **Rule-based query analysis** | 70-80% of student questions are classified instantly (free) instead of calling an AI model |
| **Content caching** | If the same slide is used in two courses or re-uploaded next semester, it's not re-processed — the cached result is reused |
| **Embedding caching** | Same text = same numbers. No need to re-compute embeddings for identical content |
| **Visual cap (30/doc)** | Limits expensive vision AI calls. Most documents don't have 30+ meaningful images |
| **Version tracking** | When we upgrade the embedding model, only changed content is re-embedded — not everything |

---

## Error Handling — Nothing Breaks Silently

A key principle: **one failure never brings down the whole system.**

```
┌──────────────────────────────────────────────────────────────┐
│                    GRACEFUL DEGRADATION                        │
│                                                               │
│  Scenario: Page 5 of a PDF is corrupted                      │
│  Today: ❌ Entire document fails to process                   │
│  V2:    ✅ Pages 1-4 and 6+ process normally.                │
│            Page 5 is logged as failed and skipped.            │
│                                                               │
│  Scenario: Vision AI is temporarily overloaded               │
│  Today: ❌ Not applicable (images ignored)                    │
│  V2:    ✅ Image gets a basic fallback description.           │
│            Other images continue processing normally.         │
│            System retries 3 times before falling back.        │
│                                                               │
│  Scenario: Cross-encoder service is down                     │
│  Today: ❌ Not applicable (doesn't exist)                     │
│  V2:    ✅ Search skips reranking and uses basic scores.      │
│            Answer quality slightly lower, but still works.   │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Complete Flow Diagram (V2)

```
    INSTRUCTOR uploads file
            │
            ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 1: INGESTION                                            │
│                                                                │
│  File → Specialist Reader → Structured Elements               │
│  (text, images, tables, formulas — each tagged with location) │
│                                                                │
│  Parsed result saved to S3 (can re-process later)             │
└───────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 2: ENRICHMENT                                           │
│                                                                │
│  Text → Semantic chunks (free)                                │
│  Images → AI vision description (~$0.001 each, max 30)        │
│  Tables → Structured headers + rows + summary                 │
│  Formulas → Parsed notation + concepts                        │
│                                                                │
│  All results cached for reuse                                 │
│  Each piece converted to searchable numbers (embeddings)      │
│  Stored in pgvector database                                  │
└───────────────────────────┬───────────────────────────────────┘
                            │
                            │   (Student asks a question)
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 3: RETRIEVAL                                            │
│                                                                │
│  1. Analyze question (what type of content is needed?)        │
│  2. Hybrid search (meaning + keywords)                        │
│  3. Cross-encoder reranks for accuracy                        │
│  4. Type-aware filter ensures mix of content types            │
│  5. Returns best 15 pieces (text, images, formulas, tables)   │
└───────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 4: REASONING                                            │
│                                                                │
│  1. Group related pieces together (same page, same parent)    │
│  2. Expand context (grab surrounding content for completeness)│
│  3. If student asked about an image → fetch + analyze it      │
│  4. Assemble everything into a prompt                         │
│  5. LLM generates answer grounded in course materials         │
│  6. Stream response word-by-word to student                   │
└───────────────────────────────────────────────────────────────┘
```

---

## Timeline & Dependencies

**New libraries needed:** python-pptx, python-docx, beautifulsoup4, pylatexenc, rank-bm25, cross-encoder model

**No new AWS services needed** — uses existing Bedrock, S3, pgvector, DynamoDB, Lambda infrastructure.

**Backward compatible** — text-only documents will produce the same quality results as today. All improvements are additive.

---

## Future (V3 and Beyond)

Things intentionally deferred to keep V2 focused:

- **Calculator tool** — AI can compute math, not just explain it
- **Table query engine** — "What's the value in row 3, column B?"
- **Citation linking** — AI response links to exact page/slide
- **Topic-overlap clustering** — group results by theme (needs usage data first)
- **Swappable search backends** — currently tied to pgvector; future could use OpenSearch or others
