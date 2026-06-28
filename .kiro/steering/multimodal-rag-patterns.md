---
inclusion: fileMatch
fileMatchPattern: "cdk/multimodal_rag_v2/**"
---

# Multimodal RAG V2

4-layer pipeline: Ingestion → Enrichment → Retrieval → Reasoning. Single Docker image, CMD selects handler per function.

## Structure
```
models/data_models.py      # ALL dataclasses/enums (single source of truth)
ingestion/handler.py       # S3 event → parse → IR → SQS
ingestion/adapters/        # Per-format (pdf, pptx, docx, html, image, latex, csv, json)
enrichment/handler.py      # SQS → enrich → embed → store
enrichment/retrieval_unit_builder.py  # EnrichedElement[] → RetrievalUnit[]
retrieval/handler.py       # Query → rank → reason → answer
reasoning/                 # LLM generation, context assembly, image escalation
persistence/               # S3 IR read/write
cache/                     # DynamoDB embedding + enrichment caches
```

## Data Model Flow
```
Layer 1: FileMetadata → RawElement → IRElement → DocumentIR
Layer 2: IRElement → EnrichedElement → RetrievalUnit
Layer 3: QueryIntent → MergedResult → RankedResult
Layer 4: StructuredContext → ContextCluster → ReasoningResult
```
`ElementType` enum: `TEXT`, `IMAGE`, `TABLE`, `FORMULA`

## Version Constants
`IR_VERSION="ir-v1"` · `ENRICHMENT_VERSION="haiku-v5-2026-06"` · `EMBEDDING_VERSION="titan-v2-1024"`
Bump when changing processing logic.

## RetrievalUnit Decomposition
| Type | Decomposition | sibling_ids |
|---|---|---|
| TEXT | Semantic chunks | Bidirectional among same parent |
| TABLE | 1 summary + N column units (min 2) | Empty |
| IMAGE | Single unit | Empty (unless caption-linked) |
| FORMULA | Single unit | Empty |

Post-processing: caption injection (prepend to TABLE/IMAGE on same page) + sibling linking (caption TEXT ↔ IMAGE).

## Handler Pattern
1. X-Ray bootstrap (try/except, print fallback)
2. `Logger(service="multimodal-rag-{layer}")`
3. Module-level singleton wiring (never inside handler)
4. `@logger.inject_lambda_context(clear_state=True)`
5. `logger.append_keys(course_id, module_id, file_id)`
6. Latency tracking per pipeline step

## Testing
- pytest, colocated `test_*.py`, relative imports
- Mock Docker deps (fitz, pptx, docx) via `sys.modules`
- Factories: `_make_text_element()`, `_make_table_element()`, etc.
- Class-based grouping: `class TestTableDecomposition:`
- `monkeypatch.setattr(handler_module, "_service", mock)`
- Run: `cd cdk && python -m pytest multimodal_rag_v2/ -v`

## Error Handling
- Element failures: log + skip (never halt pipeline)
- Handler: graceful fallback (never raise to Lambda runtime)
- Retrieval: HTTP 503 for pgvector unavailability

## Extension Points
**New adapter:** create `ingestion/adapters/{fmt}_adapter.py` → register in handler → add tests
**New element type:** add to `ElementType` enum → `EnrichedElement` fields → `element_router` → `retrieval_unit_builder` → `production_ranker` → `TypeCaps`
