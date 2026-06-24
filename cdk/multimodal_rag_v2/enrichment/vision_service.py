"""VisionService: Structured image analysis via Claude 3 Haiku on Bedrock.

Produces image_type, image_description, topics, labels, and keywords
for IMAGE elements using the Claude 3 Haiku vision model.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    IRElement,
)

logger = Logger(service="multimodal-rag-enrichment")

MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

VISION_PROMPT = """\
Analyze this image and return a JSON object with exactly these fields:
- "image_type": a short label (e.g., "diagram", "chart", "photograph", "screenshot", "graph", "table", "illustration")
- "image_description": a 1-3 sentence description of what the image shows
- "topics": an array of 1-10 relevant topics
- "labels": an array of 1-5 short labels for the image
- "keywords": an array of 1-10 searchable keywords

Return ONLY valid JSON, no other text."""


class VisionService:
    """Invokes Claude 3 Haiku vision for structured image analysis.

    Accepts a bedrock_client (boto3 Bedrock Runtime client) via constructor
    for dependency injection and testability.
    """

    def __init__(self, bedrock_client: Any) -> None:
        """Initialize VisionService.

        Args:
            bedrock_client: A boto3 Bedrock Runtime client instance.
        """
        self._client = bedrock_client

    def enrich(self, element: IRElement) -> EnrichedElement:
        """Analyze an IMAGE element using Claude 3 Haiku vision.

        Args:
            element: An IRElement with element_type=IMAGE and bytes content.

        Returns:
            EnrichedElement with image_type, image_description, topics,
            labels, keywords, and embedding_text.

        Raises:
            Exception: On Bedrock invocation failure or response parsing error.
                ElementRouter handles fallback logic.
        """
        enrich_start = time.time()

        image_bytes = element.content if isinstance(element.content, bytes) else element.content.encode("utf-8")
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")

        # Determine media type from metadata or default to png
        media_type = element.metadata.get("media_type", "image/png")

        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
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
                            "text": VISION_PROMPT,
                        },
                    ],
                }
            ],
        }

        logger.info(
            "Invoking vision model",
            extra={
                "element_id": element.element_id,
                "model_id": MODEL_ID,
                "image_size_bytes": len(image_bytes),
                "media_type": media_type,
            },
        )

        llm_start = time.time()
        response = self._client.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(request_body),
        )
        llm_latency = time.time() - llm_start

        response_body = json.loads(response["body"].read())
        result = self._parse_response(response_body)

        image_type = result.get("image_type", "unknown")
        image_description = result.get("image_description", "")
        topics = result.get("topics", [])[:10]
        labels = result.get("labels", [])[:5]
        keywords = result.get("keywords", [])[:10]

        embedding_text = f"{image_type}: {image_description}"

        enrich_latency = time.time() - enrich_start

        logger.info(
            "Vision enrichment complete",
            extra={
                "element_id": element.element_id,
                "image_type": image_type,
                "description_length": len(image_description),
                "topic_count": len(topics),
                "label_count": len(labels),
                "keyword_count": len(keywords),
                "llm_latency_ms": round(llm_latency * 1000, 2),
                "total_enrich_latency_ms": round(enrich_latency * 1000, 2),
                "input_tokens": response_body.get("usage", {}).get("input_tokens", 0),
                "output_tokens": response_body.get("usage", {}).get("output_tokens", 0),
            },
        )

        return EnrichedElement(
            element_id=element.element_id,
            element_type=ElementType.IMAGE,
            provenance=element.provenance,
            embedding_text=embedding_text,
            topics=topics,
            labels=labels,
            keywords=keywords,
            image_type=image_type,
            image_description=image_description,
            image_s3_key=element.metadata.get("image_s3_key"),
            enrichment_version=ENRICHMENT_VERSION,
        )

    def _parse_response(self, response_body: dict[str, Any]) -> dict[str, Any]:
        """Extract JSON from Claude response content.

        Args:
            response_body: The parsed response from Bedrock.

        Returns:
            Parsed JSON dict with image analysis fields.

        Raises:
            ValueError: If the response cannot be parsed as JSON.
        """
        content_blocks = response_body.get("content", [])
        for block in content_blocks:
            if block.get("type") == "text":
                text = block["text"].strip()
                # Handle potential markdown code fences
                if text.startswith("```"):
                    lines = text.split("\n")
                    # Remove first and last lines (fences)
                    text = "\n".join(lines[1:-1]).strip()
                return json.loads(text)

        raise ValueError("No text content in vision model response")
