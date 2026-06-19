# Implementation Plan: 4-Layer Multimodal RAG Architecture (V2)

## Overview

Implement the 4-layer multimodal RAG system (Ingestion → Enrichment → Retrieval → Reasoning) with strict layer boundaries, the RetrievalUnit abstraction, cross-encoder reranking, version tracking, content-hash caching, and document-level retrieval. Implementation uses Python 3.11 targeting AWS Lambda (Docker containers) with pgvector/RDS, S3, DynamoDB, and Bedrock.

## Tasks

- [x] 1. Set up project structure, data models, and core interfaces
  - [x] 1.1 Create directory structure and base modules
    - Create `cdk/multimodal_rag_v2/` package with sub-packages: `ingestion/`, `enrichment/`, `retrieval/`, `reasoning/`, `models/`, `cache/`, `persistence/`
    - Add `__init__.py` files for all packages
    - Add `requirements.txt` with dependencies: PyMuPDF, python-pptx, python-docx, beautifulsoup4, pylatexenc, rank-bm25, boto3, aws-lambda-powertools, psycopg2, langchain
    - _Requirements: All_

  - [x] 1.2 Implement data models and enums
    - Create `models/data_models.py` with all dataclasses: `ElementType`, `FileMetadata`, `Provenance`, `RawElement`, `IRElement`, `DocumentIR`, `EnrichedElement`, `RetrievalUnit`, `MergedResult`, `RankedResult`, `StructuredContext`, `ContextCluster`, `ReasoningResult`, `ImageAnalysis`, `DocumentSummary`, `DocumentMetadata`, `QueryIntent`, `TypeCaps`
    - Implement `ElementType` enum with TEXT, IMAGE, TABLE, FORMULA values
    - Add version constants: `IR_VERSION`, `ENRICHMENT_VERSION`, `EMBEDDING_VERSION`
    - _Requirements: 11.1, 11.2, 11.3_

  - [x] 1.3 Define abstract base classes and interfaces
    - Create `ingestion/base_adapter.py` with `BaseAdapter` ABC (`extract` method)
    - Create `ingestion/adapter_registry.py` with `AdapterRegistry` class (`register`, `get_adapter`)
    - Create `ingestion/ir_builder.py` stub with `IRBuilder` class signature
    - Create `persistence/ir_persistence.py` stub with `IRPersistence` class signature
    - Create `enrichment/element_router.py` stub with `ElementRouter` class signature
    - Create `enrichment/retrieval_unit_builder.py` stub with `RetrievalUnitBuilder` class signature
    - Create `retrieval/hybrid_search_engine.py` stub with `HybridSearchEngine` class signature
    - Create `retrieval/cross_encoder_reranker.py` stub with `CrossEncoderReranker` class signature
    - Create `retrieval/production_ranker.py` stub with `ProductionRanker` class signature
    - Create `retrieval/query_analyzer.py` stub with `QueryAnalyzer` class signature
    - Create `reasoning/context_builder.py` stub with `ContextBuilder` class signature
    - Create `reasoning/reasoning_engine.py` stub with `ReasoningEngine` class signature
    - _Requirements: 1.1, 3.1, 7.1, 8.1, 9.1_

- [x] 2. Implement Layer 1: Ingestion
  - [x] 2.1 Implement AdapterRegistry and file routing
    - Implement `AdapterRegistry.register()` to map extensions to adapters
    - Implement `AdapterRegistry.get_adapter()` with extension extraction from file key
    - Raise `UnsupportedFormatError` for unsupported/missing extensions
    - Enforce 200 MB file size limit before extraction begins
    - _Requirements: 1.1, 1.3, 1.8_

  - [x] 2.2 Implement PDF adapter
    - Create `ingestion/adapters/pdf_adapter.py` using PyMuPDF
    - Extract text blocks, images, tables, and formulas from all pages
    - Preserve provenance (page_num, position_index) for each element
    - Handle per-page failures: log and continue with remaining pages
    - Filter images smaller than 100x100 pixels
    - _Requirements: 1.2, 1.4, 1.5, 1.7_

  - [x] 2.3 Implement PPTX, DOCX, and HTML adapters
    - Create `ingestion/adapters/pptx_adapter.py` using python-pptx (extract text, images, tables per slide)
    - Create `ingestion/adapters/docx_adapter.py` using python-docx (extract text, images, tables per section)
    - Create `ingestion/adapters/html_adapter.py` using beautifulsoup4 (extract text, images, tables)
    - Preserve provenance (slide_num/section/position_index) for each format
    - Handle per-page/section failures gracefully
    - _Requirements: 1.2, 1.4, 1.5_

  - [x] 2.4 Implement Image, LaTeX, CSV, and JSON adapters
    - Create `ingestion/adapters/image_adapter.py` for PNG, JPEG, GIF, TIFF, BMP, WebP (single IMAGE element per file)
    - Create `ingestion/adapters/latex_adapter.py` using pylatexenc (extract text blocks and formula elements)
    - Create `ingestion/adapters/csv_adapter.py` (extract as single TABLE element)
    - Create `ingestion/adapters/json_adapter.py` (extract as TEXT or TABLE elements based on structure)
    - _Requirements: 1.2_

  - [x] 2.5 Implement IRBuilder with deduplication and ordering
    - Implement `IRBuilder.build()`: assign element_id = SHA256(content + provenance)
    - Implement content_hash = SHA256(content) for deduplication
    - Deduplicate elements by content_hash (first occurrence wins)
    - Sort elements by provenance order (page_num, position_index)
    - Set element_count dict by ElementType
    - Handle zero-element documents (empty elements list, element_count=0)
    - Fail on complete extraction failure (adapter throws unrecoverable error)
    - _Requirements: 1.6, 1.7, 1.9, 1.10_

  - [ ]* 2.6 Write property tests for Layer 1
    - **Property 1: Layer 1 Isolation (No AI Calls)** — Mock all AI clients, assert zero invocations after ingestion
    - **Property 2: Adapter Dispatch Correctness** — Supported extensions route correctly, unsupported raise UnsupportedFormatError
    - **Property 3: IR Deduplication and Completeness** — Unique content_hash per element, count equals unique hashes minus small images, sorted by provenance
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.7, 12.6**

  - [ ]* 2.7 Write unit tests for adapters and IRBuilder
    - Test PDF adapter: multi-page extraction, per-page failure handling, small image filtering
    - Test PPTX/DOCX/HTML adapters: format-specific extraction and provenance
    - Test IRBuilder: deduplication, ordering, zero-element doc, file size rejection
    - Test AdapterRegistry: extension routing, unsupported extension error
    - _Requirements: 1.1-1.10_

- [x] 3. Implement IR Persistence
  - [x] 3.1 Implement IRPersistence with S3 storage
    - Implement `IRPersistence.persist()`: store DocumentIR as JSON at `s3://ir-bucket/{course}/{module}/{file}/ir_v{version}/document_ir.json`
    - Base64-encode binary content (images) for JSON serialization
    - Implement `IRPersistence.load()`: retrieve and deserialize DocumentIR from S3
    - Handle missing/corrupted documents: return error with path and identifiers
    - Configure private bucket with IAM-scoped access and SSE-S3 encryption
    - Support version coexistence: different ir_versions stored at different paths without overwriting
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ]* 3.2 Write property tests for IR Persistence
    - **Property 4: IR Persistence Round-Trip** — Persist then load produces field-equivalent DocumentIR
    - **Property 26: IR Version Path Isolation** — Different ir_versions stored at distinct paths without overwriting
    - **Validates: Requirements 2.1, 2.2, 2.3, 11.5**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Layer 2: Enrichment Services
  - [x] 5.1 Implement ElementRouter and enrichment dispatch
    - Implement `ElementRouter.enrich_document()`: route each IRElement to correct service by element_type
    - TEXT → TextChunker, IMAGE → VisionService, FORMULA → FormulaService, TABLE → TableService
    - Implement fallback logic: on enrichment failure, produce fallback EnrichedElement with embedding_text = raw content (or empty string for binary)
    - Implement exponential backoff for Bedrock throttling (initial 1s, 2x multiplier, max 3 retries)
    - Enforce visual cap of 30 vision LLM calls per document
    - Tag every EnrichedElement with current enrichment_version
    - _Requirements: 3.1, 3.6, 3.7, 3.8, 3.9_

  - [x] 5.2 Implement TextChunker (no LLM)
    - Create `enrichment/text_chunker.py`
    - Implement semantic chunking without LLM calls
    - Ensure topics, labels, keywords lists are always empty for TEXT elements
    - Produce EnrichedElement(s) with embedding_text from chunked content
    - _Requirements: 3.2, 13.2, 13.3_

  - [x] 5.3 Implement VisionService, FormulaService, and TableService
    - Create `enrichment/vision_service.py`: invoke Claude 3 Haiku vision for image_type, image_description, topics (1-10), labels (1-5), keywords (1-10)
    - Create `enrichment/formula_service.py`: parse text-layer LaTeX directly (no LLM); use vision fallback for raster-only formulas
    - Create `enrichment/table_service.py`: extract table_headers, table_rows, generate table_summary (1-3 sentences)
    - _Requirements: 3.3, 3.4, 3.5_

  - [x] 5.4 Implement RetrievalUnitBuilder
    - Implement `RetrievalUnitBuilder.build()` dispatching by element_type
    - TABLE: produce 1 summary unit + N column-level units (minimum 2 total)
    - TEXT: produce semantic chunks with sibling_ids referencing all other chunks from same parent; single-chunk produces empty sibling_ids
    - IMAGE: produce single unit with empty sibling_ids
    - FORMULA: produce single unit
    - Validate: every unit has non-empty embedding_text (discard if empty/whitespace only)
    - Validate: all sibling_ids reference units with same parent_element_id
    - Assign parent_element_id from source IRElement
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 5.5 Implement DocumentSummary generation
    - Create `enrichment/document_summary.py`
    - Generate DocumentSummary with topics (3-10), overview (2-3 sentences), learning_objectives (1-5)
    - Extract DocumentMetadata: title, lecture_number (from filename patterns like "Lecture_7.pdf"), week (from filename/module)
    - Create DocumentSummary RetrievalUnit with metadata: is_document_summary=true, title, lecture_number, week
    - Set lecture_number/week to null when extraction fails
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 5.6 Write property tests for Layer 2
    - **Property 5: Enrichment Fault Isolation** — Failed element gets fallback, others unaffected
    - **Property 6: Visual Cap Enforcement** — At most 30 vision LLM calls per document
    - **Property 7: Text Elements Never Receive Topics** — TEXT enrichment has empty topics/labels/keywords
    - **Property 8: RetrievalUnit Structural Validity** — Valid parent_element_id, non-empty embedding_text, valid sibling_ids
    - **Property 9: Table Decomposition** — TABLE produces summary + column units (>1 total)
    - **Property 10: Text Chunk Sibling References** — Multi-chunk TEXT has bidirectional sibling_ids
    - **Validates: Requirements 3.2, 3.6, 3.8, 4.1-4.8**

- [x] 6. Implement Caching Layer
  - [x] 6.1 Implement EmbeddingCache (DynamoDB-backed)
    - Create `cache/embedding_cache.py`
    - Implement `get(content_hash, embedding_version)`: lookup by composite key, return cached embedding or None
    - Implement `put(content_hash, embedding, embedding_version)`: store embedding with composite key
    - Enforce version isolation: queries with version V only return entries stored under V
    - Handle cache unavailability gracefully: log and proceed as cache miss
    - Handle store failures: log warning and continue without retry
    - _Requirements: 6.1, 6.2, 6.3, 6.8, 6.9_

  - [x] 6.2 Implement EnrichmentCache (DynamoDB-backed)
    - Create `cache/enrichment_cache.py`
    - TEXT/FORMULA: key = (content_hash, enrichment_version) — context_hash excluded
    - IMAGE/TABLE: key = (content_hash, context_hash, enrichment_version) where context_hash = SHA256(course_topic + module_name)
    - Enforce version isolation: queries with version V only return entries stored under V
    - Handle cache unavailability gracefully: log and proceed as cache miss
    - Handle store failures: log warning and continue without retry
    - _Requirements: 6.4, 6.5, 6.6, 6.8, 6.9_

  - [x] 6.3 Implement EmbeddingGenerator with cache integration
    - Create `enrichment/embedding_generator.py`
    - Check EmbeddingCache before invoking embedding service
    - Store generated embeddings in cache after computation
    - Include embedding_version as metadata field when storing in pgvector
    - _Requirements: 6.1, 6.2, 6.7_

  - [ ]* 6.4 Write property tests for caching
    - **Property 11: Cache Version Isolation** — Entries stored under V_old not returned when queried with V_new
    - **Property 12: Context-Aware Enrichment Caching** — TEXT/FORMULA context-independent cache-hit; IMAGE/TABLE context-dependent
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.6**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement Layer 3: Retrieval
  - [x] 8.1 Implement QueryAnalyzer (two-tier classification)
    - Create `retrieval/query_analyzer.py`
    - Implement rule-based classification: case-insensitive substring matching against predefined keyword sets
    - Rule sets: requires_image (figure, diagram, graph, chart, image, picture, map, visual), requires_formula (equation, formula, derive, solve, calculate, prove), requires_table (data, table, compare, statistics, values), needs_summary (covered, lecture, overview, topics, about), requires_escalation (show me, look at, in the figure, this diagram)
    - Return immediately when rules fire (zero LLM cost)
    - Implement Haiku fallback for ambiguous queries (no rules fire)
    - Implement lecture number extraction via regex patterns
    - _Requirements: 7.1, 7.2, 7.3, 7.7, 7.8_

  - [x] 8.2 Implement HybridSearchEngine (vector + BM25)
    - Create `retrieval/hybrid_search_engine.py`
    - Execute vector search and BM25 search in parallel with 3x overfetch factor
    - Filter vector search to only matching embedding_version
    - Implement reciprocal rank fusion for merging results
    - Handle metadata filtering (is_document_summary, lecture_number) for summary queries
    - Handle cases: both return results, only one returns results (skip RRF), both return zero (empty result)
    - Apply metadata filter fallback: if filtered query returns zero results, retry without filter
    - _Requirements: 8.1, 8.2, 8.7, 8.9, 8.10, 5.4, 5.5_

  - [x] 8.3 Implement CrossEncoderReranker
    - Create `retrieval/cross_encoder_reranker.py`
    - Rerank merged results using cross-encoder model
    - Return top 30 results sorted descending by cross_encoder_score
    - Clamp scores to [0, 1] range
    - Handle cross-encoder unavailability: skip reranking, substitute RRF score as cross_encoder_score
    - _Requirements: 8.3, 8.4_

  - [x] 8.4 Implement ProductionRanker and TypeCaps filtering
    - Create `retrieval/production_ranker.py`
    - Compute final_score = cross_encoder_score + metadata_boost (metadata_boost in [0, 0.1])
    - Ensure final_score is never negative
    - Apply TypeCaps filtering: default text=8, image=4, formula=3, table=2
    - Adjust caps based on QueryIntent (image→6, formula→5, table→4)
    - Ensure deterministic ordering (no randomness)
    - _Requirements: 8.5, 8.6, 8.8, 7.4, 7.5, 7.6_

  - [ ]* 8.5 Write property tests for Layer 3
    - **Property 13: Rule-Based Query Classification** — Keywords from rule sets trigger corresponding flags at zero LLM cost
    - **Property 14: Intent-Driven Type Cap Adjustment** — requires_image→6, requires_formula→5, requires_table→4
    - **Property 15: Type Cap Enforcement** — Result count per type ≤ cap
    - **Property 16: Cross-Encoder Output Constraints** — At most top_k results, sorted desc, scores in [0,1]
    - **Property 17: Score Composition and Non-Negativity** — final_score = cross_encoder + metadata_boost, never negative
    - **Property 18: Ranking Determinism** — Same inputs produce same outputs
    - **Property 19: Version-Filtered Retrieval** — Only matching embedding_version vectors searched
    - **Property 28: Metadata-Filtered Retrieval for Lecture Queries** — needs_summary + lecture_number → metadata filter applied
    - **Property 29: Hybrid Search Overfetch** — 3x overfetch before RRF
    - **Validates: Requirements 7.1-7.8, 8.1-8.10, 5.4, 5.5**

- [x] 9. Implement Layer 4: Reasoning
  - [x] 9.1 Implement ContextBuilder (sibling expansion, clustering, token budget)
    - Create `reasoning/context_builder.py`
    - Implement `expand_siblings()`: expand ±2 siblings from same parent, stop when added tokens > 500
    - Skip expansion for results with empty sibling_ids
    - Implement `build_clusters()`: group by same page AND same parent (deterministic — use ordered operations, no hash-based/concurrent algorithms)
    - Implement `allocate_token_budget()`: rank clusters descending by highest element score, include until budget (128,000 tokens) exceeded, exclude lowest-scored
    - Implement `format_for_prompt()`: assemble final context string with source grouping
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 9.2 Implement ImageEscalation
    - Create `reasoning/image_escalation.py`
    - Filter results to those with non-null image_s3_key, select top 2 by score
    - Fetch images from S3 and invoke vision LLM analysis
    - Produce ImageAnalysis (image_s3_key, analysis text, confidence score) per image
    - Handle S3 fetch failures and vision LLM failures: skip failed images, never raise unhandled exceptions
    - Set escalation_used=false when no images available or all fetches fail
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 9.3 Implement ReasoningEngine
    - Create `reasoning/reasoning_engine.py`
    - Orchestrate full reasoning flow: query analysis → context building → escalation → answer generation
    - Inject escalation results into context after sibling expansion, before final prompt formatting
    - Handle LLM failure: return graceful fallback response
    - Return ReasoningResult with answer, sources, escalation_used, image_analyses
    - _Requirements: 10.3, 10.5, 12.4_

  - [ ]* 9.4 Write property tests for Layer 4
    - **Property 20: Token Budget Compliance** — total_tokens ≤ 128,000; lowest-scored clusters trimmed first
    - **Property 21: Sibling Expansion Guardrails** — Max ±2 siblings, stop at 500 added tokens
    - **Property 22: Deterministic Clustering** — Same page + same parent → same cluster; deterministic output
    - **Property 23: Image Escalation Trigger Correctness** — requires_escalation + images → escalate max 2; no images → skip
    - **Property 24: Reasoning Layer Fault Tolerance** — Never raises unhandled exception
    - **Validates: Requirements 9.1-9.7, 10.1-10.5, 12.3, 12.4**

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Version tracking and backward compatibility
  - [x] 11.1 Implement version tracking across all layers
    - Ensure DocumentIR always has non-empty ir_version (set from build-time constant)
    - Ensure every EnrichedElement has non-empty enrichment_version
    - Ensure every RetrievalUnit has non-empty embedding_version in pgvector metadata
    - Ensure single processing run applies same enrichment_version and embedding_version to all artifacts from one document
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 11.2 Implement backward compatibility for text-only documents
    - Ensure text-only documents never call VisionService, FormulaService, or TableService
    - Ensure text-only processing does not attach topics/labels/keywords to RetrievalUnits
    - Ensure no LLM service invoked during text enrichment (only version-tracking metadata added)
    - _Requirements: 13.1, 13.2, 13.3_

  - [ ]* 11.3 Write property tests for version tracking and backward compat
    - **Property 25: Version Metadata Completeness** — ir_version, enrichment_version, embedding_version all non-empty
    - **Property 27: Backward Compatibility for Text-Only Documents** — No vision/formula services called, equivalent retrieval quality
    - **Validates: Requirements 11.1-11.4, 13.1-13.3**

- [x] 12. Integration wiring and Lambda handler
  - [x] 12.1 Implement ingestion Lambda handler
    - Create `ingestion/handler.py`: S3 ObjectCreated event → parse → persist DocumentIR
    - Wire AdapterRegistry with all adapters registered by extension
    - Integrate with IR Persistence for S3 storage
    - Add structured logging with aws-lambda-powertools
    - Add X-Ray tracing segments per layer boundary
    - _Requirements: 1.1, 2.1_

  - [x] 12.2 Implement enrichment Lambda handler
    - Create `enrichment/handler.py`: triggered after IR persistence → load DocumentIR → enrich → store RetrievalUnits
    - Wire ElementRouter, RetrievalUnitBuilder, EmbeddingGenerator, DocumentSummary
    - Integrate caches (EmbeddingCache, EnrichmentCache)
    - Store RetrievalUnits in pgvector with all metadata
    - Add structured logging and X-Ray tracing
    - _Requirements: 3.1, 4.1, 5.1, 6.1_

  - [x] 12.3 Implement retrieval + reasoning Lambda handler
    - Create `retrieval/handler.py`: query → QueryAnalyzer → HybridSearch → CrossEncoder → ProductionRanker → TypeCaps → ContextBuilder → ReasoningEngine → answer
    - Wire all Layer 3 + Layer 4 components together
    - Handle error scenarios: pgvector unavailable (503), BM25 unavailable (vector-only fallback), LLM failure (graceful fallback)
    - Add structured logging (query_id, latencies, cost_estimate) and X-Ray tracing
    - _Requirements: 7.1, 8.1, 9.1, 10.1, 12.1, 12.2, 12.4, 12.5_

  - [ ]* 12.4 Write integration tests
    - Test end-to-end: PDF → IR → enrich → RetrievalUnits → pgvector
    - Test re-enrichment from persisted IR (without re-parsing)
    - Test cross-encoder rerank path
    - Test parent-child expansion at retrieval
    - Test escalation via QueryIntent path
    - Test cache hit path (identical content re-ingested)
    - Test DocumentSummary retrieval for lecture queries
    - Test backward compatibility for text-only documents
    - _Requirements: All_

- [x] 13. CDK infrastructure for multimodal RAG v2
  - [x] 13.1 Add CDK resources for multimodal RAG v2 Lambdas
    - Add Docker-based Lambda functions for ingestion, enrichment, and retrieval+reasoning layers
    - Configure S3 bucket for IR persistence (private, SSE-S3, RETAIN removal policy)
    - Add DynamoDB tables for EmbeddingCache and EnrichmentCache
    - Configure S3 event notification to trigger ingestion Lambda
    - Add SQS queue between ingestion and enrichment (decoupling)
    - _Requirements: 2.5, 6.1_

  - [x] 13.2 Configure IAM roles for multimodal RAG v2 Lambdas
    - Create dedicated IAM role per layer Lambda (least-privilege, per IAM Security Policy)
    - Ingestion role: S3 read (course materials), S3 write (IR bucket), CloudWatch Logs
    - Enrichment role: S3 read (IR bucket), Bedrock InvokeModel (specific model ARNs), DynamoDB (cache tables), pgvector (RDS Proxy), CloudWatch Logs
    - Retrieval+Reasoning role: pgvector (RDS Proxy), Bedrock InvokeModel, S3 read (images for escalation), CloudWatch Logs
    - Scope all permissions to specific resource ARNs per IAM Security Policy
    - _Requirements: 2.5, 12.1-12.6_

  - [ ]* 13.3 Write CDK assertion tests for multimodal RAG v2 infrastructure
    - Test Lambda configurations (runtime, tracing, log retention, function names)
    - Test IAM roles have correct permissions (no wildcards, scoped ARNs)
    - Test S3 bucket configuration (encryption, removal policy)
    - Test DynamoDB table configuration for caches
    - _Requirements: All infrastructure requirements_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses Python 3.11 explicitly — all implementation uses Python
- CDK infrastructure follows existing project conventions (dedicated roles, scoped IAM, Docker Lambdas)
- All IAM permissions follow the IAM Security Policy steering rules (no wildcards, specific ARNs)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3", "2.4", "3.1"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "3.2"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3"] },
    { "id": 5, "tasks": ["5.4", "5.5", "6.1", "6.2"] },
    { "id": 6, "tasks": ["5.6", "6.3", "6.4"] },
    { "id": 7, "tasks": ["8.1", "8.2"] },
    { "id": 8, "tasks": ["8.3", "8.4"] },
    { "id": 9, "tasks": ["8.5", "9.1", "9.2"] },
    { "id": 10, "tasks": ["9.3", "9.4"] },
    { "id": 11, "tasks": ["11.1", "11.2"] },
    { "id": 12, "tasks": ["11.3", "12.1", "12.2"] },
    { "id": 13, "tasks": ["12.3", "13.1"] },
    { "id": 14, "tasks": ["12.4", "13.2"] },
    { "id": 15, "tasks": ["13.3"] }
  ]
}
```
