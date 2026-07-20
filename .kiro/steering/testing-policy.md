---
inclusion: always
---

# Testing Policy

Every implementation change must include tests. Non-negotiable.

## When to Test
- New feature → happy path + at least one error case
- Bug fix → reproducing test first, then fix
- Refactor → verify existing tests pass; add coverage if untested
- CDK change → add/update assertion tests

## Exempt: doc/comment changes, steering/hook edits

## Frameworks
| Area | Framework | Location | Command |
|---|---|---|---|
| CDK | Jest + `Template.fromStack()` | `cdk/test/*.test.ts` | `cd cdk && npm test` |
| multimodal_rag_v2 | pytest | Colocated `test_*.py` | `cd cdk && python -m pytest multimodal_rag_v2/ -v` |
| chatbot_v2 | pytest | Colocated `test_*.py` | `cd cdk && python -m pytest chatbot_v2/ -v` |
| math_compute | pytest | `cdk/math_compute/tests/` | `cd cdk && python -m pytest math_compute/ -v` |
| Frontend (unit/component) | Vitest + React Testing Library | Colocated `*.test.jsx` | `cd frontend && npm run test` |
| Frontend (E2E smoke) | Playwright | `frontend/e2e/*.spec.js` | `cd frontend && npm run test:e2e` |

> **Frontend testing** harness **landed in OCELIA rebuild Phase 1** — **Vitest + RTL** (`npm run test`, jsdom env, `src/test/setup.js`) and **Playwright** (`npm run test:e2e`) are configured and green. The bar is **≥1 automated test per critical flow** (login/role routing, course join, student chat + streaming, module create/edit, prompt save + conflict, admin CRUD) — not a coverage percentage. The Quality Rules below apply to frontend tests too. (Playwright browsers install on first run: `npx playwright install`; real critical-flow smokes are authored from Phase 5.)

## Quality Rules
- Deterministic: no network, no real AWS creds, no unseeded randomness
- Use factories (`_make_text_element()`, `createTestStacks()`) over duplicated setup
- Test behavior not implementation
- One assertion concept per test
- Run tests before presenting result; fix failures before marking complete
