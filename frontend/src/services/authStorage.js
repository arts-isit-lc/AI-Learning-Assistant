import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito"
import { sessionStorage } from "aws-amplify/utils"

/**
 * Persist Cognito tokens in `sessionStorage` instead of the Amplify default
 * (`localStorage`). Session hardening for shared / lab machines: tokens are
 * scoped to the browser tab and cleared when it closes, so a closed browser
 * doesn't leave a resumable session on the machine.
 *
 * Trade-offs (accepted): sessions are per-tab — opening the app in a new tab
 * starts signed-out — while a page reload keeps the session (sessionStorage
 * survives reload, only clearing on tab close).
 *
 * Must run once at startup, before any auth call (see main.jsx).
 */
export function configureAuthStorage() {
  cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage)
}
