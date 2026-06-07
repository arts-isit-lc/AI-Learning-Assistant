"""
Topic Extraction Module

Extracts main topics and learning objectives from uploaded PDF documents
using Claude 3 Haiku via Amazon Bedrock. Runs as a non-blocking step in
the data ingestion pipeline.
"""

import os
import json
import tempfile
from datetime import datetime, timezone

import boto3
import fitz
from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")

# Character threshold for full-text vs sampling decision (~40K tokens)
DIRECT_SEND_LIMIT = 160000

# NOTE: Hard-coded to Haiku for cost/speed. If extraction quality is insufficient,
# consider switching to Claude 3 Sonnet (anthropic.claude-3-sonnet-20240229-v1:0).
# The model ID can be made configurable via SSM parameter in a future iteration.
TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

EXTRACTION_PROMPT = """Analyze this educational document and extract the core subject matter.

Identify only the concepts that an instructor would expect students to learn
and be assessed on.

Exclude:
- Examples and case studies
- Citations and references
- Supporting details and tangential mentions
- Administrative content (syllabus info, grading policies)
- Appendices and indexes

Prefer broad conceptual topics over narrow subtopics.

Return ONLY a valid JSON object (no markdown, no explanation):
{
    "topics": ["topic1", "topic2", ...],
    "learning_objectives": ["objective1", "objective2", ...]
}

Limit: maximum 5 topics and 5 learning objectives.

Document text:
"""

# Initialize S3 client (reused across invocations)
s3 = boto3.client('s3')


def should_extract_topics(file_id: str, s3_etag: str, connection) -> bool:
    """
    Check if topic extraction is needed by comparing S3 ETag.
    If the ETag matches what was previously extracted, content hasn't changed.

    Args:
        file_id: The unique identifier of the file in Module_Files.
        s3_etag: The ETag from the S3 event payload.
        connection: Active database connection.

    Returns:
        True if extraction should proceed, False if it should be skipped.
    """
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT metadata FROM "Module_Files"
            WHERE file_id = %s;
        """, (file_id,))
        row = cur.fetchone()
        cur.close()

        if not row or not row[0]:
            return True

        meta = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        topic_data = meta.get("topic_extraction")
        if not topic_data:
            return True

        # Compare ETags — if same, content hasn't changed, skip extraction
        stored_etag = topic_data.get("s3_etag")
        if stored_etag and stored_etag == s3_etag:
            logger.info(f"Skipping topic extraction — ETag unchanged ({s3_etag})")
            return False

        return True

    except Exception as e:
        logger.warning(f"Error checking extraction status, proceeding with extraction: {e}")
        return True


def extract_text_from_pdf(bucket: str, file_key: str) -> str:
    """
    Download a PDF from S3 and extract all text content.
    Uses PyMuPDF with OCR fallback for scanned pages.
    If total text exceeds DIRECT_SEND_LIMIT, applies sampling strategy.

    Args:
        bucket: S3 bucket name containing the PDF.
        file_key: S3 object key for the PDF.

    Returns:
        The extracted text to send to the LLM (full or sampled).
    """
    with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
        s3.download_file(bucket, file_key, tmp_file.name)
        doc = fitz.open(tmp_file.name)

        all_pages = []
        total_chars = 0

        for page in doc:
            text = page.get_text().strip()
            if len(text) < 30:
                try:
                    tessdata_path = os.environ.get("TESSDATA_PREFIX", "/usr/share/tessdata")
                    tp = page.get_textpage_ocr(tessdata=tessdata_path)
                    text = tp.extractText()
                except Exception:
                    text = ""
            if text.strip():
                all_pages.append(text)
                total_chars += len(text)

        doc.close()
        os.remove(tmp_file.name)

    if not all_pages:
        return ""

    # Decision: send full or sample
    if total_chars <= DIRECT_SEND_LIMIT:
        return "\n\n".join(all_pages)
    else:
        logger.info(f"Document exceeds {DIRECT_SEND_LIMIT} chars ({total_chars}), applying sampling")
        return sample_large_document(all_pages)


def sample_large_document(pages: list, target_chars: int = DIRECT_SEND_LIMIT) -> str:
    """
    For documents exceeding the direct send limit, sample:
    - First 20% of pages (introduction, context setting)
    - Evenly spaced pages from the middle 60%
    - Last 10% of pages (conclusions, summaries)

    Total output stays within target_chars.

    Args:
        pages: List of page text strings.
        target_chars: Maximum total characters for the sampled output.

    Returns:
        Sampled text with section separators.
    """
    total_pages = len(pages)

    # Always include first 20% and last 10%
    first_count = max(2, total_pages // 5)
    last_count = max(2, total_pages // 10)

    first_section = pages[:first_count]
    last_section = pages[-last_count:]

    # Budget remaining chars for middle sampling
    first_chars = sum(len(p) for p in first_section)
    last_chars = sum(len(p) for p in last_section)
    middle_budget = target_chars - first_chars - last_chars

    # Sample from middle pages
    middle_start = first_count
    middle_end = total_pages - last_count
    middle_pages = pages[middle_start:middle_end]

    sampled_middle = []
    middle_chars = 0

    if middle_pages and middle_budget > 0:
        step = max(1, len(middle_pages) // 8)  # pick ~8 evenly spaced pages
        for i in range(0, len(middle_pages), step):
            if middle_chars + len(middle_pages[i]) > middle_budget:
                break
            sampled_middle.append(middle_pages[i])
            middle_chars += len(middle_pages[i])

    # Combine with separators indicating sampling
    result_parts = (
        first_section
        + ["--- [sampled middle pages] ---"]
        + sampled_middle
        + ["--- [final pages] ---"]
        + last_section
    )
    return "\n\n".join(result_parts)


def call_haiku_for_topics(full_text: str, bedrock_client) -> dict:
    """
    Call Claude 3 Haiku to extract main topics from document text.
    Retries up to 3 times on JSON parse failures.

    Args:
        full_text: The extracted document text to analyze.
        bedrock_client: Boto3 Bedrock Runtime client.

    Returns:
        Dict containing topics, learning_objectives, and provenance metadata.

    Raises:
        RuntimeError: If all 3 parse attempts fail.
    """
    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": EXTRACTION_PROMPT + full_text}
        ]
    })

    for attempt in range(3):
        try:
            response = bedrock_client.invoke_model(
                modelId=TOPIC_EXTRACTION_MODEL_ID,
                body=request_body
            )
            result = json.loads(response["body"].read())
            content = result["content"][0]["text"]

            # Clean response: strip markdown fences if present
            content = content.strip()
            if content.startswith("```"):
                # Remove opening fence line (may include language identifier)
                content = content.split("\n", 1)[1] if "\n" in content else content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            parsed = json.loads(content)

            # Validate structure
            if "topics" not in parsed or not isinstance(parsed["topics"], list):
                raise ValueError("Missing or invalid 'topics' field")

            # Enforce maximum limits
            parsed["topics"] = parsed["topics"][:5]
            if "learning_objectives" in parsed and isinstance(parsed["learning_objectives"], list):
                parsed["learning_objectives"] = parsed["learning_objectives"][:5]
            else:
                parsed["learning_objectives"] = []

            # Add provenance metadata
            parsed["extracted_at"] = datetime.now(timezone.utc).isoformat()
            parsed["model"] = TOPIC_EXTRACTION_MODEL_ID
            parsed["version"] = 1

            return parsed

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning(f"Topic extraction attempt {attempt + 1}/3 failed: {e}")
            if attempt == 2:
                raise RuntimeError(f"Topic extraction failed after 3 attempts: {e}")

    # Should not reach here, but safety fallback
    raise RuntimeError("Topic extraction failed after 3 attempts")


def update_file_metadata(file_id: str, topics: dict, s3_etag: str, connection):
    """
    Update the metadata column of Module_Files with extracted topics.
    Uses file_id as identifier. Nests under 'topic_extraction' key,
    preserving any other existing metadata keys.

    Args:
        file_id: The unique identifier of the file.
        topics: Dict containing extracted topics and provenance.
        s3_etag: The S3 ETag to store for idempotency.
        connection: Active database connection.
    """
    cur = connection.cursor()

    # Read existing metadata to merge (don't overwrite other fields)
    cur.execute("""
        SELECT metadata FROM "Module_Files"
        WHERE file_id = %s;
    """, (file_id,))
    row = cur.fetchone()

    existing = {}
    if row and row[0]:
        existing = row[0] if isinstance(row[0], dict) else json.loads(row[0])

    # Store topics with ETag for idempotency
    topics["s3_etag"] = s3_etag
    existing["topic_extraction"] = topics

    cur.execute("""
        UPDATE "Module_Files"
        SET metadata = %s::jsonb
        WHERE file_id = %s;
    """, (json.dumps(existing), file_id))
    connection.commit()
    cur.close()
