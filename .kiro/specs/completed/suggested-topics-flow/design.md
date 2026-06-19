# Design Document: Suggested Topics Flow

## Architecture Overview

This feature modifies two existing React pages (`InstructorNewModule.jsx` and `InstructorEditCourse.jsx`) to improve the topic suggestion workflow. The changes are purely frontend — no backend API or CDK changes are required. The existing `POST /instructor/generate_topics` endpoint already returns the necessary data.

The design introduces:
1. A shared utility function for the "should trigger generation" condition
2. A shared deduplication/merge utility
3. A new `SuggestedTopicsPanel` UI section for the Edit Module page
4. Auto-generation wiring on the New Module page

```
┌─────────────────────────────────────────────────────────────┐
│                    InstructorNewModule                        │
│                                                              │
│  useProcessingPoller ──► shouldAutoGenerate() ──► API call   │
│                                  │                           │
│                                  ▼                           │
│                    mergeTopics(existing, incoming)            │
│                                  │                           │
│                                  ▼                           │
│                    setKeyTopics(merged)                       │
│                    + success toast                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   InstructorEditCourse                        │
│                                                              │
│  useProcessingPoller ──► shouldAutoGenerate() ──► API call   │
│  "Suggested Topics" btn ─────────────────────────► API call  │
│                                  │                           │
│                                  ▼                           │
│                    setSuggestedTopics(result.topics)          │
│                                  │                           │
│                                  ▼                           │
│                    <SuggestedTopicsPanel>                     │
│                      - selectable chips                       │
│                      - "Add All" / "Dismiss" actions          │
│                      - click chip → addToKeyTopics()          │
│                    </SuggestedTopicsPanel>                    │
└─────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### Utility: `shouldAutoGenerate(trackedFiles)`

A pure function extracted to `frontend/src/utils/topicGenerationHelpers.js` that determines whether auto-generation should fire.

```javascript
/**
 * Determines whether auto-generation should be triggered.
 * @param {Object} trackedFiles - Map of fileId -> { status: string }
 * @returns {boolean} true when all files are terminal AND at least one is "complete"
 */
export function shouldAutoGenerate(trackedFiles) {
  const entries = Object.values(trackedFiles);
  if (entries.length === 0) return false;

  const terminalStatuses = ["complete", "failed", "timed_out"];
  const allTerminal = entries.every((f) => terminalStatuses.includes(f.status));
  const hasComplete = entries.some((f) => f.status === "complete");

  return allTerminal && hasComplete;
}
```

### Utility: `mergeTopics(existing, incoming)`

A pure function for deduplicating and merging topic arrays (case-insensitive).

```javascript
/**
 * Merges incoming topics into existing topics, skipping case-insensitive duplicates.
 * @param {string[]} existing - Current key topics
 * @param {string[]} incoming - New topics to merge
 * @returns {string[]} Combined list with no duplicates
 */
export function mergeTopics(existing, incoming) {
  const existingLower = new Set(existing.map((t) => t.toLowerCase().trim()));
  const toAdd = incoming.filter(
    (t) => t.trim() && !existingLower.has(t.toLowerCase().trim())
  );
  return [...existing, ...toAdd];
}
```

### Utility: `findDuplicates(existing, incoming)`

Returns the subset of incoming topics that already exist (case-insensitive match).

```javascript
/**
 * Finds which incoming topics are duplicates of existing ones.
 * @param {string[]} existing - Current key topics
 * @param {string[]} incoming - Topics to check
 * @returns {Set<string>} Set of incoming topic strings that are duplicates (original casing)
 */
export function findDuplicates(existing, incoming) {
  const existingLower = new Set(existing.map((t) => t.toLowerCase().trim()));
  return new Set(
    incoming.filter((t) => existingLower.has(t.toLowerCase().trim()))
  );
}
```

### Component: `SuggestedTopicsPanel` (inline in `InstructorEditCourse.jsx`)

Not extracted as a shared component since it's only used on the Edit page. Rendered as a section below the Key Topics area.

**Props/State interface:**
```javascript
// State managed in InstructorEditCourse
const [suggestedTopics, setSuggestedTopics] = useState([]); // topics from API
const [duplicateTopics, setDuplicateTopics] = useState(new Set()); // pre-computed duplicates
```

**Visual spec:**
- Container: `Box` with light background (`sx={{ bgcolor: 'action.hover', borderRadius: 1, p: 2, mt: 1 }}`)
- Header row: "Suggested Topics" label + "Add All" button + "Dismiss" button
- Chips: MUI `Chip` with `variant="filled"`, `color="secondary"`, `clickable` — visually distinct from the `variant="outlined"` `color="primary"` key topic chips
- Duplicate chips: rendered with `disabled` state and a tooltip "Already in your topics"
- Area hides when `suggestedTopics` is empty

### InstructorNewModule Changes

1. **Add state:** `isGeneratingTopics` (boolean)
2. **Add ref:** `hasAutoGeneratedRef = useRef(false)` — prevents duplicate triggers
3. **Add effect:** watches `trackedFiles` changes, calls `shouldAutoGenerate()`, gates on `hasAutoGeneratedRef`
4. **Add handler:** `handleAutoGenerateTopics()` — calls API, on success calls `mergeTopics(keyTopics, result.topics)` and sets result, shows toast
5. **Remove:** the static "Save the module first…" text block
6. **Add:** loading indicator (MUI `CircularProgress` + caption) near Key Topics when `isGeneratingTopics === true`

### InstructorEditCourse Changes

1. **Add state:** `suggestedTopics`, `duplicateTopics`
2. **Replace:** "Populate from generated topics" button with "Suggested Topics" button
3. **Modify `handleGenerateTopics`:** on success, set `suggestedTopics` instead of `setModuleTopics`, compute duplicates via `findDuplicates(keyTopics, result.topics)`
4. **Modify auto-generation effect:** on success, same as above — populate `suggestedTopics` panel instead of overwriting
5. **Add:** `SuggestedTopicsPanel` section with Add All / Dismiss / individual chip click handlers
6. **Add handlers:**
   - `handleAddSuggestion(topic)` — adds single topic via `mergeTopics`, removes from `suggestedTopics`
   - `handleAddAllSuggestions()` — merges all non-duplicate suggestions, clears `suggestedTopics`
   - `handleDismissSuggestions()` — clears `suggestedTopics`

## Data Flow

### New Module Page — Auto-Generation Sequence

```
1. Instructor uploads files → useFileUpload → results handed to useProcessingPoller
2. Poller updates trackedFiles state as files process
3. useEffect detects shouldAutoGenerate(trackedFiles) === true
4. Guard: hasAutoGeneratedRef.current → if true, skip (idempotence)
5. Set hasAutoGeneratedRef.current = true
6. Set isGeneratingTopics = true
7. POST /instructor/generate_topics { module_id: moduleId }
8a. Success → mergeTopics(keyTopics, result.topics) → setKeyTopics → toast.success
8b. Processing → toast.info with ready/total counts
8c. Error → toast.error, keyTopics unchanged
9. Set isGeneratingTopics = false
```

### Edit Module Page — Manual "Suggested Topics" Flow

```
1. Instructor clicks "Suggested Topics" button
2. Set isGeneratingTopics = true (button disabled + spinner)
3. POST /instructor/generate_topics { module_id: module.module_id }
4a. Success → setSuggestedTopics(result.topics), compute duplicates
4b. Processing → toast.info
4c. Error → toast.error
5. Set isGeneratingTopics = false
6. Instructor interacts with suggestion chips:
   - Click chip → handleAddSuggestion (moves to keyTopics)
   - "Add All" → handleAddAllSuggestions (bulk merge)
   - "Dismiss" → handleDismissSuggestions (clear panel)
7. When suggestedTopics.length === 0, panel hides
```

### Edit Module Page — Auto-Generation on File Completion

Same trigger as New Module page but populates `suggestedTopics` state instead of directly setting `keyTopics`. The existing `keyTopics` are never modified by auto-generation.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| API returns `{ status: "processing" }` | Toast with "Topic extraction is still processing (X/Y files ready)" — no UI state change |
| API returns `{ status: "no_files" }` | Toast "No files uploaded yet" — no UI state change |
| API returns `{ status: "error", message }` | Toast error with message — no UI state change |
| Network error / exception | Toast "Failed to generate topics" — no UI state change |
| Auto-generation fires when keyTopics already manually entered (New Module) | `mergeTopics` skips duplicates, only adds new ones |
| Suggestion already in keyTopics (Edit Module) | Chip rendered as disabled with tooltip; skip on click/Add All |

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `frontend/src/utils/topicGenerationHelpers.js` | **New** | `shouldAutoGenerate`, `mergeTopics`, `findDuplicates` utilities |
| `frontend/src/pages/instructor/InstructorNewModule.jsx` | **Modified** | Add auto-generation effect, loading indicator, remove static message |
| `frontend/src/pages/instructor/InstructorEditCourse.jsx` | **Modified** | Replace "Populate" button with "Suggested Topics" + panel, modify auto-gen to use suggestions UI |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Auto-generation trigger condition

*For any* map of tracked files, `shouldAutoGenerate` returns `true` if and only if all entries have a terminal status (`complete`, `failed`, or `timed_out`) AND at least one entry has status `complete`.

**Validates: Requirements 1.1, 5.1**

### Property 2: Auto-generation fires at most once

*For any* sequence of `trackedFiles` state transitions applied to a component using the `hasAutoGeneratedRef` guard, the generate-topics API call is invoked at most once per component lifecycle, regardless of how many intermediate state updates occur.

**Validates: Requirements 1.5, 5.4**

### Property 3: Merge deduplication preserves existing topics

*For any* existing key topics list and any incoming topics list, `mergeTopics(existing, incoming)` returns a result that: (a) starts with all elements of `existing` in order, (b) appends only elements from `incoming` whose lowercase-trimmed form is not already in `existing`, and (c) has length ≤ `existing.length + incoming.length`.

**Validates: Requirements 2.5, 4.3, 4.4**

### Property 4: Merge deduplication is case-insensitive

*For any* existing topic `t` and any incoming topic whose lowercased-trimmed form equals the lowercased-trimmed form of `t`, `mergeTopics` will not add the incoming topic to the result.

**Validates: Requirements 2.5, 4.3**

### Property 5: Deleting a topic reduces list length by one

*For any* non-empty key topics list and any valid index within that list, removing the topic at that index produces a list of length `n - 1` that no longer contains the removed topic at that position.

**Validates: Requirements 2.3**

### Property 6: Adding a unique topic grows list by one

*For any* key topics list and any new topic string that is non-empty, non-whitespace, and not already present (case-sensitive per the existing input handler), adding it produces a list of length `n + 1` whose last element is the new topic.

**Validates: Requirements 2.4**

### Property 7: Auto-generation on Edit page preserves existing key topics

*For any* existing key topics list and any successful auto-generation response, the `keyTopics` state remains identical before and after the auto-generation completes — only `suggestedTopics` state changes.

**Validates: Requirements 5.3**

### Property 8: Selecting a suggestion moves it from suggestions to key topics

*For any* set of suggested topics and any single suggestion selected by the instructor, after selection: (a) the suggestion is no longer in the `suggestedTopics` list, and (b) if it was not a duplicate, it is now in `keyTopics`.

**Validates: Requirements 4.2, 4.6**

### Property 9: "Add All" produces the union of key topics and non-duplicate suggestions

*For any* current key topics and current suggestions, clicking "Add All" produces a `keyTopics` equal to `mergeTopics(keyTopics, suggestedTopics)` and empties the `suggestedTopics` array.

**Validates: Requirements 4.4, 4.6**

### Property 10: findDuplicates correctly identifies existing topics

*For any* existing topics list and incoming topics list, `findDuplicates(existing, incoming)` returns exactly the set of incoming topics whose lowercased-trimmed form matches any lowercased-trimmed form in existing.

**Validates: Requirements 4.3**
