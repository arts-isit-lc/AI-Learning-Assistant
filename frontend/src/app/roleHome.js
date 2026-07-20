/**
 * Canonical landing path for a role. Used by the "/" redirect, by `RequireRole`
 * (to bounce a wrong-role visit somewhere sensible), and after login. Every role
 * resolves to a real home — this is what keeps the router free of dead ends.
 *
 * @param {"admin"|"instructor"|"student"|null|undefined} role
 * @param {boolean} [isInstructorAsStudent] instructor previewing the student UI
 * @returns {string}
 */
export function roleHomePath(role, isInstructorAsStudent = false) {
  switch (role) {
    case "admin":
      return "/admin/instructors";
    case "instructor":
      return isInstructorAsStudent ? "/courses" : "/instructor/courses";
    case "student":
      return "/courses";
    default:
      return "/login";
  }
}
