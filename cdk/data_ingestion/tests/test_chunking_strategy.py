"""Unit tests for configurable chunking strategy in process_file_in_memory().

Requirements validated: 8.1, 8.2
"""

import hashlib
import sys
import os
from unittest.mock import MagicMock, patch

import pytest

# Add src to path so we can import the module under test
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# Mock heavy dependencies that are not installed in the test environment
sys.modules.setdefault("boto3", MagicMock())
sys.modules.setdefault("botocore", MagicMock())
sys.modules.setdefault("langchain_postgres", MagicMock())
sys.modules.setdefault("langchain_aws", MagicMock())

# Mock aws_lambda_powertools Logger
mock_powertools = MagicMock()
mock_logger_instance = MagicMock()
mock_powertools.Logger.return_value = mock_logger_instance
sys.modules.setdefault("aws_lambda_powertools", mock_powertools)


# Define a real Document class for tests
class Document:
    def __init__(self, page_content="", metadata=None):
        self.page_content = page_content
        self.metadata = metadata or {}


# Ensure langchain_core.documents exposes our Document class
if "langchain_core" not in sys.modules:
    sys.modules["langchain_core"] = MagicMock()
if "langchain_core.documents" not in sys.modules:
    sys.modules["langchain_core.documents"] = MagicMock()
sys.modules["langchain_core.documents"].Document = Document

# Mock fitz (PyMuPDF) with realistic behavior
mock_fitz = MagicMock()
sys.modules["fitz"] = mock_fitz

# Mock langchain_experimental.text_splitter
mock_experimental = MagicMock()
mock_semantic_chunker_cls = MagicMock()
mock_experimental.SemanticChunker = mock_semantic_chunker_cls
sys.modules["langchain_experimental"] = mock_experimental
sys.modules["langchain_experimental.text_splitter"] = mock_experimental

# Mock langchain_text_splitters
mock_text_splitters = MagicMock()
mock_recursive_cls = MagicMock()
mock_text_splitters.RecursiveCharacterTextSplitter = mock_recursive_cls
sys.modules["langchain_text_splitters"] = mock_text_splitters

# Now import the module under test
from processing.in_memory import (
    _get_text_splitter,
    process_file_in_memory,
)


def _create_mock_fitz_doc(page_texts):
    """Create a mock fitz Document with pages returning given texts."""
    mock_doc = MagicMock()
    pages = []
    for text in page_texts:
        page = MagicMock()
        page.get_text.return_value = text
        pages.append(page)

    mock_doc.__iter__ = MagicMock(return_value=iter(pages))
    mock_doc.__enter__ = MagicMock(return_value=mock_doc)
    mock_doc.__exit__ = MagicMock(return_value=False)
    mock_doc.close = MagicMock()
    mock_fitz.open.return_value = mock_doc
    return mock_doc


class TestGetTextSplitter:
    """Tests for _get_text_splitter helper function."""

    def test_returns_recursive_splitter_for_recursive_strategy(self):
        embeddings = MagicMock()
        result = _get_text_splitter("recursive", embeddings, 1000, 100)

        mock_recursive_cls.assert_called_once_with(
            chunk_size=1000,
            chunk_overlap=100,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )
        assert result == mock_recursive_cls.return_value

    def test_returns_semantic_chunker_for_semantic_strategy(self):
        mock_recursive_cls.reset_mock()
        mock_semantic_chunker_cls.reset_mock()

        embeddings = MagicMock()
        result = _get_text_splitter("semantic", embeddings, 1000, 100)

        mock_semantic_chunker_cls.assert_called_once_with(embeddings)
        mock_recursive_cls.assert_not_called()
        assert result == mock_semantic_chunker_cls.return_value

    def test_defaults_to_semantic_for_unknown_strategy(self):
        mock_semantic_chunker_cls.reset_mock()

        embeddings = MagicMock()
        result = _get_text_splitter("unknown_strategy", embeddings, 500, 50)

        mock_semantic_chunker_cls.assert_called_once_with(embeddings)
        assert result == mock_semantic_chunker_cls.return_value

    def test_recursive_uses_custom_chunk_size_and_overlap(self):
        mock_recursive_cls.reset_mock()

        embeddings = MagicMock()
        _get_text_splitter("recursive", embeddings, 2000, 200)

        mock_recursive_cls.assert_called_once_with(
            chunk_size=2000,
            chunk_overlap=200,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )


class TestProcessFileInMemoryChunkingStrategy:
    """Tests for chunking strategy configuration in process_file_in_memory()."""

    def setup_method(self):
        """Reset mocks before each test."""
        mock_recursive_cls.reset_mock()
        mock_semantic_chunker_cls.reset_mock()
        mock_fitz.reset_mock()

        # Clear any env vars set by previous tests
        for key in ["CHUNKING_STRATEGY", "CHUNK_SIZE", "CHUNK_OVERLAP"]:
            os.environ.pop(key, None)

    def _setup_basic_doc(self, text="This is a sufficiently long test document with enough content for chunking."):
        """Set up a basic 1-page document mock."""
        _create_mock_fitz_doc([text])

        # Make the text splitter return a chunk
        chunk_doc = Document(page_content=text)
        splitter_mock = MagicMock()
        splitter_mock.create_documents.return_value = [chunk_doc]
        mock_recursive_cls.return_value = splitter_mock
        mock_semantic_chunker_cls.return_value = splitter_mock
        return text

    def test_defaults_to_semantic_when_no_env_var(self):
        text = self._setup_basic_doc()

        chunks, full_text = process_file_in_memory(
            file_bytes=b"fake pdf content",
            file_id="test-file-id",
            filename="test.pdf",
            embeddings=MagicMock(),
        )

        mock_semantic_chunker_cls.assert_called_once()
        mock_recursive_cls.assert_not_called()

    def test_uses_recursive_when_env_var_set(self):
        os.environ["CHUNKING_STRATEGY"] = "recursive"
        text = self._setup_basic_doc()

        chunks, full_text = process_file_in_memory(
            file_bytes=b"fake pdf content",
            file_id="test-file-id",
            filename="test.pdf",
            embeddings=MagicMock(),
        )

        mock_recursive_cls.assert_called_once_with(
            chunk_size=1000,
            chunk_overlap=100,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )
        mock_semantic_chunker_cls.assert_not_called()

    def test_explicit_parameter_overrides_env_var(self):
        os.environ["CHUNKING_STRATEGY"] = "semantic"
        text = self._setup_basic_doc()

        chunks, full_text = process_file_in_memory(
            file_bytes=b"fake pdf content",
            file_id="test-file-id",
            filename="test.pdf",
            embeddings=MagicMock(),
            chunking_strategy="recursive",
            chunk_size=500,
            chunk_overlap=50,
        )

        mock_recursive_cls.assert_called_once_with(
            chunk_size=500,
            chunk_overlap=50,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )
        mock_semantic_chunker_cls.assert_not_called()

    def test_chunk_size_env_var_respected(self):
        os.environ["CHUNKING_STRATEGY"] = "recursive"
        os.environ["CHUNK_SIZE"] = "2000"
        os.environ["CHUNK_OVERLAP"] = "200"
        text = self._setup_basic_doc()

        chunks, full_text = process_file_in_memory(
            file_bytes=b"fake pdf content",
            file_id="test-file-id",
            filename="test.pdf",
            embeddings=MagicMock(),
        )

        mock_recursive_cls.assert_called_once_with(
            chunk_size=2000,
            chunk_overlap=200,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )

    def test_recursive_strategy_produces_valid_chunks_with_metadata(self):
        text = "This is a sufficiently long test document with enough content for chunking."
        _create_mock_fitz_doc([text])

        chunk_doc = Document(page_content=text)
        splitter_mock = MagicMock()
        splitter_mock.create_documents.return_value = [chunk_doc]
        mock_recursive_cls.return_value = splitter_mock

        chunks, full_text = process_file_in_memory(
            file_bytes=b"fake pdf content",
            file_id="test-file-id-123",
            filename="lecture.pdf",
            embeddings=MagicMock(),
            chunking_strategy="recursive",
            chunk_size=1000,
            chunk_overlap=100,
        )

        assert len(chunks) == 1
        assert chunks[0].metadata["file_id"] == "test-file-id-123"
        assert "source" in chunks[0].metadata
        assert "doc_id" in chunks[0].metadata
        assert "page_numbers" in chunks[0].metadata
        assert "chunk_index" in chunks[0].metadata
        assert "content_hash" in chunks[0].metadata
        assert full_text == text

    def test_file_id_still_mandatory_with_recursive_strategy(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            process_file_in_memory(
                file_bytes=b"fake",
                file_id="",
                filename="test.pdf",
                embeddings=MagicMock(),
                chunking_strategy="recursive",
            )
