# Module-Based RAG System Specification

## Overview

This document defines a scalable Retrieval-Augmented Generation (RAG) system that supports:

- File-level embeddings
- Cross-module file referencing
- High-quality retrieval using modern RAG techniques

---

# Architecture Summary

- Single vector index (no per-file collections)
- Metadata filtering using `file_id`
- Optional file-level embeddings for fast ranking
- Multi-stage retrieval pipeline

---

# Database Schema

## Modules

```sql
modules
-------
id
name
course_id
created_at
```

## Files

```sql
files
-------
id
module_id
file_name
file_type
file_size
uploaded_at
```

## Module File References

```sql
module_file_references
----------------------
module_id
referenced_file_id
```

## Document Chunks (Vector Table)

```sql
document_chunks
---------------
id
file_id
module_id
chunk_index
chunk_text
embedding
token_count
```

## File Embeddings (Optional but Recommended)

```sql
file_embeddings
---------------
file_id
summary_text
embedding
```

---

# Upload Pipeline

## Steps

1. Store file metadata in `files`
2. Extract text from file
3. Chunk text (~500 tokens per chunk)
4. Generate embeddings for each chunk
5. Insert into `document_chunks`
6. (Optional) Generate file summary embedding and store in `file_embeddings`

---

# Retrieval Pipeline

## Step 1: Query Rewriting

Generate improved queries from user input.

Example:

User: "When is it due?"

Rewritten queries:
- "When is assignment 1 due?"
- "assignment 1 deadline"

---

## Step 2: Resolve Allowed Files

```sql
SELECT id FROM files WHERE module_id = :module_id
UNION
SELECT referenced_file_id FROM module_file_references WHERE module_id = :module_id
```

Result:

```
allowed_file_ids = [...]
```

---

## Step 3: File Ranking (Optional but Recommended)

```sql
SELECT file_id
FROM file_embeddings
WHERE file_id IN (allowed_file_ids)
ORDER BY cosine_similarity(embedding, :query_embedding)
LIMIT 3
```

---

## Step 4: Chunk Retrieval

```sql
SELECT *
FROM document_chunks
WHERE file_id IN (:selected_file_ids)
ORDER BY cosine_similarity(embedding, :query_embedding)
LIMIT 20
```

---

## Step 5: Hybrid Search

Combine:

- Vector similarity
- Keyword search (BM25)

Score:

```
final_score = 0.7 * vector + 0.3 * keyword
```

---

## Step 6: Reranking

Use cross-encoder or LLM reranker.

Input: top 20 chunks

Output: top 4 chunks

---

## Step 7: Context Assembly

```
Context:
[chunk1]
[chunk2]
[chunk3]
[chunk4]

Question:
[user query]
```

---

## Step 8: Answer Generation

Rules:

- Only answer using provided context
- If answer is not found, respond with "I don't know"

---

## Step 9: Citations

Attach source file names to responses.

---

## Step 10: Answer Verification (Optional)

Run validation prompt:

"Is this answer supported by the context?"

Reject if unsupported.

---

# Full Pipeline Flow

```
User Query
 → Query Rewriting
 → Resolve Files
 → File Ranking
 → Chunk Retrieval
 → Hybrid Search
 → Reranking
 → Context Assembly
 → Answer Generation
 → Citation + Verification
```

---

# Key Design Decisions

## Single Index vs Collections

Use a single index with metadata filtering instead of per-file collections.

## Why

- Faster queries
- Easier scaling
- Simpler architecture

---

# Optional Enhancements

## Document-Level Embeddings

- Improves file selection

## Hybrid Search

- Improves keyword matching

## Multi-Query Retrieval

- Improves recall

---

# Expected Implementation Output

The system should include:

- Database schema
- File upload pipeline
- Embedding generation
- Retrieval service
- Reranking logic
- LLM integration

---

# Notes for Implementation

- Use batching for embedding generation
- Cache frequent queries if needed
- Limit token usage when building context
- Monitor latency of vector search

---

# End of Specification

