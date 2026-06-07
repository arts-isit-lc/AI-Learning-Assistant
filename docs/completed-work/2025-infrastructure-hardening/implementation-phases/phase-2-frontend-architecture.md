# Phase 2 — Frontend Architecture (Medium Risk, High Impact)

## 2.1 Standardize Styling Approach

The app mixes three styling systems:
- Tailwind CSS (utility classes in JSX)
- MUI `sx` prop (inline style objects)
- Inline `style={{ }}` attributes

This creates inconsistency and makes it hard to maintain a design system. Pick one primary approach:

- **Option A**: Tailwind-first — use Tailwind for layout/spacing, MUI only for component behavior. Remove `sx` props where Tailwind equivalents exist.
- **Option B**: MUI-first — use MUI's `sx` and theme system for everything. Remove Tailwind.

Option A is recommended since the app already uses Tailwind heavily for layout and MUI primarily for pre-built components (tables, dialogs, drawers).

## 2.2 Add Error Boundaries

No error boundaries exist. A single unhandled error in any component crashes the entire app with a white screen. Add:

- A top-level `ErrorBoundary` wrapping `<Router>` in `App.jsx`
- Page-level error boundaries for each major route

## 2.3 Improve State Management

The app passes `course`, `module`, `setCourse`, `setModule` through 3-4 levels of props. `UserContext` only manages `isInstructorAsStudent`.

Options:
- Expand `UserContext` to include `course`, `module`, and auth state
- Or adopt a lightweight state library like Zustand (simpler than Redux, no boilerplate)

This eliminates prop drilling and makes it easier to add new features that need access to the current course/module.

## 2.4 Add Frontend Tests

Zero test files exist. At minimum:
- Unit tests for utility functions (`titleCase`, API client)
- Component tests for critical flows (login, chat submission)
- Use Vitest (already compatible with Vite) + React Testing Library

## 2.5 Migrate MUI Deprecated Props

27 instances of deprecated `inputProps`/`InputProps`/`InputLabelProps` across 11 files. These still work but will break in a future MUI major. Migrate to `slotProps.htmlInput`, `slotProps.input`, `slotProps.inputLabel`.
