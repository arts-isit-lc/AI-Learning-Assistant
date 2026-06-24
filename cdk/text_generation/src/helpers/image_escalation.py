"""Image escalation for the text_generation chatbot.

When a query references a specific figure/image, this module:
1. Detects figure references in the query (e.g., "Figure 1.1", "fig 3.2")
2. Looks up the corresponding image retrieval unit in the database
3. Fetches the image bytes from S3
4. Sends the image + user's question to Claude vision
5. Returns the analysis as a LangChain Document for inclusion in context

This gives the chatbot the ability to "see" images and answer visual questions.
"""

from __future__ import annotations

import base64
import json
import re
import time
from typing import Optional

import boto3
from langchain_core.documents import Document
from aws_lambda_powertools import Logger

logger = Logger(service="text-generation")

# Claude 3 Haiku for vision analysis (fast + cheap)
VISION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

# Regex to detect figure/table/algorithm references
_FIGURE_REF_PATTERN = re.compile(
    r"\b(figure|fig\.?|table|algorithm)\s*(\d+(?:[.-]\d+)*)",
    re.IGNORECASE,
)


def detect_figure_reference(query: str) -> Optional[tuple[str, str]]:
    """Detect a figure/table reference in the query.

    Args:
        query: The user's question.

    Returns:
        Tuple of (ref_type, number) e.g. ("figure", "1.1"), or None if no match.
    """
    match = _FIGURE_REF_PATTERN.search(query)
    if match:
        raw_type = match.group(1).lower().rstrip(".")
        ref_type = "figure" if raw_type in ("figure", "fig") else raw_type
        number = match.group(2)
        return (ref_type, number)
    return None


def find_image_retrieval_unit(
    ref_type: str,
    number: str,
    module_id: str,
    connection,
) -> Optional[dict]:
    """Find the image retrieval unit matching a figure reference.

    Searches by:
    1. metadata->>'figure_ref' matching the reference
    2. Falls back to searching embedding_text for the figure caption
    Then finds the sibling image retrieval unit if the match is a text caption.

    Args:
        ref_type: Type of reference ("figure", "table", "algorithm").
        number: The number (e.g., "1.1").
        module_id: Module ID for scoping.
        connection: psycopg2 connection.

    Returns:
        Dict with retrieval_id, image_s3_key, embedding_text, or None.
    """
    if connection is None:
        return None

    try:
        cur = connection.cursor()

        # Strategy 1: Direct image retrieval unit with matching figure reference
        # Look for image elements whose embedding_text contains the figure reference
        figure_pattern = f"%{ref_type} {number}%"
        cur.execute("""
            SELECT retrieval_id, embedding_text, metadata
            FROM retrieval_units
            WHERE element_type = 'image'
            AND LOWER(embedding_text) LIKE LOWER(%s)
            AND metadata->>'module_id' = %s
            LIMIT 1;
        """, (figure_pattern, module_id))

        row = cur.fetchone()
        if row:
            metadata = row[2] if isinstance(row[2], dict) else json.loads(row[2]) if row[2] else {}
            cur.close()
            return {
                "retrieval_id": row[0],
                "embedding_text": row[1],
                "image_s3_key": metadata.get("image_s3_key"),
            }

        # Strategy 2: Find via figure_ref metadata on text captions, then get sibling image
        figure_ref_value = f"{ref_type} {number}"
        cur.execute("""
            SELECT retrieval_id, embedding_text, metadata, sibling_ids
            FROM retrieval_units
            WHERE metadata->>'figure_ref' ILIKE %s
            AND metadata->>'module_id' = %s
            LIMIT 1;
        """, (figure_ref_value, module_id))

        row = cur.fetchone()
        if row:
            sibling_ids = row[3] if isinstance(row[3], list) else json.loads(row[3]) if row[3] else []
            # Look for image sibling
            if sibling_ids:
                placeholders = ",".join(["%s"] * len(sibling_ids))
                cur.execute(f"""
                    SELECT retrieval_id, embedding_text, metadata
                    FROM retrieval_units
                    WHERE retrieval_id IN ({placeholders})
                    AND element_type = 'image'
                    LIMIT 1;
                """, sibling_ids)

                img_row = cur.fetchone()
                if img_row:
                    metadata = img_row[2] if isinstance(img_row[2], dict) else json.loads(img_row[2]) if img_row[2] else {}
                    cur.close()
                    return {
                        "retrieval_id": img_row[0],
                        "embedding_text": img_row[1],
                        "image_s3_key": metadata.get("image_s3_key"),
                    }

        # Strategy 3: Broader search — any image on the same page as text mentioning the figure
        cur.execute("""
            SELECT retrieval_id, embedding_text, metadata
            FROM retrieval_units
            WHERE element_type = 'image'
            AND metadata->>'module_id' = %s
            AND LOWER(embedding_text) LIKE LOWER(%s)
            LIMIT 1;
        """, (module_id, f"%{number}%"))

        row = cur.fetchone()
        if row:
            metadata = row[2] if isinstance(row[2], dict) else json.loads(row[2]) if row[2] else {}
            cur.close()
            return {
                "retrieval_id": row[0],
                "embedding_text": row[1],
                "image_s3_key": metadata.get("image_s3_key"),
            }

        cur.close()
        return None

    except Exception:
        logger.exception("Error finding image retrieval unit")
        return None


def fetch_image_from_s3(image_s3_key: str, s3_client=None) -> Optional[bytes]:
    """Fetch image bytes from S3.

    Args:
        image_s3_key: S3 key or full s3://bucket/key URI.
        s3_client: Boto3 S3 client (created if not provided).

    Returns:
        Image bytes, or None on failure.
    """
    if not image_s3_key:
        return None

    if s3_client is None:
        s3_client = boto3.client("s3")

    try:
        # Parse s3://bucket/key format
        if image_s3_key.startswith("s3://"):
            without_prefix = image_s3_key[5:]
            parts = without_prefix.split("/", 1)
            if len(parts) == 2:
                bucket = parts[0]
                key = parts[1]
            else:
                logger.warning("Invalid S3 URI format", extra={"image_s3_key": image_s3_key})
                return None
        else:
            # Assume it's just a key — need bucket from env
            import os
            bucket = os.environ.get("IR_BUCKET_NAME", "")
            key = image_s3_key
            if not bucket:
                logger.warning("No IR_BUCKET_NAME env var and key is not full URI")
                return None

        response = s3_client.get_object(Bucket=bucket, Key=key)
        image_bytes = response["Body"].read()

        logger.info(
            "Image fetched from S3",
            extra={"image_s3_key": image_s3_key, "size_bytes": len(image_bytes)},
        )
        return image_bytes

    except Exception:
        logger.exception("Failed to fetch image from S3", extra={"image_s3_key": image_s3_key})
        return None


def analyze_image_with_vision(
    image_bytes: bytes,
    query: str,
    bedrock_client=None,
) -> Optional[str]:
    """Send image to Claude vision with the user's question.

    Args:
        image_bytes: Raw image bytes.
        query: The user's question about the image.
        bedrock_client: Boto3 Bedrock Runtime client.

    Returns:
        Vision analysis text, or None on failure.
    """
    if bedrock_client is None:
        bedrock_client = boto3.client("bedrock-runtime")

    try:
        vision_start = time.time()

        image_base64 = base64.b64encode(image_bytes).decode("utf-8")

        # Determine media type (default png for our extracted images)
        media_type = "image/png"

        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1500,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_base64,
                            },
                        },
                        {
                            "type": "text",
                            "text": (
                                f"A student is asking: {query}\n\n"
                                "Please analyze this image in detail to answer their question. "
                                "Describe all relevant visual elements including colors, labels, "
                                "data points, axes, legends, and any text visible in the image. "
                                "Be specific and thorough."
                            ),
                        },
                    ],
                }
            ],
        })

        response = bedrock_client.invoke_model(
            modelId=VISION_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=body,
        )

        response_body = json.loads(response["body"].read())
        analysis = response_body["content"][0]["text"]

        vision_latency = time.time() - vision_start

        logger.info(
            "Vision analysis complete",
            extra={
                "analysis_length": len(analysis),
                "vision_latency_ms": round(vision_latency * 1000, 2),
                "input_tokens": response_body.get("usage", {}).get("input_tokens", 0),
                "output_tokens": response_body.get("usage", {}).get("output_tokens", 0),
            },
        )

        return analysis

    except Exception:
        logger.exception("Vision LLM analysis failed")
        return None


def escalate_image_for_query(
    query: str,
    module_id: str,
    connection,
    bedrock_client=None,
    s3_client=None,
) -> Optional[Document]:
    """Full image escalation pipeline: detect → find → fetch → analyze.

    If the query references a figure/image, fetches it from S3 and runs
    Claude vision to produce a detailed analysis. Returns the analysis as
    a LangChain Document for inclusion in the retrieval context.

    Args:
        query: The user's question.
        module_id: Module ID for scoping image lookup.
        connection: psycopg2 connection for DB queries.
        bedrock_client: Boto3 Bedrock Runtime client.
        s3_client: Boto3 S3 client.

    Returns:
        A Document containing the vision analysis, or None if escalation
        wasn't triggered or failed.
    """
    escalation_start = time.time()

    # Step 1: Detect figure reference
    ref = detect_figure_reference(query)
    if ref is None:
        return None

    ref_type, number = ref
    logger.info(
        "Figure reference detected — initiating image escalation",
        extra={"ref_type": ref_type, "number": number},
    )

    # Step 2: Find the image in the database
    image_unit = find_image_retrieval_unit(ref_type, number, module_id, connection)
    if image_unit is None:
        logger.info(
            "No image found for figure reference",
            extra={"ref_type": ref_type, "number": number, "module_id": module_id},
        )
        return None

    image_s3_key = image_unit.get("image_s3_key")
    if not image_s3_key:
        logger.info(
            "Image retrieval unit has no S3 key",
            extra={"retrieval_id": image_unit["retrieval_id"]},
        )
        return None

    # Step 3: Fetch from S3
    image_bytes = fetch_image_from_s3(image_s3_key, s3_client=s3_client)
    if image_bytes is None:
        return None

    # Step 4: Vision analysis
    analysis = analyze_image_with_vision(image_bytes, query, bedrock_client=bedrock_client)
    if analysis is None:
        return None

    total_latency = time.time() - escalation_start

    logger.info(
        "Image escalation complete",
        extra={
            "ref_type": ref_type,
            "number": number,
            "retrieval_id": image_unit["retrieval_id"],
            "total_escalation_latency_ms": round(total_latency * 1000, 2),
        },
    )

    # Return as a Document so it's included in the LLM context
    return Document(
        page_content=(
            f"[Visual Analysis of {ref_type.title()} {number}]\n"
            f"The following is a detailed analysis of the image from {ref_type} {number}:\n\n"
            f"{analysis}"
        ),
        metadata={
            "element_type": "image_escalation",
            "ref_type": ref_type,
            "number": number,
            "retrieval_id": image_unit["retrieval_id"],
            "image_s3_key": image_s3_key,
        },
    )
