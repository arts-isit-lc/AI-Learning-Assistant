import logging
import re
import os
from typing import Dict, List, Optional

import psycopg2
from langchain_core.documents import Document
from langchain_core.runnables import RunnableLambda
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_classic.chains import create_history_aware_retriever

logger = logging.getLogger(__name__)

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3
TOP_K = 6

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


def hybrid_search(
    query: str,
    query_embedding: List[float],
    connection_string: str,
    collection_name: str,
    allowed_file_ids: Optional[List[str]],
    k: int = TOP_K,
    connection=None,
) -> List[Document]:
    # P-6: Reuse passed connection if available, otherwise create a new one
    owns_connection = connection is None
    conn = connection if connection else psycopg2.connect(connection_string)

    try:
        cur = conn.cursor()

        file_id_filter = ""
        params_base = [collection_name]

        if allowed_file_ids:
            placeholders = ",".join(["%s"] * len(allowed_file_ids))
            file_id_filter = f"AND e.cmetadata->>'file_id' IN ({placeholders})"
            params_base += allowed_file_ids

        vector_sql = f"""
            SELECT
                e.id,
                e.document,
                e.cmetadata,
                1 - (e.embedding <=> %s::vector) AS vector_score
            FROM langchain_pg_embedding e
            JOIN langchain_pg_collection c ON e.collection_id = c.uuid
            WHERE c.name = %s
            {file_id_filter}
            ORDER BY vector_score DESC
            LIMIT 20;
        """
        cur.execute(vector_sql, [query_embedding] + params_base)
        vector_rows = cur.fetchall()

        keyword_sql = f"""
            SELECT
                e.id,
                ts_rank_cd(
                    to_tsvector('english', e.document),
                    plainto_tsquery('english', %s)
                ) AS keyword_score
            FROM langchain_pg_embedding e
            JOIN langchain_pg_collection c ON e.collection_id = c.uuid
            WHERE c.name = %s
            AND to_tsvector('english', e.document) @@ plainto_tsquery('english', %s)
            {file_id_filter}
            ORDER BY keyword_score DESC
            LIMIT 20;
        """
        cur.execute(keyword_sql, [query, collection_name, query] + (allowed_file_ids or []))
        keyword_rows = cur.fetchall()

        cur.close()

        # Blending logic (pure Python, no DB)
        vector_scores = {row[0]: row for row in vector_rows}
        keyword_scores = {row[0]: row[1] for row in keyword_rows}

        max_kw = max(keyword_scores.values(), default=1) or 1
        keyword_scores_norm = {id_: score / max_kw for id_, score in keyword_scores.items()}

        max_vec = max((row[3] for row in vector_rows), default=1) or 1

        all_ids = set(vector_scores.keys()) | set(keyword_scores_norm.keys())
        blended = []
        for id_ in all_ids:
            v_score = (vector_scores[id_][3] / max_vec) if id_ in vector_scores else 0.0
            k_score = keyword_scores_norm.get(id_, 0.0)
            blended.append((id_, VECTOR_WEIGHT * v_score + KEYWORD_WEIGHT * k_score))

        blended.sort(key=lambda x: x[1], reverse=True)
        top_ids = [id_ for id_, _ in blended[:k]]

        # Fetch missing document content (keyword-only hits not in vector results)
        id_to_row = {row[0]: row for row in vector_rows}
        missing_ids = [id_ for id_ in top_ids if id_ not in id_to_row]
        if missing_ids:
            cur2 = conn.cursor()
            placeholders = ",".join(["%s"] * len(missing_ids))
            cur2.execute(
                f"SELECT id, document, cmetadata FROM langchain_pg_embedding WHERE id IN ({placeholders});",
                missing_ids
            )
            for row in cur2.fetchall():
                id_to_row[row[0]] = (row[0], row[1], row[2], 0.0)
            cur2.close()

        return [
            Document(page_content=id_to_row[id_][1], metadata=id_to_row[id_][2] or {})
            for id_ in top_ids if id_ in id_to_row
        ]

    except Exception as e:
        logger.error(f"Error in hybrid_search: {e}")
        if not owns_connection:
            conn.rollback()
        raise
    finally:
        if owns_connection and conn:
            conn.close()


def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    allowed_file_ids: Optional[List[str]] = None,
    connection=None,
):
    # P-6: Removed unused get_vectorstore() call — hybrid_search uses raw SQL directly

    collection_name = vectorstore_config_dict['collection_name']
    psycopg2_connection_string = (
        f"dbname={vectorstore_config_dict['dbname']} "
        f"user={vectorstore_config_dict['user']} "
        f"password={vectorstore_config_dict['password']} "
        f"host={vectorstore_config_dict['host']} "
        f"port={vectorstore_config_dict['port']} "
        f"sslmode=require"
    )

    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        return hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=psycopg2_connection_string,
            collection_name=collection_name,
            allowed_file_ids=allowed_file_ids,
            connection=connection,
        )

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
            logger.info("ARCH-2: Using LLM reformulation for query")
            return history_aware_retriever.invoke(input_dict)
        else:
            logger.info("ARCH-2: Skipping LLM reformulation — query appears standalone")
            return retriever.invoke(query)

    return RunnableLambda(conditional_retriever)
