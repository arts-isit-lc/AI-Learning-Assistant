"""Session state management and DynamoDB serialization for Chatbot V2.

Defines the core data models (SessionState, ConceptProgress) and provides
functions for creating, serializing, and deserializing session state for
DynamoDB persistence with optimistic concurrency control.
"""

import math
from dataclasses import dataclass, field
from typing import Literal

Stage = Literal["prior_knowledge", "comprehension", "application", "mastery"]
ConceptLevel = Literal["introduced", "discussed", "demonstrated", "mastery"]


@dataclass
class ConceptProgress:
    """Per-concept tracking record.

    Tracks the exposure level, total exposures, and successful demonstrations
    for a single concept within a learning session.
    """

    level: ConceptLevel = "introduced"
    exposures: int = 0
    demonstrations: int = 0


@dataclass
class SessionState:
    """Complete learning session state persisted to DynamoDB.

    Contains all fields needed to drive conversation flow, track engagement,
    manage concept progress, and support optimistic concurrency control.
    """

    session_id: str
    stage: Stage = "prior_knowledge"
    module_complete: bool = False
    completion_message_sent: bool = False
    interactions: int = 0
    engagement_score: float = 0.0
    concept_progress: dict[str, ConceptProgress] = field(default_factory=dict)
    concepts_exposed: list[str] = field(default_factory=list)
    concepts_discussed: list[str] = field(default_factory=list)
    concepts_demonstrated: list[str] = field(default_factory=list)
    module_concepts: list[str] = field(default_factory=list)
    correct_count: int = 0
    partial_count: int = 0
    incorrect_count: int = 0
    consecutive_failures: int = 0
    consecutive_correct: int = 0
    hint_level: int = 0
    hint_count: int = 0
    # Last Socratic response mode chosen by select_mode() this session (e.g.
    # "hint_nudge"/"hint_scaffold"). Persisted purely so the course-progress
    # debug view can surface it — it is otherwise transient (recomputed each
    # turn) and NOT part of the client-facing per-turn response.
    last_mode: str = ""
    state_version: int = 0
    tutor_state: dict = field(default_factory=dict)  # V2: math tutoring state (step progression)
    # Static-per-module metadata, cached lazily when CACHE_MODULE_METADATA is on
    # (#10) to avoid re-querying Postgres every turn. Defaults preserve
    # back-compat with previously serialized sessions.
    module_name: str = ""
    allowed_file_ids: list[str] = field(default_factory=list)


def create_default_state(session_id: str) -> SessionState:
    """Create initial state for a new session with all defaults.

    Returns a SessionState with zeroed counters, empty lists/maps, and
    state_version=0. The module_concepts field is left empty and should
    be populated separately by loading Course_Modules.generated_topics.

    Args:
        session_id: Unique identifier for this learning session.

    Returns:
        A new SessionState instance with default values.
    """
    return SessionState(session_id=session_id)


def serialize_state(state: SessionState) -> dict:
    """Convert SessionState to a DynamoDB-compatible dict.

    Handles nested ConceptProgress serialization as plain dicts,
    preserves all list fields, and includes state_version for
    optimistic concurrency control.

    Args:
        state: The SessionState to serialize.

    Returns:
        A flat dict suitable for DynamoDB PutItem.
    """
    serialized_progress = {}
    for concept_id, progress in state.concept_progress.items():
        serialized_progress[concept_id] = {
            "level": progress.level,
            "exposures": progress.exposures,
            "demonstrations": progress.demonstrations,
        }

    return {
        "session_id": state.session_id,
        "stage": state.stage,
        "module_complete": state.module_complete,
        "completion_message_sent": state.completion_message_sent,
        "interactions": state.interactions,
        "engagement_score": str(state.engagement_score),
        "concept_progress": serialized_progress,
        "concepts_exposed": state.concepts_exposed,
        "concepts_discussed": state.concepts_discussed,
        "concepts_demonstrated": state.concepts_demonstrated,
        "module_concepts": state.module_concepts,
        "correct_count": state.correct_count,
        "partial_count": state.partial_count,
        "incorrect_count": state.incorrect_count,
        "consecutive_failures": state.consecutive_failures,
        "consecutive_correct": state.consecutive_correct,
        "hint_level": state.hint_level,
        "hint_count": state.hint_count,
        "last_mode": state.last_mode,
        "state_version": state.state_version,
        "module_name": state.module_name,
        "allowed_file_ids": state.allowed_file_ids,
    }


def deserialize_state(item: dict) -> SessionState:
    """Reconstruct SessionState from a DynamoDB item.

    Restores ConceptProgress from nested dicts and handles missing fields
    gracefully by using default values. Converts engagement_score from
    string back to float for DynamoDB numeric precision.

    Args:
        item: A dict from DynamoDB GetItem response.

    Returns:
        A fully populated SessionState instance.
    """
    concept_progress = {}
    raw_progress = item.get("concept_progress", {})
    for concept_id, progress_data in raw_progress.items():
        concept_progress[concept_id] = ConceptProgress(
            level=progress_data.get("level", "introduced"),
            exposures=int(progress_data.get("exposures", 0)),
            demonstrations=int(progress_data.get("demonstrations", 0)),
        )

    return SessionState(
        session_id=item["session_id"],
        stage=item.get("stage", "prior_knowledge"),
        module_complete=item.get("module_complete", False),
        completion_message_sent=item.get("completion_message_sent", False),
        interactions=int(item.get("interactions", 0)),
        engagement_score=float(item.get("engagement_score", 0.0)),
        concept_progress=concept_progress,
        concepts_exposed=item.get("concepts_exposed", []),
        concepts_discussed=item.get("concepts_discussed", []),
        concepts_demonstrated=item.get("concepts_demonstrated", []),
        module_concepts=item.get("module_concepts", []),
        correct_count=int(item.get("correct_count", 0)),
        partial_count=int(item.get("partial_count", 0)),
        incorrect_count=int(item.get("incorrect_count", 0)),
        consecutive_failures=int(item.get("consecutive_failures", 0)),
        consecutive_correct=int(item.get("consecutive_correct", 0)),
        hint_level=int(item.get("hint_level", 0)),
        hint_count=int(item.get("hint_count", 0)),
        last_mode=item.get("last_mode", ""),
        state_version=int(item.get("state_version", 0)),
        module_name=item.get("module_name", ""),
        allowed_file_ids=item.get("allowed_file_ids", []),
    )


from constants.models import (
    MIN_INTERACTIONS_FOR_COMPLETION,
    CONCEPTS_DISCUSSED_COMPLETION_RATIO,
    MIN_ENGAGEMENT_SCORE_FOR_COMPLETION,
    ENGAGEMENT_CORRECT_INCREMENT,
    ENGAGEMENT_PARTIAL_WITH_CONCEPTS_INCREMENT,
    ENGAGEMENT_SCORE_CAP,
)
from evaluation import EvaluationResult


def update_state(state: SessionState, evaluation: EvaluationResult) -> SessionState:
    """Update session state based on an evaluation result.

    Updates exactly one of the correctness counters, manages consecutive
    streaks, and adjusts engagement_score. Never modifies module_complete or
    interactions (interactions is a per-turn counter incremented once per turn
    by the handler, independent of whether evaluation runs — H1).

    Args:
        state: The current session state to update in-place.
        evaluation: The evaluation result for the latest student answer.

    Returns:
        The modified SessionState (same object, mutated).
    """
    if evaluation.correct:
        state.correct_count += 1
        state.consecutive_failures = 0
        state.consecutive_correct += 1
        state.engagement_score = min(
            state.engagement_score + ENGAGEMENT_CORRECT_INCREMENT,
            ENGAGEMENT_SCORE_CAP,
        )
    elif evaluation.partial:
        state.partial_count += 1
        state.consecutive_failures = 0
        state.consecutive_correct = 0
        if len(evaluation.concepts_demonstrated) > 0:
            state.engagement_score = min(
                state.engagement_score + ENGAGEMENT_PARTIAL_WITH_CONCEPTS_INCREMENT,
                ENGAGEMENT_SCORE_CAP,
            )
    else:
        state.incorrect_count += 1
        state.consecutive_failures += 1
        state.consecutive_correct = 0

    return state


def check_stage_advancement(state: SessionState) -> Stage:
    """Evaluate whether the student should advance to the next learning stage.

    Thresholds (evaluated in order, only one advancement per call):
    - prior_knowledge → comprehension: correct_count >= 2
    - comprehension → application: correct_count >= 5 AND consecutive_correct >= 3
    - application → mastery: correct_count >= 8

    On advancement, resets consecutive_failures and hint_level to 0.

    Args:
        state: The current session state (mutated on advancement).

    Returns:
        The new stage (or current stage if no advancement occurred).
    """
    advanced = False

    if state.stage == "prior_knowledge" and state.correct_count >= 2:
        state.stage = "comprehension"
        advanced = True
    elif state.stage == "comprehension" and state.correct_count >= 5 and state.consecutive_correct >= 3:
        state.stage = "application"
        advanced = True
    elif state.stage == "application" and state.correct_count >= 8:
        state.stage = "mastery"
        advanced = True

    if advanced:
        state.consecutive_failures = 0
        state.hint_level = 0

    return state.stage


def required_concepts_discussed(total_concepts: int) -> int:
    """Number of distinct concepts a student must discuss to complete a module.

    Scales with module size: ceil(total * CONCEPTS_DISCUSSED_COMPLETION_RATIO),
    floored at 1. So 50% of the module's topics (rounded up), but always at
    least 1 — a single-topic module needs 1. The floor also keeps a module with
    zero topics incompletable, since concepts_discussed can never reach 1 when
    there are no concepts to discuss (preserving the prior "never trivially
    completes" behavior).

    Args:
        total_concepts: The number of topics in the module (len(module_concepts)).

    Returns:
        The minimum concepts_discussed count required (>= 1).
    """
    return max(1, math.ceil(total_concepts * CONCEPTS_DISCUSSED_COMPLETION_RATIO))


def check_module_completion(state: SessionState) -> bool:
    """Determine if the module is complete based on engagement metrics.

    Completion requires ALL of:
    - interactions >= MIN_INTERACTIONS_FOR_COMPLETION (5)
    - concepts_discussed covers at least 50% of the module's topics, rounded up,
      with a floor of 1 (see required_concepts_discussed): a 1-topic module
      needs 1, a 2-topic module needs 1, a 3- or 4-topic module needs 2, etc.
    - engagement_score >= MIN_ENGAGEMENT_SCORE_FOR_COMPLETION (0.5)

    This function does NOT reference stage, correct_count,
    consecutive_failures, or mastery.

    Args:
        state: The current session state.

    Returns:
        True if the module is complete, False otherwise.
    """
    return (
        state.interactions >= MIN_INTERACTIONS_FOR_COMPLETION
        and len(state.concepts_discussed) >= required_concepts_discussed(len(state.module_concepts))
        and state.engagement_score >= MIN_ENGAGEMENT_SCORE_FOR_COMPLETION
    )


def completion_missing_requirements(state: SessionState) -> list[str]:
    """Which completion requirements are not yet met — a diagnostic mirror of
    check_module_completion.

    Named neutrally: a non-empty list is normal in-progress, not an error. Uses
    the SAME gate inputs as check_module_completion so the probe never disagrees
    with the real gate. Phase 1 counts concepts_discussed (the current gate);
    when the gate moves to concepts_demonstrated (spec §4.3), update both in
    lockstep.

    Args:
        state: The current session state (read-only access).

    Returns:
        A subset of ["interactions", "concept_coverage", "engagement"];
        an empty list means every requirement is met.
    """
    missing: list[str] = []
    if state.interactions < MIN_INTERACTIONS_FOR_COMPLETION:
        missing.append("interactions")
    if len(state.concepts_discussed) < required_concepts_discussed(len(state.module_concepts)):
        missing.append("concept_coverage")
    if state.engagement_score < MIN_ENGAGEMENT_SCORE_FOR_COMPLETION:
        missing.append("engagement")
    return missing


def calculate_mastery_profile(state: SessionState) -> dict[str, float]:
    """Calculate per-concept mastery ratios as a pure analytics function.

    For each concept in concept_progress, mastery is computed as
    demonstrations / exposures. Returns 0.0 for concepts with zero exposures.
    Has no side effects on state.

    Args:
        state: The current session state (read-only access).

    Returns:
        A dict mapping concept_id to mastery ratio (0.0 to 1.0).
    """
    profile: dict[str, float] = {}
    for concept_id, progress in state.concept_progress.items():
        if progress.exposures == 0:
            profile[concept_id] = 0.0
        else:
            profile[concept_id] = progress.demonstrations / progress.exposures
    return profile


def calculate_coverage(state: SessionState) -> float:
    """Calculate concept coverage as a ratio of discussed to total module concepts.

    Returns len(concepts_discussed) / len(module_concepts), or 0.0 if
    module_concepts is empty (avoids division by zero). Pure analytics function.

    Args:
        state: The current session state (read-only access).

    Returns:
        Coverage ratio from 0.0 to 1.0.
    """
    if not state.module_concepts:
        return 0.0
    return len(state.concepts_discussed) / len(state.module_concepts)
