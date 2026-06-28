---
inclusion: always
---

# Planning & Refinement Protocol

**Applies when:** user asks to plan/design/architect/propose a feature, or the task is complex (multi-file, new infra, new data flows).
**Does NOT apply:** obvious bug fixes, single-file edits, docs, or when user says "just do it."

## Refinement Loop (max 5 autonomous iterations)

**Pass 1 — Draft:** Problem statement, approach, implementation steps, affected files, testing strategy.

**Pass 2 — Critique** the draft on: completeness, feasibility, constraint violations (IAM/CDK/Lambda), scope creep, data flow gaps, testing blind spots, security, performance/cost.

**Pass 3 — Revise:** Fix gaps, remove scope creep, add error handling, simplify.

**Pass 4 — Score** (8 dimensions, 1–10 each, present average):

| Dimension | Measures |
|---|---|
| Architecture quality | Separation of concerns, existing patterns, coupling |
| Production readiness | Error handling, logging, monitoring, degradation |
| Security | IAM scoping, input validation, secrets |
| Completeness | All requirements, edge cases, missing steps |
| Testability | Test strategy, determinism, critical path coverage |
| Simplicity | Minimal changes, no gold-plating |
| Cost & performance | Lambda sizing, Bedrock calls, caching, cold starts |
| Maintainability | Readability, self-documenting, extensible, stable deps |

## Loop Control
- **Score ≥ 9** → present plan, wait for user approval
- **Score < 9** → auto-loop (focus on weakest dimension), do NOT ask user
- **After 5 auto-loops** → present best version with honest note on unresolved issues

**User feedback is unlimited** (does not count toward the 5 cap). Each round triggers Pass 2→3→4.

## User Commands
| Says | Action |
|---|---|
| "go" / "implement" | Begin implementation |
| Specific feedback | Re-run Pass 2→3→4 |
| "simplify" | Reduce scope, re-run Pass 3 |
| "expand" | Add requirements, re-run Pass 1 |
| "skip" / "just do it" | Implement directly |

## Rules
- No implementation code during planning (prose/pseudocode only)
- Never assume approval — wait for explicit go-ahead
- Never unilaterally expand scope
