"""ImageEscalation fetches images from S3 and invokes vision LLM for analysis.

Classification is handled by QueryAnalyzer (requires_escalation field).
This module only handles execution: S3 fetch + vision LLM call.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import ImageAnalysis, RankedResult

logger = Logger(service="multimodal-rag-reasoning")

# Claude 3 Haiku model ID for vision analysis
VISION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"


@dataclass
class EscalationResult:
    """Result of image escalation processing."""

    escalation_used: bool
    image_analyses: list[ImageAnalysis] = field(default_factory=list)


class ImageEscalation:
    """Fetches images from S3 and invokes vision LLM for detailed analysis.

    Accepts s3_client and bedrock_client via constructor for dependency injection
    and testability.

    Error handling:
    - S3 fetch failure -> skip that image, log, continue with next
    - Vision LLM failure -> skip that image, log, continue with next
    - Never raises unhandled exceptions to caller
    """

    def __init__(
        self,
        s3_client: Any = None,
        bedrock_client: Any = None,
        bucket_name: str = "",
    ) -> None:
        """Initialize ImageEscalation with AWS clients.

        Args:
            s3_client: Boto3 S3 client (injected for testing).
            bedrock_client: Boto3 Bedrock Runtime client (injected for testing).
            bucket_name: S3 bucket name where images are stored.
        """
        self.s3_client = s3_client
        self.bedrock_client = bedrock_client
        self.bucket_name = bucket_name

    def escalate(
        self, results: list[RankedResult], query: str, query_intent=None
    ) -> EscalationResult:
        """Perform image escalation on ranked results.

        When a figure_reference is present in query_intent, prefers images that
        are siblings of text results containing matching figure captions.
        Falls back to top-scoring images when no sibling link exists.

        Args:
            results: Ranked results from the retrieval layer.
            query: The user's original query for vision analysis context.
            query_intent: Optional QueryIntent with figure_reference for targeted lookup.

        Returns:
            EscalationResult with escalation_used flag and image analyses.
        """
        try:
            # Strategy 1: If figure_reference is set, find sibling-linked images
            if query_intent is not None and query_intent.figure_reference is not None:
                sibling_images = self._find_sibling_linked_images(
                    results, query_intent.figure_reference.number
                )
                if sibling_images:
                    analyses: list[ImageAnalysis] = []
                    for img_result in sibling_images[:2]:  # max 2
                        analysis = self._analyze_image(img_result, query)
                        if analysis is not None:
                            analyses.append(analysis)
                    if analyses:
                        return EscalationResult(escalation_used=True, image_analyses=analyses)

            # Strategy 2: Fallback to top-scoring image results by image_s3_key
            image_results = [r for r in results if r.image_s3_key is not None]

            if not image_results:
                return EscalationResult(escalation_used=False, image_analyses=[])

            # Select top 2 by score (descending)
            sorted_results = sorted(
                image_results, key=lambda r: r.score, reverse=True
            )
            top_results = sorted_results[:2]

            analyses = []

            for result in top_results:
                analysis = self._analyze_image(result, query)
                if analysis is not None:
                    analyses.append(analysis)

            if analyses:
                return EscalationResult(
                    escalation_used=True, image_analyses=analyses
                )
            else:
                return EscalationResult(
                    escalation_used=False, image_analyses=[]
                )

        except Exception:
            logger.exception("Unexpected error during image escalation")
            return EscalationResult(escalation_used=False, image_analyses=[])

    def _find_sibling_linked_images(
        self, results: list[RankedResult], figure_number: str
    ) -> list[RankedResult]:
        """Find image results that are siblings of text chunks with a matching figure reference.

        Looks for text results whose metadata contains a figure_ref matching the
        requested figure number, then finds image results whose retrieval_id
        appears in that text result's sibling_ids.

        Args:
            results: All ranked results from retrieval.
            figure_number: The figure number to match (e.g., "1.1").

        Returns:
            List of image RankedResults linked as siblings to the matching caption.
        """
        # Find text results with matching figure_ref in metadata
        matching_text_results = []
        for r in results:
            fig_ref = r.metadata.get("figure_ref", "")
            # Match if the figure number appears in the figure_ref
            # e.g., figure_ref="figure 1.1" matches figure_number="1.1"
            if figure_number in fig_ref:
                matching_text_results.append(r)

        if not matching_text_results:
            return []

        # Collect sibling_ids from matching text results
        sibling_ids: set[str] = set()
        for text_result in matching_text_results:
            sibling_ids.update(text_result.sibling_ids)

        if not sibling_ids:
            return []

        # Find image results whose retrieval_id is in the sibling_ids
        sibling_images = [
            r for r in results
            if r.retrieval_id in sibling_ids and r.image_s3_key is not None
        ]

        return sibling_images

    def _analyze_image(
        self, result: RankedResult, query: str
    ) -> ImageAnalysis | None:
        """Fetch an image from S3 and invoke vision LLM analysis.

        Args:
            result: A ranked result with a non-null image_s3_key.
            query: The user's query for context.

        Returns:
            ImageAnalysis if successful, None if any step fails.
        """
        image_s3_key = result.image_s3_key
        if image_s3_key is None:
            return None

        # Step 1: Fetch image from S3
        image_bytes = self._fetch_image(image_s3_key)
        if image_bytes is None:
            return None

        # Step 2: Invoke vision LLM
        analysis = self._invoke_vision_llm(image_bytes, image_s3_key, query)
        return analysis

    def _fetch_image(self, image_s3_key: str) -> bytes | None:
        """Fetch image bytes from S3.

        Args:
            image_s3_key: The S3 object key or full s3:// URI for the image.

        Returns:
            Image bytes if successful, None on failure.
        """
        try:
            # Handle full s3:// URI format: s3://bucket-name/key
            key = image_s3_key
            bucket = self.bucket_name
            if key.startswith("s3://"):
                # Parse s3://bucket/key format
                without_prefix = key[5:]  # remove "s3://"
                parts = without_prefix.split("/", 1)
                if len(parts) == 2:
                    bucket = parts[0]
                    key = parts[1]

            response = self.s3_client.get_object(Bucket=bucket, Key=key)
            return response["Body"].read()
        except Exception:
            logger.exception(
                "Failed to fetch image from S3",
                extra={"image_s3_key": image_s3_key, "bucket": bucket},
            )
            return None

    def _invoke_vision_llm(
        self, image_bytes: bytes, image_s3_key: str, query: str
    ) -> ImageAnalysis | None:
        """Invoke Claude 3 Haiku vision model for image analysis.

        Args:
            image_bytes: Raw image bytes fetched from S3.
            image_s3_key: The S3 key (for result attribution).
            query: The user's query for analysis context.

        Returns:
            ImageAnalysis if successful, None on failure.
        """
        try:
            import json

            image_base64 = base64.b64encode(image_bytes).decode("utf-8")

            # Determine media type from key extension
            media_type = self._get_media_type(image_s3_key)

            body = json.dumps(
                {
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
                                    "text": (
                                        f"Analyze this image in the context of the following question: {query}\n\n"
                                        "Provide a detailed description of what this image shows and how it "
                                        "relates to the question. Include any relevant labels, data points, "
                                        "or concepts visible in the image."
                                    ),
                                },
                            ],
                        }
                    ],
                }
            )

            response = self.bedrock_client.invoke_model(
                modelId=VISION_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=body,
            )

            response_body = json.loads(response["body"].read())
            analysis_text = response_body["content"][0]["text"]

            # Extract confidence from stop_reason (full response = high confidence)
            stop_reason = response_body.get("stop_reason", "end_turn")
            confidence = 0.9 if stop_reason == "end_turn" else 0.7

            return ImageAnalysis(
                image_s3_key=image_s3_key,
                analysis=analysis_text,
                confidence=confidence,
            )

        except Exception:
            logger.exception(
                "Failed to invoke vision LLM",
                extra={"image_s3_key": image_s3_key},
            )
            return None

    @staticmethod
    def _get_media_type(image_s3_key: str) -> str:
        """Determine media type from file extension.

        Args:
            image_s3_key: S3 object key.

        Returns:
            MIME type string for the image.
        """
        key_lower = image_s3_key.lower()
        if key_lower.endswith(".png"):
            return "image/png"
        elif key_lower.endswith(".gif"):
            return "image/gif"
        elif key_lower.endswith(".webp"):
            return "image/webp"
        elif key_lower.endswith((".jpg", ".jpeg")):
            return "image/jpeg"
        elif key_lower.endswith(".tiff") or key_lower.endswith(".tif"):
            return "image/tiff"
        elif key_lower.endswith(".bmp"):
            return "image/bmp"
        else:
            # Default to png for unknown extensions
            return "image/png"
