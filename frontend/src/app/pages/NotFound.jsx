import { Link } from "react-router-dom"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-8 text-center">
      <h1 className="text-h2 font-semibold text-navy">404</h1>
      <p className="text-body text-muted-foreground">We couldn&rsquo;t find that page.</p>
      <Link
        to="/"
        className="rounded-md bg-primary px-4 py-2 text-caption font-semibold text-primary-foreground transition-colors duration-fast hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Back to home
      </Link>
    </div>
  )
}
