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
- `toUserMessage(error)` maps `{status}` → short copy (404 / 429 / ≥500 / null-network / fallback). Reusable for any inline surface.
- React Query hooks expose `isError`, `error`, `refetch` (queries) and `isError`, `error`, `reset` (mutations). Mutations that want to own their error inline set `meta: { suppressGlobalError: true }` — `useFinalizeModule`, `useEditModule`, `useValidatePrompt`, `useEnrollCourse` already do.
- The `Alert` primitive (`components/ui/alert.jsx`) has a `destructive` variant and is the app's inline status surface.

---

## 2. Principles

**2.1 Contextual, persistent, actionable.** Errors surface where the action happened, stay until resolved/dismissed, and offer the next step (Retry for reads; fix-and-resubmit for forms). No transient popups, no global notification region (that was deliberately removed).

**2.2 Reuse the Tier 1 seams.** Reads → `ErrorState` + `refetch`. Writes → a form-top `Alert` (or `FormField` inline error for field-level). Deletes → already done (`ConfirmDialog.error`). Copy comes from `toUserMessage`, with a small per-form override for known status codes (400/409).

**2.3 Don't double-surface.** A mutation that renders its own inline error sets `meta.suppressGlobalError` so the console seam doesn't also log it as "unhandled". (The seam is not user-facing, so this is about log-noise hygiene, not UX.)

**2.4 Behaviour first, minimal churn.** No refactor of the query hooks' data shapes; this is additive UI + a few `meta` flags. No re-introduction of `react-toastify`.

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

For a sub-region (a panel inside a larger screen), render the same `ErrorState` scoped to that region with a `className` for sizing. Existing hand-rolled `isError` alerts (`StudentsTab`, `ChatHistoryTab`, `ConfigurationTab`) migrate to `ErrorState` for consistency (adds Retry they currently lack).

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
    <AlertDescription>{writeErrorCopy(mutation.error)}</AlertDescription>
  </Alert>
)}
```

Where `writeErrorCopy` is a tiny per-form mapper for the known, user-correctable statuses, falling back to `toUserMessage`:

```text
finalize/edit module: 400 → "A module with this name already exists."
                      409 → "Files are still being processed — try again shortly."
                      else → toUserMessage(error)
create/duplicate course: else → toUserMessage(error)   (validation is client-side)
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

### 4.4 `meta.suppressGlobalError` additions
Add the flag to the write mutations that will own their error inline and are *not* already suppressed: `useSavePrompt`, `useCreateCourse`, `useDuplicateCourse`, `useElevateInstructor`, and the admin enroll/unenroll/access mutations used by the staged Save-changes flows (`useUpdateCourseAccess`, `useUpdateInstructorAccess`, `useEnrollInstructor`, `useUnenrollInstructor`). Keeps the console seam quiet for errors the screen now shows. (Deletes + finalize/edit/validate/enroll-course are already suppressed.)

---

## 5. Rejected alternatives
1. **Re-introduce a single app-level notification region** (a toast replacement). Rejected — the new design explicitly removes transient notifications; this would re-create the exact pattern we deleted.
2. **Server-derived error messages.** Rejected — `toUserMessage` already maps status→copy client-side; the API stays a thin data layer.
3. **Leave reads silent, only fix writes.** Rejected — silent failed reads are the larger share of the gap (28 hooks) and the most confusing (blank region, no explanation).

---

## 6. Tasks

- [ ] **T1 — `ErrorState` on reads (Tier 2a).** Add `if (isError) return <ErrorState … onRetry={refetch} />` to each screen in §4.1; migrate the three bespoke `isError` alerts to `ErrorState`. _Tests: per screen, render with the query hook mocked to `{ isError: true }` and assert the error + a working Retry (calls `refetch`)._
- [ ] **T2 — form-top `Alert` on writes (Tier 2b).** Add the `Alert` block + `writeErrorCopy` mapper to each flow in §4.2; surface the admin Save-changes partial-failure. _Tests: mutation mocked to `isError`; assert the Alert + copy (incl. 400/409 mapping); assert the form stays open with input intact._
- [ ] **T3 — optimistic-revert signals (Tier 3).** Add the compact inline signal to the InstructorCourseLayout toggle and the ConfigurationTab reorders. _Tests: mutation `isError` → signal shown; clears on retry._
- [ ] **T4 — `meta.suppressGlobalError` additions (§4.4).** _Tests: none new (behavioural no-op for the log seam); covered by existing hook tests._
- [ ] **T5 — docs.** Update `ui-component-registry.md` / `frontend-conventions.md` if any new copy-mapper helper is extracted; note completion in `engineering-log.md`.

## 7. Acceptance Criteria
- **AC-1:** Every screen in §4.1 renders an `ErrorState` with a working Retry (→ `refetch`) when its read fails; no screen resolves a failed read to a silent empty region.
- **AC-2:** Every write flow in §4.2 shows an inline `Alert` on failure, keeps the user on the form with input preserved, and maps 400/409 to specific copy where applicable.
- **AC-3:** The two live optimistic controls show a brief "reverted" signal on rollback and clear it on the next attempt.
- **AC-4:** No transient/toast/global notification is introduced anywhere.
- **AC-5:** `cd frontend && npm run test` (Vitest) + `npm run lint` + `npm run build` all pass; each new/changed screen has ≥1 error-path test.

## 8. Test Strategy
Vitest + RTL, colocated (`testing-policy`). For each screen/flow: mock the relevant query/mutation hook to an error state and assert the rendered error UI + the recovery affordance (Retry calls `refetch`; form stays open). Deterministic — no network, no real timers beyond RTL. This is the same mocking style the existing feature tests already use (hooks mocked via `vi.mock("@/services/queries", …)`).

## 9. Refinement history
- **Draft:** carved directly from the Tier 1 toast-removal work; the read/write/optimistic inventory is the M2/M3 analysis produced during that task.

## 10. Residual Risks / Open Items
- **Scope size.** Tier 2a touches many screens; it can ship screen-by-screen (each is independent and independently testable) rather than as one big PR.
- **Compact vs full-region `ErrorState`.** A couple of secondary reads (layout access-code/prompt) may warrant a smaller inline note rather than a full dashed panel — per-screen judgment, same component.
- **"Reverted" signal placement (Tier 3).** The toggle sits in a tight header row; the exact placement/anchoring of its inline signal is a small design decision to confirm during implementation.
