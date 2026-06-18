"""Unit tests for mandatory file_id enforcement in chunk metadata (Task 2.3).

Requirements validated: 1.1, 1.2, 1.3
"""

import hashlib
import sys
import os
from unittest.mock import MagicMock, patch

import pytest

# Add src to path so we can import the module under test
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# Must set env var before importing documents module
os.environ.setdefault("EMBEDDING_BUCKET_NAME", "test-embedding-bucket")

# Mock heavy dependencies that are not installed in the test environment
sys.modules.setdefault("boto3", MagicMock())
sys.modules.setdefault("botocore", MagicMock())
sys.modules.setdefault("fitz", MagicMock())
sys.modules.setdefault("langchain_postgres", MagicMock())
sys.modules.setdefault("langchain_aws", MagicMock())
sys.modules.setdefault("langchain_experimental", MagicMock())
sys.modules.setdefault("langchain_experimental.text_splitter", MagicMock())

sys.modules.setdefault("aws_lambda_powertools", MagicMock())

# Define a real Document class for tests — langchain_core may not be installed,
# or may already be mocked by another test module in the same pytest session.
class Document:
    def __init__(self, page_content="", metadata=None):
        self.page_content = page_content
        self.metadata = metadata or {}


# Ensure the mock langchain_core.documents module exposes our real Document class
# so that store_doc_chunks can filter/process chunks correctly.
if "langchain_core" not in sys.modules:
    sys.modules["langchain_core"] = MagicMock()
if "langchain_core.documents" not in sys.modules:
    sys.modules["langchain_core.documents"] = MagicMock()
sys.modules["langchain_core.documents"].Document = Document

from processing.documents import store_doc_chunks, add_document, process_documents


class TestStoreDocChunksFileIdValidation:
    """Tests for mandatory file_id enforcement in store_doc_chunks()."""

    def test_raises_value_error_when_file_id_is_none(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            store_doc_chunks(
                bucket="test-bucket",
                filenames=["test_file_page_1.txt"],
                vectorstore=MagicMock(),
                embeddings=MagicMock(),
                file_id=None,
            )

    def test_raises_value_error_when_file_id_is_empty_string(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            store_doc_chunks(
                bucket="test-bucket",
                filenames=["test_file_page_1.txt"],
                vectorstore=MagicMock(),
                embeddings=MagicMock(),
                file_id="",
            )

    @patch("processing.documents.s3")
    @patch("processing.documents.SemanticChunker")
    def test_all_chunks_have_file_id_in_metadata(self, mock_chunker_cls, mock_s3):
        # Set up mock S3 to return text content
        mock_s3.download_fileobj.side_effect = lambda bucket, key, buf: buf.write(b"Some document text content for testing.")

        # Set up mock chunker to produce chunks
        mock_chunker = MagicMock()
        mock_chunker.create_documents.return_value = [
            Document(page_content="chunk one text here"),
            Document(page_content="chunk two text here"),
        ]
        mock_chunker_cls.return_value = mock_chunker

        result = store_doc_chunks(
            bucket="test-bucket",
            filenames=["course/module/documents/file.pdf_page_1.txt"],
            vectorstore=MagicMock(),
            embeddings=MagicMock(),
            file_id="test-file-id-123",
        )

        assert len(result) == 2
        for chunk in result:
            assert chunk.metadata["file_id"] == "test-file-id-123"

    @patch("processing.documents.s3")
    @patch("processing.documents.SemanticChunker")
    def test_all_chunks_have_required_metadata_fields(self, mock_chunker_cls, mock_s3):
        mock_s3.download_fileobj.side_effect = lambda bucket, key, buf: buf.write(b"Document text content.")

        mock_chunker = MagicMock()
        mock_chunker.create_documents.return_value = [
            Document(page_content="test chunk content"),
        ]
        mock_chunker_cls.return_value = mock_chunker

        result = store_doc_chunks(
            bucket="test-bucket",
            filenames=["course/module/documents/file.pdf_page_3.txt"],
            vectorstore=MagicMock(),
            embeddings=MagicMock(),
            file_id="file-uuid-456",
        )

        assert len(result) == 1
        chunk = result[0]

        # Requirement 1.1: file_id present unconditionally
        assert chunk.metadata["file_id"] == "file-uuid-456"
        # Requirement 1.3: source, doc_id, page_numbers, chunk_index, content_hash
        assert "source" in chunk.metadata
        assert "doc_id" in chunk.metadata
        assert "page_numbers" in chunk.metadata
        assert "chunk_index" in chunk.metadata
        assert "content_hash" in chunk.metadata

    @patch("processing.documents.s3")
    @patch("processing.documents.SemanticChunker")
    def test_content_hash_is_sha256_of_chunk_text(self, mock_chunker_cls, mock_s3):
        chunk_text = "specific text for hashing"
        expected_hash = hashlib.sha256(chunk_text.encode('utf-8')).hexdigest()

        mock_s3.download_fileobj.side_effect = lambda bucket, key, buf: buf.write(b"raw page text")

        mock_chunker = MagicMock()
        mock_chunker.create_documents.return_value = [
            Document(page_content=chunk_text),
        ]
        mock_chunker_cls.return_value = mock_chunker

        result = store_doc_chunks(
            bucket="test-bucket",
            filenames=["doc.pdf_page_1.txt"],
            vectorstore=MagicMock(),
            embeddings=MagicMock(),
            file_id="file-id-abc",
        )

        assert result[0].metadata["content_hash"] == expected_hash

    @patch("processing.documents.s3")
    @patch("processing.documents.SemanticChunker")
    def test_page_number_extracted_from_filename(self, mock_chunker_cls, mock_s3):
        mock_s3.download_fileobj.side_effect = lambda bucket, key, buf: buf.write(b"page text")

        mock_chunker = MagicMock()
        mock_chunker.create_documents.return_value = [
            Document(page_content="chunk text"),
        ]
        mock_chunker_cls.return_value = mock_chunker

        result = store_doc_chunks(
            bucket="test-bucket",
            filenames=["course/module/documents/lecture.pdf_page_5.txt"],
            vectorstore=MagicMock(),
            embeddings=MagicMock(),
            file_id="file-id-xyz",
        )

        assert result[0].metadata["page_numbers"] == [5]

    @patch("processing.documents.s3")
    @patch("processing.documents.SemanticChunker")
    def test_chunk_index_increments_across_pages(self, mock_chunker_cls, mock_s3):
        mock_s3.download_fileobj.side_effect = lambda bucket, key, buf: buf.write(b"page text")

        mock_chunker = MagicMock()
        # First page produces 2 chunks, second page produces 1 chunk
        mock_chunker.create_documents.side_effect = [
            [Document(page_content="chunk A"), Document(page_content="chunk B")],
            [Document(page_content="chunk C")],
        ]
        mock_chunker_cls.return_value = mock_chunker

        result = store_doc_chunks(
            bucket="test-bucket",
            filenames=[
                "doc.pdf_page_1.txt",
                "doc.pdf_page_2.txt",
            ],
            vectorstore=MagicMock(),
            embeddings=MagicMock(),
            file_id="file-id-multi",
        )

        assert len(result) == 3
        assert result[0].metadata["chunk_index"] == 0
        assert result[1].metadata["chunk_index"] == 1
        assert result[2].metadata["chunk_index"] == 2


class TestAddDocumentFileIdValidation:
    """Tests for mandatory file_id enforcement in add_document()."""

    def test_raises_value_error_when_file_id_is_none(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            add_document(
                bucket="test-bucket",
                course="CS101",
                module="mod-123",
                filename="notes.pdf",
                vectorstore=MagicMock(),
                embeddings=MagicMock(),
                file_id=None,
            )

    def test_raises_value_error_when_file_id_is_empty(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            add_document(
                bucket="test-bucket",
                course="CS101",
                module="mod-123",
                filename="notes.pdf",
                vectorstore=MagicMock(),
                embeddings=MagicMock(),
                file_id="",
            )


class TestProcessDocumentsFileIdValidation:
    """Tests for mandatory file_id enforcement in process_documents()."""

    def test_raises_value_error_when_file_id_is_none(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            process_documents(
                bucket="test-bucket",
                course="CS101",
                module="mod-123",
                vectorstore=MagicMock(),
                embeddings=MagicMock(),
                record_manager=MagicMock(),
                file_id=None,
            )

    def test_raises_value_error_when_file_id_is_empty(self):
        with pytest.raises(ValueError, match="file_id is mandatory"):
            process_documents(
                bucket="test-bucket",
                course="CS101",
                module="mod-123",
                vectorstore=MagicMock(),
                embeddings=MagicMock(),
                record_manager=MagicMock(),
                file_id="",
            )
