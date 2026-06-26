"""Vectorstore retriever using the multimodal-rag v2 retrieval_units table.

Replaces the old LangChain-based hybrid search (langchain_pg_embedding) with
direct queries against the v2 retrieval_units table which uses:
- pgvector cosine similarity (Titan Embed v2, 1024 dimensions)
- PostgreSQL full-text search (ts_vector column)
- Reciprocal rank fusion for merging results
- Image escalation for visual questions (Claude vision)

The retriever returns LangChain Document objects for compatibility with the
existing RAG chain in chat.py.
"""

import json
import re
import os
import time
from typing import Dict, List, Optional

import psycopg2
from langchain_core.documents import Document
from langchain_core.runnables import RunnableLambda
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_classic.chains import create_history_aware_retriever
from aws_lambda_powertools import Logger

from helpers.image_escalation import escalate_image_for_query

logger = Logger(service="text-generation")

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3
TOP_K = 8
OVERFETCH_FACTOR = 3

# Embedding model used by v2 pipeline (must match what was used during ingestion)
EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"
EMBEDDING_DIMENSIONS = 1024

# ARCH-2: Heuristic patterns for detecting ambiguous messages that need LLM reformulation
AMBIGUOUS_PATTERNS = [
    r'^(yes|no|yeah|nah|sure|okay|ok)[\.\?\!]?$',
    r'^(tell|explain|elaborate|say)\s+(me\s+)?more',
    r'^(go on|continue|keep going|what else)',
    r'^(why|how so|how come|what do you mean)[\?\.\!]?$',
    r'^(can you|could you)\s+(explain|clarify|elaborate)',
]
CONTEXT_PRONOUNS = r'\b(it|that|this|these|those|they|them|its|their)\b'


def needs_reformulation(query: str, chat_history) -> bool:
    """
    ARCH-2: Lightweight heuristic to decide if a question needs LLM reformulation.
    Returns True if the question likely references previous context.
    """
    if not chat_history:
        return False

    # Strip the "user\n" prefix added by get_student_query()
    cleaned = query.strip().lower()
    if cleaned.startswith("user"):
        cleaned = cleaned[4:].strip()

    for pattern in AMBIGUOUS_PATTERNS:
        if re.match(pattern, cleaned, re.IGNORECASE):
            return True

    word_count = len(cleaned.split())
    if word_count < 4:
        return True

    if word_count < 15 and re.search(CONTEXT_PRONOUNS, cleaned):
        return True

    return False


def hybrid_search_v2(
    query: str,
    query_embedding: List[float],
    module_id: str,
    allowed_file_ids: Optional[List[str]],
    k: int = TOP_K,
    connection=None,
) -> List[Document]:
    """Hybrid search against the v2 retrieval_units table.

    Performs vector similarity search + full-text keyword search, merges
    results using reciprocal rank fusion, and returns LangChain Document objects.

    Args:
        query: The user's search query.
        query_embedding: Pre-computed embedding vector (1024d, Titan Embed v2).
        module_id: Module ID to filter results by (stored in metadata->>'module_id').
        allowed_file_ids: Optional list of file IDs to restrict search to.
        k: Number of results to return.
        connection: Reusable psycopg2 connection.

    Returns:
        List of LangChain Document objects with page_content and metadata.
    """
    search_start = time.time()
    overfetch_k = k * OVERFETCH_FACTOR

    if connection is None:
        logger.error("No database connection provided for hybrid_search_v2")
        return []

    try:
        cur = connection.cursor()

        # Build metadata filter for module_id scoping
        where_clauses = []
        params_vector: list = []
        params_keyword: list = []

        if module_id:
            where_clauses.append("metadata->>'module_id' = %s")
            params_vector.append(module_id)
            params_keyword.append(module_id)

        if allowed_file_ids:
            placeholders = ",".join(["%s"] * len(allowed_file_ids))
            where_clauses.append(f"metadata->>'file_id' IN ({placeholders})")
            params_vector.extend(allowed_file_ids)
            params_keyword.extend(allowed_file_ids)

        where_sql = (" AND " + " AND ".join(where_clauses)) if where_clauses else ""

        # --- Vector similarity search ---
        vector_start = time.time()
        embedding_str = f"[{','.join(str(v) for v in query_embedding)}]"

        vector_sql = f"""
            SELECT retrieval_id, embedding_text, element_type, metadata,
                   1 - (embedding <=> %s::vector) AS score
            FROM retrieval_units
            WHERE embedding IS NOT NULL{where_sql}
            ORDER BY embedding <=> %s::vector
            LIMIT %s;
        """
        vector_params = [embedding_str] + params_vector + [embedding_str, overfetch_k]
        cur.execute(vector_sql, vector_params)
        vector_rows = cur.fetchall()
        vector_latency = time.time() - vector_start

        # --- Full-text keyword search ---
        keyword_start = time.time()
        keyword_sql = f"""
            SELECT retrieval_id, embedding_text, element_type, metadata,
                   ts_rank(ts_vector, plainto_tsquery('english', %s)) AS score
            FROM retrieval_units
            WHERE ts_vector @@ plainto_tsquery('english', %s){where_sql}
            ORDER BY score DESC
            LIMIT %s;
        """
        keyword_params = [query, query] + params_keyword + [overfetch_k]
        cur.execute(keyword_sql, keyword_params)
        keyword_rows = cur.fetchall()
        keyword_latency = time.time() - keyword_start

        cur.close()

        # --- Reciprocal Rank Fusion ---
        RRF_K = 60
        rrf_scores: dict[str, float] = {}
        row_data: dict[str, tuple] = {}

        for rank, row in enumerate(vector_rows, start=1):
            rid = row[0]
            rrf_scores[rid] = rrf_scores.get(rid, 0.0) + 1.0 / (RRF_K + rank)
            row_data[rid] = row

        for rank, row in enumerate(keyword_rows, start=1):
            rid = row[0]
            rrf_scores[rid] = rrf_scores.get(rid, 0.0) + 1.0 / (RRF_K + rank)
            if rid not in row_data:
                row_data[rid] = row

        # Sort by RRF score descending, take top k
        sorted_results = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
        top_results = sorted_results[:k]

        # Convert to LangChain Documents
        documents: List[Document] = []
        for rid, rrf_score in top_results:
            row = row_data[rid]
            embedding_text = row[1]
            element_type = row[2]
            metadata = row[3] if isinstance(row[3], dict) else (json.loads(row[3]) if row[3] else {})

            # Build document metadata for downstream use
            doc_metadata = {
                "retrieval_id": rid,
                "element_type": element_type,
                "rrf_score": round(rrf_score, 5),
                "file_id": metadata.get("file_id", ""),
                "module_id": metadata.get("module_id", ""),
                "page_num": metadata.get("provenance_page_num"),
                "image_s3_key": metadata.get("image_s3_key"),
            }

            documents.append(Document(
                page_content=embedding_text,
                metadata=doc_metadata,
            ))

        total_latency = time.time() - search_start

        logger.info(
            "V2 hybrid search complete",
            extra={
                "vector_results": len(vector_rows),
                "keyword_results": len(keyword_rows),
                "rrf_candidates": len(rrf_scores),
                "returned_results": len(documents),
                "vector_latency_ms": round(vector_latency * 1000, 2),
                "keyword_latency_ms": round(keyword_latency * 1000, 2),
                "total_search_latency_ms": round(total_latency * 1000, 2),
                "module_id": module_id,
                "allowed_file_ids_count": len(allowed_file_ids) if allowed_file_ids else 0,
                "top_rrf_score": round(top_results[0][1], 5) if top_results else 0,
            },
        )

        return documents

    except Exception:
        logger.exception(
            "Error in hybrid_search_v2",
            extra={
                "module_id": module_id,
                "allowed_file_ids_count": len(allowed_file_ids) if allowed_file_ids else 0,
            },
        )
        if connection:
            connection.rollback()
        raise


def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    allowed_file_ids: Optional[List[str]] = None,
    collection_names: Optional[List[str]] = None,
    connection=None,
    image_results_collector: Optional[List] = None,
):
    """Build a retriever that searches the v2 retrieval_units table.

    Returns a RunnableLambda compatible with LangChain's RAG chain.
    The collection_names parameter is repurposed as module_id for v2 filtering.

    Args:
        llm: LangChain LLM for query reformulation.
        vectorstore_config_dict: DB connection config (unused for connection if connection param given).
        embeddings: LangChain embeddings model for generating query embeddings.
        allowed_file_ids: Optional file ID filter.
        collection_names: Module IDs — the first entry is used as the module_id filter.
        connection: Reusable psycopg2 connection.
        image_results_collector: Optional mutable list that will be populated with
            all retrieval Documents during search. Used by figure_selection module
            to separate image/text results and run deterministic figure selection
            in parallel with LLM generation.
    """
    # The primary module_id is the first collection name
    module_id = collection_names[0] if collection_names else ""

    def retrieve(query: str) -> List[Document]:
        embed_start = time.time()
        query_embedding = embeddings.embed_query(query)
        embed_latency = time.time() - embed_start

        logger.info(
            "Query embedding generated for v2 search",
            extra={"embed_latency_ms": round(embed_latency * 1000, 2)},
        )

        documents = hybrid_search_v2(
            query=query,
            query_embedding=query_embedding,
            module_id=module_id,
            allowed_file_ids=allowed_file_ids,
            connection=connection,
        )

        # Collect image results for figure selection (side-channel)
        if image_results_collector is not None:
            image_results_collector.clear()
            for doc in documents:
                # Collect all documents — handler separates image/text for figure selection
                image_results_collector.append(doc)

        # Image escalation: if query references a figure, fetch and analyze the image
        try:
            escalation_doc = escalate_image_for_query(
                query=query,
                module_id=module_id,
                connection=connection,
            )
            if escalation_doc is not None:
                # Prepend the vision analysis so it appears first in context
                documents = [escalation_doc] + documents
        except Exception:
            logger.exception("Image escalation failed, continuing with text results only")

        return documents

    retriever = RunnableLambda(retrieve)

    # Build the LLM-based reformulation chain (used only when heuristic triggers)
    contextualize_q_system_prompt = (
        "Given a chat history and the latest user question "
        "which might reference context in the chat history, "
        "formulate a standalone question which can be understood "
        "without the chat history. Do NOT answer the question, "
        "just reformulate it if needed and otherwise return it as is."
    )
    contextualize_q_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", contextualize_q_system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    history_aware_retriever = create_history_aware_retriever(llm, retriever, contextualize_q_prompt)

    # ARCH-2: Conditional wrapper that skips LLM reformulation for standalone questions
    always_reformulate = os.environ.get("ALWAYS_REFORMULATE", "").lower() == "true"

    def conditional_retriever(input_dict):
        query = input_dict.get("input", "")
        chat_history = input_dict.get("chat_history", [])

        if always_reformulate or needs_reformulation(query, chat_history):
            logger.info(
                "Using LLM reformulation for query",
                extra={"reason": "always_reformulate" if always_reformulate else "heuristic_match"},
            )
            return history_aware_retriever.invoke(input_dict)
        else:
            logger.info("Skipping LLM reformulation — query appears standalone")
            return retriever.invoke(query)

    return RunnableLambda(conditional_retriever)
