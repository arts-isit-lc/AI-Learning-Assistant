# Multimodal RAG + Chatbot Flow — Audit Findings

Date: 2026-07-01 · Scope: full pipeline (ingestion → enrichment → retrieval → reasoning → chatbot orchestration → display → persistence → reload).
Method: four parallel slice audits + direct re-verification of the most severe items.
Status: **audit only — no code changed.** Fix in priority order after review.

Confidence legend: **[V]** verified directly from source in this pass · **[R]** agent-reported, mechanism plausible but not line-verified · **[G]** relied on grep (unreliable in this repo — see Tooling note) → treat as needs-verification.

## Systemic root cause
Every recurring failure is the same shape: **two paths that should agree, don't** (display vs persistence, display vs grounding, canonical vs projection, live vs reload, streaming vs final, ranker-score vs display-gate). And there is **no handler-level / integration test** — the ~841 tests are unit tests with mocks that pass while the wiring between units breaks. That gap is why these keep reaching production. Primary recommendation: add a small integration-test layer that exercises the real chatbot handler and the retrieval→display→persist→reload path with mocked AWS/Bedrock only.

---

## HIGH

- **H1 [V][Correctness] Adaptive-learning loop is inert on normal sessions.** `chatbot_v2/main.py` gates evaluation on `eval_should_run = state.interactions > 0 and message_content`, but `interactions` is incremented **only** inside `state_machine.update_state`, which is called **only** when an evaluation ran. Chicken-and-egg: `interactions` stays 0 forever on non-math sessions → evaluation LLM never runs → no stage advancement, no module completion, mode never progresses. Impact: the core V2 structured-learning feature does not function on normal chats. Fix: increment `interactions` once per processed turn, before the eval gate. No handler-level test exists to catch this.
- **H2 [V][Security/IDOR] `GET /student/get_messages` has no ownership check.** `studentFunction.js` runs `SELECT * FROM "Messages" WHERE session_id = ${sessionId}` with no enrollment/ownership verification; the student authorizer only proves "is a student," not "owns this session." Any authenticated student can read any session's full history by `session_id`. `update_session_name` / `delete_last_message` are similarly unscoped. Fix: verify caller owns the session via Sessions→Student_Modules→Enrolments→Users.
- **H3 [V][Security/IDOR] `GET /student/figure_url` can sign arbitrary S3 keys.** Strategy 3 presigns any key starting with `courses/`/`images/` with **no** `verifyStudentAccess`; Strategy 1 skips the access check when `metadata.module_id` is absent. Figures are stored at `images/{course_id}/{module_id}/...`, so a student can presign another course's figures (IDOR). Fix: require a resolved `retrieval_units` row + enrollment check before signing; drop the raw-key passthrough.
- **H4 [R][Correctness] Enrichment cache collapses multi-chunk TEXT elements.** A multi-chunk TEXT element yields N `EnrichedElement`s sharing one `content_hash`; the TEXT cache sort key is `enrichment_version` only, so `put()` overwrites and a later cache hit returns a single chunk → silent data loss / recall degradation on re-ingestion or duplicated text. Fix: don't cache TEXT (the chunker makes no LLM calls, so zero benefit), or store a list per key.
- **H5 [V][Correctness] Embedding failures silently wipe a file's index.** `_generate_embeddings` catches-and-skips embedding errors (no backoff); `_store_in_pgvector` then `DELETE`s the file's rows and commits, inserting only units that embedded, and marks status `complete`. Under Titan throttling during bulk upload, most/all units vanish and re-ingestion deletes prior good vectors while inserting nothing — file becomes unsearchable, marked "complete." Fix: add backoff; fail the record (raise → SQS retry) if a threshold of embeddings are missing; never DELETE+commit with zero inserts.
- **H6 [V][Seam] Tables & formulas repeat the figure-grounding bug (just fixed for figures only).** `select_tables`/`select_formulas` run after generation and there is no `build_table_grounding`/`build_formula_grounding`, so the response LLM can disclaim ("couldn't find that in the retrieved materials") a table/formula the display path simultaneously renders. Fix: select tables/formulas pre-generation and inject their summary/latex into `rag_context`, mirroring the figure fix.

## MEDIUM

- **M1 [V][Robustness] Block display silently depends on cross-encoder health.** `production_ranker` final score = `cross_encoder_score + boost`. With the cross-encoder configured, scores are ~[0,1] and the 0.5/0.8 display gates in `figure_selection` work; when it's unavailable, `cross_encoder_score` falls back to clamped RRF (~0.03) → final ≤ ~0.13 → tables/formulas and non-escalated figures never clear the gates. Two incompatible score scales feed the same gates. Fix: normalize to a documented [0,1] score contract regardless of path.
- **M2 [V][Correctness] `metadata_boost` can dominate relevance.** Boost (≤0.1) is additive; in the RRF-fallback regime (~0.03) it outranks true relevance (summary/page-1 wins). Fix: multiplicative or normalized boost.
- **M3 [R][Seam] `_persist_session_state` optimistic-lock retry clobbers.** On `ConditionalCheckFailedException` it reloads only the version then does an **unconditional** `put_item` with the stale start-of-turn state — concurrent/double-submit turns lose updates. Fix: re-apply deltas onto reloaded state (or `UpdateItem`) and retry the conditional put.
- **M4 [R][Seam] Streaming vs final divergence on guardrail paths.** The `streaming.stream_response` guardrail `except` re-raises without sending `done=True`, so a stream-consuming client can hang; the non-fail-closed retry re-streams from scratch (double tokens). Fix: always emit a terminal/reset chunk before returning a blocked/redirect result.
- **M5 [R][Seam] Math tutor path diverges from the normal path.** Persists RDS-before-DynamoDB (inverts canonical-first), ignores `ASYNC_RDS_PROJECTION`, never calls `log_engagement`, and does **not** assemble/persist/return `blocks` — so today's block-persistence fix does not hold on tutor turns. Fix: route tutor persistence through one shared helper (Dynamo-first, block-aware, flag-aware, engagement-logged).
- **M6 [R][Seam] Response-shape parity across 4 return sites.** `session_name`, `blocks`, `llm_verdict`, and the `session_state` schema vary by path (normal/guardrail-block/tutor/tutor-block). Fix: one response assembler used by all exits.
- **M7 [G][Correctness] Hint escalation is dead logic.** `hint_level`/`hint_count` appear to never be incremented (only reset), so `hint_scaffold` is unreachable and hint escalation never happens. NEEDS VERIFICATION (grep-based; grep is unreliable here). Fix (if confirmed): increment on hint-mode selection + persist.
- **M8 [V][Correctness] Document-summary metadata filter never matches.** Enrichment writes `is_document_summary` as a JSON boolean (`true`); retrieval compares `metadata->>'is_document_summary' = str(True)` = `'True'`. `'true' != 'True'` → summary/"what's in Lecture X?" filtering is dead. Fix: compare/store consistently (string or SQL boolean cast).
- **M9 [V][Seam] Re-ingestion DELETE uses the unindexed JSON path.** `_store_in_pgvector` deletes `WHERE metadata->>'file_id' = %s` while the rest of the system (deleteFile, retrieval scope, index `idx_retrieval_units_file_id`) uses the first-class `file_id` column. Full-scan + divergent identity path. Fix: delete by the `file_id` column.
- **M10 [V][Correctness] Caption injection/sibling linking over-matches.** `_inject_captions_into_elements` uses `.search()` on the first 150 chars despite a docstring claiming `re.match` anchoring, so mid-text "as shown in Figure 2.1" is treated as a caption; captions are keyed per page, so multi-figure pages inject one page-level caption into every image/table. Fix: anchor to chunk start; key finer than page.
- **M11 [V][Correctness] Figure-reference matching is substring-based.** `image_escalation._find_image_by_figure_ref_in_db` uses `LIKE '%{ref} {number}%'`, so "figure 4" matches "Figure 4.1 / 40 / 24" (Strategy A `LIMIT 1` silently picks one). Fix: word-boundary/exact `ref_type`+`number` match.
- **M12 [R][Correctness] `AIMessage.TableBlock` shape mismatch.** Backend emits `{headers, rows, summary, content?}`; the component reads `caption`/`markdown` (never set) and `[]` is truthy, so text-only tables render as an empty `<table>` shell and the content fallback is unreachable. Affects live + reload. Fix: map `summary`→caption; render `content` when structured headers/rows are absent.
- **M13 [V/R][Risk] Render blocks are not in the canonical store.** `message_blocks` live only in RDS + the transient SQS payload; DynamoDB (declared source of truth) is text-only. If a projection is dropped or the planned Phase-2 rebuild runs, figure/table/formula blocks are unrecoverable. Not a bug today (current DynamoDB consumers only need text). Fix: store blocks in DynamoDB too, or explicitly declare RDS authoritative for blocks.
- **M14 [R][Risk] Partial math results presented as verified.** `math_compute_client` marks `status == "partial"` as `success=True`, and the direct-answer prompt asserts "all values are verified." A partial (inconclusive) result can enter tutoring / be framed as authoritative. Fix: gate on `status == "verified"`; soften language for partial.
- **M15 [R][Correctness] `retrieval_id` is non-deterministic (`uuid4`).** Re-ingesting a file assigns all-new `retrieval_id`s, so the `ON CONFLICT (retrieval_id)` upsert is effectively dead and any persisted reference (`message_blocks` figure ids, figure_url resolution) goes **stale after re-ingestion**. Directly undermines today's persistence fix on re-ingestion. Fix: derive `retrieval_id` deterministically (parent + chunk index + version).
- **M16 [R][Risk] Guardrail-blocked turns persist to RDS but not DynamoDB.** Opposite of the canonical-first invariant and undocumented (may be intentional to avoid feeding blocked content back to the model). Fix: make the policy explicit and symmetric.

## LOW
- **L1 [R][Opt]** `FigureImage` does N+1 `figure_url` calls (1–3 DB round-trips each) and re-signs on every mount; no cache. → cache by `figure_id` / batch endpoint.
- **L2 [R][Opt]** Cache miss re-enriches the ENTIRE document (re-runs vision for already-cached images). → enrich only the uncached subset.
- **L3 [R][Opt]** Enrichment opens 4× psycopg2 connections + 4× Secrets Manager GETs per record. → cache secret + share one connection.
- **L4 [R][Opt]** Embeddings generated strictly serially. → bounded `ThreadPoolExecutor`.
- **L5 [R][Opt]** Duplicate Haiku topic extraction (`_extract_and_store_topics` vs `document_summary`). → share one call.
- **L6 [R][Risk]** Enrichment caches fallback/degraded outputs → transient failure becomes sticky. → skip caching fallbacks.
- **L7 [V][Correctness]** `get_messages` returns 404 on empty session (frontend treats as error/clears). → return `200 []`.
- **L8 [R][Correctness]** Query-analyzer keyword lists incomplete; `_FIGURE_LOOKUP_PATTERN` misses "equation 5"/"diagram 3". → reconcile.
- **L9 [R][Risk]** IR dedup by `content_hash` (content only) drops legitimately-repeated content on other pages. → dedup by `element_id`.
- **L10 [R][Risk]** Version bumps leave stale rows (no GC/backfill); a bump has no effect for never-re-ingested files. → version-scoped cleanup.
- **L11 [V][Maint]** Dead code: unreachable `return None` in retrieval `_generate_query_embedding`; `state.to_dict()` never exists (tutor-block `session_state` always `{}`); `hasattr(compute_result,'_raw_response')` always False; verbose debug logs on hot paths.

## Verified sound (not exhaustive)
Scope isolation (file_id/module_id TEXT columns + `= ANY(text[])`) is consistent end-to-end; RRF math is correct (issue is downstream scale); `message_blocks` JSONB round-trips and gives live/reload figure parity; async consumer persists blocks with the same gating; schema matches what code reads/writes (no drift); graceful degradation (pgvector→503, BM25→vector-only, LLM→fallback) is non-raising; guardrail IDs sent as top-level kwargs (not in model body).

## Recommended fix order
1. H1 (adaptive loop) — highest functional impact, cheap fix + one handler integration test.
2. H2/H3 (IDOR) — security; scope both endpoints.
3. H6 + M1 (tables/formulas grounding + score-scale) — same class as the bug that started this; fix together.
4. H4/H5 (enrichment data-loss) — ingestion correctness.
5. M15 (deterministic retrieval_id) — protects the persistence fixes across re-ingestion.
6. Remaining M/L as capacity allows.
Add the integration-test layer alongside #1–#3.

## Tooling note
`grep_search` is unreliable in this workspace — it returned "no matches" for `interactions`, `CREATE TABLE`, and `githubRepoName` that demonstrably exist. Verify with read_code / read_file, not grep.


---

# Resolution Status (2026-07-01)

All findings worked in 7 phases, fixed **at the seam** with tests, verified:
`multimodal_rag_v2 + chatbot_v2` 885 pass · `lambda/deleteLastMessage` 3 · `cdk test/access-control.test.ts` 6 · frontend ESLint clean · py_compile + node --check clean. (Full CDK `Template.fromStack` suite needs Docker — not run here; no stack `.ts` changed.)

**Systemic root cause addressed:** added the missing handler-level / seam test layer — `chatbot_v2/src/test_handler_integration.py` (calls the real `main.handler()` with only AWS/Bedrock IO stubbed) + `test_persist_turn.py`. This is what the "two paths that disagree" bugs kept slipping through.

## HIGH — all resolved
- **H1** RESOLVED — `interactions` is now a per-turn counter incremented once per processed turn before the eval gate (main.py). Seam test: `test_eval_runs_once_interactions_bootstrapped`, `test_interactions_increments_and_is_persisted_each_turn`.
- **H2** RESOLVED — ownership check (`verifyStudentOwnsSession`, chain Sessions→Student_Modules→Enrolments→Users) on `get_messages`, `/session/messages`, `update_session_name`; `deleteLastMessage.py` gets its own `verify_session_ownership`. Tests: `access-control.test.ts`, `test_deleteLastMessage.py`.
- **H3** RESOLVED — `figure_url` drops the Strategy-3 arbitrary-key passthrough (→404) and makes the enrollment check mandatory/fail-closed before signing.
- **H4** RESOLVED — TEXT is never cached (chunker makes no LLM calls; version-only sort key collapsed multi-chunk TEXT). Test: `test_enrich_with_cache.py`.
- **H5** RESOLVED — embedding backoff + success-rate gate (raise → SQS retry), and `_store_in_pgvector` refuses to DELETE+commit with zero inserts. Tests: `test_generate_embeddings.py`, `test_store_in_pgvector.py`.
- **H6** RESOLVED — `build_table_grounding`/`build_formula_grounding` added; tables/formulas/figures selected pre-generation and grounded into `rag_context`. Seam test: `test_figure_is_both_grounded_and_displayed`.

## MEDIUM
- **M1** RESOLVED — block selection is reference-and-rank-based (no absolute score gate; RRF-scale scores made the old gates unreachable).
- **M2** RESOLVED — `metadata_boost` applied multiplicatively (`score * (1+boost)`), so it can't outrank relevance in the RRF regime.
- **M3** RESOLVED — `_persist_session_state` conditional-put retry no longer clobbers with stale state.
- **M4** RESOLVED — streaming emits a terminal `done=True` before re-raising a guardrail error (no client hang).
- **M5** RESOLVED — one shared `_persist_turn` (DynamoDB-first, block-aware, engagement-logged, async-aware) for normal + tutor. Tests: `test_persist_turn.py`.
- **M6** RESOLVED — one `_session_state_view(state)` used by all 4 return sites; schema now identical (adds `tutor_active` to the normal/guardrail exits). Seam test: `test_guardrail_block_shape_matches_normal`.
- **M7** RESOLVED (was [G]/grep, verified) — `hint_level`/`hint_count` increment on hint-mode selection.
- **M8** RESOLVED — metadata boolean filter serializes to JSON `'true'/'false'`. Test in `test_module_scoped_retrieval.py`.
- **M9** RESOLVED — re-ingestion DELETE uses the indexed `file_id` column. Test in `test_store_in_pgvector.py`.
- **M10** RESOLVED — caption injection/linking anchors with `.match`; multi-caption pages are skipped as ambiguous. Tests in `test_caption_injection.py`.
- **M11** RESOLVED — exact figure-reference regex (`_build_reference_regex`); "figure 4" no longer matches "figure 4.1". Tests in `test_image_escalation.py`.
- **M12** RESOLVED — `AIMessage.TableBlock` fixed (`[]`-truthy bug; reads `summary`/`content` the backend actually emits).
- **M13** RESOLVED BY DECISION — RDS is the authoritative store for `message_blocks` (DynamoDB stays text-only canonical log). See engineering-log ADR-003. Not a bug today.
- **M14** RESOLVED — tutoring requires `status == 'verified'`; partial math results no longer framed as authoritative.
- **M15** DEFERRED — deterministic `retrieval_id`. Risky multi-site change; impact mitigated by the wipe-and-restart workflow. Revisit if incremental re-ingestion becomes routine.
- **M16** RESOLVED BY DOC — guardrail-blocked turns persist to RDS but not DynamoDB, intentionally (blocked content must not re-enter model history). Documented in main.py.

## LOW
- **L1** RESOLVED — `FigureImage` module-level TTL cache (dedupes N+1, avoids re-sign, refreshes before the 1h URL expiry).
- **L2** RESOLVED — enrichment only re-enriches the uncached subset (no more re-running vision on cached images).
- **L3** DEFERRED — share DB conn/secret. Module-global secret cache adds cross-invocation/test state on a per-upload cold path; low value vs risk.
- **L4** DEFERRED — parallel embeddings. Pure perf; adds concurrency risk on top of the new backoff/success-gate.
- **L5** DEFERRED — dedup Haiku topic extraction. `document_summary` and `_extract_and_store_topics` have different prompts/inputs/consumers (pgvector summary unit vs `Module_Files.metadata` topic-aggregation); merging risks changing the `generate_topics` pipeline. ~1 call per upload.
- **L6** RESOLVED — fallback/degraded enrichments are no longer cached (`EnrichedElement.is_fallback`).
- **L7** RESOLVED — `get_messages` returns `200 []` on an empty owned session (was 404).
- **L8** NOT A BUG — the query-analyzer keyword lists are intentionally curated (broad words removed on purpose; see `test_query_analyzer_v2.py::TestRemovedBroadKeywords`). The proposed keyword additions were reverted.
- **L9** DEFERRED — IR dedup by `element_id` vs `content_hash`. Content-only dedup is intentional (docstring + 4 tests); switching would keep repeated headers/footers as retrieval noise. Not a verified bug.
- **L10** DEFERRED — version-scoped GC. Destructive row deletion; needs a migration/backfill design, out of scope for a bug-fix pass.
- **L11** RESOLVED — dead code removed (unreachable `return None`; `state.to_dict`; `_raw_response`).
