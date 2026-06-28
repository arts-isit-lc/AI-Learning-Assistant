---
inclusion: fileMatch
fileMatchPattern: "frontend/**"
---

# Frontend Conventions

## Stack
React 18 (JSX only) · Vite 5 · React Router 7 (BrowserRouter, lazy routes) · MUI v9 (primary UI lib) · Tailwind 3 (coexists) · lucide-react (icons for new code) · Amplify v6 (auth/API) · react-markdown + react-syntax-highlighter · rehype-katex + remark-math · Recharts · react-toastify · material-react-table · react-pdf

## Key Rules
- Functional components only, no class components
- `import.meta.env.VITE_*` (never `process.env`)
- Amplify v6 modular imports: `import { fetchAuthSession } from 'aws-amplify/auth'`
- No test framework — ESLint is the only gate
- Lazy load pages via `React.lazy()` + `Suspense`

## Styling (Dual System)

**New code:** Tailwind + semantic tokens (`bg-background`, `text-foreground`, `bg-muted`, etc.) · `cn()` from `src/lib/utils.js` · lucide-react icons · shadcn/ui if available (`Progress`, `Skeleton`)

**Existing MUI pages:** Keep MUI consistent within file · never partially convert · never mix `sx={{}}` with Tailwind on same element

**MUI theme** (`src/Theme.jsx`): primary `#5536DA`, bg `#F8F9FD`

## shadcn/ui (Partial)
Configured (`components.json`), 2 components installed: `progress.jsx`, `skeleton.jsx`. Add more: `npx shadcn@latest add <component>`

## Structure
```
src/components/       # Shared (AIMessage, StudentMessage, headers, FileViewerPanel, etc.)
src/components/ui/    # shadcn primitives
src/pages/admin/      # Fully MUI
src/pages/instructor/ # MUI + some Tailwind
src/pages/student/    # Mix (StudentChat=Tailwind, CourseView=MUI)
src/services/         # apiClient
src/context/          # React context providers
src/constants/        # LLM models, etc.
src/utils/            # auth, formatters
src/lib/              # cn() utility
```

## Commands
`npm run dev` · `npm run build` · `npm run lint` · `npm run preview`
