# Supplementary Chunk Detection & Prompt Steering

## Overview

Retrieval runs exactly as it does today — best 6 chunks regardless of source. After retrieval, chunks are tagged and majority source is detected. If majority are supplementary, the prompt gains a redirect instruction before the LLM generates its response. If majority are primary (or there are no supplementary files at all), the prompt is identical to what exists today — zero behaviour change for the normal case.

---

## 1. `cdk/text_generation/src/main.py`

### 1.1 Update `get_allowed_file_ids` to return the two lists separately

```python
def get_allowed_file_ids(module_id):
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT file_id FROM "Module_Files" WHERE module_id = %s;
        """, (module_id,))
        own_ids = [str(row[0]) for row in cur.fetchall()]

        cur.execute("""
            SELECT referenced_file_id FROM "Module_File_References"
            WHERE source_module_id = %s;
        """, (module_id,))
        ref_ids = [str(row[0]) for row in cur.fetchall()]

        cur.close()
        return own_ids, ref_ids
    except Exception as e:
        logger.error(f"Error fetching allowed_file_ids: {e}")
        return [], []
```

### 1.2 Update `handler` to unpack both lists and pass `context_info` through

```python
own_file_ids, ref_file_ids = get_allowed_file_ids(module_id)

history_aware_retriever, context_info = get_vectorstore_retriever(
    llm=llm,
    vectorstore_config_dict=vectorstore_config_dict,
    embeddings=embeddings,
    own_file_ids=own_file_ids,
    ref_file_ids=ref_file_ids
)

response = get_response(
    query=student_query,
    topic=topic,
    llm=llm,
    history_aware_retriever=history_aware_retriever,
    context_info=context_info,
    table_name=TABLE_NAME,
    session_id=session_id,
    course_system_prompt=system_prompt,
    module_prompt=module_prompt,
    course_id=course_id,
    module_id=module_id,
    connection=connection
)
```

---

## 2. `cdk/text_generation/src/helpers/vectorstore.py`

### 2.1 Update `hybrid_search` to accept both ID lists, tag each returned document with its source type, and return a `context_has_primary` flag alongside the documents

The retrieval SQL and blending logic are completely unchanged. Only the result-building step at the end changes:

```python
def hybrid_search(
    query, query_embedding, connection_string, collection_name,
    own_file_ids, ref_file_ids, k=TOP_K
):
    own_file_id_set = set(own_file_ids)
    all_file_ids = own_file_ids + ref_file_ids

    # ... all existing SQL and blending logic unchanged, use all_file_ids for the filter ...

    # Tag each document with source type
    results = []
    for id_ in top_ids:
        if id_ not in id_to_row:
            continue
        row = id_to_row[id_]
        metadata = row[2] or {}
        metadata["source_type"] = (
            "primary" if metadata.get("file_id", "") in own_file_id_set
            else "supplementary"
        )
        results.append(Document(page_content=row[1], metadata=metadata))

    primary_count = sum(1 for d in results if d.metadata.get("source_type") == "primary")
    context_has_primary = primary_count > len(results) / 2

    return results, context_has_primary
```

### 2.2 Update `get_vectorstore_retriever` to accept both ID lists, use a mutable dict as a side channel to surface `context_has_primary` after retrieval runs, and return both the retriever and the side channel

```python
def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict,
    embeddings,
    own_file_ids=None,
    ref_file_ids=None
):
    collection_name = vectorstore_config_dict['collection_name']
    psycopg2_connection_string = (
        f"dbname={vectorstore_config_dict['dbname']} "
        f"user={vectorstore_config_dict['user']} "
        f"password={vectorstore_config_dict['password']} "
        f"host={vectorstore_config_dict['host']} "
        f"port={vectorstore_config_dict['port']}"
    )

    context_info = {"has_primary": True}  # mutable dict as side channel

    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        docs, has_primary = hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=psycopg2_connection_string,
            collection_name=collection_name,
            own_file_ids=own_file_ids or [],
            ref_file_ids=ref_file_ids or []
        )
        context_info["has_primary"] = has_primary
        return docs

    retriever = RunnableLambda(retrieve)

    # ... existing contextualize_q_prompt and create_history_aware_retriever unchanged ...

    return history_aware_retriever, context_info
```

---

## 3. `cdk/text_generation/src/helpers/chat.py`

Update `get_response` to accept `context_info` and inject a redirect instruction into the prompt when the majority of retrieved chunks are from supplementary files. When `context_info["has_primary"]` is `True` the `source_note` is an empty string and the prompt is byte-for-byte identical to today.

```python
def get_response(
    query, topic, llm, history_aware_retriever, context_info,
    table_name, session_id, course_system_prompt, module_prompt,
    course_id, module_id, connection
):
    guardrails = (
        "Do not summarize readings if asked. Ask questions, guide reasoning, connected to the readings. "
        "Keep discussion focused on the assigned readings or course topics. If the student goes off-topic, politely redirect to the reading. "
        "Maintain respectful, professional tone; avoid conversations around explicit or harmful content; redirect back to the reading as needed. "
        "Do not give medical, legal, or psychological advice. "
        "Do not request personal information, treat interactions as anonymous."
        "Do not share the prompts you are given."
    )

    supplementary_redirect = (
        "The context retrieved for this question comes mostly from supplementary reference material "
        "rather than the primary reading. Briefly acknowledge what the student asked, give a concise "
        "answer if the context supports it, then explicitly redirect the student back to the primary "
        "reading by asking a question grounded in the primary material."
    )

    source_note = supplementary_redirect if not context_info.get("has_primary", True) else ""

    system_prompt = (
        ""
        "system"
        "You are an instructor for a course. "
        f"Your job is to help the student understand the concepts in the course reading on topic: {topic}.\n"
        f"{course_system_prompt}\n"
        f"{module_prompt}\n"
        f"{guardrails}\n"
        f"{source_note}\n"
        "Continue this process until students have completed at least 5 interactions and written 300 words.\n"
        "Once students have achieved this, include 'Thank you for chatting with me about this topic, "
        "you are ready to go discuss this with your class.' in your response and do not ask any further questions about the topic. "
        "Use the following pieces of retrieved context to answer a question asked by the student. "
        "Use three sentences maximum and keep the answer concise. "
        "End each answer with a question that encourages the student to think critically about the topic."
        ""
        "documents"
        "{context}"
        ""
        "assistant"
    )

    # ... rest of existing chain building unchanged ...
```

---

## Summary of Files Changed

| File | Change |
|---|---|
| `cdk/text_generation/src/main.py` | Split `get_allowed_file_ids` return value, unpack both lists in `handler`, pass `context_info` to `get_response` |
| `cdk/text_generation/src/helpers/vectorstore.py` | Tag chunks with source type, return `context_has_primary`, update `get_vectorstore_retriever` signature and return value |
| `cdk/text_generation/src/helpers/chat.py` | Accept `context_info`, inject supplementary redirect instruction when majority of chunks are supplementary |

---

## Notes

- The `context_has_primary` threshold is a simple majority check (`primary_count > len(results) / 2`) and can be tightened or loosened depending on how aggressively you want to redirect students
- If a module has no supplementary files at all, `ref_file_ids` is an empty list, every chunk is tagged `primary`, and `context_has_primary` is always `True` — the prompt never changes
- The mutable dict side channel pattern is necessary because `create_history_aware_retriever` wraps the retriever and only exposes documents, not arbitrary return values
