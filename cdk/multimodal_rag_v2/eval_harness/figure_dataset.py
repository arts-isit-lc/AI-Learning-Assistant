"""Figure-question evaluation dataset for Step 0 (chatbot-latency-optimization).

Schema + loader for the A/B/C/D "does stored perception replace live
perception?" comparison. Data only — no Bedrock/AWS calls, so it stays
deterministic and unit-testable.

Each item pins a real figure (dev IR bucket key + its retrieval_id) to a
student question and a set of ground-truth facts a correct answer must contain.
`ground_truth_facts` is the rubric the LLM-judge scores against (see
scoring.py); `expected_figure_id` drives the retrieval-precision metric.

Populating to the ~100 real items the plan calls for is a Phase-2 data-gathering
task (harvest real figure questions from dev + label facts with an SME); the
seed entries in figure_eval_set.json are schema templates, not real data — each
is flagged in `notes`. See .kiro/specs/chatbot-latency-optimization/findings.md.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

# Fields every dataset entry must provide (others default). Kept as a module
# constant so the loader and its test assert the same contract.
REQUIRED_FIELDS = {
    "query",
    "figure_ref",
    "image_s3_key",
    "expected_figure_id",
    "ground_truth_facts",
}

DEFAULT_DATASET_PATH = os.path.join(os.path.dirname(__file__), "figure_eval_set.json")


@dataclass
class FigureEvalItem:
    """One figure question under evaluation.

    Attributes:
        query: The student's question (as they'd type it).
        figure_ref: The referenced figure, e.g. "figure 3" (or "" if generic).
        image_s3_key: S3 key/URI of the image under test (dev IR bucket).
        expected_figure_id: retrieval_id that SHOULD appear in the answer's
            sources — drives the retrieval-precision metric.
        ground_truth_facts: Facts a correct answer must contain; the judge
            rubric (correctness = fraction supported).
        expected_concepts: Optional course concepts the figure illustrates.
        course_id / module_id: Optional scope (for wiring real arms later).
        notes: Provenance / labeling notes (seed entries are flagged here).
    """

    query: str
    figure_ref: str
    image_s3_key: str
    expected_figure_id: str
    ground_truth_facts: list[str]
    expected_concepts: list[str] = field(default_factory=list)
    course_id: str = ""
    module_id: str = ""
    notes: str = ""


def load_figure_eval_set(path: str | None = None) -> list[FigureEvalItem]:
    """Load and validate the figure-eval dataset from JSON.

    Args:
        path: Optional path to the dataset JSON (defaults to figure_eval_set.json
            alongside this module).

    Returns:
        A list of validated FigureEvalItem.

    Raises:
        ValueError: if an entry is missing a required field or ground_truth_facts
            is empty (a fact-less item can't be scored for correctness).
    """
    path = path or DEFAULT_DATASET_PATH
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)

    items: list[FigureEvalItem] = []
    for i, entry in enumerate(raw):
        missing = REQUIRED_FIELDS - set(entry)
        if missing:
            raise ValueError(f"figure_eval_set[{i}] missing fields: {sorted(missing)}")
        if not entry["ground_truth_facts"]:
            raise ValueError(f"figure_eval_set[{i}] has empty ground_truth_facts")
        items.append(
            FigureEvalItem(
                query=entry["query"],
                figure_ref=entry["figure_ref"],
                image_s3_key=entry["image_s3_key"],
                expected_figure_id=entry["expected_figure_id"],
                ground_truth_facts=list(entry["ground_truth_facts"]),
                expected_concepts=list(entry.get("expected_concepts", [])),
                course_id=entry.get("course_id", ""),
                module_id=entry.get("module_id", ""),
                notes=entry.get("notes", ""),
            )
        )
    return items
