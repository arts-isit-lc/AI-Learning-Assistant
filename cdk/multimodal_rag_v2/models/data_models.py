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
# Bumped 2026-07: enrichment vision + document-summary models moved from
# Claude 3 Haiku to Claude Haiku 4.5. Invalidates the enrichment cache =>
# next ingestion re-enriches affected elements.
ENRICHMENT_VERSION: str = "haiku45-v6-2026-07"
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


class VisionMode(Enum):
    """Structural mode of a VisionAnalysis: one image vs. several co-analyzed."""

    SINGLE = "single"
    MULTI = "multi"


class ResolutionConfidence(Enum):
    """Confidence that a parsed figure reference resolved to the intended image."""

    HIGH = "high"      # sibling-linked, or a single in-scope DB match
    MEDIUM = "medium"  # multiple candidates within the same module
    LOW = "low"        # candidates span multiple modules — may be the wrong figure


class ComparisonType(Enum):
    """The content type a structured comparison operates on.

    Used as the registry key that selects a resolver + comparator.
    """

    TABLE = "table"
    FORMULA = "formula"


class ComparisonIntent(Enum):
    """Prompt shape for a structured comparison: evaluative vs. side-by-side.

    Mirrors the multi-image feature's ``compare`` / ``describe_each`` intents but
    as a typed enum. v1 only produces COMPARE (comparison verb present); DESCRIBE
    is reserved for a future multi-referent-without-verb path.
    """

    COMPARE = "compare"
    DESCRIBE = "describe"


class EquationType(Enum):
    """Best-effort LEXICAL classification of a formula (token heuristics, NOT
    semantic parsing). May be UNKNOWN; must never be presented as authoritative."""

    SCALAR_EQUALITY = "scalar_equality"
    VECTOR_EQUATION = "vector_equation"
    MATRIX_EQUATION = "matrix_equation"
    OPTIMIZATION_OBJECTIVE = "optimization_objective"
    PROBABILITY_EXPRESSION = "probability_expression"
    RECURSIVE_DEFINITION = "recursive_definition"
    PIECEWISE = "piecewise"
    UNKNOWN = "unknown"


class EquivalenceStatus(Enum):
    """Symbolic-equivalence verdict. UNKNOWN = unparsed or undecided.

    In Phase 1 (lexical only) this is always UNKNOWN; Phase 2 (SymPy via
    math_compute) may set EQUIVALENT/NOT_EQUIVALENT.
    """

    EQUIVALENT = "equivalent"
    NOT_EQUIVALENT = "not_equivalent"
    UNKNOWN = "unknown"


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
class FormulaReference:
    """A reference to a formula/equation in course materials.

    A dedicated type — a formula is not a figure, so we do not overload
    FigureReference. (A future StructuredReference base could unify the
    reference types, but that migration is out of scope.)
    """

    number: str = ""   # "3.4" when the query gives one; "" for keyword-only refs
    keyword: str = ""  # matched token: "equation" | "eq" | "eqn" | "formula"


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
    # Multi-image reasoning (multi-figure comparison): figure_references holds ALL
    # distinct references parsed from the query in order; figure_reference remains
    # the first (or None) so single-reference consumers are unaffected.
    figure_references: list[FigureReference] = field(default_factory=list)
    requires_multi_image: bool = False  # True when >= 2 distinct references
    requires_comparison: bool = False   # True when comparison language AND multi-image
    # Table-native comparison: >= 2 distinct TABLE references AND comparison
    # language. Independent of the image path; when true the reasoning engine
    # runs the deterministic table comparator instead of image escalation.
    requires_table_comparison: bool = False
    # Formula-native comparison: comparison language AND (>= 2 numbered formula
    # references OR a formula-intent keyword). Sets formula flags only — never
    # requires_image. Resolution (numbered -> top-2 retrieved fallback) decides
    # which formulas are actually compared.
    formula_references: list[FormulaReference] = field(default_factory=list)
    requires_formula_comparison: bool = False


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
    # Set for the multi-image (MULTI) path so the retrieval handler can surface the
    # resolved figures (image_results union + wire image_analyses). None for SINGLE.
    vision_analysis: VisionAnalysis | None = None
    # Set for the table-native comparison path so the handler can union the
    # resolved tables into table_results. Additive; None for all other queries.
    structured_comparison: StructuredComparison | None = None


@dataclass
class ImageAnalysis:
    """Result of vision LLM analysis on an escalated image."""

    image_s3_key: str
    analysis: str
    confidence: float


@dataclass
class ResolvedReference:
    """Audit record mapping a requested figure reference to the image chosen for it.

    Recorded on every multi-image resolution so debugging "why did it compare the
    wrong two images?" is a data lookup, not a guess.
    """

    reference: str  # e.g. "Figure 2.1"
    retrieval_id: str
    image_s3_key: str
    confidence: ResolutionConfidence


@dataclass
class VisionAnalysis:
    """Product of a multi-image (MULTI) vision call over >= 2 co-presented figures.

    v1 uses this for the MULTI path only; the single-image path continues to return
    ImageAnalysis (see EscalationResult). SINGLE is reserved for a later migration
    that unifies both paths onto this model.
    """

    mode: VisionMode
    analysis: str
    confidence: float  # vision-model confidence in the analysis
    resolved_images: list[RankedResult] = field(default_factory=list)
    reference_mapping: list[ResolvedReference] = field(default_factory=list)
    prompt_intent: str = "describe_each"  # "compare" | "describe_each"


# ---------------------------------------------------------------------------
# Structured comparison (table-native) models
#
# Non-visual counterpart to VisionAnalysis: compares the STRUCTURED content of
# two referents (v1: tables) deterministically. The comparator is the source of
# truth — it computes `ComparisonFacts`; the LLM only explains them. No image
# bytes and no comparison LLM call are involved.
# ---------------------------------------------------------------------------


@dataclass
class ResolvedReferent:
    """One referenced item resolved to its structured content + confidence.

    ``structured_content`` is the ONLY input the comparator reads (a plain dict,
    e.g. {headers, rows, summary} for a table) — keeping the comparator pure and
    testable without retrieval-layer objects. ``result`` carries the full
    RankedResult purely for the retrieval handler's display union (table_results)
    and MUST NOT be read by the comparator.
    """

    reference: str  # e.g. "Table 2.1"
    retrieval_id: str
    parent_element_id: str
    confidence: ResolutionConfidence
    structured_content: dict[str, Any] = field(default_factory=dict)
    result: RankedResult | None = None


@dataclass
class TableShape:
    """Per-referent shape/columns of a table (N-way-ready)."""

    label: str
    n_rows: int
    n_cols: int
    columns: list[str] = field(default_factory=list)


@dataclass
class RowAlignmentResult:
    """Result of aligning rows across referents on a chosen key column.

    ``differing_cells`` is bounded; ``unaligned_by_label`` maps each referent's
    label to how many of its keys were not shared by all referents.
    """

    key_columns: list[str] = field(default_factory=list)
    aligned_rows: int = 0
    differing_cells: list[dict[str, Any]] = field(default_factory=list)
    unaligned_by_label: dict[str, int] = field(default_factory=dict)


@dataclass
class ComparisonFacts:
    """Base/marker for the typed facts a comparator produces."""


@dataclass
class TableComparisonFacts(ComparisonFacts):
    """Deterministic, verified diff between tables (N-way-ready)."""

    per_referent: list[TableShape] = field(default_factory=list)
    shared_columns: list[str] = field(default_factory=list)
    unique_columns: dict[str, list[str]] = field(default_factory=dict)
    row_alignment: RowAlignmentResult | None = None


@dataclass
class EquivalenceResult:
    """Symbolic-equivalence verdict for a formula pair (Tier 2 fills this)."""

    status: EquivalenceStatus = EquivalenceStatus.UNKNOWN
    method: str = ""   # e.g. "sympy simplify(a-b)==0"
    reason: str = ""   # short, for observability/grounding


@dataclass
class FormulaProfile:
    """Per-referent lexical profile of a formula (N-way-ready).

    Raw + normalized token streams are retained so future similarity metrics
    (Jaccard, TF-IDF, edit distance, tree matching) need not re-tokenize.
    """

    label: str
    variables: list[str] = field(default_factory=list)
    constants: list[str] = field(default_factory=list)
    operators: list[str] = field(default_factory=list)
    functions: list[str] = field(default_factory=list)
    greek: list[str] = field(default_factory=list)
    equation_type: EquationType = EquationType.UNKNOWN  # best-effort lexical
    tokens: list[str] = field(default_factory=list)
    normalized_tokens: list[str] = field(default_factory=list)


@dataclass
class FormulaComparisonFacts(ComparisonFacts):
    """Deterministic lexical diff between formulas (N-way-ready).

    ``equivalence`` is UNKNOWN in Phase 1 (lexical only); Phase 2 may fill it.
    """

    per_referent: list[FormulaProfile] = field(default_factory=list)
    # category -> shared values across ALL referents (variables/functions/...)
    shared: dict[str, list[str]] = field(default_factory=dict)
    # label -> {category -> values unique to that referent}
    unique: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    equivalence: EquivalenceResult = field(default_factory=EquivalenceResult)


@dataclass
class StructuredComparison:
    """Product of a structured comparison over >= 1 resolved referents.

    ``referents`` are the comparator inputs (and grounding labels/confidence);
    ``resolved_results`` exposes the full RankedResults for the handler's
    display union. Mirrors VisionAnalysis (referents/facts vs. resolved images).
    """

    comparison_type: ComparisonType
    intent: ComparisonIntent
    referents: list[ResolvedReferent] = field(default_factory=list)
    facts: ComparisonFacts | None = None
    degraded: bool = False

    @property
    def resolved_results(self) -> list[RankedResult]:
        """Full RankedResults for the referents (for the display union)."""
        return [r.result for r in self.referents if r.result is not None]


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
