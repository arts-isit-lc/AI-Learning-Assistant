/**
 * Pure role-transition helpers for the admin Lambda.
 *
 * These functions contain no I/O (no DB, no AWS SDK) so they are trivially and
 * deterministically unit-testable. The DB write is performed by the caller in
 * adminFunction.js using the array these functions return.
 *
 * Role model: a user's `roles` is a `varchar[]` in the "Users" table, so a user
 * can hold more than one role at once (e.g. ["admin", "instructor"]). App-level
 * dashboards/routing are driven by Cognito groups, not this array, so adding a
 * role here does not change which UI a user lands on.
 */

/**
 * Compute the roles array after elevating a user to instructor.
 *
 * Semantics (additive):
 *  - Already an instructor -> returns null (idempotent, nothing to write).
 *  - A plain "student" is converted to "instructor" (the learner role is
 *    replaced when the person becomes staff).
 *  - Any other roles (notably "admin") are preserved and "instructor" is added,
 *    so an admin becomes ["admin", "instructor"] and keeps admin access.
 *
 * @param {string[] | null | undefined} currentRoles
 * @returns {string[] | null} the new roles array, or null when no change is needed
 */
function computeRolesAfterElevation(currentRoles) {
  const roles = Array.isArray(currentRoles) ? currentRoles : [];

  if (roles.includes("instructor")) {
    return null;
  }

  if (roles.includes("student")) {
    return roles.map((role) => (role === "student" ? "instructor" : role));
  }

  return [...roles, "instructor"];
}

/**
 * Compute the roles array after removing the instructor role from a user.
 *
 * Semantics:
 *  - Removes "instructor" while preserving every other role, so an admin stays
 *    an admin instead of being forced down to "student".
 *  - If removing "instructor" would leave the user with no roles at all, they
 *    fall back to "student".
 *
 * @param {string[] | null | undefined} currentRoles
 * @returns {string[]} the new roles array
 */
function computeRolesAfterDemotion(currentRoles) {
  const roles = Array.isArray(currentRoles) ? currentRoles : [];
  const remaining = roles.filter((role) => role !== "instructor");
  return remaining.length > 0 ? remaining : ["student"];
}

module.exports = { computeRolesAfterElevation, computeRolesAfterDemotion };
