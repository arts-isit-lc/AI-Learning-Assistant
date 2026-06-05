---
inclusion: fileMatch
fileMatchPattern: "frontend/**"
---

# Frontend Conventions

## Stack
- **React 18** — JSX only (`.jsx`/`.js`, no TypeScript)
- **Vite 5** — build tool and dev server
- **React Router 7** — hash-based routing (`/#/` prefix for Amplify Hosting compatibility)
- **Tailwind CSS** — all styling (layout, spacing, color, typography)
- **shadcn/ui** — component library (code lives in `src/components/ui/`, owned by this project)
- **Radix UI** — headless primitives (installed automatically by shadcn/ui per component)
- **lucide-react** — icons (tree-shakeable; import only what you use)
- **AWS Amplify v6** — auth and AppSync client
- **Recharts** — data visualization
- **react-markdown** + **react-syntax-highlighter** — LLM response rendering
- **react-hook-form** + **zod** — forms and validation
- **@tanstack/react-table** — sortable/filterable data tables

## Key Rules
- **Tailwind only** — no inline `style={{}}` props, no CSS-in-JS, no separate `.css` files except `index.css`
- **shadcn/ui components first** — before building a new component check if shadcn has it (`Button`, `Dialog`, `Table`, `Select`, `Input`, `Tabs`, `Sheet`, `Toast`, `Card`, `Badge`, `Calendar`, `Command`)
- **No MUI** — `@mui/material`, `@emotion/*`, `@mui/icons-material` are removed; do not reintroduce
- **lucide-react for icons** — no other icon libraries; import individually: `import { Search } from 'lucide-react'`
- **Amplify v6 modular imports** — never the legacy `import Amplify from 'aws-amplify'` pattern:
  ```javascript
  import { signIn, getCurrentUser } from 'aws-amplify/auth';
  import { generateClient } from 'aws-amplify/api';
  ```
- **No `process.env`** — use `import.meta.env.VITE_*` for env vars
- **Functional components only** — no class components; use `prop-types` for runtime checks
- **Co-locate components** with their feature — not in a global `components/` dump
- **No test framework** — ESLint is the only automated quality gate; do not add vitest/Jest unless explicitly requested

## Component Variant Pattern
All UI components use `cva` + `cn` for variants. See `src/components/ui/button.jsx` as the canonical example:
```javascript
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'
const variants = cva('base-classes', { variants: { ... }, defaultVariants: { ... } })
```

## Design Tokens
Global colour palette and spacing defined in `tailwind.config.js` and CSS variables in `src/index.css`.
Never use raw hex values or hardcoded px values in components — always use Tailwind token classes (`bg-primary-600`, `p-4`, `text-sm`).

## Commands (run from `frontend/`)
```bash
npm run dev      # Vite dev server
npm run build    # production build -> dist/
npm run lint     # ESLint (run after any significant change)
npm run preview  # preview production build
```
