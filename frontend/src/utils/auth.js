import { fetchAuthSession } from "aws-amplify/auth";

/**
 * OPT-10: Get auth session and email from the ID token payload
 * instead of making a separate Cognito GetUser API call via fetchUserAttributes().
 */
export async function getAuthSessionAndEmail() {
  const session = await fetchAuthSession();
  const token = session.tokens.idToken;
  const email = token.payload.email;
  return { token, email, session };
}
