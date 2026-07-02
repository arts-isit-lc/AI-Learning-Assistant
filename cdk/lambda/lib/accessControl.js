/**
 * Access-control helpers for the student Lambda.
 *
 * These are pure with respect to the database: each takes the `sqlConn` tagged
 * template as its first argument and performs a single scoped SELECT. Keeping
 * them dependency-free (no AWS SDK / no direct connection setup) makes the
 * authorization logic unit-testable in isolation with a mock `sqlConn`.
 *
 * The caller MUST pass the identity proven by the authorizer
 * (`event.requestContext.authorizer.email`) — never an email taken from a query
 * string — so a caller cannot impersonate another user.
 */

/**
 * Verify the student is enrolled in the course that owns the given module.
 *
 * The join chain (Enrolments → Users → Course_Concepts → Course_Modules)
 * prevents mixed-parameter attacks where course_id and module_id belong to
 * different courses.
 *
 * @returns {Promise<string|null>} the enrolment_id if enrolled, else null.
 */
async function verifyStudentAccess(sqlConn, email, courseId, moduleId) {
  const result = await sqlConn`
    SELECT e.enrolment_id
    FROM "Enrolments" e
    JOIN "Users" u ON u.user_id = e.user_id
    JOIN "Course_Concepts" cc ON cc.course_id = e.course_id
    JOIN "Course_Modules" cm ON cm.concept_id = cc.concept_id
    WHERE u.user_email = ${email}
      AND cm.module_id = ${moduleId}
      AND e.course_id = ${courseId}
      AND cm.status = 'active'
    LIMIT 1;
  `;
  return result.length > 0 ? result[0].enrolment_id : null;
}

/**
 * Verify the caller owns the given session.
 *
 * Ownership chain: Sessions → Student_Modules → Enrolments → Users. A session
 * belongs to exactly one student (via the enrolment behind its student_module),
 * so this returns true only when the authenticated caller is that student.
 * Guards every per-session read/mutation (get_messages, session name updates)
 * against IDOR by session_id.
 *
 * @returns {Promise<boolean>} true if the caller owns the session.
 */
async function verifyStudentOwnsSession(sqlConn, email, sessionId) {
  const result = await sqlConn`
    SELECT 1
    FROM "Sessions" s
    JOIN "Student_Modules" sm ON sm.student_module_id = s.student_module_id
    JOIN "Enrolments" e ON e.enrolment_id = sm.enrolment_id
    JOIN "Users" u ON u.user_id = e.user_id
    WHERE s.session_id = ${sessionId}
      AND u.user_email = ${email}
    LIMIT 1;
  `;
  return result.length > 0;
}

module.exports = { verifyStudentAccess, verifyStudentOwnsSession };
