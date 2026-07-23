import { Icon } from "@/components/ui/icon"
import {
  MdHome,
  MdWarning,
  MdCheckCircle,
  MdInfo,
  MdErrorOutline,
} from "react-icons/md"

/**
 * OCELIA design-token preview (Phase 1, dev-only).
 *
 * A living gallery that renders every token category so the foundation can be
 * eyeballed and regression-checked. Reachable at `/style-guide`. This is the
 * seed of the Phase 4 component gallery.
 *
 * NOTE: this page intentionally uses a few inline `hsl(var(--token))` styles to
 * preview the RAW brand/neutral ramp, which is not surfaced as Tailwind colour
 * classes. That is the documented dynamic-value exception to the "no inline
 * styles" rule (ui-design-system.md) and is confined to this dev gallery — app
 * components must use the semantic token classes shown below.
 */

function Section({ id, title, children }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-h4 text-navy border-b border-border pb-2">
        {title}
      </h2>
      {children}
    </section>
  )
}

const SEMANTIC_SURFACES = [
  { token: "background", bg: "bg-background", fg: "text-foreground", ring: true },
  { token: "card", bg: "bg-card", fg: "text-card-foreground", ring: true },
  { token: "primary", bg: "bg-primary", fg: "text-primary-foreground" },
  { token: "secondary", bg: "bg-secondary", fg: "text-secondary-foreground" },
  { token: "muted", bg: "bg-muted", fg: "text-muted-foreground" },
  { token: "accent", bg: "bg-accent", fg: "text-accent-foreground" },
  { token: "navy", bg: "bg-navy", fg: "text-navy-foreground" },
  { token: "destructive", bg: "bg-destructive", fg: "text-destructive-foreground" },
  {
    token: "destructive-muted",
    bg: "bg-destructive-muted",
    fg: "text-destructive-muted-foreground",
  },
  { token: "success", bg: "bg-success", fg: "text-success-foreground" },
  { token: "warning", bg: "bg-warning", fg: "text-warning-foreground" },
  { token: "info", bg: "bg-info", fg: "text-info-foreground" },
]

const BRAND_RAMP = [
  { token: "--brand-purple", hex: "#6829C2" },
  { token: "--brand-navy", hex: "#002145" },
  { token: "--brand-cyan", hex: "#6EC4E8" },
  { token: "--neutral-900", hex: "#000000" },
  { token: "--neutral-700", hex: "#404040" },
  { token: "--neutral-500", hex: "#808080" },
  { token: "--neutral-300", hex: "#808080" },
  { token: "--neutral-0", hex: "#FFFFFF" },
]

// Full class strings must appear literally so Tailwind's content scanner emits
// them (it does not evaluate `w-${x}` interpolation).
const SPACING = [
  { name: "space-xs", w: "w-xs" },
  { name: "space-sm", w: "w-sm" },
  { name: "space-md", w: "w-md" },
  { name: "space-lg", w: "w-lg" },
  { name: "space-xl", w: "w-xl" },
]
const RADIUS = [
  { name: "rounded-sm", cls: "rounded-sm" },
  { name: "rounded-md", cls: "rounded-md" },
  { name: "rounded-lg", cls: "rounded-lg" },
]
const SHADOWS = [
  { name: "shadow-card", cls: "shadow-card" },
  { name: "shadow-dropdown", cls: "shadow-dropdown" },
  { name: "shadow-modal", cls: "shadow-modal" },
]
const ZINDEX = ["base", "dropdown", "sticky", "overlay", "modal", "toast"]

function ColorSwatch({ token, bg, fg, ring }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`flex h-16 items-end rounded-md p-2 ${bg} ${fg} ${
          ring ? "border border-border" : ""
        }`}
      >
        <span className="text-caption font-semibold">Aa</span>
      </div>
      <code className="text-caption text-muted-foreground">{token}</code>
    </div>
  )
}

export default function StyleGuide() {
  return (
    <main className="min-h-screen bg-background px-8 py-10 text-left text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-h2 font-semibold text-navy">OCELIA design tokens</h1>
          <p className="text-body text-muted-foreground">
            Phase 1 foundation preview — colour, typography, spacing, radius,
            shadow, motion, z-index, icons. Values live in{" "}
            <code className="text-caption">src/index.css</code>.
          </p>
        </header>

        {/* COLOUR */}
        <Section id="tokens-colour" title="Colour — semantic tokens">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {SEMANTIC_SURFACES.map((s) => (
              <ColorSwatch key={s.token} {...s} />
            ))}
          </div>
          <h3 className="text-caption font-semibold uppercase text-muted-foreground">
            Brand &amp; neutral ramp (raw)
          </h3>
          <div className="grid grid-cols-4 gap-4 sm:grid-cols-8">
            {BRAND_RAMP.map((c) => (
              <div key={c.token} className="flex flex-col gap-1">
                {/* dev-only: raw token preview via CSS var (see file header) */}
                <div
                  className="h-12 rounded-md border border-border"
                  style={{ backgroundColor: `hsl(var(${c.token}))` }}
                />
                <code className="text-caption text-muted-foreground">{c.hex}</code>
              </div>
            ))}
          </div>
        </Section>

        {/* TYPOGRAPHY */}
        <Section id="tokens-type" title="Typography — Inter (Whitney fallback)">
          <p className="text-h2">H2 · 34/46</p>
          <p className="text-h4">H4 · 18/28 semibold</p>
          <p className="text-body">
            Body · 18/28 book — the quick brown fox jumps over the lazy dog.
          </p>
          <p className="text-caption text-muted-foreground">
            Caption · 14/20 — helper text, timestamps, labels.
          </p>
          <div className="flex gap-6">
            <span className="text-body font-book">font-book (400)</span>
            <span className="text-body font-semibold">font-semibold (600)</span>
          </div>
        </Section>

        {/* SPACING */}
        <Section id="tokens-spacing" title="Spacing — 4pt grid">
          <div className="flex flex-col gap-2">
            {SPACING.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <code className="w-20 text-caption text-muted-foreground">
                  {s.name}
                </code>
                <div className={`h-4 bg-primary rounded-sm ${s.w}`} />
              </div>
            ))}
          </div>
        </Section>

        {/* RADIUS */}
        <Section id="tokens-radius" title="Radius">
          <div className="flex gap-6">
            {RADIUS.map((r) => (
              <div key={r.name} className="flex flex-col items-center gap-1">
                <div className={`h-16 w-16 bg-secondary border border-border ${r.cls}`} />
                <code className="text-caption text-muted-foreground">{r.name}</code>
              </div>
            ))}
          </div>
        </Section>

        {/* SHADOW */}
        <Section id="tokens-shadow" title="Shadow">
          <div className="flex flex-wrap gap-8">
            {SHADOWS.map((s) => (
              <div key={s.name} className="flex flex-col items-center gap-2">
                <div className={`h-20 w-32 rounded-lg bg-card border border-border ${s.cls}`} />
                <code className="text-caption text-muted-foreground">{s.name}</code>
              </div>
            ))}
          </div>
        </Section>

        {/* MOTION */}
        <Section id="tokens-motion" title="Motion">
          <div className="flex gap-6">
            <div className="flex flex-col items-center gap-2">
              <div className="h-16 w-16 rounded-md bg-primary transition-transform duration-fast ease-standard hover:scale-110" />
              <code className="text-caption text-muted-foreground">duration-fast</code>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="h-16 w-16 rounded-md bg-info transition-transform duration-normal ease-standard hover:scale-110" />
              <code className="text-caption text-muted-foreground">duration-normal</code>
            </div>
          </div>
          <p className="text-caption text-muted-foreground">Hover a square to preview the easing.</p>
        </Section>

        {/* Z-INDEX */}
        <Section id="tokens-z" title="Z-index scale">
          <ul className="flex flex-wrap gap-3">
            {ZINDEX.map((z) => (
              <li
                key={z}
                className="rounded-md border border-border bg-muted px-3 py-1 text-caption text-muted-foreground"
              >
                z-{z}
              </li>
            ))}
          </ul>
        </Section>

        {/* ICONS */}
        <Section id="tokens-icons" title="Icons — Material via <Icon>">
          <div className="flex items-center gap-6">
            <Icon icon={MdHome} label="Home" size={28} className="text-navy" />
            <Icon icon={MdCheckCircle} label="Success" size={28} className="text-success" />
            <Icon icon={MdInfo} label="Info" size={28} className="text-info" />
            <Icon icon={MdWarning} label="Warning" size={28} className="text-warning" />
            <Icon icon={MdErrorOutline} label="Error" size={28} className="text-destructive" />
          </div>
          <p className="text-caption text-muted-foreground">
            Tree-shakeable per-icon SVGs; colour inherits from a token text class.
          </p>
        </Section>

        {/* INTERACTIVE STATES (preview) */}
        <Section id="tokens-states" title="Interactive states (token-driven)">
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-caption font-semibold text-primary-foreground transition-colors duration-fast hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-95"
            >
              Default / hover / focus / active
            </button>
            <button
              type="button"
              disabled
              className="rounded-md bg-primary px-4 py-2 text-caption font-semibold text-primary-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              Disabled
            </button>
          </div>
          <p className="text-caption text-muted-foreground">
            Full primitive state sets ship in Phase 4; this shows the token wiring
            (ring = focus, opacity = disabled).
          </p>
        </Section>
      </div>
    </main>
  )
}
