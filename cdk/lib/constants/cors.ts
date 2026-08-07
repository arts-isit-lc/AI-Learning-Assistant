import { Annotations } from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * S3 CORS allowed-origins configuration for the presigned-URL buckets that the
 * browser talks to directly (document ingestion, embedding storage, chat-log
 * export, and the multimodal-RAG IR bucket).
 *
 * Why this is configured rather than referenced:
 * The only legitimate cross-origin caller is the Amplify-hosted SPA, but its
 * origin (`https://<branch>.<appId>.amplifyapp.com`) is generated when the app
 * is created in the AmplifyStack — which is *downstream* of the bucket stacks in
 * the dependency graph. Referencing it here would create a circular dependency,
 * so the allowed origins are supplied explicitly (context override, then
 * per-environment defaults).
 */

/**
 * Per-environment default browser origins allowed to reach the presigned-URL
 * buckets. Override at deploy time (recommended for prod) with:
 *
 *   cdk deploy ... -c allowedOrigins=https://app.example.com,https://www.example.com
 */
export const DEFAULT_ALLOWED_ORIGINS: Record<string, string[]> = {
  dev: [
    "https://ocelia-dev.arts.ubc.ca", // dev SPA custom domain (Amplify) — primary origin
    "https://dev.dbqfar7gbtstn.amplifyapp.com", // dev Amplify default domain (dev branch) — fallback
    "https://main.dbqfar7gbtstn.amplifyapp.com", // dev Amplify default domain (main branch) — fallback
    "http://localhost:5173", // Vite dev server
    "http://localhost:4173", // Vite preview
  ],
  // Set the production SPA origin(s) here or via `-c allowedOrigins=...`.
  // Left empty intentionally: the prod Amplify domain is not known at author
  // time. Until it is set, resolveAllowedOrigins falls back to "*" with a
  // synth-time warning (see below) so prod uploads/downloads never silently break.
  prod: [],
};

/**
 * Resolve the CORS `allowedOrigins` list for the browser-facing S3 buckets.
 *
 * Precedence:
 *   1. `-c allowedOrigins=<comma-separated>` context (or an array in cdk.json)
 *   2. Per-environment {@link DEFAULT_ALLOWED_ORIGINS}
 *   3. `["*"]` fallback + a synth-time warning (never silently lock out the SPA)
 */
export function resolveAllowedOrigins(
  scope: Construct,
  environment: string
): string[] {
  const ctx = scope.node.tryGetContext("allowedOrigins");
  const fromContext =
    typeof ctx === "string"
      ? ctx
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : Array.isArray(ctx)
        ? (ctx as unknown[]).map(String).filter(Boolean)
        : [];

  if (fromContext.length > 0) return fromContext;

  const defaults = DEFAULT_ALLOWED_ORIGINS[environment] ?? [];
  if (defaults.length > 0) return defaults;

  Annotations.of(scope).addWarning(
    `S3 CORS: no allowedOrigins configured for environment "${environment}"; ` +
      `falling back to "*". Restrict with -c allowedOrigins=https://your-app-origin`
  );
  return ["*"];
}
