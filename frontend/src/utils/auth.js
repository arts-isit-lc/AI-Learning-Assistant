import { signOut } from "aws-amplify/auth";

/**
 * Sign out the current user and redirect to the login page.
 * Shared across all header components and pages with sign-out buttons.
 */
export async function handleSignOut(event) {
  event.preventDefault();
  try {
    await signOut();
    window.location.href = "/";
  } catch (error) {
    console.error("Error signing out: ", error);
  }
}
