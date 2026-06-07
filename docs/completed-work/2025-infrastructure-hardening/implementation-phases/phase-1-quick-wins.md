# Phase 1 — Quick Wins (Low Risk, High Impact)

## 1.1 Remove Dead Code & Unused Dependencies

### Dead Source Files

Two files in `frontend/src/functions/` are never imported anywhere in the application:

- `sigV4Client.js` — custom AWS SigV4 signing implementation (294 lines)
- `getSignedRequest.js` — wrapper around sigV4Client (59 lines)

These are leftover from an earlier architecture where the app signed API requests with IAM credentials. The current app uses Cognito JWT tokens directly via `fetchAuthSession()`. Both files can be deleted.

Additionally:

- `frontend/src/utils/auth.js` — exports `getAuthSessionAndEmail()` but is never imported by any file. `InstructorEditCourse.jsx` has its own local copy of the same function. This file can be deleted.
- `frontend/src/assets/react.svg` — default Vite scaffold asset, never referenced in source. Can be deleted.

### Unused npm Dependencies

The following `package.json` dependencies are not imported anywhere in frontend source code and can be removed:

| Package | Why it's unused |
|---|---|
| `crypto-js` | Only used by `sigV4Client.js` (dead code) |
| `@aws-crypto/sha256-js` | Leftover from SigV4 flow, not imported anywhere |
| `@aws-sdk/credential-provider-node` | Server-side package, never used in browser code |
| `@smithy/signature-v4` | Leftover from SigV4 flow, not imported anywhere |
| `@smithy/protocol-http` | Not imported anywhere in source |
| `@smithy/eventstream-codec` | Not imported anywhere in source |
| `@smithy/util-utf8` | Not imported anywhere in source |
| `@aws-sdk/client-s3` | Not imported anywhere in frontend source |
| `@aws-sdk/client-bedrock-agent-runtime` | Not imported anywhere in frontend source |
| `@aws-sdk/types` | Not imported anywhere in frontend source |
| `@aws-sdk/client-cognito-identity` | Not imported in frontend source (used in backend Lambda code via `@aws-sdk/client-cognito-identity-provider` — a different package) |
| `react-beautiful-dnd` | No `DragDropContext`/`Droppable`/`Draggable` usage — the `draggable` prop on `ToastContainer` is from `react-toastify`, unrelated |
| `amazon-cognito-identity-js` | Not imported in source code. Not a dependency of `aws-amplify` v6 (verified — `npm ls` shows it as a direct-only dep with no dependents). Leftover from an earlier Amplify version. |

Note on `@mui/x-date-pickers`: Not directly used in source code, but it's a required peer dependency of `material-react-table`. Removing it breaks the build. Keep it.

Note on `@aws-amplify/ui-react`: This package is only used for its CSS import (`@aws-amplify/ui-react/styles.css` in `App.jsx`). No Amplify UI components (`Authenticator`, `Button`, etc.) are used. Consider whether the CSS is actually needed — if it's only providing base Amplify styles that aren't visible, the package and import can be removed.

### Unused Imports in Source Files

| File | Unused Import |
|---|---|
| `App.jsx` | `cognitoUserPoolsTokenProvider` from `aws-amplify/auth/cognito` |
| `App.jsx` | `CookieStorage` from `aws-amplify/utils` |
| `InstructorEditConcept.jsx` | `getCurrentUser` from `aws-amplify/auth` (imported but never called) |

### What we gain

- Smaller `node_modules` and faster `npm install` — removes 13 unused packages, reducing dependency tree size and install time.
- Smaller production bundle — tree-shaking can't always eliminate unused packages that are listed as dependencies, especially ones with side effects. Removing them guarantees they won't leak into the bundle. The AWS SDK packages alone are substantial.
- Reduced attack surface — fewer dependencies means fewer potential supply-chain vulnerabilities to track. `crypto-js` in particular has had past CVEs.
- Less confusion for new contributors — dead code and phantom dependencies create false signals about what the app actually uses.
- Cleaner linter output — unused imports generate ESLint warnings that add noise.

---

## 1.2 Extract Duplicated Utility Functions

A deep scan of the frontend source reveals six categories of duplicated helper functions that should be extracted into shared modules.

### 1.2a Text Formatting — `frontend/src/utils/formatters.js`

`titleCase()` is copy-pasted into 14 files (~7 lines each = ~98 duplicated lines). `courseTitleCase()` is in 6 files (~11 lines each = ~66 duplicated lines).

```
frontend/src/utils/formatters.js
  - titleCase(str)
  - courseTitleCase(str)
```

Files containing `titleCase()` (14 files):
- `InstructorModules.jsx`, `InstructorAnalytics.jsx`, `InstructorEditConcept.jsx`, `InstructorConcepts.jsx`, `InstructorHomepage.jsx`, `InstructorEditCourse.jsx`, `InstructorNewModule.jsx`, `ViewStudents.jsx`, `CourseDetails.jsx`, `InstructorDetails.jsx`, `AdminInstructors.jsx`, `StudentHomepage.jsx`, `StudentChat.jsx`, `CourseView.jsx`

Files containing `courseTitleCase()` (6 files):
- `InstructorModules.jsx`, `ChatLogs.jsx`, `InstructorAnalytics.jsx`, `PromptSettings.jsx`, `InstructorConcepts.jsx`, `ViewStudents.jsx`

### 1.2b File Name Utilities — `frontend/src/utils/fileHelpers.js`

Three file-related helpers are duplicated across the file management pages:

| Function | Duplicated in | Logic |
|---|---|---|
| `cleanFileName(fileName)` | `InstructorNewModule.jsx`, `InstructorEditCourse.jsx`, `FileManagement.jsx` (3 files) | `fileName.replace(/[^a-zA-Z0-9._-]/g, "_")` |
| `removeFileExtension(fileName)` | `InstructorNewModule.jsx`, `InstructorEditCourse.jsx` (2 files) | `fileName.replace(/\.[^/.]+$/, "")` |
| `getFileType(filename)` | `InstructorNewModule.jsx`, `InstructorEditCourse.jsx` (2 files) | Splits on `.` and returns the last part |

All three are one-liners or near-one-liners with identical implementations. Extract to:

```
frontend/src/utils/fileHelpers.js
  - cleanFileName(fileName)
  - removeFileExtension(fileName)
  - getFileType(filename)
```

### 1.2c Sign-Out Handler — `frontend/src/utils/auth.js`

`handleSignOut` is duplicated in 5 files with identical logic (call `signOut()`, redirect to `/`, catch and log error):

- `AdminHeader.jsx`, `InstructorHeader.jsx`, `StudentHeader.jsx` (3 header components)
- `StudentChat.jsx`, `CourseView.jsx` (2 page components)

Extract to a shared utility:

```
frontend/src/utils/auth.js  (replace the current dead file)
  - handleSignOut(event)
```

Note: The current `utils/auth.js` exports `getAuthSessionAndEmail()` but is never imported (dead code from 1.1). Replace its contents with the shared `handleSignOut`. The `getAuthSessionAndEmail` pattern becomes unnecessary once the centralized API client (1.3) is built.

### 1.2d Toast Config Objects — `frontend/src/utils/toast.js`

Every `toast.success()` and `toast.error()` call includes the same 6-line config object:

```js
{
  position: "top-center",
  autoClose: 1000,
  hideProgressBar: false,
  closeOnClick: true,
  pauseOnHover: true,
  draggable: true,
}
```

This config block appears 64 times across 15 files. Extract default configs:

```
frontend/src/utils/toast.js
  - TOAST_DEFAULTS  (base config)
  - showSuccess(message)  — wraps toast.success with defaults
  - showError(message)    — wraps toast.error with defaults
```

This pairs with 1.4 (consolidating `<ToastContainer>`) — together they eliminate all per-page toast boilerplate.

### 1.2e Duplicated CSS Import — `react-toastify/dist/ReactToastify.css`

This CSS file is imported in 15 separate files. Once `<ToastContainer>` is moved to `App.jsx` (1.4), the CSS import should also move there. All 15 per-file imports can be removed.

### Summary

| Category | Files affected | Duplicated definitions | Lines saved (approx) |
|---|---|---|---|
| `titleCase` / `courseTitleCase` | 14 + 6 files | 20 function defs | ~164 lines |
| `cleanFileName` / `removeFileExtension` / `getFileType` | 3 + 2 + 2 files | 7 function defs | ~42 lines |
| `handleSignOut` | 5 files | 5 function defs | ~40 lines |
| Toast config objects | 15 files | 64 config blocks | ~384 lines |
| Toast CSS import | 15 files | 15 import lines | ~15 lines |
| **Total** | | | **~645 lines** |

**What we gain:**
- Eliminates ~645 lines of duplicated code, replaced by ~4 small utility modules (~60 lines total) and one-line imports.
- Bug fixes in one place — if any formatting, file handling, or auth logic needs to change, you fix it once instead of hunting through dozens of files.
- Testability — shared utilities can each have a focused unit test file covering edge cases, which is impractical when functions are scattered across page components.
- Consistency — toast notifications currently use slightly different `autoClose` values (1000ms vs 2000ms vs 3000ms) depending on who wrote the page. Shared helpers enforce a single default.

---

## 1.3 Create a Centralized API Client

### Current state

79 `fetch()` calls across 23 files, each manually handling auth token extraction and URL construction. Breakdown by HTTP method:

| Method | Count | Notes |
|---|---|---|
| GET | 36 | Read operations — courses, modules, students, analytics |
| POST | 18 | Create operations — modules, concepts, sessions, messages |
| PUT | 13 | Update operations — reorder, edit, session names, file metadata |
| DELETE | 12 | Delete operations — modules, concepts, sessions, files |
| **Total** | **79** | |

The typical pattern repeated in every call:

```js
const session = await fetchAuthSession();
const token = session.tokens.idToken;
const response = await fetch(
  `${import.meta.env.VITE_API_ENDPOINT}instructor/some_endpoint?param=${value}`,
  { method: "GET", headers: { Authorization: token, "Content-Type": "application/json" } }
);
```

### Inconsistencies found

**Two different patterns for getting the user's email:**
1. `fetchUserAttributes()` — makes a separate Cognito `GetUser` API call (used in 14 files, ~20 call sites). This is a network round-trip to Cognito on every page load.
2. `session.tokens.idToken.payload.email` — extracts email directly from the JWT payload (used in `InstructorHomepage.jsx` and `StudentChat.jsx`). This is instant, no network call.

The dead `utils/auth.js` file even has a comment noting this: *"Get auth session and email from the ID token payload instead of making a separate Cognito GetUser API call via fetchUserAttributes()."* The centralized client should use the token payload approach by default, eliminating ~20 unnecessary Cognito API calls per user session.

**Inconsistent error handling across files:**
- Some check `response.ok` and show a toast on failure
- Some check `response.ok` and only `console.error`
- Some don't check `response.ok` at all and just call `response.json()`
- Some use `try/catch`, some use `.then()/.catch()` chains
- Some mix both styles in the same file (e.g., `StudentChat.jsx`)

**Inconsistent token variable naming:**
- `token`, `authToken`, `authtoken` (lowercase t in `InstructorEditConcept.jsx`)

### Special cases the client must handle

**1. S3 presigned URL uploads (2 files):**
`InstructorNewModule.jsx` and `InstructorEditCourse.jsx` both implement a two-step upload flow:
  - Step 1: GET a presigned URL from the API (standard auth pattern)
  - Step 2: PUT the file directly to S3 using the presigned URL (no auth header, `Content-Type` is the file's MIME type)

The centralized client should handle Step 1. Step 2 is a raw `fetch()` to S3 — it should remain a plain `fetch()` or be wrapped in a separate `uploadToS3(presignedUrl, file)` helper.

The `uploadFiles()` function itself is also duplicated between `InstructorNewModule.jsx` and `InstructorEditCourse.jsx` with near-identical logic. This should be extracted to a shared `frontend/src/services/fileUpload.js` module that uses the API client internally.

**2. Parallel fire-and-forget calls (`StudentChat.jsx`):**
The chat flow fires `createMessage` and `textGeneration` in parallel via `Promise.all([fetch(...), fetch(...)])`. The client should support returning raw `Response` objects for cases where the caller needs fine-grained control over parallel execution.

**3. Promise chain style (`Session.jsx`, `StudentHeader.jsx`, `StudentChat.jsx`):**
Some components use `.then()` chains instead of `async/await`. The centralized client should return Promises (which it will naturally, being async), so both styles work.

**4. Calls that need the email alongside the token:**
~20 call sites need both the auth token and the user's email. The client's auth helper should return both: `{ token, email }` extracted from the JWT payload.

### Proposed structure

```
frontend/src/services/api.js
  - apiClient.get(path, queryParams)
  - apiClient.post(path, queryParams, body)
  - apiClient.put(path, queryParams, body)
  - apiClient.delete(path, queryParams)
  - apiClient.getAuth()  → { token, email }  (for cases needing raw access)

frontend/src/services/fileUpload.js
  - getPresignedUrl(courseId, moduleId, moduleName, fileName, fileType)
  - uploadToS3(presignedUrl, file)
  - uploadFiles(files, courseId, moduleId, moduleName)  (orchestrates the full flow)
```

All methods in `apiClient` would:
1. Call `fetchAuthSession()` once
2. Extract `token` and `email` from the JWT payload (no `fetchUserAttributes()` call)
3. Construct the full URL from `VITE_API_ENDPOINT` + path + query params
4. Set `Authorization` and `Content-Type` headers
5. Auto-serialize body with `JSON.stringify()` for POST/PUT
6. Check `response.ok` and throw a structured error on failure
7. Return parsed JSON

### What we gain

- Single point of change for auth logic — if the token extraction path changes (e.g., Amplify v7 API changes), you update one file instead of 23.
- Eliminates ~20 unnecessary `fetchUserAttributes()` network calls per session — email is already in the JWT payload.
- Consistent error handling — currently each `fetch()` call handles errors differently. A centralized client enforces a single strategy.
- Automatic token refresh — a centralized client can handle expired token retry logic once, rather than requiring each page to deal with it.
- Reduced boilerplate per page — each API call drops from ~5-6 lines (session + token + fetch + headers) to a single line like `apiClient.get("instructor/courses", { email })`.
- Easier testing — pages can mock a single `apiClient` import instead of mocking `fetchAuthSession` and `fetch` separately in every test.
- Deduplicates the `uploadFiles()` function — currently copy-pasted between `InstructorNewModule.jsx` and `InstructorEditCourse.jsx`.

---

## 1.4 Consolidate Toast Configuration

### Current state

14 files render their own `<ToastContainer>` component. 16 files call `toast.error()` / `toast.success()` (including `FileManagement.jsx` which calls `toast` but relies on a parent's container). There are 90 total `toast.*()` calls across the codebase.

### `<ToastContainer>` configuration variants

| autoClose | Files |
|---|---|
| `5000` (default) | `Login.jsx`, `InstructorModules.jsx`, `InstructorConcepts.jsx`, `InstructorEditConcept.jsx`, `InstructorNewConcept.jsx`, `InstructorNewModule.jsx`, `InstructorEditCourse.jsx`, `PromptSettings.jsx`, `AdminCreateCourse.jsx`, `AdminInstructors.jsx` (10 files) |
| `1000` | `InstructorDetails.jsx`, `StudentHomepage.jsx` (2 files) |
| `(no props — bare tag)` | `StudentDetails.jsx`, `CourseDetails.jsx` (2 files — uses react-toastify defaults: bottom-right, 5000ms, light theme) |

The 2 bare `<ToastContainer />` instances in `StudentDetails.jsx` and `CourseDetails.jsx` use completely different defaults (bottom-right position, light theme) compared to the other 12 files (top-center, colored theme). This means toasts on those pages look and behave differently from the rest of the app.

### Per-call toast config duplication

Each individual `toast.error()` / `toast.success()` call also passes its own config object. The breakdown:

| Config pattern | Count | Notes |
|---|---|---|
| Full 7-line config block with `autoClose: 1000` | 54 calls | Most common — instructor/admin CRUD operations |
| Full 7-line config block with `autoClose: 3000` | 19 calls | `Login.jsx` and `FileManagement.jsx` |
| Full 7-line config block with `autoClose: 2000` | 3 calls | `InstructorNewModule.jsx` and `InstructorEditCourse.jsx` validation |
| Minimal `{ theme: "colored" }` only | 6 calls | `Login.jsx` password validation errors |
| Full config with `{ theme: "colored" }` (no position/autoClose) | 2 calls | `Login.jsx` sign-up success/error |
| **Total** | **~84** | (remaining 6 calls have slight variations) |

70 of the 90 calls include `progress: undefined` — which is a no-op (it's the default). This is pure noise.

### The conflict between container and per-call configs

When a `<ToastContainer>` has `autoClose={5000}` but a `toast.error()` call passes `autoClose: 1000`, the per-call value wins. This means the container's `autoClose` prop is effectively ignored in most files — the real behavior is controlled by the 54 calls that pass `autoClose: 1000`. This is confusing: the container says 5 seconds, but toasts disappear in 1 second.

### Proposed fix

**Step 1: Single `<ToastContainer>` in `App.jsx`**

```jsx
// App.jsx
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

// Inside the return:
<ToastContainer
  position="top-center"
  autoClose={1000}
  hideProgressBar={false}
  newestOnTop={false}
  closeOnClick
  rtl={false}
  pauseOnFocusLoss
  draggable
  pauseOnHover
  theme="colored"
/>
```

Use `autoClose={1000}` as the default since that's what 54 of 90 calls already use.

**Step 2: Remove per-call config objects**

Once the container has the right defaults, most `toast.*()` calls can drop their config entirely:

```js
// Before (7 lines):
toast.success("Module Created Successfully", {
  position: "top-center",
  autoClose: 1000,
  hideProgressBar: false,
  closeOnClick: true,
  pauseOnHover: true,
  draggable: true,
  progress: undefined,
});

// After (1 line):
toast.success("Module Created Successfully");
```

For the ~19 calls in `Login.jsx` that need `autoClose: 3000` (longer display for auth errors), pass only the override:

```js
toast.error("Error logging in", { autoClose: 3000 });
```

**Step 3: Remove per-file imports**

Remove from all 14 files:
- `import { ToastContainer } from "react-toastify"` (keep `toast` import)
- `import "react-toastify/dist/ReactToastify.css"`

`FileManagement.jsx` already only imports `toast` (no `ToastContainer`), so it just needs the CSS import removed.

### Files affected

| File | Has `<ToastContainer>` | Has `toast.*()` calls | CSS import |
|---|---|---|---|
| `Login.jsx` | Yes | 16 | Yes |
| `InstructorModules.jsx` | Yes | 4 | Yes |
| `InstructorConcepts.jsx` | Yes | 4 | Yes |
| `InstructorEditConcept.jsx` | Yes | 7 | Yes |
| `InstructorNewConcept.jsx` | Yes | 3 | Yes |
| `InstructorNewModule.jsx` | Yes | 4 | Yes |
| `InstructorEditCourse.jsx` | Yes | 6 | Yes |
| `PromptSettings.jsx` | Yes | 2 | Yes |
| `StudentDetails.jsx` | Yes | 2 | Yes |
| `AdminCreateCourse.jsx` | Yes | 6 | Yes |
| `AdminInstructors.jsx` | Yes | 2 | Yes |
| `InstructorDetails.jsx` | Yes | 6 | Yes |
| `CourseDetails.jsx` | Yes | 8 | Yes |
| `StudentHomepage.jsx` | Yes | 3 | Yes |
| `FileManagement.jsx` | No | 1 | Yes |

### What we gain

- Removes 14 duplicate `<ToastContainer>` declarations, 15 duplicate CSS imports, and ~64 redundant per-call config blocks (~450 lines of boilerplate total).
- Fixes the 2 inconsistent pages (`StudentDetails.jsx`, `CourseDetails.jsx`) where toasts currently appear bottom-right with a light theme instead of top-center colored.
- Prevents toast stacking bugs — multiple `ToastContainer` instances on the same page can cause duplicate toasts or z-index conflicts. A single root-level container eliminates this.
- Consistent toast behavior — changing the position, autoClose duration, or theme is a one-line change in `App.jsx` instead of editing 14 files and 90 call sites.
- Cleaner page components — each `toast.*()` call becomes a single line instead of an 8-line block.

---

## 1.5 Add `.env.example`

### Current state

No `.env.example` exists. No `.env` file is committed (correctly gitignored). Neither the `README.md` nor `docs/deploymentGuide.md` document which environment variables the frontend needs. New developers have to grep the source code to figure out what's required.

### Environment variables actually used in source code

A full scan of `import.meta.env.VITE_*` references across the frontend reveals 6 distinct variables:

| Variable | References | Used in | Purpose |
|---|---|---|---|
| `VITE_API_ENDPOINT` | 79 | 23 files | Base URL for all REST API calls |
| `VITE_API_KEY` | 4 | `StudentChat.jsx`, `InstructorHomepage.jsx` | AppSync WebSocket authorization header |
| `VITE_GRAPHQL_WS_URL` | 3 | `StudentChat.jsx`, `InstructorHomepage.jsx` | AppSync WebSocket endpoint for real-time notifications/streaming |
| `VITE_COGNITO_USER_POOL_ID` | 2 | `App.jsx`, `Login.jsx` | Amplify auth config + JWT verification |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | 2 | `App.jsx`, `Login.jsx` | Amplify auth config + JWT verification |
| `VITE_AWS_REGION` | 2 | `App.jsx`, `getSignedRequest.js` (dead code) | Amplify auth config — only `App.jsx` usage matters |

### Variables set by CDK but NOT used in source code

| Variable | Set by | Notes |
|---|---|---|
| `VITE_IDENTITY_POOL_ID` | `amplify-stack.ts` + `api-gateway-stack.ts` (Secrets Manager) | Passed to Amplify build environment but never read by `import.meta.env` in any source file. Likely a leftover from when the app used IAM-based auth with the Identity Pool. Can be removed from the Amplify stack's `environmentVariables` once confirmed unused. |

### Variables used in source but NOT set by CDK

| Variable | Used in | Notes |
|---|---|---|
| `VITE_API_KEY` | `StudentChat.jsx`, `InstructorHomepage.jsx` | Used for AppSync WebSocket `Authorization` header. Not set in `amplify-stack.ts` `environmentVariables`. Must be configured manually in the Amplify console or local `.env`. This is a gap — if a developer doesn't know to set it, WebSocket subscriptions (chat streaming, notifications) silently fail. |

### Proposed `.env.example`

```env
# REST API — base URL for all backend calls (set by CDK output)
VITE_API_ENDPOINT=

# AWS region for Cognito auth
VITE_AWS_REGION=

# Cognito User Pool — used for Amplify auth config and JWT verification
VITE_COGNITO_USER_POOL_ID=
VITE_COGNITO_USER_POOL_CLIENT_ID=

# AppSync — real-time WebSocket for chat streaming and notifications
VITE_GRAPHQL_WS_URL=
VITE_API_KEY=
```

Note: `VITE_IDENTITY_POOL_ID` is intentionally omitted — it's not referenced in source code. If it's confirmed unused, also remove it from `amplify-stack.ts` and the Secrets Manager secret in `api-gateway-stack.ts`.

### Additional recommendation: add `VITE_API_KEY` to the Amplify stack

`VITE_API_KEY` is the only env var that's used in source but not automatically set by CDK. Add it to `amplify-stack.ts`:

```ts
environmentVariables: {
  // ... existing vars ...
  VITE_API_KEY: apiStack.getEventApiKey(), // needs a new getter on ApiGatewayStack
},
```

This requires adding an API_KEY authorization mode to the AppSync API (or extracting the Lambda authorizer token). Until then, document it clearly in `.env.example` so developers know to set it manually.

### What we gain

- Faster onboarding — new developers can copy `.env.example` to `.env` and fill in values instead of grepping the codebase to figure out what's needed.
- Self-documenting — the file serves as living documentation of the app's external configuration surface. Comments explain what each variable is for and where to find the values.
- Prevents silent failures — `VITE_API_KEY` is currently undocumented. If it's missing, WebSocket subscriptions fail silently (no error, just no real-time updates). `.env.example` makes this obvious.
- Identifies dead config — `VITE_IDENTITY_POOL_ID` is set by CDK but never consumed. Documenting what's actually needed exposes this waste.
- CDK alignment — highlights the gap where `VITE_API_KEY` should be auto-set by the infrastructure but isn't.
