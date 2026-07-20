/**
 * Full-viewport loading state shown while auth resolves (guards / role redirect).
 * Token-driven; keeps the screen from flashing blank during the async session
 * check (plan §10: every wait has a visible state).
 *
 * @param {{ label?: string }} props
 */
export default function LoadingScreen({ label = "Loading\u2026" }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-background"
    >
      <span className="flex items-center gap-3 text-body text-muted-foreground">
        <span
          className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary"
          aria-hidden="true"
        />
        {label}
      </span>
    </div>
  )
}
