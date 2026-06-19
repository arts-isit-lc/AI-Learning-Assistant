"""Unit tests for IRPersistence — persist, load, error handling, and version coexistence."""

from __future__ import annotations

import base64
import io
import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from ..models.data_models import (
    DocumentIR,
    ElementType,
    FileMetadata,
    IRElement,
    IR_VERSION,
    Provenance,
)
from .exceptions import IRNotFoundError
from .ir_persistence import IRPersistence


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


def _make_file_metadata(
    course_id: str = "CS101",
    module_id: str = "module1",
    file_id: str = "file-abc",
) -> FileMetadata:
    return FileMetadata(
        course_id=course_id,
        module_id=module_id,
        file_id=file_id,
        file_key=f"courses/{course_id}/{module_id}/{file_id}.pdf",
        file_size=5000,
        extension="pdf",
    )


def _make_text_element(
    content: str = "Hello world",
    page_num: int = 1,
    position_index: int = 0,
) -> IRElement:
    return IRElement(
        element_id="elem-text-001",
        content=content,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=page_num, position_index=position_index),
        content_hash="hash-text-001",
        metadata={"key": "value"},
    )


def _make_image_element(
    content: bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50,
    page_num: int = 2,
    position_index: int = 1,
) -> IRElement:
    return IRElement(
        element_id="elem-img-001",
        content=content,
        element_type=ElementType.IMAGE,
        provenance=Provenance(page_num=page_num, position_index=position_index),
        content_hash="hash-img-001",
        metadata={"width": 200, "height": 150},
    )


def _make_document_ir(
    elements: list[IRElement] | None = None,
    ir_version: str = IR_VERSION,
) -> DocumentIR:
    fm = _make_file_metadata()
    if elements is None:
        elements = [_make_text_element(), _make_image_element()]
    element_count = {}
    for el in elements:
        element_count[el.element_type] = element_count.get(el.element_type, 0) + 1
    return DocumentIR(
        file_metadata=fm,
        elements=elements,
        element_count=element_count,
        ir_version=ir_version,
    )


class FakeS3Client:
    """In-memory S3 client for testing without network calls."""

    def __init__(self) -> None:
        self._store: dict[str, dict[str, bytes]] = {}

    def put_object(self, Bucket: str, Key: str, Body: bytes, **kwargs) -> dict:
        if Bucket not in self._store:
            self._store[Bucket] = {}
        self._store[Bucket][Key] = Body
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def get_object(self, Bucket: str, Key: str) -> dict:
        if Bucket not in self._store or Key not in self._store[Bucket]:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "Not Found"}},
                "GetObject",
            )
        body = self._store[Bucket][Key]
        return {"Body": io.BytesIO(body)}


@pytest.fixture
def fake_s3() -> FakeS3Client:
    return FakeS3Client()


@pytest.fixture
def persistence(fake_s3: FakeS3Client) -> IRPersistence:
    return IRPersistence(bucket_name="test-ir-bucket", s3_client=fake_s3)


# ---------------------------------------------------------------------------
# Tests for persist()
# ---------------------------------------------------------------------------


class TestPersist:
    def test_persist_returns_s3_path(self, persistence: IRPersistence) -> None:
        doc_ir = _make_document_ir()
        path = persistence.persist(doc_ir)
        expected = f"s3://test-ir-bucket/CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        assert path == expected

    def test_persist_stores_valid_json(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        doc_ir = _make_document_ir()
        persistence.persist(doc_ir)
        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        stored_bytes = fake_s3._store["test-ir-bucket"][key]
        data = json.loads(stored_bytes.decode("utf-8"))
        assert data["ir_version"] == IR_VERSION
        assert len(data["elements"]) == 2

    def test_persist_base64_encodes_binary_content(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        binary_content = b"\x89PNG\r\n\x1a\n" + b"\xab\xcd" * 20
        element = IRElement(
            element_id="elem-bin",
            content=binary_content,
            element_type=ElementType.IMAGE,
            provenance=Provenance(page_num=1, position_index=0),
            content_hash="hash-bin",
        )
        doc_ir = _make_document_ir(elements=[element])
        persistence.persist(doc_ir)

        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        data = json.loads(fake_s3._store["test-ir-bucket"][key].decode("utf-8"))
        el_data = data["elements"][0]
        assert el_data["content_is_binary"] is True
        # Verify it's valid base64 that decodes to the original
        decoded = base64.b64decode(el_data["content"])
        assert decoded == binary_content

    def test_persist_string_content_stored_directly(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        doc_ir = _make_document_ir(elements=[_make_text_element(content="some text")])
        persistence.persist(doc_ir)

        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        data = json.loads(fake_s3._store["test-ir-bucket"][key].decode("utf-8"))
        el_data = data["elements"][0]
        assert el_data["content"] == "some text"
        assert el_data["content_is_binary"] is False

    def test_persist_uses_sse_s3_encryption(self, fake_s3: FakeS3Client) -> None:
        """Verify ServerSideEncryption=AES256 is passed to put_object."""
        mock_s3 = MagicMock()
        persistence = IRPersistence(bucket_name="test-bucket", s3_client=mock_s3)
        doc_ir = _make_document_ir()
        persistence.persist(doc_ir)
        call_kwargs = mock_s3.put_object.call_args[1]
        assert call_kwargs["ServerSideEncryption"] == "AES256"

    def test_persist_serializes_element_type_as_value(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        doc_ir = _make_document_ir(elements=[_make_text_element()])
        persistence.persist(doc_ir)

        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        data = json.loads(fake_s3._store["test-ir-bucket"][key].decode("utf-8"))
        assert data["elements"][0]["element_type"] == "text"

    def test_persist_serializes_provenance_as_dict(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        element = IRElement(
            element_id="elem-prov",
            content="text",
            element_type=ElementType.TEXT,
            provenance=Provenance(page_num=3, slide_num=None, section="intro", position_index=5),
            content_hash="hash-prov",
        )
        doc_ir = _make_document_ir(elements=[element])
        persistence.persist(doc_ir)

        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        data = json.loads(fake_s3._store["test-ir-bucket"][key].decode("utf-8"))
        prov = data["elements"][0]["provenance"]
        assert prov["page_num"] == 3
        assert prov["slide_num"] is None
        assert prov["section"] == "intro"
        assert prov["position_index"] == 5


# ---------------------------------------------------------------------------
# Tests for load()
# ---------------------------------------------------------------------------


class TestLoad:
    def test_load_returns_equivalent_document_ir(
        self, persistence: IRPersistence
    ) -> None:
        original = _make_document_ir()
        persistence.persist(original)
        loaded = persistence.load("CS101", "module1", "file-abc")

        # FileMetadata equivalence
        assert loaded.file_metadata.course_id == original.file_metadata.course_id
        assert loaded.file_metadata.module_id == original.file_metadata.module_id
        assert loaded.file_metadata.file_id == original.file_metadata.file_id
        assert loaded.file_metadata.file_key == original.file_metadata.file_key
        assert loaded.file_metadata.file_size == original.file_metadata.file_size
        assert loaded.file_metadata.extension == original.file_metadata.extension

        # Elements equivalence
        assert len(loaded.elements) == len(original.elements)
        assert loaded.ir_version == original.ir_version

    def test_load_preserves_text_element_fields(
        self, persistence: IRPersistence
    ) -> None:
        original = _make_document_ir(elements=[_make_text_element()])
        persistence.persist(original)
        loaded = persistence.load("CS101", "module1", "file-abc")

        elem = loaded.elements[0]
        orig_elem = original.elements[0]
        assert elem.element_id == orig_elem.element_id
        assert elem.content == orig_elem.content
        assert elem.element_type == orig_elem.element_type
        assert elem.content_hash == orig_elem.content_hash
        assert elem.provenance.page_num == orig_elem.provenance.page_num
        assert elem.provenance.position_index == orig_elem.provenance.position_index
        assert elem.metadata == orig_elem.metadata

    def test_load_preserves_binary_content(self, persistence: IRPersistence) -> None:
        binary_data = b"\x00\x01\x02\xff" * 100
        element = IRElement(
            element_id="elem-bin",
            content=binary_data,
            element_type=ElementType.IMAGE,
            provenance=Provenance(page_num=1, position_index=0),
            content_hash="hash-bin",
        )
        original = _make_document_ir(elements=[element])
        persistence.persist(original)
        loaded = persistence.load("CS101", "module1", "file-abc")

        assert isinstance(loaded.elements[0].content, bytes)
        assert loaded.elements[0].content == binary_data

    def test_load_preserves_element_count(self, persistence: IRPersistence) -> None:
        original = _make_document_ir()
        persistence.persist(original)
        loaded = persistence.load("CS101", "module1", "file-abc")
        assert loaded.element_count == original.element_count

    def test_load_missing_document_raises_ir_not_found_error(
        self, persistence: IRPersistence
    ) -> None:
        with pytest.raises(IRNotFoundError) as exc_info:
            persistence.load("CS999", "module-nonexist", "file-missing")
        err = exc_info.value
        assert err.course_id == "CS999"
        assert err.module_id == "module-nonexist"
        assert err.file_id == "file-missing"
        assert "not found" in err.reason

    def test_load_corrupted_json_raises_ir_not_found_error(
        self, fake_s3: FakeS3Client
    ) -> None:
        persistence = IRPersistence(bucket_name="test-ir-bucket", s3_client=fake_s3)
        # Manually put corrupted JSON
        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        fake_s3._store.setdefault("test-ir-bucket", {})[key] = b"not valid json {{"

        with pytest.raises(IRNotFoundError) as exc_info:
            persistence.load("CS101", "module1", "file-abc")
        assert "corrupted" in exc_info.value.reason

    def test_load_malformed_structure_raises_ir_not_found_error(
        self, fake_s3: FakeS3Client
    ) -> None:
        persistence = IRPersistence(bucket_name="test-ir-bucket", s3_client=fake_s3)
        # Valid JSON but missing required fields
        key = f"CS101/module1/file-abc/ir_v{IR_VERSION}/document_ir.json"
        invalid_data = json.dumps({"some_field": "value"}).encode("utf-8")
        fake_s3._store.setdefault("test-ir-bucket", {})[key] = invalid_data

        with pytest.raises(IRNotFoundError) as exc_info:
            persistence.load("CS101", "module1", "file-abc")
        assert "deserialization" in exc_info.value.reason

    def test_load_with_explicit_ir_version(self, persistence: IRPersistence) -> None:
        doc_ir = _make_document_ir(ir_version="custom-v2")
        persistence.persist(doc_ir)
        loaded = persistence.load("CS101", "module1", "file-abc", ir_version="custom-v2")
        assert loaded.ir_version == "custom-v2"

    def test_load_default_version_uses_ir_version_constant(
        self, persistence: IRPersistence
    ) -> None:
        doc_ir = _make_document_ir(ir_version=IR_VERSION)
        persistence.persist(doc_ir)
        # load() without explicit version should use IR_VERSION
        loaded = persistence.load("CS101", "module1", "file-abc")
        assert loaded.ir_version == IR_VERSION


# ---------------------------------------------------------------------------
# Tests for version coexistence
# ---------------------------------------------------------------------------


class TestVersionCoexistence:
    def test_different_versions_stored_at_different_paths(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        """Different ir_versions are stored at distinct paths without overwriting."""
        doc_v1 = _make_document_ir(ir_version="v1")
        doc_v2 = _make_document_ir(ir_version="v2")

        path_v1 = persistence.persist(doc_v1)
        path_v2 = persistence.persist(doc_v2)

        assert path_v1 != path_v2
        assert "ir_vv1" in path_v1
        assert "ir_vv2" in path_v2

        # Both are accessible
        loaded_v1 = persistence.load("CS101", "module1", "file-abc", ir_version="v1")
        loaded_v2 = persistence.load("CS101", "module1", "file-abc", ir_version="v2")
        assert loaded_v1.ir_version == "v1"
        assert loaded_v2.ir_version == "v2"

    def test_persisting_new_version_does_not_overwrite_old(
        self, persistence: IRPersistence, fake_s3: FakeS3Client
    ) -> None:
        """Storing a new version doesn't affect the old version's data."""
        text_el = _make_text_element(content="Version 1 content")
        doc_v1 = _make_document_ir(elements=[text_el], ir_version="old-v1")
        persistence.persist(doc_v1)

        text_el_v2 = _make_text_element(content="Version 2 content")
        doc_v2 = _make_document_ir(elements=[text_el_v2], ir_version="new-v2")
        persistence.persist(doc_v2)

        # Old version still returns original content
        loaded_v1 = persistence.load("CS101", "module1", "file-abc", ir_version="old-v1")
        assert loaded_v1.elements[0].content == "Version 1 content"

        # New version has updated content
        loaded_v2 = persistence.load("CS101", "module1", "file-abc", ir_version="new-v2")
        assert loaded_v2.elements[0].content == "Version 2 content"


# ---------------------------------------------------------------------------
# Tests for error handling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    def test_s3_permission_error_raises_ir_not_found_error(self) -> None:
        """Non-NoSuchKey S3 errors also result in IRNotFoundError."""
        mock_s3 = MagicMock()
        mock_s3.get_object.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "Access Denied"}},
            "GetObject",
        )
        persistence = IRPersistence(bucket_name="test-bucket", s3_client=mock_s3)
        with pytest.raises(IRNotFoundError) as exc_info:
            persistence.load("CS101", "module1", "file-abc")
        assert "S3 error" in exc_info.value.reason

    def test_load_never_raises_unhandled_exception_for_known_errors(self) -> None:
        """S3 errors, JSON errors, and deserialization errors are all caught."""
        mock_s3 = MagicMock()
        mock_s3.get_object.side_effect = ClientError(
            {"Error": {"Code": "InternalError", "Message": "Internal"}},
            "GetObject",
        )
        persistence = IRPersistence(bucket_name="test-bucket", s3_client=mock_s3)
        # Should raise IRNotFoundError, not raw ClientError
        with pytest.raises(IRNotFoundError):
            persistence.load("CS101", "module1", "file-abc")


# ---------------------------------------------------------------------------
# Tests for empty document
# ---------------------------------------------------------------------------


class TestEmptyDocument:
    def test_persist_and_load_empty_elements(self, persistence: IRPersistence) -> None:
        """A DocumentIR with zero elements can round-trip correctly."""
        doc_ir = _make_document_ir(elements=[])
        persistence.persist(doc_ir)
        loaded = persistence.load("CS101", "module1", "file-abc")
        assert loaded.elements == []
        assert loaded.element_count == {}
