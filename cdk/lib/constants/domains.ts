/**
 * Canonical browser origin per environment — the single URL each environment's
 * SPA should be served from.
 *
 * This is the source of truth shared by:
 *   - AmplifyStack, which 301-redirects the auto-generated
 *     `https://main.<appId>.amplifyapp.com` default domain to this origin so
 *     each environment has exactly one canonical URL.
 *   - constants/cors.ts, which uses it as the primary allowed origin for the
 *     browser-facing presigned-URL S3 buckets.
 *
 * Keeping both in one place prevents the redirect target and the CORS allow-list
 * from drifting apart (a mismatch would silently break uploads).
 *
 * Format: scheme + host, no trailing slash (this is an HTTP `Origin`, and it is
 * also a valid Amplify redirect target — Amplify auto-appends the request path).
 */
export const CANONICAL_APP_ORIGIN: Record<string, string> = {
  dev: "https://ocelia-dev.arts.ubc.ca",
  prod: "https://ocelia.arts.ubc.ca",
};

/**
 * The auto-generated Amplify default origin (the `main` branch) per environment
 * — the redirect *source* that gets bounced to {@link CANONICAL_APP_ORIGIN}.
 *
 * Why hardcoded (not `amplifyApp.defaultDomain`): the default domain is an
 * attribute of the Amplify App resource, so referencing it inside that same
 * resource's `customRules` creates a self-referential circular dependency at
 * synth time. The Amplify app id is assigned once at creation and is stable for
 * the life of the app, so a literal is safe. `cors.ts` already pins these same
 * hosts. If an app is ever recreated (new id), update both here and in the CORS
 * allow-list.
 */
export const AMPLIFY_DEFAULT_ORIGIN: Record<string, string> = {
  dev: "https://main.dbqfar7gbtstn.amplifyapp.com",
  prod: "https://main.d21r345xhq29at.amplifyapp.com",
};

/**
 * Resolve the canonical origin for an environment, or `undefined` when the
 * environment has no configured canonical domain (e.g. an ad-hoc `staging`
 * deploy). Callers should treat `undefined` as "don't add the redirect" rather
 * than inventing a target.
 */
export function resolveCanonicalOrigin(environment: string): string | undefined {
  return CANONICAL_APP_ORIGIN[environment];
}

/**
 * Resolve the Amplify default origin (redirect source) for an environment, or
 * `undefined` when unknown.
 */
export function resolveAmplifyDefaultOrigin(environment: string): string | undefined {
  return AMPLIFY_DEFAULT_ORIGIN[environment];
}
