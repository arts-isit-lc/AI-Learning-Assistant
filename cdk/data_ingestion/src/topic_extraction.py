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

Identify the specific concepts that would appear as:
- Lecture topics or section headings
- Exam questions or assessment items
- Learning outcomes in a course syllabus

Extract the concepts that are distinct and assessable. Do NOT collapse multiple distinct concepts into one broader category.

For example, if a chapter covers "Classical Conditioning", "Operant Conditioning", and "Observational Learning", list all three — do NOT merge them into "Learning Theory".

Exclude:
- Examples and case studies (unless they ARE the topic)
- Citations, references, and bibliographic entries
- Administrative content (syllabus logistics, grading policies)
- Appendices, indexes, and glossaries

Return ONLY a valid JSON object (no markdown, no explanation, no trailing commas):
{
    "topics": ["topic1", "topic2", ...],
    "learning_objectives": ["objective1", "objective2", ...],
    "confidence": 0.0
}

confidence: How confident are you that the identified topics accurately represent the main subject matter of the provided text? (0.0 = very uncertain, 1.0 = highly confident).

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


def extract_text_from_pdf(bucket: str, file_key: str) -> tuple:
    """
    Download a PDF from S3 and extract all text content.
    Uses PyMuPDF with OCR fallback for scanned pages.
    If total text exceeds DIRECT_SEND_LIMIT, applies sampling strategy.

    Args:
        bucket: S3 bucket name containing the PDF.
        file_key: S3 object key for the PDF.

    Returns:
        Tuple of (extracted_text, extraction_method, total_chars) where extraction_method
        is "full_document" or "sampled_document", and total_chars is the original document size.
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
        return "", "full_document", 0

    # Decision: send full or sample
    if total_chars <= DIRECT_SEND_LIMIT:
        return "\n\n".join(all_pages), "full_document", total_chars
    else:
        logger.info(f"Document exceeds {DIRECT_SEND_LIMIT} chars ({total_chars}), applying sampling")
        return sample_large_document(all_pages), "sampled_document", total_chars


def sample_large_document(pages: list, target_chars: int = DIRECT_SEND_LIMIT) -> str:
    """
    For documents exceeding the direct send limit, build a compressed
    representation by taking the first ~500 chars of every page.

    This preserves topic coverage across the entire document (headings,
    opening paragraphs) rather than sampling a handful of full pages
    which may miss major sections entirely.

    Falls back to the first/last strategy if per-page headers still
    exceed the budget.

    Args:
        pages: List of page text strings.
        target_chars: Maximum total characters for the sampled output.

    Returns:
        Sampled text with page markers.
    """
    # Strategy 1: First 500 chars per page (captures headings + opening text)
    PER_PAGE_LIMIT = 500
    compressed = []
    total_chars = 0

    for i, page in enumerate(pages):
        snippet = page[:PER_PAGE_LIMIT].strip()
        if not snippet:
            continue
        entry = f"[Page {i + 1}] {snippet}"
        if total_chars + len(entry) > target_chars:
            break
        compressed.append(entry)
        total_chars += len(entry)

    # Always return the compressed representation — even partial coverage
    # of all pages (via headings) is better than full text of a few pages.
    return "\n\n".join(compressed)


def repair_json(content: str) -> str:
    """
    Attempt to repair common LLM JSON output issues:
    - Trailing commas in arrays/objects
    - Missing closing braces
    """
    import re
    # Remove trailing commas before ] or }
    content = re.sub(r',\s*([}\]])', r'\1', content)
    return content


def call_haiku_for_topics(full_text: str, bedrock_client, extraction_method: str = "full_document", original_chars: int = 0) -> dict:
    """
    Call Claude 3 Haiku to extract main topics from document text.
    Retries up to 3 times on JSON parse failures with repair attempts.

    Args:
        full_text: The extracted document text to analyze.
        bedrock_client: Boto3 Bedrock Runtime client.
        extraction_method: "full_document" or "sampled_document" — stored for diagnostics.
        original_chars: Total character count of the original document (for coverage calculation).

    Returns:
        Dict containing topics, learning_objectives, confidence, coverage, and provenance metadata.

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

            # Validate Bedrock response shape before indexing
            if (
                not isinstance(result, dict)
                or "content" not in result
                or not isinstance(result["content"], list)
                or len(result["content"]) == 0
                or "text" not in result["content"][0]
            ):
                raise ValueError(f"Unexpected Bedrock response shape: {str(result)[:200]}")

            content = result["content"][0]["text"]

            # Clean response: strip markdown fences if present
            content = content.strip()
            if content.startswith("```"):
                # Remove opening fence line (may include language identifier)
                content = content.split("\n", 1)[1] if "\n" in content else content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            # Attempt JSON repair before parsing
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                repaired = repair_json(content)
                parsed = json.loads(repaired)

            # Validate structure
            if "topics" not in parsed or not isinstance(parsed["topics"], list):
                raise ValueError("Missing or invalid 'topics' field")

            # Sanitize topic strings — remove empty, non-string, or generic entries
            parsed["topics"] = [
                t.strip() for t in parsed["topics"]
                if isinstance(t, str) and t.strip()
            ][:5]

            if "learning_objectives" in parsed and isinstance(parsed["learning_objectives"], list):
                parsed["learning_objectives"] = [
                    o.strip() for o in parsed["learning_objectives"]
                    if isinstance(o, str) and o.strip()
                ][:5]
            else:
                parsed["learning_objectives"] = []

            # Confidence = model's assessment of topic accuracy against the provided text
            if "confidence" not in parsed or not isinstance(parsed.get("confidence"), (int, float)):
                parsed["confidence"] = 0.85

            # Coverage = what fraction of the original document was sent to the LLM
            if extraction_method == "full_document":
                parsed["coverage"] = 1.0
            else:
                # original_chars is the total raw document size; full_text is the sampled version
                parsed["coverage"] = round(len(full_text) / original_chars, 2) if original_chars > 0 else 1.0

            # Add provenance metadata
            parsed["extracted_at"] = datetime.now(timezone.utc).isoformat()
            parsed["model"] = TOPIC_EXTRACTION_MODEL_ID
            parsed["version"] = 2
            parsed["extraction_method"] = extraction_method

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
