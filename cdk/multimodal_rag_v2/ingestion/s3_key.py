"""Course-material S3 key parsing, shared by the ingestion and failure handlers.

Kept free of heavy imports so the small failure handler can use it without
loading the document adapters.
"""

from __future__ import annotations

import os


def parse_s3_key(key: str) -> dict[str, str]:
    """Parse course_id, module_id, and file_id from the S3 key path.

    Expected key format: courses/{course_id}/{module_id}/{filename}

    Args:
        key: The S3 object key from the event (already URL-decoded).

    Returns:
        Dict with course_id, module_id, file_id, and filename.

    Raises:
        ValueError: If the key does not match the expected format.
    """
    parts = key.split("/")
    if len(parts) < 4 or parts[0] != "courses":
        raise ValueError(
            f"S3 key does not match expected format "
            f"'courses/{{course_id}}/{{module_id}}/{{filename}}': {key}"
        )

    course_id = parts[1]
    module_id = parts[2]
    filename = parts[3]
    # file_id is filename without extension
    file_id = os.path.splitext(filename)[0]

    return {
        "course_id": course_id,
        "module_id": module_id,
        "file_id": file_id,
        "filename": filename,
    }
