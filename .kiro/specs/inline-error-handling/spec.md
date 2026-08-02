# Inline Error Handling (Tiers 2–3) — Spec

**Status:** Proposed — awaiting go-ahead before implementation. Direct follow-up to the **toast removal + Tier 1** work (see the "Toast notifications fully removed" entry in `engineering-log.md`). Frontend-only; no CDK/IAM/Bedrock/DB change.
**Area:** `frontend` — feature screens (`src/features/{student,instructor,admin}/*`, `src/app/layouts/*`) + two composed components already shipped in Tier 1 (`ErrorState`, `ConfirmDialog.error`). Colocated Vitest + RTL tests per `testing-policy`.
**Depends on (already landed in Tier 1):** the presentational `ErrorState` composed component; `toUserMessage()` (`services/apiError.js`) repurposed for inline copy; the global `queryClient` handler reduced to a `console.error` + telemetry seam; `ConfirmDialog`'s `error` prop (delete flows already use it).

---

## 1. Problem Statement

Tier 1 removed `react-toastify` and made **successes** implicit (the visible state change is the confirmation) and **delete failures** visible (in the `ConfirmDialog`). But two error surfaces were intentionally deferred and are currently **logged-but-not-shown**:

1. **Failed data reads.** ~28 query hooks feed screens; only three screens (`StudentsTab`, `ChatHistoryTab`, `ConfigurationTab`) render an `isError` state. On every other screen a failed GET (after retries) currently shows the user *nothing* — the region just stays empty/loading-resolved-to-empty. The error is logged by the global seam but never surfaced.
2. **Failed writes (create / edit / save / toggle / reorder).** With the per-call toasts gone, mutation failures for module publish/edit, prompt save, course create/duplicate, instructor invite, the admin staged "Save changes" flows, and the optimistic toggles/reorders are logged but not shown. Several are user-correctable (e.g. 400 duplicate-name, 409 files-still-processing) and *should* be surfaced where the action happened.

This is the known interim gap. The industry-standard end state (see the earlier error-handling discussion) is **inline, contextual, actionable** error surfaces — not silence. This spec closes that gap without reintroducing any transient/global notification.

### Load-bearing facts (verified in Tier 1 work)
- `ErrorState` (`src/components/composed/ErrorState.jsx`) exists: presentational, `{ icon?, title?, description?, onRetry?, retryLabel?, className? }`, `role="alert"`, renders a Retry button only when `onRetry` is passed. Mirrors `EmptyState`.
- `ConfirmDialog` accepts `error` (string) → renders a destructive `Alert` and stays open. All six delete sites already use it.
- `toUserMessage(error)` maps `{status}` → short copy (404 / 429 / ≥500 / null-network / fallback). Reusable for any inline surface; Tier 2b extends it with an optional `overrides` map (§4.2) — backward-compatible with every Tier 1 caller.
- React Query hooks expose `isError`, `error`, `refetch` (queries) and `isError`, `error`, `reset` (mutations). Mutations that want to own their error inline set `meta: { suppressGlobalError: true }` — `useFinalizeModule`, `useEditModule`, `useValidatePrompt`, `useEnrollCourse` already do.
- The `Alert` primitive (`components/ui/alert.jsx`) has a `destructive` variant and is the app's inline status surface.

---

## 2. Principles

**2.1 Contextual, persistent, actionable.** Errors surface where the action happened, stay until resolved/dismissed, and offer the next step (Retry for reads; fix-and-resubmit for forms). No transient popups, no global notification region (that was deliberately removed).

**2.2 Reuse the Tier 1 seams.** Reads → `ErrorState` + `refetch`. Writes → a form-top `Alert` (or `FormField` inline error for field-level). Deletes → already done (`ConfirmDialog.error`). Copy comes from `toUserMessage`, with a small per-form override for known status codes (400/409).

**2.3 Don't double-surface — as a convention, not a per-mutation choice.** Any mutation that renders its own inline error sets `meta.suppressGlobalError` (§4.4) so the log/telemetry seam doesn't also record the same failure. Making it a *rule* (documented in `frontend-conventions.md`) — rather than a decision each author re-makes — is what keeps the logs quiet as new mutations are added.

**2.4 Behaviour first, minimal churn.** No refactor of the query hooks' data shapes; this is additive UI + a few `meta` flags. No re-introduction of `react-toastify`.

**2.5 Error ownership.** Each query or mutation owns rendering its own error state, next to where its data/action lives. A parent layout must **not** inspect or aggregate its children's error states unless it owns the corresponding query. Concretely, avoid:

```jsx
<CoursePage>            // owns none of these queries
  <AnalyticsPanel/>     // owns useAnalytics    → renders its own error
  <ReferencePanel/>     // owns useFileUrl       → renders its own error
  <FilesPanel/>         // owns useModuleFiles   → renders its own error
</CoursePage>
```

`CoursePage` should not reach into the three panels to render one aggregated banner — that re-creates the "one failure blanks everything" problem the localized approach (§4.1) exists to prevent. The rule is simply: **whoever calls the hook renders its error.**

---

## 3. Goals / Non-Goals

**Goals**
- **Tier 2a — reads:** every screen that renders query data shows an `ErrorState` (with Retry → `refetch`) on `isError`, instead of a silent empty region.
- **Tier 2b — writes:** create / edit / save / invite flows surface failures inline (form-top `Alert`, or field-level via `FormField` where the error maps to a field), keeping the user on the form with their input intact.
- **Tier 3 — optimistic reverts:** the live optimistic mutations (course-active toggle; concept/module reorder) show a brief inline "couldn't save — reverted" message next to the control when they roll back.
- Every change ships with a Vitest + RTL test for the error path (`testing-policy`).

**Non-Goals**
- No transient/toast/snackbar or global notification region (removed by design).
- No backend, CDK, IAM, or schema change.
- No change to the auth/inline (403) or 401-refresh paths (already correct).
- No new error-reporting/telemetry backend (the `TODO(telemetry)` seam is left as-is; wiring a sink is separate).

---

## 4. Design

### 4.1 Tier 2a — reads (`ErrorState` on `isError`)

Standard pattern for a full-region read:

```jsx
const { data = [], isLoading, isError, error, refetch } = useThing(id)
...
if (isError) {
  return <ErrorState description={toUserMessage(error)} onRetry={() => refetch()} />
}
```

**Primary vs secondary reads (the rule that bounds this tier).** A failed read must NOT blindly blank the whole screen:

- A screen's **primary** query — the one whose data *is* the page (the roster on `StudentsTab`, the message table on `ChatHistoryTab`, the course/instructor lists, the student course page) — failing **replaces the primary content region** with a full-region `ErrorState` + Retry.
- A **secondary** query — a panel or accessory within an otherwise-populated page (the access code / prompt-conflict dot in `InstructorCourseLayout`, an analytics panel, a module's file list, the reference-doc panel) — failing renders a **localized `ErrorState` (or compact inline note) scoped to that panel only.** It never blanks the page.

Worked example — a Course screen backed by `files` / `prompt` / `analytics` / `modules`: if `files` fails but the other three succeed, **only the files panel** shows an error + Retry; the rest of the page stays usable. Each screen classifies its own queries (primary = the content the route exists to show; everything else = secondary); **when in doubt, localize.** Although there are roughly 28 query hooks, many are rendered in multiple independent regions, so the implementation is closer to **40–60 localized error surfaces** — most of them secondary panels that should fail *locally*, which keeps each screen's change small (and its test focused).

Existing hand-rolled `isError` alerts (`StudentsTab`, `ChatHistoryTab`, `ConfigurationTab`) migrate to `ErrorState` for consistency (and gain the Retry they currently lack).

**Screens/queries to cover** (the read hooks with no inline error today):

| Screen | Query hook(s) |
|---|---|
| StudentHome | `useCourses`, `useCourseProgressSummary` |
| CourseView | `useCoursePage` |
| StudentChat | `useModuleSessions`, `useSessionMessages`, `useModuleFiles` (chat stream already has `RetryBanner`) |
| ReferenceDocPanel | `useFileUrl` |
| InstructorCourseLayout | `useInstructorCourses`, `useCoursePrompt`, `useAccessCode` |
| Insights / AnalyticsChart | `useAnalytics` |
| SettingsTab | `useCoursePrompt`, `usePreviousPrompts` |
| StudentDetail | `useStudentMessages` |
| CourseWizard / EditModule | `useConcepts`, `useModules`, `useCourseFiles`, `useModuleReferences`, `useModuleAllFiles` |
| admin CourseList / CourseDetail | `useAdminCourses`, `useCourseInstructors`, `useAdminInstructors` |
| admin InstructorList / InstructorDetail | `useAdminInstructors`, `useInstructorAssignedCourses` |
| migrate to `ErrorState` | `StudentsTab`, `ChatHistoryTab`, `ConfigurationTab` (already have a bespoke Alert) |

Not every one needs a full-page error (e.g. `useCoursePrompt`/`useAccessCode` in the layout are secondary — a compact inline note is enough). Each screen decides full-region vs compact per its layout; the component is the same.

### 4.2 Tier 2b — writes (form-top `Alert`)

Pattern (form-top, above the fields / footer):

```jsx
{mutation.isError && (
  <Alert variant="destructive">
    <AlertDescription>
      {toUserMessage(mutation.error, { 400: "A module with this name already exists." })}
    </AlertDescription>
  </Alert>
)}
```

**One translation function, not per-form mappers.** Rather than a `writeErrorCopy()` per form, extend the single existing `toUserMessage(error, overrides?)` with an optional per-status override map — so error copy stays in one place and no form invents its own mapper:

```text
// services/apiError.js — overrides is optional, so every Tier 1 caller keeps working
toUserMessage(error, overrides = {}) =>
  overrides[error?.status] ?? <existing status→copy mapping>
```

Each form passes only the codes it specializes; everything else falls through to the shared default:

```text
CourseWizard Publish / EditModule Save:
  toUserMessage(err, { 400: "A module with this name already exists.",
                       409: "Files are still being processed — try again shortly." })
create / duplicate course, save prompt, invite:
  toUserMessage(err)                        // shared default (validation is client-side)
```

**Flows to cover:**

| Flow | Mutation | Surface |
|---|---|---|
| CourseWizard Publish | `useFinalizeModule` (already `suppressGlobalError`) | form-top `Alert` on the review step; 400/409 copy |
| EditModule Save | `useEditModule` (already `suppressGlobalError`) | form-top `Alert`; 400 copy |
| SettingsTab Save | `useSavePrompt` | `Alert` above the footer; set `suppressGlobalError` |
| CreateCourse | `useCreateCourse` | `Alert` in the dialog; set `suppressGlobalError` |
| DuplicateCourse / DuplicateCourseDialog | `useDuplicateCourse` | `Alert` in the dialog; set `suppressGlobalError` |
| AddInstructorDialog | `useElevateInstructor` (per-email `Promise.allSettled`) | `Alert` summarizing "N of M invites failed"; keep the dialog open |
| admin CourseDetail / InstructorDetail "Save changes" | staged `mutateAsync` batch | form-top `Alert` on partial failure (the `catch` currently swallows); report that some changes didn't save |

Field-level errors that already work (JoinCourseDialog inline `setError`, CourseWizard step-0 duplicate-name `nameError`, SettingsTab conflict inline) stay as-is — they're already the right pattern.

### 4.3 Tier 3 — optimistic-revert signals

The two **live** optimistic mutations (the admin toggles are *staged*, so they're covered by 4.2's Save-changes Alert):

| Control | Mutation | Signal |
|---|---|---|
| InstructorCourseLayout course-active toggle | `useUpdateInstructorCourseAccess` (optimistic + rollback) | compact inline text/`Alert` beside the toggle: "Couldn't update — reverted." bound to `mutation.isError`, cleared on next attempt |
| ConfigurationTab concept/module drag-reorder | `useReorderConcepts` / `useReorderModules` (optimistic + rollback) | compact inline `Alert` above the tree: "Couldn't save the new order — reverted." |

These render off `mutation.isError` and clear when the next attempt starts (`isPending`) or succeeds. Because the cache already rolls back in the hook's `onError`, the UI is consistent; the signal just explains the snap-back.

### 4.4 `meta.suppressGlobalError` — a convention, not ad-hoc flags

**Convention to add to `frontend-conventions.md`: *any mutation that renders its own user-visible error MUST set `meta: { suppressGlobalError: true }`.*** Symmetrically, a mutation that does *not* surface its own error (fire-and-forget / background) leaves the flag off so the seam still captures it. Making this a rule — not a per-mutation judgment — is what stops log-noise from silently returning the day someone adds, say, `useRenameCourse()`, wires an inline `Alert`, and forgets the flag.

Apply it to the write mutations gaining inline errors here that aren't already suppressed: `useSavePrompt`, `useCreateCourse`, `useDuplicateCourse`, `useElevateInstructor`, and the admin staged-save mutations (`useUpdateCourseAccess`, `useUpdateInstructorAccess`, `useEnrollInstructor`, `useUnenrollInstructor`). **Also retrofit the six Tier 1 delete mutations** (`useDeleteCourse`, `useDeleteInstructorCourse`, `useLowerInstructor`, `useDeleteStudent`, `useDeleteModule`, `useDeleteConcept`): they already render inline via `ConfirmDialog.error` but were left logging, so they don't yet meet the convention. (finalize/edit/validate/enroll-course already comply.)

> **Caveat (§10):** the global seam is *log-only* today, so `suppressGlobalError` currently couples "don't double-show" with "don't log/telemeter." Once a telemetry sink is wired we may want to split those — always telemeter genuine faults (5xx/network), only suppress the *user-facing* duplicate — so inline-handled faults still reach observability. Flagged so the coupling stays a conscious choice.

---

## 5. Rejected alternatives
1. **Re-introduce a single app-level notification region** (a toast replacement). Rejected — the new design explicitly removes transient notifications; this would re-create the exact pattern we deleted.
2. **Server-derived error messages.** Rejected — `toUserMessage` already maps status→copy client-side; the API stays a thin data layer.
3. **Leave reads silent, only fix writes.** Rejected — silent failed reads are the larger share of the gap (28 hooks) and the most confusing (blank region, no explanation).

---

## 6. Tasks

- [ ] **T1 — `ErrorState` on reads (Tier 2a), in three independently-reviewable phases** (classify each query primary vs secondary per §4.1 — most are secondary and fail *locally*):
  - [ ] **T1a — student:** StudentHome, CourseView, StudentChat reads (the stream keeps `RetryBanner`), ReferenceDocPanel.
  - [ ] **T1b — instructor:** InstructorCourseLayout, InsightsTab/AnalyticsChart, SettingsTab, StudentDetail, CourseWizard, EditModule; migrate `StudentsTab` / `ChatHistoryTab` / `ConfigurationTab` off their bespoke alerts.
  - [ ] **T1c — admin:** CourseList, CourseDetail, InstructorList, InstructorDetail.
  - _Tests per screen: hook mocked to `{ isError: true }` → primary failure shows a full-region `ErrorState`, a secondary failure a panel-scoped one (rest of page still renders); Retry calls `refetch`; **plus the recovery path — error→success re-render (AC-2).**_
- [ ] **T2 — form-top `Alert` on writes (Tier 2b).** Add the `Alert` block to each flow in §4.2 using `toUserMessage(err, overrides)`; surface the admin Save-changes partial-failure. _Tests: mutation mocked to `isError` → assert the Alert + copy (incl. 400/409 overrides) and that the form stays open with input intact._
- [ ] **T3 — optimistic-revert signals (Tier 3).** Add the compact inline signal to the InstructorCourseLayout toggle and the ConfigurationTab reorders. _Tests: mutation `isError` → signal shown; clears on retry._
- [ ] **T4 — `suppressGlobalError` convention (§4.4).** Extend `toUserMessage` with the optional `overrides` param; add the flag to the write mutations gaining inline errors AND retrofit the six Tier 1 delete mutations; document the convention in `frontend-conventions.md`. _Tests: a `toUserMessage` unit test for the overrides path; the flag itself is a log-seam no-op covered by existing hook tests._
- [ ] **T5 — docs.** Note completion in `engineering-log.md`; refresh `ui-component-registry.md`'s `ErrorState` entry with the Retry / secondary-panel usage.

## 7. Acceptance Criteria
- **AC-1:** A failed **primary** read renders a full-region `ErrorState` + working Retry (→ `refetch`); a failed **secondary** read renders an `ErrorState` scoped to its panel and leaves the rest of the page usable. No screen resolves a failed read to a silent empty region.
- **AC-2:** **After a successful Retry the `ErrorState` disappears automatically and the normal content renders** — no manual refresh, no stuck error (error → retry → success → content).
- **AC-3:** Every write flow in §4.2 shows an inline `Alert` on failure and **keeps the user on the form with their input preserved** — never clears the form on a failed save. Known statuses (400/409) map to specific copy.
- **AC-4:** All error copy comes from the single `toUserMessage(error, overrides?)` — no per-form mapper.
- **AC-5:** Every mutation that renders its own inline error sets `meta.suppressGlobalError` (including the retrofitted Tier 1 delete mutations), and the convention is written into `frontend-conventions.md`.
- **AC-6:** The two live optimistic controls show a brief "reverted" signal on rollback and clear it on the next attempt.
- **AC-7:** All new inline error surfaces use the existing accessible primitives (`ErrorState` or `Alert` — both `role="alert"`) and stay keyboard-accessible (Retry is a real `Button`); no custom, less-accessible error widgets are introduced.
- **AC-8:** No transient/toast/global notification is introduced anywhere.
- **AC-9:** `cd frontend && npm run test` (Vitest) + `npm run lint` + `npm run build` all pass; each new/changed screen has ≥1 error-path test **including the retry→recovery path**.

## 8. Test Strategy
Vitest + RTL, colocated (`testing-policy`), reusing the existing `vi.mock("@/services/queries", …)` style. For each screen/flow:
- **Error render:** mock the hook to an error state → assert the right surface (primary = full-region `ErrorState`; secondary = panel-scoped, with the rest of the page still rendered; write = form-top `Alert` with the mapped copy).
- **Recovery (AC-2):** mock the hook error-*then*-success (`mockReturnValueOnce({ isError: true, refetch })`, then a success value), click **Retry**, and assert the `ErrorState` is gone and the content rendered — exactly the regression a "Retry calls `refetch`" assertion alone would miss.
- **Form preservation (AC-3):** after a failed write, assert the field values are still present.
- **Accessibility (AC-7):** query the surfaces by role (`getByRole("alert")`, `getByRole("button", { name: /retry/i })`) rather than by text — this both reads clearly and enforces that the accessible `ErrorState`/`Alert` primitives (not a bespoke `<div>`) are what's rendered.

Deterministic — no network, no real timers beyond RTL.

## 9. Refinement history
- **Draft:** carved directly from the Tier 1 toast-removal work; the read/write/optimistic inventory is the M2/M3 analysis produced during that task.
- **Reviewer round 1:** (1) added the **primary-vs-secondary read rule** (§4.1) so a secondary-query failure never blanks a whole page — this is what actually bounds Tier 2a's size; (2) replaced the per-form `writeErrorCopy()` with a single `toUserMessage(error, overrides?)` (§4.2, §4.4); (3) elevated `suppressGlobalError` to a documented **convention** and added a task to **retrofit the Tier 1 delete mutations**, plus a telemetry-coupling caveat (§4.4, §10); (4) **split Tier 2a into student / instructor / admin phases** (§6) for smaller reviews; (5) added **AC-2 retry→recovery** and made **form-input-preservation** an explicit AC + test (§7, §8).
- **Reviewer round 2:** (1) added **§2.5 Error ownership** (whoever calls the hook renders its error; parents don't aggregate children's errors) with the `<CoursePage>` anti-pattern; (2) softened the "~28 hooks → 40–60 surfaces" wording to read as architecture doc; (3) added **AC-7 accessibility** (new surfaces reuse `ErrorState`/`Alert` + stay keyboard-accessible) with a role-based test convention (§8).

## 10. Residual Risks / Open Items
- **Telemetry vs. `suppressGlobalError` coupling.** The seam is log-only today, so suppressing it for inline-handled mutations also hides those faults from a future telemetry sink. If observability needs *all* faults, split the seam (always telemeter; only suppress the user-facing duplicate). **Decision needed when telemetry is wired.**
- **Primary/secondary is guidance, not enforced.** The classification (§4.1) is a per-screen review judgment, not a lint rule — so it relies on reviewers; the phasing (§6) keeps each review small enough to catch mis-classifications.
- **Compact vs full-region `ErrorState`.** Secondary reads use a smaller inline note rather than a full dashed panel — same component, `className` for sizing.
- **"Reverted" signal placement (Tier 3).** The course-active toggle sits in a tight header row; the exact anchoring of its inline signal is a small design decision to confirm during implementation.
