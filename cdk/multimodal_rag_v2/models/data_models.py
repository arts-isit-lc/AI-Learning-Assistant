"""Data models and enums for the multimodal RAG V2 pipeline.

All dataclasses used across layers are defined here to maintain a single
source of truth and avoid circular imports.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ---------------------------------------------------------------------------
# Version constants
# ---------------------------------------------------------------------------

IR_VERSION: str = "ir-v1"
ENRICHMENT_VERSION: str = "haiku-v5-2026-06"
EMBEDDING_VERSION: str = "titan-v2-1024"


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ElementType(Enum):
    """Types of content elements extracted from documents."""

    TEXT = "text"
    IMAGE = "image"
    TABLE = "table"
    FORMULA = "formula"


# ---------------------------------------------------------------------------
# Layer 1: Ingestion data models
# ---------------------------------------------------------------------------


@dataclass
class FileMetadata:
    """Metadata about an uploaded file."""

    course_id: str
    module_id: str
    file_id: str
    file_key: str
    file_size: int
    extension: str


@dataclass
class Provenance:
    """Source location within a document."""

    page_num: int | None = None
    slide_num: int | None = None
    section: str | None = None
    position_index: int = 0


@dataclass
class RawElement:
    """An element extracted by an adapter before normalization."""

    content: bytes | str
    element_type: ElementType
    provenance: Provenance
    raw_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class IRElement:
    """A normalized element within the DocumentIR."""

    element_id: str  # SHA256(content + provenance)
    content: bytes | str
    element_type: ElementType
    provenance: Provenance
    content_hash: str  # SHA256(content) for deduplication
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class DocumentIR:
    """Intermediate representation of a parsed document."""

    file_metadata: FileMetadata
    elements: list[IRElement]
    element_count: dict[ElementType, int] = field(default_factory=dict)
    ir_version: str = IR_VERSION


# ---------------------------------------------------------------------------
# Layer 2: Enrichment data models
# ---------------------------------------------------------------------------


@dataclass
class EnrichedElement:
    """An IRElement after enrichment processing."""

    element_id: str
    element_type: ElementType
    provenance: Provenance
    embedding_text: str
    # Topics/labels/keywords: only for IMAGE, TABLE, and raster FORMULA (not TEXT)
    topics: list[str] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    source_ref: str = ""
    image_s3_key: str | None = None
    # Formula-specific
    formula_text: str | None = None
    latex_repr: str | None = None
    formula_concepts: list[str] = field(default_factory=list)
    # Table-specific
    table_headers: list[str] = field(default_factory=list)
    table_rows: list[list[str]] = field(default_factory=list)
    table_summary: str | None = None
    # Image-specific
    image_type: str | None = None
    image_description: str | None = None
    # Context
    file_id: str = ""
    course_id: str = ""
    module_id: str = ""
    enrichment_version: str = ""
    # True when this element is a degraded/fallback result (enrichment failed,
    # was throttled past retries, or hit the visual cap). Fallbacks must NOT be
    # cached (L6) — otherwise a transient failure becomes sticky across
    # re-ingestions. New trailing field with a default: backward-compatible with
    # already-cached items (missing key -> default False on deserialize).
    is_fallback: bool = False


@dataclass
class RetrievalUnit:
    """A searchable unit stored in pgvector. One IRElement can produce multiple RetrievalUnits."""

    retrieval_id: str
    parent_element_id: str
    embedding_text: str
    element_type: ElementType
    provenance: Provenance
    metadata: dict[str, Any] = field(default_factory=dict)
    sibling_ids: list[str] = field(default_factory=list)
    embedding_version: str = ""


# ---------------------------------------------------------------------------
# Layer 3: Retrieval data models
# ---------------------------------------------------------------------------


@dataclass
class FigureReference:
    """A structured reference to a figure, table, or algorithm in course materials."""

    ref_type: str  # "figure", "table", "algorithm"
    number: str    # "1.1", "2.3", "4"


@dataclass
class QueryIntent:
    """Structured output of QueryAnalyzer."""

    needs_summary: bool = False
    requires_image: bool = False
    requires_formula: bool = False
    requires_table: bool = False
    requires_escalation: bool = False
    requires_figure_lookup: bool = False
    lecture_number: int | None = None
    week_number: int | None = None
    figure_reference: FigureReference | None = None


@dataclass
class TypeCaps:
    """Per-type limits on results returned."""

    max_text: int = 8
    max_image: int = 4
    max_formula: int = 3
    max_table: int = 2


@dataclass
class MergedResult:
    """Result after reciprocal rank fusion of vector + BM25 searches."""

    retrieval_id: str
    parent_element_id: str
    content: str
    element_type: ElementType
    rrf_score: float
    vector_score: float
    keyword_score: float
    cross_encoder_score: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    sibling_ids: list[str] = field(default_factory=list)


@dataclass
class RankedResult:
    """Final ranked result after production ranking."""

    retrieval_id: str
    parent_element_id: str
    content: str
    element_type: ElementType
    score: float
    cross_encoder_score: float
    metadata_boost: float
    metadata: dict[str, Any] = field(default_factory=dict)
    image_s3_key: str | None = None
    sibling_ids: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Layer 4: Reasoning data models
# ---------------------------------------------------------------------------


@dataclass
class StructuredContext:
    """Context assembled for the reasoning engine."""

    text_passages: list[RankedResult] = field(default_factory=list)
    image_descriptions: list[RankedResult] = field(default_factory=list)
    formula_results: list[RankedResult] = field(default_factory=list)
    table_results: list[RankedResult] = field(default_factory=list)
    token_count: int = 0


@dataclass
class ContextCluster:
    """A cluster of related elements grouped by source."""

    primary_element: RankedResult | None = None
    related_elements: list[RankedResult] = field(default_factory=list)
    relationship_note: str = ""
    module_context: str = ""
    token_cost: int = 0


@dataclass
class ReasoningResult:
    """Output of the reasoning engine."""

    answer: str
    sources: list[str]
    escalation_used: bool = False
    image_analyses: list[ImageAnalysis] = field(default_factory=list)


@dataclass
class ImageAnalysis:
    """Result of vision LLM analysis on an escalated image."""

    image_s3_key: str
    analysis: str
    confidence: float


# ---------------------------------------------------------------------------
# Document-level models
# ---------------------------------------------------------------------------


@dataclass
class DocumentSummary:
    """Document-level summary for 'What's in Lecture X?' queries."""

    file_id: str
    topics: list[str]
    summary: str
    learning_objectives: list[str] = field(default_factory=list)
    enrichment_version: str = ""


@dataclass
class DocumentMetadata:
    """Structured metadata for exact-match filtered retrieval."""

    file_id: str
    title: str | None = None
    lecture_number: int | None = None
    week: int | None = None
    module_name: str = ""
    source_type: str = ""
    page_count: int = 0
    upload_date: str = ""
