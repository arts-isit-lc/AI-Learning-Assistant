# Image Display Architecture — Design Proposal

## Problem

The V2 multimodal pipeline successfully processes images: the enrichment layer describes them via Claude Haiku vision, stores descriptions in pgvector, and retrieval finds them when students ask visual questions. The image escalation module runs live vision analysis against specific figures.

But the student never sees the actual image. The LLM receives text descriptions and produces text answers. When a student asks "What does Figure 1.1 show?", they get a paragraph describing it — not the image itself.

## Design Principles

1. **`blocks` is the only canonical format.** Every response is a block sequence. Derived views are computed projections, never stored.
2. **The LLM has one job: answer the question.** No tags, no annotations, no metadata. Pure prose.
3. **Figure selection is deterministic.** Based on retrieval rank, query intent, and escalation — signals that exist before and independently of LLM generation.
4. **Eligibility is gated by upstream signals.** A figure is only eligible if it passes a hard deterministic rule. No figure appears without an explainable reason.
5. **Separate content identity from access.** Figure IDs are permanent. Presigned URLs are ephemeral, generated on demand.
6. **Figures always grouped at end.** No inline placement heuristics.

## Three Independent Systems

```
┌─────────────────────────────────────────────────┐
│  1. UNDERSTANDING                                │
│     LLM generates prose answer                   │
│     Input: context + question                    │
│     Output: text (no metadata)                   │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  2. FIGURE SELECTION (deterministic)             │
│     Decides which figures to show                │
│     Input: retrieval scores + query intent +     │
│            escalation results                    │
│     Output: ordered figure_id list               │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  3. RENDERING                                    │
│     blocks → UI                                  │
│     Input: text + selected figures               │
│     Output: block sequence                       │
└─────────────────────────────────────────────────┘
```

**Execution model:** Shared-input parallel execution after a common preprocessing stage. Retrieval, query analysis, and escalation all run first — producing a shared context. Then LLM generation and figure selection execute on those shared outputs with no dependency on each other's results. Neither reads the other's output. They join at block assembly.

## Figure Eligibility Gate

A figure is eligible for display if and only if it satisfies **at least one** hard deterministic rule:

| Rule | Signal | Condition |
|------|--------|-----------|
| Escalation match | Image escalation fired and found this figure | `escalation_figure_id == figure_id` |
| Top-K retrieval | Figure ranked in top-K image results | `retrieval_rank <= K` (K=5) |
| Intent + score | Query needs images AND figure scores above threshold | `requires_image AND score > 0.4` |
| High-confidence fallback | Any figure with very high retrieval score | `score > 0.8` (bypasses intent) |

No figure outside this eligibility set is ever shown. This prevents semantic hallucinated relevance.

### Query-Grounding Constraint (precision filter)

After eligibility, an additional precision filter prevents attaching figures that are retrieved via broad semantic overlap but aren't grounded in the question or its supporting context.

A figure passes the grounding check if it matches **either**:
- The **query** directly (figure caption/description is semantically close to the question)
- A **top supporting text chunk** (the figure co-occurs with or is sibling-linked to text that was also retrieved)

This is not an embedding comparison — it uses retrieval metadata that already exists:

```python
def is_grounded(figure: dict, query: str, top_text_results: list) -> bool:
    """Check if a figure is grounded in the query or supporting context.

    Uses existing retrieval metadata — no additional embedding calls.

    Grounding signals:
    1. Figure was retrieved BY the same query (it's in image_results — always true for candidates)
    2. Figure shares a module+page with a top text chunk (co-location)
    3. Figure has sibling_ids that overlap with retrieved text chunk IDs

    At least one signal must be present beyond basic retrieval membership.
    """
    fig_page = figure.get("metadata", {}).get("page_num")
    fig_module = figure.get("metadata", {}).get("module_id")
    fig_siblings = set(figure.get("metadata", {}).get("sibling_ids", []))

    for text_result in top_text_results[:5]:  # check against top-5 text chunks
        text_page = text_result.metadata.get("page_num")
        text_module = text_result.metadata.get("module_id")
        text_id = text_result.metadata.get("retrieval_id")

        # Co-location: same page in same module
        if fig_page and text_page and fig_module == text_module and fig_page == text_page:
            return True

        # Sibling link: figure is explicitly linked to a retrieved text chunk
        if text_id and text_id in fig_siblings:
            return True

    return False
```

This leverages the sibling linking and provenance already built by `RetrievalUnitBuilder` — no new infrastructure.

Figures that fail the grounding check are demoted (not hard-excluded in v1) — logged for monitoring, and excluded from display unless they're the only eligible figure for an escalation query.

```python
def get_eligible_figures(
    image_results: list[RankedResult],
    text_results: list[RankedResult],
    query_intent: QueryIntent,
    escalation_figure_id: str | None,
    query: str,
    top_k: int = 5,
    intent_threshold: float = 0.4,
    fallback_threshold: float = 0.8,
) -> list[dict]:
    """Determine which figures are eligible for display.

    Eligibility requires at least one hard signal.
    Grounding check adds precision (demotes ungrounded figures).
    """
    eligible = []
    seen = set()

    # Rule 1: Escalated figure (always eligible, highest priority, skip grounding)
    if escalation_figure_id:
        eligible.append({
            "figure_id": escalation_figure_id,
            "reason": "escalation",
            "priority": 0,
            "grounded": True,
        })
        seen.add(escalation_figure_id)

    for rank, result in enumerate(image_results):
        fig_id = result.metadata.get("figure_id") or result.retrieval_id
        if fig_id in seen or not result.image_s3_key:
            continue

        reasons = []

        # Rule 2: Top-K retrieval rank
        if rank < top_k:
            reasons.append("top_k_retrieval")

        # Rule 3: Intent + score threshold
        if (query_intent.requires_image or query_intent.requires_escalation) \
                and result.score > intent_threshold:
            reasons.append("intent_and_score")

        # Rule 4: High-confidence fallback
        if result.score > fallback_threshold:
            reasons.append("high_confidence")

        if reasons:
            # Grounding check: is this figure connected to query/context?
            grounded = is_grounded(
                figure={"metadata": result.metadata},
                query=query,
                top_text_results=text_results,
            )

            if not grounded:
                logger.info(
                    "Figure eligible but ungrounded — demoted",
                    extra={"figure_id": fig_id, "reasons": reasons, "score": result.score},
                )

            eligible.append({
                "figure_id": fig_id,
                "reason": reasons[0],
                "priority": rank + 1 if grounded else rank + 100,  # demote ungrounded
                "score": result.score,
                "grounded": grounded,
                "metadata": result.metadata,
            })
            seen.add(fig_id)

    return eligible
```

## Figure Selection (from eligible set)

```python
def select_figures(
    eligible_figures: list[dict],
    query_intent: QueryIntent,
    max_figures: int = 3,
) -> list[str]:
    """Select final figures from the eligible set.

    Rules:
    - Escalated figure always included (first)
    - Grounded figures prioritized over ungrounded
    - Remaining ordered by priority (retrieval rank)
    - Capped at max_figures
    - If query doesn't need images AND no escalation AND no high-confidence,
      return empty (text-only response)

    Returns:
        Ordered list of figure_ids for block assembly.
    """
    if not eligible_figures:
        return []

    # If no image intent and no escalation, only show high-confidence grounded figures
    has_escalation = any(f["reason"] == "escalation" for f in eligible_figures)
    has_high_confidence = any(
        f["reason"] == "high_confidence" and f.get("grounded", True)
        for f in eligible_figures
    )

    if not query_intent.requires_image and not query_intent.requires_escalation \
            and not has_escalation and not has_high_confidence:
        return []

    # Select in priority order (grounded figures sort lower = higher priority)
    selected = []
    for fig in sorted(eligible_figures, key=lambda f: f["priority"]):
        if len(selected) >= max_figures:
            break
        selected.append(fig["figure_id"])

    return selected
```

Properties:
- Fully deterministic
- Testable with unit tests (no embedding model, no LLM)
- Runs in parallel with LLM generation (no sequential dependency)
- Every displayed figure has an auditable reason
- Intent-gated with high-confidence fallback

## Optional Enhancement: Answer-Conditioned Reranking (Deferred)

**Status: Not in Phase 1. Evaluated after production data collection.**

After shipping deterministic selection, if logs show answer-figure misalignment:

```python
def soft_rerank(selected_figures: list[str], answer: str, embeddings_model) -> list[str]:
    """Reorder selected figures by answer similarity.

    IMPORTANT: This only REORDERS. It never EXCLUDES.
    Deterministic selection is authoritative. Reranking is a soft quality signal.
    """
    # ... embedding comparison ...
    # Returns same figures in new order
```

Key constraint: **reranking may reorder but must NEVER exclude deterministic selections.**

This preserves the stability guarantee while allowing optional quality improvement. Ship without it first. Add when data justifies it.

## Full Pipeline

```
Student Question
       │
       ▼
Hybrid Retrieval
       │
       ├── Text chunks (scored)
       ├── Image results (scored, ranked, with metadata)
       │
       ▼
Query Analyzer → intent
       │
       ▼
Image Escalation (if triggered) → escalation_figure_id + analysis
       │
       ▼
Context Assembly → LLM context
       │
       │
       ├─────────────────────────────────────────┐
       │                                          │
       ▼                                          ▼
┌──────────────────┐                 ┌──────────────────────────┐
│  LLM Generation  │                 │  Figure Selection        │
│  (prose answer)  │                 │  (deterministic rules)   │
│                  │  SHARED-INPUT   │                          │
│  No tags         │  PARALLEL       │  eligibility gate        │
│  No metadata     │  EXECUTION      │  → select from eligible  │
│  Just text       │                 │  → ordered figure_ids    │
└────────┬─────────┘                 └─────────────┬────────────┘
         │                                          │
         └───────────────────┬──────────────────────┘
                             │
                             ▼
                    Block Assembly
                    [text block] + [figure blocks]
                             │
                             ▼
              Response: { blocks, session_name, llm_verdict }
                             │
                             ▼
                    Frontend renders blocks
```

No feedback loop. LLM output does not influence figure selection. Figure selection does not influence LLM generation. They share preprocessing outputs and join at block assembly.

## Canonical Data Model

### Response (always)

```json
{
  "blocks": [
    { "type": "text", "content": "The unit circle shows how sine and cosine relate..." },
    { "type": "figure", "id": "course6_fig_001" }
  ],
  "session_name": "Trig Concepts",
  "llm_verdict": "correct"
}
```

### Block assembly

```python
def assemble_blocks(answer: str, selected_figures: list[str]) -> list[dict]:
    """Text block + figure blocks grouped at end."""
    blocks = []
    if answer.strip():
        blocks.append({"type": "text", "content": answer.strip()})
    for figure_id in selected_figures:
        blocks.append({"type": "figure", "id": figure_id})
    return blocks
```

### DynamoDB storage

```json
{
  "message_id": "...",
  "student_sent": false,
  "blocks": [
    { "type": "text", "content": "..." },
    { "type": "figure", "id": "course6_fig_001" }
  ],
  "time_sent": "..."
}
```

### Backward compatibility

```jsx
const renderBlocks = message.blocks
  ? message.blocks
  : [{ type: "text", content: message.message_content }];
```

## Figure URL Endpoint

### `GET /student/figure_url`

```
GET /student/figure_url?figure_id=course6_fig_001
```

```json
{
  "url": "https://bucket.s3.../image.png?X-Amz-...",
  "caption": "Relationship between sine and cosine",
  "page": 12,
  "figure_id": "course6_fig_001"
}
```

Frontend fetches on demand. No URLs stored anywhere.

## Frontend

### `FigureImage` component

```jsx
const FigureImage = ({ figureId }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiClient.get("student/figure_url", { figure_id: figureId })
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [figureId]);

  if (loading) return <Skeleton className="h-48 w-full rounded" />;
  if (error) return null;

  return (
    <figure className="my-4">
      <img
        src={data.url}
        alt={data.caption || "Course figure"}
        className="max-w-full rounded border border-border"
        loading="lazy"
      />
      {data.caption && (
        <figcaption className="text-xs text-muted-foreground mt-2">
          {data.caption}
        </figcaption>
      )}
    </figure>
  );
};
```

### `AIMessage` block renderer

```jsx
const AIMessage = ({ blocks, message_content }) => {
  const renderBlocks = blocks && blocks.length > 0
    ? blocks
    : [{ type: "text", content: message_content }];

  return (
    <div>
      {renderBlocks.map((block, i) => {
        switch (block.type) {
          case "text":
            return <MarkdownRender key={i} content={block.content} />;
          case "figure":
            return <FigureImage key={i} figureId={block.id} />;
          default:
            return null;
        }
      })}
    </div>
  );
};
```

### Streaming UX

Text streams via WebSocket. On completion:
- HTTP response arrives with `blocks`
- Frontend replaces streamed text with block rendering
- Figures render below text (no position shift)
- Skeleton placeholder in figure area during load

## Figure Identity System

### Phase 1 (interim)

Use `retrieval_id` as figure identifier.

### Phase 2 (stable IDs at ingestion)

```python
figure_id = f"{module_id_short}_fig_{position_index:03d}"
```

Stored in metadata:
```python
{
    "figure_id": "4a03a6bc_fig_001",
    "display_label": "1.1",
    "caption": "...",
    "image_s3_key": "courses/.../image.png",
    "page_num": 12,
    "image_type": "diagram",
    "objects": ["unit circle", "angle"],
    "labels": ["x", "y", "theta"],
}
```

## Implementation Phases

### Phase 1: Blocks + Deterministic Figure Selection (Ship This)

| Component | Change |
|-----------|--------|
| `vectorstore.py` | Collect ranked image results with metadata |
| `image_escalation.py` | `get_eligible_figures()` + `select_figures()` + `assemble_blocks()` |
| `main.py` | Wire parallel figure selection + block response |
| `studentFunction.js` | `GET /student/figure_url` endpoint |
| `AIMessage.jsx` | Block renderer |
| `StudentChat.jsx` | Pass blocks; streaming transition |
| DynamoDB | Store blocks per message |

No LLM changes. No embedding calls. No parsing. Pure rule-based selection.

### Phase 2: Stable Figure IDs

| Component | Change |
|-----------|--------|
| `retrieval_unit_builder.py` | Generate figure_id |
| `retrieval_units` metadata | Index on figure_id |
| Endpoint | Resolve by figure_id (retrieval_id fallback) |

### Phase 3: Enhanced Metadata

| Component | Change |
|-----------|--------|
| Vision enrichment | Structured extraction: objects, labels |
| Retrieval | Metadata field search |

### Phase 4: Optional Answer-Conditioned Reranking

**Only if production logs show answer-figure misalignment.**

| Component | Change |
|-----------|--------|
| `image_escalation.py` | `soft_rerank()` — reorders only, never excludes |
| Feature flag | Toggle on/off for A/B evaluation |

### Phase 5: Additional Block Types

| Block type | Renderer |
|-----------|----------|
| `figure` | FigureImage |
| `figure_group` | Gallery (for dense visual topics) |
| `table` | Structured table |
| `equation` | KaTeX |

## What Stays The Same

- Enrichment pipeline
- Retrieval hybrid search
- Image escalation (vision analysis for LLM context)
- QueryAnalyzer
- LLM system prompt
- Streaming WebSocket protocol
- Existing DynamoDB messages

## What Changes

| Component | Change | Phase | Effort |
|-----------|--------|-------|--------|
| `vectorstore.py` | Collect image results | 1 | Small |
| `image_escalation.py` | Eligibility + selection + assembly | 1 | Medium |
| `main.py` | Wire selection; block response | 1 | Medium |
| `studentFunction.js` | Figure URL endpoint | 1 | Medium |
| `AIMessage.jsx` | Block renderer | 1 | Medium |
| `StudentChat.jsx` | Pass blocks; streaming | 1 | Small |
| DynamoDB | Store blocks | 1 | Small |
| `retrieval_unit_builder.py` | Stable figure_id | 2 | Medium |
| Vision enrichment | Structured metadata | 3 | Large |
| `image_escalation.py` | Soft rerank (optional) | 4 | Small |
| Block renderers | Table, equation, figure_group | 5 | Large |

## Risks

| Risk | Mitigation |
|------|-----------|
| Intent misclassification drops figures | High-confidence fallback (score > 0.8 bypasses intent) |
| Wrong figure selected | Eligibility gate: every figure has auditable reason |
| Answer doesn't mention displayed figure | Acceptable in v1; soft rerank (Phase 4) addresses if needed |
| Old messages lack blocks | Auto-wrapped at render time |
| Streaming → blocks layout shift | Figures below text; skeleton during load |

## Non-Goals

- Inline figure placement within paragraphs
- LLM-emitted structural metadata (tags, JSON, citations)
- Answer-conditioned reranking as a gating mechanism
- Presigned URLs stored anywhere
- Multiple response schemas
- Feedback loops between LLM output and figure selection
