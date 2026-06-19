# Requirements Document

## Introduction

This document defines the requirements for the 4-Layer Multimodal RAG Architecture (V2) for the AI Learning Assistant. The system processes course materials (PDF, PPTX, DOCX, HTML, Image, LaTeX, CSV, JSON) through four isolated layers — Ingestion, Enrichment, Retrieval, and Reasoning — to provide students with accurate, multimodal answers grounded in course content. V2 introduces strict layer boundaries, the RetrievalUnit abstraction, cross-encoder reranking, version tracking, content-hash caching, and document-level retrieval.

## Glossary

- **Ingestion_Layer**: Layer 1 — parses raw files into a format-independent intermediate representation (DocumentIR) without any AI/LLM calls
- **Enrichment_Layer**: Layer 2 — applies multimodal intelligence to IR elements, producing EnrichedElements and RetrievalUnits stored in pgvector
- **Retrieval_Layer**: Layer 3 — performs hybrid search (vector + BM25), cross-encoder reranking, and type-capped filtering to find relevant content
- **Reasoning_Layer**: Layer 4 — assembles context from retrieved results and generates answers using LLM with optional image escalation
- **DocumentIR**: The intermediate representation of a parsed document containing IRElements with provenance, content hashes, and version metadata
- **IRElement**: A single element within a DocumentIR (text block, image, table, or formula) with a unique element_id derived from content + provenance
- **EnrichedElement**: An IRElement after enrichment processing, containing embedding_text, topics, labels, and type-specific metadata
- **RetrievalUnit**: A searchable unit stored in pgvector; one IRElement can produce multiple RetrievalUnits (e.g., table → summary unit + column units)
- **AdapterRegistry**: Dispatches files to format-specific parsers based on file extension
- **IRBuilder**: Normalizes raw adapter output into DocumentIR with deduplication and ordering
- **IR_Persistence**: S3 storage of DocumentIR enabling re-enrichment without re-parsing
- **QueryAnalyzer**: Two-tier query classifier — rule-based first (free, 70-80% hit rate), Haiku LLM fallback for ambiguous queries
- **QueryIntent**: The structured output of QueryAnalyzer containing intent flags (needs_summary, requires_image, requires_formula, requires_table, requires_escalation)
- **CrossEncoder_Reranker**: Re-scores merged search results using a cross-encoder model for higher precision ranking
- **ContextBuilder**: Orchestrates context assembly — groups by source, expands siblings, builds clusters, manages token budgets
- **ImageEscalation**: Fetches images from S3 and calls vision LLM for detailed analysis when QueryIntent.requires_escalation is true
- **EmbeddingCache**: DynamoDB-backed cache mapping content_hash + embedding_version → embedding vector
- **EnrichmentCache**: DynamoDB-backed cache mapping (content_hash, context_hash, enrichment_version) → EnrichedElement
- **DocumentSummary**: Document-level summary RetrievalUnit for answering "What's in Lecture X?" queries
- **DocumentMetadata**: Structured metadata (title, lecture_number, week) stored on DocumentSummary units for exact-match filtering
- **TypeCaps**: Per-type limits on results returned (default: text=8, image=4, formula=3, table=2)
- **HybridSearch_Engine**: Combines vector similarity search and BM25 keyword search via reciprocal rank fusion

## Requirements

### Requirement 1: Document Ingestion

**User Story:** As an instructor, I want course materials in various formats to be automatically parsed into a structured intermediate representation, so that the system can process any supported file type without manual intervention.

#### Acceptance Criteria

1. WHEN a file is uploaded to the S3 course materials bucket, THE Ingestion_Layer SHALL detect the file extension and route it to the appropriate adapter via the AdapterRegistry
2. WHEN a supported file (PDF, PPTX, DOCX, HTML, PNG, JPEG, GIF, TIFF, BMP, WebP, LaTeX, CSV, JSON) is processed, THE Ingestion_Layer SHALL extract all content elements (text blocks, images, tables, and formulas) without making any AI or LLM service calls
3. IF the AdapterRegistry receives a file with an unsupported or missing extension, THEN THE Ingestion_Layer SHALL return an UnsupportedFormatError indicating the unrecognized extension and reject the file with HTTP status 400
4. WHEN a file contains multiple pages or slides, THE Ingestion_Layer SHALL extract elements from all pages and preserve provenance information (page number, slide number, section, position index)
5. IF a specific page or section within a file raises a parsing exception during adapter extraction, THEN THE Ingestion_Layer SHALL log the failure with the page identifier and exception type, mark that page as failed in the DocumentIR metadata, and continue processing all remaining pages without affecting their output
6. WHEN the IRBuilder processes raw elements, THE Ingestion_Layer SHALL assign unique element_ids (SHA256 of content + provenance), deduplicate by content_hash, and sort elements by provenance order
7. THE Ingestion_Layer SHALL produce exactly one IRElement per unique content element after deduplication — no content SHALL be silently dropped except images smaller than 100x100 pixels
8. IF an uploaded file exceeds 200 MB in size, THEN THE Ingestion_Layer SHALL reject the file before any content extraction begins, returning an error indicating the maximum allowed file size has been exceeded
9. WHEN a file with zero extractable content elements is processed (excluding dropped sub-100x100 images), THE Ingestion_Layer SHALL produce a DocumentIR with an empty elements list and element_count of zero rather than raising an error
10. IF content extraction fails completely (the adapter throws an unrecoverable error for the entire file, not just a single page), THEN THE Ingestion_Layer SHALL fail the ingestion process and return an error indicating extraction failure rather than producing an empty DocumentIR

### Requirement 2: IR Persistence

**User Story:** As a system operator, I want the intermediate representation to be persisted to S3 separately from enrichment, so that documents can be re-enriched without re-parsing when enrichment logic changes.

#### Acceptance Criteria

1. WHEN a DocumentIR is produced by the Ingestion_Layer, THE IR_Persistence SHALL store it as a JSON object at path `s3://ir-bucket/{course}/{module}/{file}/ir_v{version}/document_ir.json`, where `{version}` corresponds to the DocumentIR's `ir_version` field.
2. WHEN a DocumentIR is persisted with a different `ir_version` than an existing stored IR for the same document, THE IR_Persistence SHALL store it at a distinct path (differing in the `ir_v{version}` segment) without overwriting or deleting the prior version's object.
3. WHEN the Enrichment_Layer requests a document by course_id, module_id, and file_id, THE IR_Persistence SHALL load the DocumentIR from S3 and return a DocumentIR that is field-equivalent to the original: all IRElements preserve their element_id, element_type, content (binary content base64-encoded for JSON round-trip), content_hash, provenance, and metadata values — the IR_Persistence SHALL NOT raise unhandled exceptions during successful load operations
4. IF the Enrichment_Layer requests a DocumentIR that does not exist at the expected S3 path (deleted, never persisted, or corrupted), THEN THE IR_Persistence SHALL return an error indication immediately specifying the missing path and document identifiers, without attempting alternative locations and without raising an unhandled exception.
5. THE IR_Persistence SHALL use a private S3 bucket with IAM-scoped access and encryption at rest (SSE-S3).

### Requirement 3: Element Enrichment

**User Story:** As a student, I want all types of course content (text, images, formulas, tables) to be intelligently enriched with searchable descriptions, so that I can find relevant content regardless of its original format.

#### Acceptance Criteria

1. WHEN the Enrichment_Layer receives a DocumentIR, THE ElementRouter SHALL route each IRElement to the correct enrichment service based on element_type (TEXT → TextChunker, IMAGE → VisionService, FORMULA → FormulaService, TABLE → TableService)
2. WHEN a TEXT element is processed, THE TextChunker SHALL produce semantic chunks without calling any LLM service and SHALL NOT assign topics, labels, or keywords to text elements — the resulting EnrichedElement SHALL have empty topics, labels, and keywords lists
3. WHEN an IMAGE element is processed, THE VisionService SHALL produce a structured description including image_type, image_description, topics (1-10 items), labels (1-5 items), and keywords (1-10 items) using Claude 3 Haiku vision
4. WHEN a FORMULA element with text-layer LaTeX is processed, THE FormulaService SHALL parse it directly without LLM calls and produce formula_text, latex_repr, and formula_concepts; WHEN a FORMULA element is raster-only (content is bytes), THE FormulaService SHALL use vision fallback to extract the same fields
5. WHEN a TABLE element is processed, THE TableService SHALL extract table_headers (list of column names), table_rows (list of row data), and generate a table_summary (1-3 sentences describing the table content)
6. IF an enrichment service fails for a specific element (exception raised), THEN THE Enrichment_Layer SHALL produce a fallback EnrichedElement with embedding_text set to the raw content string (or empty string for binary content) and continue processing remaining elements without interruption
7. IF Bedrock returns a throttling error (HTTP 429 or ThrottlingException) during enrichment, THEN THE Enrichment_Layer SHALL retry with exponential backoff (initial delay 1s, multiplier 2x) up to 3 times before producing a fallback element
8. WHILE processing a document, THE Enrichment_Layer SHALL enforce a visual cap of 30 vision LLM calls per document — once the cap is reached, remaining image and raster formula elements SHALL receive fallback enrichment without LLM invocation
9. WHEN an EnrichedElement is produced (whether from enrichment service or fallback), THE Enrichment_Layer SHALL tag it with the current enrichment_version identifier (e.g., "haiku-v3-2026-06")

### Requirement 4: RetrievalUnit Construction

**User Story:** As a student, I want each enriched element to be decomposed into optimal searchable units, so that retrieval can match at the right granularity for each content type.

#### Acceptance Criteria

1. WHEN the RetrievalUnitBuilder processes an EnrichedElement, THE Enrichment_Layer SHALL produce one or more RetrievalUnits, each with a parent_element_id that matches the element_id of the source IRElement from which the EnrichedElement was derived
2. WHEN a TABLE EnrichedElement is processed, THE RetrievalUnitBuilder SHALL produce exactly one summary RetrievalUnit containing the table_summary as embedding_text, plus at least one column-level RetrievalUnit per table header — resulting in a minimum of 2 total RetrievalUnits
3. WHEN a TEXT EnrichedElement is processed and produces more than one RetrievalUnit, THE RetrievalUnitBuilder SHALL assign sibling_ids to each unit referencing all other units from the same parent element, forming a bidirectional sibling relationship
4. WHEN an IMAGE EnrichedElement is processed, THE RetrievalUnitBuilder SHALL produce a single RetrievalUnit containing the image description as embedding_text with an empty sibling_ids list
5. THE Enrichment_Layer SHALL ensure every RetrievalUnit has embedding_text containing at least 1 non-whitespace character before storing it in pgvector
6. THE Enrichment_Layer SHALL ensure all sibling_ids within a RetrievalUnit reference other RetrievalUnits that share the same parent_element_id
7. IF an EnrichedElement has embedding_text that is empty or contains only whitespace, THEN THE RetrievalUnitBuilder SHALL discard that element and produce zero RetrievalUnits for it without halting processing of other elements
8. WHEN a TEXT EnrichedElement is processed and produces exactly one RetrievalUnit, THE RetrievalUnitBuilder SHALL assign an empty sibling_ids list to that unit

### Requirement 5: Document-Level Summary

**User Story:** As a student, I want to ask "What's in Lecture X?" and get an accurate overview, so that I can quickly understand what a specific lecture covers.

#### Acceptance Criteria

1. WHEN the Enrichment_Layer completes element-level processing of a document, THE Enrichment_Layer SHALL generate one DocumentSummary containing topics (3-10 items), a 2-3 sentence overview, and learning objectives (1-5 items)
2. WHEN a DocumentSummary is generated, THE Enrichment_Layer SHALL create a RetrievalUnit with metadata including is_document_summary=true, title, lecture_number (extracted from filename patterns like "Lecture_7.pdf" or document headers), and week (extracted from filename or module structure)
3. IF lecture_number or week cannot be extracted from the document filename or headers, THEN THE Enrichment_Layer SHALL set the corresponding metadata field to null — the DocumentSummary RetrievalUnit SHALL still be created but will not be retrievable via metadata filtering on that field
4. WHEN a query contains lecture reference patterns (e.g., "lecture 7", "lec 3", "Lecture 12"), THE Retrieval_Layer SHALL apply metadata filtering on lecture_number for exact-match retrieval
5. IF a metadata-filtered query returns zero results, THEN THE Retrieval_Layer SHALL immediately fall back to standard hybrid search without metadata filtering, without notifying the user

### Requirement 6: Embedding and Caching

**User Story:** As a system operator, I want embeddings and enrichment results to be cached by content hash, so that re-ingesting identical content avoids redundant computation and cost.

#### Acceptance Criteria

1. WHEN generating an embedding for a RetrievalUnit, THE Enrichment_Layer SHALL first query the EmbeddingCache using (content_hash, embedding_version) as the composite key — if a matching entry exists, the cached embedding SHALL be returned without invoking the embedding service
2. WHEN an embedding is generated by the embedding service (cache miss), THE Enrichment_Layer SHALL store it in the EmbeddingCache keyed by (content_hash, embedding_version)
3. WHEN the EmbeddingCache is queried with embedding_version V, THE EmbeddingCache SHALL return only entries stored under version V and SHALL NOT return entries stored under any other version, regardless of content_hash match
4. WHEN enriching a TEXT or FORMULA element, THE EnrichmentCache SHALL use (content_hash, enrichment_version) as the composite lookup key — context_hash SHALL NOT be included, so identical content enriched in different courses SHALL cache-hit when enrichment_version matches
5. WHEN enriching an IMAGE or TABLE element, THE EnrichmentCache SHALL use (content_hash, context_hash, enrichment_version) as the composite lookup key, where context_hash = SHA256(course_topic + module_name) — so the same image in a different course or module context SHALL NOT cache-hit
6. WHEN the EnrichmentCache is queried with enrichment_version V, THE EnrichmentCache SHALL return only entries stored under version V and SHALL NOT return entries stored under any other version
7. WHEN a RetrievalUnit is stored in pgvector, THE Enrichment_Layer SHALL include the embedding_version as a metadata field on the stored record to enable version-filtered retrieval at query time
8. IF the EmbeddingCache or EnrichmentCache is unavailable or returns an error during lookup, THEN THE Enrichment_Layer SHALL proceed as if a cache miss occurred — invoking the embedding or enrichment service directly — and SHALL log the cache failure without interrupting document processing
9. IF the EmbeddingCache or EnrichmentCache is unavailable or returns an error during a store operation, THEN THE Enrichment_Layer SHALL continue processing without retrying the cache write, and SHALL log the store failure as a warning

### Requirement 7: Query Analysis

**User Story:** As a student, I want my queries to be understood in terms of what content types are needed, so that the system retrieves the most relevant mix of text, images, formulas, and tables.

#### Acceptance Criteria

1. WHEN a query is received, THE QueryAnalyzer SHALL first attempt rule-based classification using case-insensitive keyword matching against predefined rule sets (requires_image: ["figure", "diagram", "graph", "chart", "image", "picture", "map", "visual"], requires_formula: ["equation", "formula", "derive", "solve", "calculate", "prove"], requires_table: ["data", "table", "compare", "statistics", "values"], needs_summary: ["covered", "lecture", "overview", "topics", "about"], requires_escalation: ["show me", "look at", "in the figure", "this diagram"]) — a rule fires when any keyword from its set appears as a substring in the lowercased query
2. WHEN rule-based classification matches one or more rules, THE QueryAnalyzer SHALL return a QueryIntent with the corresponding flags set to true immediately without invoking any LLM service
3. WHEN no rules fire for a query, THE QueryAnalyzer SHALL fall back to Claude 3 Haiku for classification and return a QueryIntent with the same structure and flag semantics as the rule-based path
4. WHEN QueryIntent.requires_image is true, THE Retrieval_Layer SHALL increase max_image type cap from 4 to 6
5. WHEN QueryIntent.requires_formula is true, THE Retrieval_Layer SHALL increase max_formula type cap from 3 to 5
6. WHEN QueryIntent.requires_table is true, THE Retrieval_Layer SHALL increase max_table type cap from 2 to 4
7. WHEN QueryIntent.needs_summary is true and a lecture number is detected in the query via regex patterns (e.g., "lecture 7", "lec 3", "Lecture 12"), THE Retrieval_Layer SHALL apply metadata filtering to retrieve only DocumentSummary units matching that lecture_number
8. WHEN QueryIntent.needs_summary is true but no lecture number can be extracted from the query, THE Retrieval_Layer SHALL perform standard hybrid search without metadata filtering, using the adjusted TypeCaps

### Requirement 8: Hybrid Search and Reranking

**User Story:** As a student, I want search to combine semantic understanding with keyword matching and precision reranking, so that I get the most relevant results regardless of how I phrase my question.

#### Acceptance Criteria

1. WHEN a search is performed, THE HybridSearch_Engine SHALL execute both vector similarity search and BM25 keyword search in parallel with an overfetch factor of 3x the requested result count (default requested count: 15, yielding overfetch of 45 per search method)
2. WHEN vector and keyword results are available, THE HybridSearch_Engine SHALL merge them using reciprocal rank fusion
3. WHEN merged results are produced, THE CrossEncoder_Reranker SHALL rescore all merged results and return the top 30 sorted descending by cross_encoder_score — IF the cross-encoder produces a score outside the range [0, 1], THEN THE CrossEncoder_Reranker SHALL clamp it to the nearest valid boundary (0 or 1)
4. IF the cross-encoder service is unavailable, THEN THE Retrieval_Layer SHALL skip reranking, substitute the RRF score as cross_encoder_score for downstream processing, and continue the pipeline through ProductionRanker scoring and TypeCaps filtering as normal
5. WHEN cross-encoder reranking is complete, THE ProductionRanker SHALL compute final_score as cross_encoder_score + metadata_boost, where metadata_boost is in the range [0, 0.1] and the final_score SHALL never be negative
6. WHEN ranked results are produced, THE Retrieval_Layer SHALL apply TypeCaps filtering to enforce per-type diversity limits (default: text=8, image=4, formula=3, table=2)
7. THE HybridSearch_Engine SHALL only compare query embeddings against vectors with matching embedding_version — vectors with mismatched versions SHALL be excluded from results
8. WHEN identical inputs (same query, same collection, same allowed_file_ids) are provided against unchanged underlying data, THE Retrieval_Layer SHALL produce identical output ordering with no randomness
9. IF both vector search and BM25 search return zero results, THEN THE Retrieval_Layer SHALL return an empty result list without invoking the cross-encoder or ProductionRanker
10. IF only one search method (vector or BM25) returns results while the other returns zero results, THEN THE Retrieval_Layer SHALL continue processing with the available results from the successful method (RRF skipped when only one source is available)

### Requirement 9: Context Assembly

**User Story:** As a student, I want retrieved results to be assembled into coherent context with related content grouped together, so that the LLM can generate well-structured answers with proper references.

#### Acceptance Criteria

1. WHEN ranked results are provided to the ContextBuilder, THE Reasoning_Layer SHALL expand each result by retrieving up to 2 siblings in each direction (max_sibling_distance=2) from the same parent element, preserving provenance ordering of the expanded siblings
2. WHILE expanding siblings for a single result, THE ContextBuilder SHALL stop expansion for that result when total added tokens from its siblings exceed 500 tokens (max_expansion_tokens=500), even if fewer than 2 siblings per direction have been added
3. IF a result has an empty sibling_ids list, THEN THE ContextBuilder SHALL include that result in the expanded set without modification and proceed to the next result
4. WHEN expanded results are available, THE ContextBuilder SHALL cluster elements that share the same page AND same parent element, producing identical clusters for identical inputs (deterministic) — THE ContextBuilder SHALL use ordered operations and SHALL NOT use hash-based or concurrent processing algorithms that could introduce non-determinism
5. WHEN clusters are formed, THE ContextBuilder SHALL allocate the token budget (max 128,000 tokens) by ranking clusters in descending order of their highest element score (cross_encoder_score + metadata_boost), including clusters until the budget would be exceeded, and excluding remaining lowest-scored clusters entirely
6. IF the total tokens of all clusters exceed the max_tokens budget (default 128,000), THEN THE ContextBuilder SHALL remove the lowest-scored clusters first until total tokens fit within the budget
7. THE ContextBuilder SHALL ensure total tokens in the assembled context never exceed the configured max_tokens budget (default 128,000 tokens)

### Requirement 10: Image Escalation

**User Story:** As a student, I want to ask questions about specific figures and diagrams and get detailed visual analysis, so that I can understand complex visual content in my course materials.

#### Acceptance Criteria

1. WHEN QueryIntent.requires_escalation is true AND retrieved results contain elements with image_s3_key values, THE Reasoning_Layer SHALL filter results to only those with non-null image_s3_key values, select the top 2 from the filtered set by descending RankedResult score, fetch them from S3, and invoke vision LLM analysis — producing one ImageAnalysis (containing image_s3_key, analysis text, and confidence score) per fetched image
2. IF QueryIntent.requires_escalation is true but no retrieved results have image_s3_key values, THEN THE Reasoning_Layer SHALL skip image escalation and proceed with text-only reasoning, setting escalation_used to false in the ReasoningResult
3. WHEN image escalation produces analyses, THE ContextBuilder SHALL append escalation results (formatted as image analysis sections) into the assembled context after source grouping and sibling expansion but before final prompt formatting
4. IF S3 fetch or vision LLM invocation fails during escalation (network error, timeout, or error response), THEN THE Reasoning_Layer SHALL skip the failed image, produce an answer using only text-based context and any successfully analyzed images, and set escalation_used to false in the ReasoningResult — the system SHALL never raise an unhandled exception to the caller
5. WHEN image escalation completes successfully, THE Reasoning_Layer SHALL set escalation_used to true and include all ImageAnalysis results in the image_analyses field of the ReasoningResult

### Requirement 11: Version Tracking

**User Story:** As a system operator, I want all processed artifacts to carry version metadata, so that I can identify stale data and trigger selective re-processing when models or schemas change.

#### Acceptance Criteria

1. THE Ingestion_Layer SHALL tag every DocumentIR with a non-empty ir_version string field set to the IR schema version constant defined at build time
2. THE Enrichment_Layer SHALL tag every EnrichedElement with a non-empty enrichment_version string identifying the enrichment model and its version (e.g., "haiku-v3-2026-06")
3. THE Enrichment_Layer SHALL tag every RetrievalUnit with a non-empty embedding_version string identifying the embedding model and dimensionality (e.g., "titan-v2-1024")
4. WHEN a document is enriched in a single processing run, THE Enrichment_Layer SHALL apply the same enrichment_version to all EnrichedElements and the same embedding_version to all RetrievalUnits produced from that document
5. WHEN the ir_version changes, THE IR_Persistence SHALL store the new DocumentIR at a path containing the new version segment (`ir_v{version}`) without overwriting or deleting DocumentIR stored under prior version paths — both old and new versions SHALL remain accessible
6. WHEN the embedding_version changes, THE Retrieval_Layer SHALL include an embedding_version filter on every query so that only vectors matching the current embedding_version are compared — vectors stored under prior versions SHALL remain in pgvector but SHALL NOT appear in query results

### Requirement 12: Error Handling and Resilience

**User Story:** As a system operator, I want each layer to handle failures gracefully without cascading errors, so that partial failures in one component do not bring down the entire pipeline.

#### Acceptance Criteria

1. IF pgvector is unavailable during retrieval (connection timeout or error), THEN THE Retrieval_Layer SHALL return HTTP 503 to the caller
2. IF BM25 search is unavailable but pgvector is available, THEN THE Retrieval_Layer SHALL proceed with vector-only search results through the remaining pipeline (RRF skipped, cross-encoder applied to vector-only results, then ProductionRanker scoring and TypeCaps filtering as normal)
3. IF the context assembled by the Reasoning_Layer exceeds the token budget (128,000 tokens), THEN THE ContextBuilder SHALL trim the lowest-scored clusters first until total tokens fit within the budget
4. IF an LLM failure occurs in the Reasoning_Layer during answer generation, THEN THE Reasoning_Layer SHALL return a graceful fallback response indicating the service is temporarily unavailable — the system SHALL NOT raise unhandled exceptions when returning fallback responses
5. IF an S3 failure occurs while fetching images for escalation, THEN THE Reasoning_Layer SHALL skip escalation and produce an answer using only text-based context
6. THE Ingestion_Layer SHALL never make AI/LLM service calls — any element requiring AI processing SHALL be deferred to the Enrichment_Layer

### Requirement 13: Backward Compatibility

**User Story:** As a system operator, I want text-only documents to produce identical retrieval behavior to V1, so that the V2 migration does not regress existing functionality.

#### Acceptance Criteria

1. WHEN a text-only document (containing only elements with element_type=TEXT after parsing) is processed through the V2 pipeline, THE system SHALL produce RetrievalUnits with equivalent retrieval quality to V1 for the same document — the same queries SHALL return the same set of matching RetrievalUnits in equivalent rank order, though implementation differences (tokenization, embedding models) are acceptable as long as retrieval quality is equivalent (exact byte-level match is not required)
2. THE system SHALL process documents containing only text elements to completion without requiring vision or formula enrichment services to be reachable — the text processing path SHALL NOT call VisionService, FormulaService, or TableService even when those services are available (hard prohibition, not tolerance of unavailability)
3. WHEN a text-only document is processed through the V2 pipeline, THE system SHALL not attach topics, labels, or keywords to any resulting RetrievalUnit, and SHALL not invoke any LLM service during enrichment — the only additions compared to V1 storage SHALL be version-tracking metadata fields (ir_version, enrichment_version, embedding_version) which do not affect retrieval ranking
