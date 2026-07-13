"""Concept-level progress tracking for Chatbot V2 learning sessions.

Manages concept exposure, discussion, demonstration, and mastery transitions.
Maintains three coverage lists (exposed, discussed, demonstrated) and per-concept
progress records. All functions return modified state copies for testability.

Key definitions:
- Exposed: concept appeared in an assistant message (bot mentioned it)
- Discussed: concept appeared in BOTH assistant AND student messages
- Demonstrated: student showed correct understanding per evaluation
- Mastery: demonstrations/exposures ratio meets threshold
"""

from dataclasses import replace

from state_machine import ConceptProgress, SessionState
from constants.models import MASTERY_DEMONSTRATION_RATIO

# Level ordering for advancement — strictly linear, never regresses
LEVEL_ORDER: list[str] = ["introduced", "discussed", "demonstrated", "mastery"]


def introduce_concepts(state: SessionState, concepts: list[str]) -> SessionState:
    """Mark concepts as introduced (appeared in assistant message).

    - Add new concepts to concepts_exposed (idempotent — no duplicates)
    - Create concept_progress entries at level='introduced' with exposures=1
    - Increment exposures for already-known concepts

    Args:
        state: Current session state.
        concepts: List of concept identifiers from assistant message.

    Returns:
        Updated SessionState with concepts introduced.
    """
    new_exposed = list(state.concepts_exposed)
    new_progress = dict(state.concept_progress)

    for concept in concepts:
        # Idempotent membership in concepts_exposed
        if concept not in new_exposed:
            new_exposed.append(concept)

        if concept in new_progress:
            # Increment exposures for existing concepts
            existing = new_progress[concept]
            new_progress[concept] = ConceptProgress(
                level=existing.level,
                exposures=existing.exposures + 1,
                demonstrations=existing.demonstrations,
            )
        else:
            # Create new entry at 'introduced' level
            new_progress[concept] = ConceptProgress(
                level="introduced",
                exposures=1,
                demonstrations=0,
            )

    return replace(
        state,
        concepts_exposed=new_exposed,
        concept_progress=new_progress,
    )


def discuss_concepts(state: SessionState, concepts: list[str]) -> SessionState:
    """Mark concepts as discussed (appeared in BOTH assistant AND student messages).

    - Add new concepts to concepts_discussed (idempotent — no duplicates)
    - Advance level to at least 'discussed' in concept_progress
    - Creates concept_progress entry if concept not already tracked

    Args:
        state: Current session state.
        concepts: List of concept identifiers the student engaged with.

    Returns:
        Updated SessionState with concepts discussed.
    """
    new_discussed = list(state.concepts_discussed)
    new_progress = dict(state.concept_progress)

    for concept in concepts:
        # Idempotent membership in concepts_discussed
        if concept not in new_discussed:
            new_discussed.append(concept)

        if concept in new_progress:
            # Advance level to at least 'discussed'
            existing = new_progress[concept]
            new_progress[concept] = advance_concept_level(existing, "discussed")
        else:
            # Create new entry at 'discussed' level
            new_progress[concept] = ConceptProgress(
                level="discussed",
                exposures=0,
                demonstrations=0,
            )

    return replace(
        state,
        concepts_discussed=new_discussed,
        concept_progress=new_progress,
    )


def demonstrate_concepts(state: SessionState, concepts: list[str]) -> SessionState:
    """Record successful demonstrations from evaluation.

    - Add to concepts_demonstrated (idempotent — no duplicates)
    - Increment demonstrations count in concept_progress
    - Advance level to 'demonstrated'
    - Check mastery threshold: demonstrations/exposures >= MASTERY_DEMONSTRATION_RATIO

    Args:
        state: Current session state.
        concepts: List of concept identifiers the student demonstrated.

    Returns:
        Updated SessionState with concepts demonstrated.
    """
    new_demonstrated = list(state.concepts_demonstrated)
    new_progress = dict(state.concept_progress)

    for concept in concepts:
        # Idempotent membership in concepts_demonstrated
        if concept not in new_demonstrated:
            new_demonstrated.append(concept)

        if concept in new_progress:
            existing = new_progress[concept]
            new_demonstrations = existing.demonstrations + 1
            # Advance to at least 'demonstrated'
            updated = advance_concept_level(
                ConceptProgress(
                    level=existing.level,
                    exposures=existing.exposures,
                    demonstrations=new_demonstrations,
                ),
                "demonstrated",
            )
            # Check mastery threshold
            if updated.exposures > 0 and (new_demonstrations / updated.exposures) >= MASTERY_DEMONSTRATION_RATIO:
                updated = advance_concept_level(updated, "mastery")
            new_progress[concept] = updated
        else:
            # Create new entry — first demonstration without prior exposure
            new_progress[concept] = ConceptProgress(
                level="demonstrated",
                exposures=0,
                demonstrations=1,
            )

    return replace(
        state,
        concepts_demonstrated=new_demonstrated,
        concept_progress=new_progress,
    )


def record_misunderstandings(state: SessionState, concepts: list[str]) -> SessionState:
    """Record misunderstandings without penalizing completion.

    - Increment exposures (student was exposed but didn't understand)
    - Does NOT decrement demonstrations
    - Does NOT affect engagement_score or module_complete

    Args:
        state: Current session state.
        concepts: List of concept identifiers the student misunderstood.

    Returns:
        Updated SessionState with misunderstandings recorded.
    """
    new_progress = dict(state.concept_progress)

    for concept in concepts:
        if concept in new_progress:
            existing = new_progress[concept]
            new_progress[concept] = ConceptProgress(
                level=existing.level,
                exposures=existing.exposures + 1,
                demonstrations=existing.demonstrations,
            )
        else:
            # Create new entry — misunderstanding on first encounter
            new_progress[concept] = ConceptProgress(
                level="introduced",
                exposures=1,
                demonstrations=0,
            )

    return replace(
        state,
        concept_progress=new_progress,
    )


def advance_concept_level(progress: ConceptProgress, target: str) -> ConceptProgress:
    """Advance level to at least target, never regress.

    Level ordering: introduced < discussed < demonstrated < mastery.
    If the current level is already at or beyond the target, no change occurs.

    Args:
        progress: Current concept progress record.
        target: Target level to advance to.

    Returns:
        Updated ConceptProgress with level at least at target.
    """
    current_index = LEVEL_ORDER.index(progress.level)
    target_index = LEVEL_ORDER.index(target)

    if target_index > current_index:
        return ConceptProgress(
            level=LEVEL_ORDER[target_index],
            exposures=progress.exposures,
            demonstrations=progress.demonstrations,
        )

    return progress
