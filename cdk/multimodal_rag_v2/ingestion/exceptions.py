"""Custom exceptions for the ingestion layer."""


class UnsupportedFormatError(Exception):
    """Raised when a file has an unsupported or missing extension."""

    def __init__(self, extension: str, file_key: str = "") -> None:
        self.extension = extension
        self.file_key = file_key
        message = (
            f"Unsupported file extension: '{extension}'"
            if extension
            else "Missing file extension"
        )
        if file_key:
            message += f" for file: {file_key}"
        super().__init__(message)


class FileSizeExceededError(Exception):
    """Raised when a file exceeds the maximum allowed size."""

    MAX_SIZE_MB = 200

    def __init__(self, file_size_bytes: int, file_key: str = "") -> None:
        self.file_size_bytes = file_size_bytes
        self.file_key = file_key
        size_mb = file_size_bytes / (1024 * 1024)
        message = (
            f"File size {size_mb:.1f} MB exceeds maximum allowed size "
            f"of {self.MAX_SIZE_MB} MB"
        )
        if file_key:
            message += f" for file: {file_key}"
        super().__init__(message)


class ExtractionFailureError(Exception):
    """Raised when content extraction fails completely for a file."""

    def __init__(self, file_key: str, reason: str = "") -> None:
        self.file_key = file_key
        self.reason = reason
        message = f"Complete extraction failure for file: {file_key}"
        if reason:
            message += f" — {reason}"
        super().__init__(message)
