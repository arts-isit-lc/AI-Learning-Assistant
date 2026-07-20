import { Link } from "react-router-dom"

/**
 * Generic "screen arrives in a later phase" placeholder. Lets the full route
 * map, role shell, guards, and deep-linking go live in Phase 2 before the
 * feature screens are built (Phases 5-7).
 *
 * @param {{ title: string, phase?: number, description?: string }} props
 */
export default function Placeholder({ title, phase, description }) {
  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {phase != null && (
        <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          OCELIA &middot; arrives in Phase {phase}
        </p>
      )}
      <h1 className="mt-1 text-h2 font-semibold text-navy">{title}</h1>
      <p className="mt-3 text-body text-muted-foreground">
        {description ??
          "This screen isn't built yet. The route, role shell, and guards are live \u2014 the feature lands in a later rebuild phase."}
      </p>
      <Link
        to="/"
        className="mt-6 inline-block text-caption font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Back to home
      </Link>
    </div>
  )
}
