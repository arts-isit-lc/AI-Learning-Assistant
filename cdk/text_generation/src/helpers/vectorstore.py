from typing import Dict, List, Optional

import psycopg2
from langchain_core.documents import Document
from langchain_core.runnables import RunnableLambda
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_classic.chains import create_history_aware_retriever

from helpers.helper import get_vectorstore

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3
TOP_K = 6


def hybrid_search(
    query: str,
    query_embedding: List[float],
    connection_string: str,
    collection_name: str,
    allowed_file_ids: Optional[List[str]],
    k: int = TOP_K
) -> List[Document]:
    conn = psycopg2.connect(connection_string)
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
    conn.close()

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

    id_to_row = {row[0]: row for row in vector_rows}
    missing_ids = [id_ for id_ in top_ids if id_ not in id_to_row]
    if missing_ids:
        conn2 = psycopg2.connect(connection_string)
        cur2 = conn2.cursor()
        placeholders = ",".join(["%s"] * len(missing_ids))
        cur2.execute(
            f"SELECT id, document, cmetadata FROM langchain_pg_embedding WHERE id IN ({placeholders});",
            missing_ids
        )
        for row in cur2.fetchall():
            id_to_row[row[0]] = (row[0], row[1], row[2], 0.0)
        cur2.close()
        conn2.close()

    return [
        Document(page_content=id_to_row[id_][1], metadata=id_to_row[id_][2] or {})
        for id_ in top_ids if id_ in id_to_row
    ]


def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    allowed_file_ids: Optional[List[str]] = None
):
    vectorstore, _ = get_vectorstore(
        collection_name=vectorstore_config_dict['collection_name'],
        embeddings=embeddings,
        dbname=vectorstore_config_dict['dbname'],
        user=vectorstore_config_dict['user'],
        password=vectorstore_config_dict['password'],
        host=vectorstore_config_dict['host'],
        port=int(vectorstore_config_dict['port'])
    )

    collection_name = vectorstore_config_dict['collection_name']
    psycopg2_connection_string = (
        f"dbname={vectorstore_config_dict['dbname']} "
        f"user={vectorstore_config_dict['user']} "
        f"password={vectorstore_config_dict['password']} "
        f"host={vectorstore_config_dict['host']} "
        f"port={vectorstore_config_dict['port']}"
    )

    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        return hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=psycopg2_connection_string,
            collection_name=collection_name,
            allowed_file_ids=allowed_file_ids
        )

    retriever = RunnableLambda(retrieve)

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
    return create_history_aware_retriever(llm, retriever, contextualize_q_prompt)
