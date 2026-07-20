---
inclusion: manual
---

# UI Component Registry

**Mandatory.** All UI work must map to components in this registry. Do not invent component names outside it. If a genuinely new component is needed, add it here before implementing it.

> **Reconciled to the OCELIA designs (Phase 0 → Phase 1).** Navigation is a **top-nav `AppHeader` per role** — the left `AppSidebar` is retired. The missing primitives/composed components from the four design sets were added below (icons, toggle, alert, tags, course card, module accordion, wizard stepper, file upload, searchbar, model dropdown, …). Token/state rules for these live in `ui-design-system.md`. This registry is the naming contract.

> **Build status (Phase 4, 2026-07-19).** Every **primitive** above is built in `src/components/ui/` (hand-written shadcn-style over Radix + cva; colocated RTL tests; rendered in the `/gallery` dev route) — except `Toast` (= react-toastify, see its row). **Reusable composed built** in `src/components/composed/`: `PageContainer, PageHeader, BackButton, Breadcrumb, EmptyState, Tag, StatCard, FileRow, ListRow, DataTable, FormField, Searchbar, ConfirmDialog, LanguageModelDropdown, CourseCard, StudentRow, ProfileHeader` (plus `AppHeader`, `SplitLayout`, `OfflineBanner` from earlier phases). The **Chat** set (`ChatThread, AIMessage, StudentMessage, TypingIndicator, ChatInput, SessionSidebar, SessionItem, RetryBanner`) is **built (Phase 5)** in `src/features/student/chat/` — it lives with the student feature (colocated with `useChatStream` + the streaming logic), not in `composed/`. The **instructor-feature composed** — `ModuleAccordion` (concept→module tree, `@dnd-kit` sortable), `WizardStepper`, `FileUpload`, `PromptHistory`, `AnalyticsChart` (Recharts) — are **built (Phase 6)** in `src/components/composed/`. **All registry components are now built.** The **Admin slice (Phase 7)** — instructor + course management — composes existing registry components (`SplitLayout`, `ListRow`, `ProfileHeader`, `ConfirmDialog`, `Dialog`, `Toggle`, `Searchbar`) with **no new registry entries**. Legacy composed still live under `src/components/` until their page migrates (removed in P8).

## Registry Rules
- Map every Figma node to a registry component before writing code
- Reject or flag unknown component names (e.g. `ChatBubble2`, `MessageBoxNew`, `CustomCard`)
- Variants are expressed via the `variant` prop — not separate component names
- `src/components/ui/` — shadcn/ui primitives (this table's "Primitives"), owned by project
- `src/components/composed/` — app-level composed components from this registry (new code; legacy composed remain under `src/components/` until migrated)
- `src/features/<area>/` — feature modules compose the above (not registry entries)

---

## Primitives (shadcn/ui in `src/components/ui/`)
| Component | Usage |
|---|---|
| `Button` | All clickable actions. **UI + CTA families via `variant`:** `default`, `secondary`, `outline`, `ghost`, `danger` (destructive token), `cta`, `link`. Sizes via `size`. Loading state via `Button/Spinner` (disable + spinner) |
| `Input` | Single-line text entry |
| `Textarea` | Multi-line text entry (chat input, prompt settings) |
| `Card` | Surface container with optional header/footer |
| `Badge` | Status labels, tags, role indicators |
| `Dialog` | Modal overlays (confirmations, forms) |
| `Sheet` | Side panel / drawer |
| `Tabs` | Tab navigation within a page |
| `Select` | Dropdown selection |
| `Table` | Data table shell (combine with TanStack Table for sorting/filtering) |
| `Toast` | Transient notifications — provided by **react-toastify** (wired in `AppV2` + `queryClient`), **not** a Radix primitive. No shadcn Toast component |
| `Tooltip` | Hover labels on icon buttons |
| `Separator` | Visual dividers |
| `Avatar` | User/AI avatar circles |
| `Skeleton` | Loading placeholder for any content area |
| `ScrollArea` | Scrollable container with consistent scrollbar styling |
| `Command` | Searchable command palette / combobox |
| `Icon` | Tree-shakeable per-icon Material SVG — `<Icon icon={MdX} label?=… />`. Decorative (aria-hidden) by default; `label` for icon-only controls. Colour via a `text-*` token class. (Built in Phase 1) |
| `Label` | Form field label (pairs with `FormField`) |
| `Toggle` | On/off switch — course active/inactive, per-instructor OCELIA access, boolean settings |
| `Checkbox` | Boolean selection in forms / roster multi-select |
| `RadioGroup` | Single-choice selection |
| `Alert` | Inline, persistent status/callout — `info` / `success` / `warning` / `destructive`. Distinct from the transient `Toast` |
| `Progress` | Determinate + indeterminate progress bar (uploads, async jobs). Already in `src/components/ui/progress.jsx` |
| `Accordion` | Expand/collapse sections — Configuration Concept→Module tree, collapsible panels |
| `DropdownMenu` | Action / kebab menus |
| `Popover` | Anchored, non-modal floating panel |

---

## App Components (`src/components/`)

### Chat
| Component | Props | Notes |
|---|---|---|
| `ChatThread` | `messages`, `isStreaming`, `streamingText` | Scrollable message list container |
| `AIMessage` | `content`, `isStreaming?` | Assistant bubble with markdown rendering |
| `StudentMessage` | `content`, `isMostRecent`, `onDelete?` | User bubble with optional delete on hover |
| `TypingIndicator` | — | Animated 3-dot indicator while AI is processing |
| `ChatInput` | `onSubmit`, `disabled` | Sticky textarea + send button |
| `SessionSidebar` | `sessions`, `activeSession`, `onSelect`, `onNew`, `onDelete` | Left panel session list |
| `SessionItem` | `session`, `isActive`, `onSelect`, `onDelete` | Single session row |
| `RetryBanner` | `onRetry` | Error state banner when AI response fails |

### Navigation
| Component | Props | Notes |
|---|---|---|
| `AppHeader` | `role`, `items?` | **Top-nav** app header per role (student/instructor/admin) — replaces the retired `AppSidebar`. Instructor: Global Analytics + Global Chats items → placeholder "coming soon" stubs; `Quicklink?` placeholder dropped |
| `Breadcrumb` | `items` | Breadcrumb trail for deep routes (supports the no-dead-ends rule) |
| `PageHeader` | `title`, `actions?` | Top-of-page title with optional action buttons |
| `BackButton` | `onClick` | Standardised back navigation |

### Layout
| Component | Props | Notes |
|---|---|---|
| `PageContainer` | `children` | Max-width wrapper with consistent padding |
| `SplitLayout` | `sidebar`, `main` | Two-column layout for chat and detail pages |
| `EmptyState` | `icon`, `title`, `description`, `action?` | Placeholder for empty lists |

### Data Display
| Component | Props | Notes |
|---|---|---|
| `DataTable` | `columns`, `data`, `loading?` | TanStack Table + shadcn Table wrapper |
| `StatCard` | `label`, `value`, `trend?` | Single metric card for analytics |
| `FileRow` | `file`, `onDelete?` | File entry in file management lists |
| `Tag` | `label`, `variant?`, `onRemove?` | Key-topic / category tag — distinct from the status `Badge` |

### Course & Content
| Component | Props | Notes |
|---|---|---|
| `CourseCard` | `course`, `onOpen`, `state?` | Course tile (Card/Course). States: default / hover / clicked / inactive |
| `ModuleAccordion` | `concept`, `modules`, `onReorder?` | Configuration Concept→Module tree row; expand = read-only module summary + Edit/Delete. Drag-and-drop reorder via `@dnd-kit` |
| `ListRow` | `children`, `onClick?`, `selected?` | Generic selectable list row (courses, instructors, sessions) |

### People
| Component | Props | Notes |
|---|---|---|
| `StudentRow` | `student`, `actions?` | Roster row — name, progress, actions |
| `ProfileHeader` | `user`, `subtitle?` | Profile / detail header (instructor + course detail pages) |

### Forms
| Component | Props | Notes |
|---|---|---|
| `FormField` | `label`, `error?`, `children` | Label + input + inline error wrapper (RHF + Zod; errors never toasted) |
| `Searchbar` | `value`, `onChange`, `placeholder?` | Debounced search input |
| `LanguageModelDropdown` | `value`, `onChange`, `models` | LLM selection dropdown (Settings) |
| `FileUpload` | `onFiles`, `accept?`, `status?` | Drag/drop upload with idle / uploading / success / error states |
| `WizardStepper` | `steps`, `current` | Module-wizard step indicator (4-step create flow) |
| `PromptHistory` | `versions`, `onRestore?` | Prompt version history (`previous_prompts`) |
| `ConfirmDialog` | `title`, `description`, `onConfirm`, `onCancel` | Destructive-action confirmation |

> **CRUD / confirmation modals** (join course, add/duplicate/delete course, add/remove/delete instructor, save changes, discard, prompt-conflict override) are **feature compositions of `Dialog` / `ConfirmDialog`** — they live in `src/features/<area>/`, not as separate registry names.

---

## Naming Rules
- PascalCase for all component names
- No numeric suffixes (`Card2`, `ButtonNew`) — use `variant` prop instead
- No role prefixes on shared components (`AdminButton` is wrong; use `Button` with variant)
- Role-specific pages live in `src/pages/{admin|instructor|student}/` — they compose registry components, they are not registry entries themselves
