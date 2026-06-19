"""FormulaService: LaTeX parsing for text-layer formulas, vision fallback for raster.

For TEXT-LAYER formulas (content is str): parses LaTeX directly without LLM.
For RASTER-ONLY formulas (content is bytes): delegates to VisionService for fallback.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    IRElement,
)

if TYPE_CHECKING:
    from .vision_service import VisionService

logger = Logger(service="multimodal-rag-enrichment")

# Common LaTeX command patterns mapped to readable concepts
_CONCEPT_PATTERNS: list[tuple[str, str]] = [
    (r"\\frac", "fraction"),
    (r"\\int", "integral"),
    (r"\\sum", "summation"),
    (r"\\prod", "product"),
    (r"\\lim", "limit"),
    (r"\\sqrt", "square root"),
    (r"\\partial", "partial derivative"),
    (r"\\nabla", "gradient"),
    (r"\\infty", "infinity"),
    (r"\\matrix|\\bmatrix|\\pmatrix", "matrix"),
    (r"\\vec|\\mathbf", "vector"),
    (r"\\sin|\\cos|\\tan|\\cot|\\sec|\\csc", "trigonometry"),
    (r"\\log|\\ln", "logarithm"),
    (r"\\exp|e\^", "exponential"),
    (r"\\det", "determinant"),
    (r"\\binom", "binomial"),
    (r"\\sigma|\\mu|\\bar", "statistics"),
    (r"\\forall|\\exists", "logic"),
    (r"\\cup|\\cap|\\subset|\\in(?!t)", "set theory"),
    (r"\\rightarrow|\\Rightarrow|\\implies", "implication"),
    (r"\\equiv|\\approx|\\sim", "equivalence"),
    (r"P\\\(|Pr\\\(|\\mathbb\{P\}", "probability"),
    (r"\\alpha|\\beta|\\gamma|\\delta|\\epsilon|\\theta|\\lambda|\\omega", "greek notation"),
]


class FormulaService:
    """Enriches FORMULA elements.

    Text-layer formulas (str content) are parsed directly without LLM calls.
    Raster-only formulas (bytes content) use VisionService as fallback.
    """

    def __init__(self, vision_service: VisionService | None = None) -> None:
        """Initialize FormulaService.

        Args:
            vision_service: Optional VisionService instance for raster fallback.
        """
        self._vision_service = vision_service

    def enrich(self, element: IRElement) -> EnrichedElement:
        """Enrich a FORMULA element.

        Args:
            element: An IRElement with element_type=FORMULA.

        Returns:
            EnrichedElement with formula_text, latex_repr, and formula_concepts.

        Raises:
            Exception: On vision fallback failure for raster formulas.
                ElementRouter handles fallback logic.
        """
        if isinstance(element.content, bytes):
            return self._enrich_raster(element)
        return self._enrich_text_layer(element)

    def _enrich_text_layer(self, element: IRElement) -> EnrichedElement:
        """Parse text-layer LaTeX directly without LLM.

        Args:
            element: An IRElement with string content containing LaTeX.

        Returns:
            EnrichedElement with parsed formula fields.
        """
        latex_content = element.content if isinstance(element.content, str) else element.content.decode("utf-8")

        latex_repr = latex_content.strip()
        formula_text = self._latex_to_readable(latex_repr)
        formula_concepts = self._extract_concepts(latex_repr)

        embedding_text = f"Formula: {formula_text}" if formula_text else f"Formula: {latex_repr}"

        logger.info(
            "Parsed text-layer formula",
            extra={
                "element_id": element.element_id,
                "concepts_count": len(formula_concepts),
            },
        )

        return EnrichedElement(
            element_id=element.element_id,
            element_type=ElementType.FORMULA,
            provenance=element.provenance,
            embedding_text=embedding_text,
            formula_text=formula_text,
            latex_repr=latex_repr,
            formula_concepts=formula_concepts,
            enrichment_version=ENRICHMENT_VERSION,
        )

    def _enrich_raster(self, element: IRElement) -> EnrichedElement:
        """Use vision fallback for raster-only formulas.

        Args:
            element: An IRElement with bytes content (raster image of formula).

        Returns:
            EnrichedElement with formula fields from vision analysis.

        Raises:
            RuntimeError: If no VisionService is configured for raster fallback.
        """
        if self._vision_service is None:
            raise RuntimeError("VisionService required for raster formula enrichment but not configured")

        logger.info(
            "Using vision fallback for raster formula",
            extra={"element_id": element.element_id},
        )

        # Use VisionService to analyze the raster formula image
        vision_result = self._vision_service.enrich(element)

        # Repackage as formula-specific enrichment
        # Extract formula info from the vision description
        description = vision_result.image_description or ""
        formula_text = description
        latex_repr = ""
        formula_concepts = vision_result.keywords[:10] if vision_result.keywords else []

        embedding_text = f"Formula: {formula_text}" if formula_text else "Formula: (raster image)"

        return EnrichedElement(
            element_id=element.element_id,
            element_type=ElementType.FORMULA,
            provenance=element.provenance,
            embedding_text=embedding_text,
            formula_text=formula_text,
            latex_repr=latex_repr,
            formula_concepts=formula_concepts,
            enrichment_version=ENRICHMENT_VERSION,
        )

    def _latex_to_readable(self, latex: str) -> str:
        """Convert LaTeX to a simplified readable text representation.

        This is a best-effort conversion for embedding purposes,
        not a full LaTeX renderer.

        Args:
            latex: Raw LaTeX string.

        Returns:
            Simplified readable text.
        """
        text = latex

        # Remove display math delimiters
        text = re.sub(r"\$\$?|\\\[|\\\]|\\begin\{equation\}|\\end\{equation\}", "", text)
        text = re.sub(r"\\begin\{align\*?\}|\\end\{align\*?\}", "", text)

        # Common substitutions
        text = re.sub(r"\\frac\{([^}]*)\}\{([^}]*)\}", r"(\1)/(\2)", text)
        text = re.sub(r"\\sqrt\{([^}]*)\}", r"sqrt(\1)", text)
        text = re.sub(r"\\int", "integral", text)
        text = re.sub(r"\\sum", "sum", text)
        text = re.sub(r"\\prod", "product", text)
        text = re.sub(r"\\lim", "limit", text)
        text = re.sub(r"\\infty", "infinity", text)
        text = re.sub(r"\\partial", "d/d", text)
        text = re.sub(r"\\nabla", "del", text)
        text = re.sub(r"\\cdot", "*", text)
        text = re.sub(r"\\times", "x", text)
        text = re.sub(r"\\pm", "+-", text)
        text = re.sub(r"\\leq|\\le", "<=", text)
        text = re.sub(r"\\geq|\\ge", ">=", text)
        text = re.sub(r"\\neq|\\ne", "!=", text)
        text = re.sub(r"\\approx", "~=", text)
        text = re.sub(r"\\rightarrow|\\to", "->", text)
        text = re.sub(r"\\Rightarrow|\\implies", "=>", text)
        text = re.sub(r"\\forall", "for all", text)
        text = re.sub(r"\\exists", "there exists", text)
        text = re.sub(r"\\in", "in", text)

        # Greek letters
        greek = {
            "alpha": "alpha", "beta": "beta", "gamma": "gamma",
            "delta": "delta", "epsilon": "epsilon", "theta": "theta",
            "lambda": "lambda", "mu": "mu", "sigma": "sigma",
            "omega": "omega", "pi": "pi", "phi": "phi", "rho": "rho",
            "tau": "tau", "chi": "chi", "psi": "psi",
        }
        for cmd, name in greek.items():
            text = text.replace(f"\\{cmd}", name)

        # Remove remaining backslash commands
        text = re.sub(r"\\[a-zA-Z]+", "", text)
        # Remove braces
        text = re.sub(r"[{}]", "", text)
        # Collapse whitespace
        text = re.sub(r"\s+", " ", text).strip()

        return text

    def _extract_concepts(self, latex: str) -> list[str]:
        """Extract mathematical concepts from LaTeX content.

        Args:
            latex: Raw LaTeX string.

        Returns:
            List of identified mathematical concepts (deduplicated).
        """
        concepts: list[str] = []
        seen: set[str] = set()

        for pattern, concept in _CONCEPT_PATTERNS:
            if re.search(pattern, latex) and concept not in seen:
                concepts.append(concept)
                seen.add(concept)

        return concepts
