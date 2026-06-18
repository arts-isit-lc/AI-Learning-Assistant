"""
Topic Aggregation Module

Consolidates per-file topics from all Module_Files in a module into
module-level topics using Claude 3 Haiku via Amazon Bedrock.

Functionally equivalent to cdk/lambda/lib/generateTopics.js.
"""

import json
from datetime import datetime, timezone

import psycopg2
from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")

# NOTE: Hard-coded to Haiku for cost/speed. Make configurable via env var in future.
# Must stay in sync with topic_extraction.py.
TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

_CONSOLIDATION_PROMPT = """\
You are analyzing the combined topics from all course materials in a single module.
Multiple documents have been analyzed individually and their topics extracted.

Here are all the topics found across {file_count} documents:
{topics_list}

Here are all the learning objectives found:
{objectives_list}

Consolidate these into:
- "topics": The overarching main topics (maximum 7). Remove duplicates and merge \
overlapping topics. Only keep topics that represent core subject matter.
- "learning_objectives": The key learning objectives (maximum 7). Merge similar \
objectives and keep only the most important.

Do not set a minimum. If only 1-2 core topics exist, return only those.
Return valid JSON only, no markdown formatting:
{{"topics": [...], "learning_objectives": [...]}}"""


def all_files_have_topics(module_id: str, connection) -> bool:
    """
    Return True iff every Module_Files row for this module has a non-null,
    non-empty topic_extraction.topics array with at least one element.

    Uses a single JSONB-path query to avoid deserialising metadata in Python.

    Args:
        module_id: UUID of the module to check.
        connection: Active psycopg2 connection (main thread's connection).

    Returns:
        True if all files are complete with topics; False otherwise.
    """
    try:
        with connection.cursor() as cur:
            # A file is "ready" when:
            #   processing_status = 'complete'  AND
            #   metadata->'topic_extraction'->'topics' is a non-empty JSON array
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (
                        WHERE processing_status = 'complete'
                        AND jsonb_array_length(
                            metadata->'topic_extraction'->'topics'
                        ) > 0
                    ) AS ready
                FROM "Module_Files"
                WHERE module_id = %s
                """,
                (module_id,),
            )
            row = cur.fetchone()
            if not row or row[0] == 0:
                return False
            total, ready = row
            return total == ready
    except Exception as e:
        logger.warning(
            "Module completion check failed",
            extra={"module_id": module_id, "error": str(e)},
        )
        return False


def _call_haiku_for_consolidation(
    all_topics: list,
    all_objectives: list,
    file_count: int,
    bedrock_client,
) -> dict:
    """
    Call Claude 3 Haiku to consolidate per-file topics into module-level topics.
    Retries up to 3 times on JSONDecodeError, ValueError, or KeyError.

    Args:
        all_topics: Flat list of topic strings collected from all module files.
        all_objectives: Flat list of learning objective strings from all module files.
        file_count: Number of source files (used in the prompt).
        bedrock_client: Boto3 Bedrock Runtime client.

    Returns:
        Dict with `topics` (list, max 7) and `learning_objectives` (list, max 7).

    Raises:
        RuntimeError: After 3 consecutive failed attempts.
    """
    topics_list = "\n".join(f"- {t}" for t in all_topics)
    objectives_list = "\n".join(f"- {o}" for o in all_objectives)
    prompt = _CONSOLIDATION_PROMPT.format(
        file_count=file_count,
        topics_list=topics_list,
        objectives_list=objectives_list,
    )

    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    })

    last_exc = None
    for attempt in range(3):
        try:
            response = bedrock_client.invoke_model(
                modelId=TOPIC_EXTRACTION_MODEL_ID,
                body=request_body,
            )
            result = json.loads(response["body"].read())
            content = result["content"][0]["text"].strip()

            # Strip markdown fences (same logic as call_haiku_for_topics)
            if content.startswith("```"):
                content = content.split("\n", 1)[1] if "\n" in content else content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            parsed = json.loads(content)

            if "topics" not in parsed or not isinstance(parsed["topics"], list):
                raise ValueError("Missing or invalid 'topics' field")

            parsed["topics"] = parsed["topics"][:7]
            if isinstance(parsed.get("learning_objectives"), list):
                parsed["learning_objectives"] = parsed["learning_objectives"][:7]
            else:
                parsed["learning_objectives"] = []

            return parsed

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            last_exc = e
            logger.warning(
                f"Consolidation attempt {attempt + 1}/3 failed",
                extra={"error": str(e)},
            )

    raise RuntimeError(
        f"Topic consolidation failed after 3 attempts: {last_exc}"
    )


def aggregate_module_topics(
    module_id: str,
    connection,
    bedrock_client,
) -> dict:
    """
    Collect per-file topics and consolidate into module-level topics.
    Writes the result to Course_Modules.generated_topics.

    Passthrough (no Haiku call) when combined topics <= 5 AND objectives <= 5.
    Calls Haiku with retry logic when the combined count exceeds the threshold.

    Args:
        module_id: UUID of the module.
        connection: Active psycopg2 connection.
        bedrock_client: Boto3 Bedrock Runtime client.

    Returns:
        The consolidated dict written to Course_Modules.generated_topics.

    Raises:
        RuntimeError: If the Haiku consolidation call fails after 3 attempts.
    """
    # 1. Query Module_Files for all (file_id, metadata) rows for this module
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT file_id, metadata
            FROM "Module_Files"
            WHERE module_id = %s
            """,
            (module_id,),
        )
        rows = cur.fetchall()

    all_topics: list = []
    all_objectives: list = []
    source_file_ids: list = []
    source_file_etags: dict = {}

    # 2. Iterate rows: parse metadata, collect topics/objectives, build source lists
    for file_id, metadata in rows:
        if not metadata:
            continue
        meta = metadata if isinstance(metadata, dict) else json.loads(metadata)
        extraction = meta.get("topic_extraction", {})
        topics = extraction.get("topics") or []
        objectives = extraction.get("learning_objectives") or []
        # Only include files that have at least one topic
        if topics:
            all_topics.extend(topics)
            all_objectives.extend(objectives)
            source_file_ids.append(str(file_id))
            if extraction.get("s3_etag"):
                source_file_etags[str(file_id)] = extraction["s3_etag"]

    source_file_count = len(source_file_ids)
    now_iso = datetime.now(timezone.utc).isoformat()

    # 3. Passthrough path: <=5 combined topics AND <=5 combined objectives
    if len(all_topics) <= 5 and len(all_objectives) <= 5:
        consolidated = {
            "topics": all_topics,
            "learning_objectives": all_objectives,
            "raw_topics": all_topics,
            "raw_learning_objectives": all_objectives,
            "generated_at": now_iso,
            "model": "direct-passthrough",
            "source_file_count": source_file_count,
            "source_file_ids": source_file_ids,
            "source_file_etags": source_file_etags,
        }
    else:
        # 4. Haiku path: >5 topics OR >5 objectives
        llm_result = _call_haiku_for_consolidation(
            all_topics, all_objectives, source_file_count, bedrock_client
        )
        consolidated = {
            "topics": llm_result["topics"],
            "learning_objectives": llm_result.get("learning_objectives", []),
            "raw_topics": all_topics,
            "raw_learning_objectives": all_objectives,
            "generated_at": now_iso,
            "model": TOPIC_EXTRACTION_MODEL_ID,
            "source_file_count": source_file_count,
            "source_file_ids": source_file_ids,
            "source_file_etags": source_file_etags,
        }

    # 5. Write result to Course_Modules.generated_topics
    with connection.cursor() as cur:
        cur.execute(
            """
            UPDATE "Course_Modules"
            SET generated_topics = %s::jsonb
            WHERE module_id = %s
            """,
            (json.dumps(consolidated), module_id),
        )
    connection.commit()

    # 6. Log completion
    logger.info(
        "Module topic aggregation complete",
        extra={
            "module_id": module_id,
            "source_file_count": source_file_count,
            "model": consolidated["model"],
        },
    )
    return consolidated
