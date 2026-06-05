---
inclusion: fileMatch
fileMatchPattern: "frontend/**"
---

# UI Component Registry

**Mandatory.** All UI work must map to components in this registry. Do not invent component names outside it. If a genuinely new component is needed, add it here before implementing it.

## Registry Rules
- Map every Figma node to a registry component before writing code
- Reject or flag unknown component names (e.g. `ChatBubble2`, `MessageBoxNew`, `CustomCard`)
- Variants are expressed via the `variant` prop — not separate component names
- `src/components/ui/` — shadcn/ui primitives (auto-generated, owned by project)
- `src/components/` — app-level composed components from this registry

---

## Primitives (shadcn/ui in `src/components/ui/`)
| Component | Usage |
|---|---|
| `Button` | All clickable actions. Variants: `default`, `secondary`, `outline`, `ghost`, `danger` |
| `Input` | Single-line text entry |
| `Textarea` | Multi-line text entry (chat input, prompt settings) |
| `Card` | Surface container with optional header/footer |
| `Badge` | Status labels, tags, role indicators |
| `Dialog` | Modal overlays (confirmations, forms) |
| `Sheet` | Side panel / drawer |
| `Tabs` | Tab navigation within a page |
| `Select` | Dropdown selection |
| `Table` | Data table shell (combine with TanStack Table for sorting/filtering) |
| `Toast` | Transient notifications (success, error, info) |
| `Tooltip` | Hover labels on icon buttons |
| `Separator` | Visual dividers |
| `Avatar` | User/AI avatar circles |
| `Skeleton` | Loading placeholder for any content area |
| `ScrollArea` | Scrollable container with consistent scrollbar styling |
| `Command` | Searchable command palette / combobox |

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
| `AppSidebar` | `role`, `items` | Role-aware left nav (admin/instructor/student) |
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

### Forms
| Component | Props | Notes |
|---|---|---|
| `FormField` | `label`, `error?`, `children` | Label + input + error message wrapper |
| `ConfirmDialog` | `title`, `description`, `onConfirm`, `onCancel` | Destructive action confirmation |

---

## Naming Rules
- PascalCase for all component names
- No numeric suffixes (`Card2`, `ButtonNew`) — use `variant` prop instead
- No role prefixes on shared components (`AdminButton` is wrong; use `Button` with variant)
- Role-specific pages live in `src/pages/{admin|instructor|student}/` — they compose registry components, they are not registry entries themselves
