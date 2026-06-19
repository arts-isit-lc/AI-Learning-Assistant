"""Persistence layer exceptions."""

from __future__ import annotations


class IRNotFoundError(Exception):
    """Raised when a DocumentIR cannot be found at the expected S3 path.

    Attributes:
        s3_path: The S3 path that was queried.
        course_id: The course identifier.
        module_id: The module identifier.
        file_id: The file identifier.
    """

    def __init__(
        self,
        s3_path: str,
        course_id: str,
        module_id: str,
        file_id: str,
        reason: str = "not found",
    ) -> None:
        self.s3_path = s3_path
        self.course_id = course_id
        self.module_id = module_id
        self.file_id = file_id
        self.reason = reason
        super().__init__(
            f"DocumentIR {reason} at path '{s3_path}' "
            f"(course={course_id}, module={module_id}, file={file_id})"
        )
