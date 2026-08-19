/**
 * Instructor Lambda — Route index:
 *   GET    /instructor/student_course
 *   GET    /instructor/courses
 *   POST   /instructor/updateCourseAccess
 *   DELETE /instructor/delete_course
 *   GET    /instructor/course_messages_rows
 *   GET    /instructor/analytics
 *   POST   /instructor/create_concept
 *   PUT    /instructor/edit_concept
 *   PUT    /instructor/update_metadata
 *   POST   /instructor/create_module
 *   PUT    /instructor/reorder_module
 *   PUT    /instructor/edit_module
 *   PUT    /instructor/prompt
 *   GET    /instructor/view_students
 *   DELETE /instructor/delete_student
 *   GET    /instructor/view_modules
 *   GET    /instructor/view_concepts
 *   DELETE /instructor/delete_concept
 *   DELETE /instructor/delete_module
 *   GET    /instructor/get_prompt
 *   GET    /instructor/view_student_messages
 *   PUT    /instructor/generate_access_code
 *   GET    /instructor/get_access_code
 *   GET    /instructor/previous_prompts
 *   GET    /instructor/student_modules_messages
 *   GET    /instructor/check_notifications_status
 *   DELETE /instructor/remove_completed_notification
 *   GET    /instructor/course_files
 *   GET    /instructor/module_file_references
 *   PUT    /instructor/module_file_references
 *   POST   /instructor/validate_prompt
 *   POST   /instructor/generate_topics
 *   GET    /instructor/file_processing_statuses
 *   POST   /instructor/reserve_module
 *   POST   /instructor/finalize_module
 *   POST   /instructor/cleanup_module
 */
const { initializeConnection } = require("./lib.js");
const { validatePrompt } = require("./validatePrompt.js");
const { generateModuleTopics } = require("./generateTopics.js");
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const s3Client = new S3Client({ region: process.env.REGION });
const DATA_INGESTION_BUCKET = process.env.DATA_INGESTION_BUCKET;
let { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT, REGION } = process.env;

let sqlConnection = global.sqlConnection;

// Course-scoped instructor routes and the query-string identifier each carries
// for the target course. Every route listed here is gated by the centralized
// authorization check below: the caller must hold an ACTIVE instructor
// enrolment (Enrolments.access_enabled not toggled off by an admin — OCELIA
// track B4) in the resolved course. `concept_id`/`module_id` routes resolve the
// course via Course_Concepts/Course_Modules. Routes NOT listed are either not
// course-scoped (student_course preview), already guarded inline
// (updateCourseAccess, delete_course, course_messages_rows, reserve/finalize/
// cleanup_module), or the list endpoint (courses) which filters access_enabled
// directly. Keep this in sync when adding a course-scoped route.
const INSTRUCTOR_COURSE_SCOPED_ROUTES = {
  "GET /instructor/analytics": "course_id",
  "POST /instructor/create_concept": "course_id",
  "PUT /instructor/edit_concept": "concept_id",
  "PUT /instructor/update_metadata": "module_id",
  "POST /instructor/create_module": "course_id",
  "PUT /instructor/reorder_module": "module_id",
  "PUT /instructor/edit_module": "module_id",
  "PUT /instructor/prompt": "course_id",
  "GET /instructor/view_students": "course_id",
  "DELETE /instructor/delete_student": "course_id",
  "GET /instructor/view_modules": "course_id",
  "GET /instructor/view_concepts": "course_id",
  "DELETE /instructor/delete_concept": "concept_id",
  "DELETE /instructor/delete_module": "module_id",
  "GET /instructor/get_prompt": "course_id",
  "GET /instructor/view_student_messages": "course_id",
  "PUT /instructor/generate_access_code": "course_id",
  "GET /instructor/get_access_code": "course_id",
  "GET /instructor/previous_prompts": "course_id",
  "GET /instructor/student_modules_messages": "course_id",
  "GET /instructor/check_notifications_status": "course_id",
  "DELETE /instructor/remove_completed_notification": "course_id",
  "GET /instructor/course_files": "course_id",
  "GET /instructor/module_file_references": "module_id",
  "PUT /instructor/module_file_references": "module_id",
  "POST /instructor/validate_prompt": "course_id",
  "POST /instructor/generate_topics": "module_id",
  "GET /instructor/file_processing_statuses": "module_id",
};

exports.handler = async (event) => {
  // OPT-1: Read email from authorizer context instead of calling Cognito AdminGetUser
  const userEmailAttribute = event.requestContext.authorizer.email;

  // Check for query string parameters

  const queryStringParams = event.queryStringParameters || {};
  const queryEmail = queryStringParams.email;
  const instructorEmail = queryStringParams.instructor_email;

  const isUnauthorized =
    (queryEmail && queryEmail !== userEmailAttribute) ||
    (instructorEmail && instructorEmail !== userEmailAttribute);

  if (isUnauthorized) {
    return {
      statusCode: 401,
      headers: {
        "Access-Control-Allow-Headers":
          "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
      },
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const response = {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Headers":
        "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
    },
    body: "",
  };

  // Initialize the database connection if not already initialized
  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  // Function to format student full names (lowercase and spaces replaced with "_")
  const formatNames = (name) => {
    return name.toLowerCase().replace(/\s+/g, "_");
  };

  function generateAccessCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 16; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code.match(/.{1,4}/g).join("-");
  }

  // Single source of truth for "does this instructor currently have access to
  // this course?". True iff they hold an instructor enrolment AND that enrolment
  // has not been switched off by an admin via the OCELIA Access toggle (backend
  // track B4 — Enrolments.access_enabled). `IS NOT FALSE` treats a legacy NULL
  // as access-granted (the column is NOT NULL DEFAULT true, so this is only
  // belt-and-suspenders). Every per-course guard routes through this so the
  // toggle is honored consistently and the checks can't drift apart.
  const instructorHasCourseAccess = async (email, courseId) => {
    const rows = await sqlConnection`
        SELECT 1
        FROM "Enrolments" e
        JOIN "Users" u ON u.user_id = e.user_id
        WHERE u.user_email = ${email}
          AND e.course_id = ${courseId}
          AND e.enrolment_type = 'instructor'
          AND e.access_enabled IS NOT FALSE
        LIMIT 1;
      `;
    return rows.length > 0;
  };

  // Concept-scoped variant: resolve the course from the concept
  // (Course_Concepts.course_id) and apply the same active-access check.
  const instructorHasConceptAccess = async (email, conceptId) => {
    const rows = await sqlConnection`
        SELECT 1
        FROM "Course_Concepts" cc
        JOIN "Enrolments" e ON e.course_id = cc.course_id
        JOIN "Users" u ON u.user_id = e.user_id
        WHERE cc.concept_id = ${conceptId}
          AND u.user_email = ${email}
          AND e.enrolment_type = 'instructor'
          AND e.access_enabled IS NOT FALSE
        LIMIT 1;
      `;
    return rows.length > 0;
  };

  // Module-scoped variant: resolve the course from the module
  // (Course_Modules -> Course_Concepts) and apply the same active-access check.
  //
  // Draft modules are the wrinkle: reserve_module inserts a Course_Modules row
  // with concept_id = NULL (no course linkage yet) so files can upload before
  // the module is finalized. Those drafts were already gated at reserve time
  // (instructorHasCourseAccess on course_id) and carry unguessable
  // server-generated ids, so the in-flight creation calls (file_processing_
  // statuses, generate_topics, and any pre-finalize metadata/reference writes)
  // must still pass here. We therefore allow a draft (concept_id IS NULL); once
  // finalized, the resolved-course access check applies. A non-existent module
  // returns false (treated as forbidden — we don't distinguish 403 vs 404 here).
  const instructorHasModuleAccess = async (email, moduleId) => {
    const rows = await sqlConnection`
        SELECT
          (cm.concept_id IS NULL) AS is_draft,
          EXISTS (
            SELECT 1
            FROM "Course_Concepts" cc
            JOIN "Enrolments" e ON e.course_id = cc.course_id
            JOIN "Users" u ON u.user_id = e.user_id
            WHERE cc.concept_id = cm.concept_id
              AND u.user_email = ${email}
              AND e.enrolment_type = 'instructor'
              AND e.access_enabled IS NOT FALSE
          ) AS has_access
        FROM "Course_Modules" cm
        WHERE cm.module_id = ${moduleId}
        LIMIT 1;
      `;
    if (rows.length === 0) return false;
    return rows[0].is_draft === true || rows[0].has_access === true;
  };

  let data;
  try {
    const pathData = event.httpMethod + " " + event.resource;

    // ── Centralized per-course authorization ────────────────────────────────
    // For every course-scoped route (see INSTRUCTOR_COURSE_SCOPED_ROUTES),
    // verify the caller has an active instructor enrolment in the target course
    // BEFORE dispatching. This closes the gap where routes trusted only the
    // authorizer email and took course_id/module_id/concept_id from params —
    // letting an instructor act on a course they don't teach, and (the original
    // bug) ignoring the admin Access toggle (Enrolments.access_enabled). The
    // check runs only when the identifier is present, so each route still owns
    // its existing 400 for a missing identifier.
    const scopeKey = INSTRUCTOR_COURSE_SCOPED_ROUTES[pathData];
    if (scopeKey) {
      const scopeId = event.queryStringParameters?.[scopeKey];
      if (scopeId) {
        const allowed =
          scopeKey === "course_id"
            ? await instructorHasCourseAccess(userEmailAttribute, scopeId)
            : scopeKey === "concept_id"
            ? await instructorHasConceptAccess(userEmailAttribute, scopeId)
            : await instructorHasModuleAccess(userEmailAttribute, scopeId);
        if (!allowed) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "You do not teach this course" });
          console.log(response);
          return response;
        }
      }
    }

    switch (pathData) {
      case "GET /instructor/student_course":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.email
        ) {
          const email = event.queryStringParameters.email;

          // First, get the user_id for the given email
          const userResult = await sqlConnection`
            SELECT user_id FROM "Users" WHERE user_email = ${email};
          `;

          if (userResult.length === 0) {
            response.statusCode = 404;
            response.body = "User not found";
            break;
          }

          const userId = userResult[0].user_id;

          // Now, fetch the courses for that user_id, each with its instructor
          // list (name + email) — parity with GET /student/course so the shared
          // student CourseHeader renders instructors in instructor
          // preview-as-student mode too.
          data = await sqlConnection`SELECT "Courses".*,
              COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'first_name', u.first_name,
                    'last_name', u.last_name,
                    'user_email', u.user_email
                  ) ORDER BY u.last_name ASC, u.first_name ASC
                )
                FROM "Enrolments" ie
                JOIN "Users" u ON ie.user_id = u.user_id
                WHERE ie.course_id = "Courses".course_id
                  AND ie.enrolment_type = 'instructor'
              ), '[]'::json) AS instructors
            FROM "Enrolments"
            JOIN "Courses" ON "Enrolments".course_id = "Courses".course_id
            WHERE "Enrolments".user_id = ${userId}
            ORDER BY "Courses".course_name, "Courses".course_id;`;

          response.body = JSON.stringify(data);
        } else {
          response.statusCode = 400;
          response.body = "Invalid value";
        }
        break;
      case "GET /instructor/courses":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.email
        ) {
          const instructorEmail = event.queryStringParameters.email;

          try {
            // First, get the user ID using the email
            const userIdResult = await sqlConnection`
                SELECT user_id
                FROM "Users"
                WHERE user_email = ${instructorEmail}
                LIMIT 1;
              `;

            const userId = userIdResult[0]?.user_id;

            if (!userId) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Instructor not found" });
              break;
            }

            // Query to get all courses where the instructor is enrolled
            const data = await sqlConnection`
                SELECT c.*
                FROM "Enrolments" e
                JOIN "Courses" c ON e.course_id = c.course_id
                WHERE e.user_id = ${userId}
                AND e.enrolment_type = 'instructor'
                AND e.access_enabled IS NOT FALSE
                ORDER BY c.course_name, c.course_id;
              `;

            response.statusCode = 200;
            response.body = JSON.stringify(data);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "email is required" });
        }
        break;
      case "POST /instructor/updateCourseAccess":
        // Toggle Active/Inactive (Courses.course_student_access) for a course the
        // instructor teaches. Ownership is checked against the authorizer email
        // (trusted) via an instructor enrolment — an instructor can only toggle
        // their own course. Mirrors admin/updateCourseAccess (which is unscoped).
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.access
        ) {
          try {
            const { course_id, access } = event.queryStringParameters;
            const accessBool = access.toLowerCase() === "true";

            const owns = await instructorHasCourseAccess(userEmailAttribute, course_id);
            if (!owns) {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "You do not teach this course" });
              break;
            }

            const updated = await sqlConnection`
                UPDATE "Courses"
                SET course_student_access = ${accessBool}
                WHERE course_id = ${course_id}
                RETURNING course_id, course_student_access;
              `;
            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Course not found" });
              break;
            }

            response.body = JSON.stringify({
              message: "Course access updated successfully.",
              course_student_access: updated[0].course_student_access,
            });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id and access are required" });
        }
        break;
      case "DELETE /instructor/delete_course":
        // Delete a course the instructor teaches. Ownership checked against the
        // authorizer email. Row-cascade removes concepts/modules/enrolments/
        // files/sessions/messages (ON DELETE CASCADE); S3 objects + pgvector
        // embeddings are swept by the scheduled orphanCleanup backstop, same as
        // admin/delete_course (see engineering-log B6).
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          try {
            const { course_id } = event.queryStringParameters;

            const owns = await instructorHasCourseAccess(userEmailAttribute, course_id);
            if (!owns) {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "You do not teach this course" });
              break;
            }

            await sqlConnection`
                DELETE FROM "Courses"
                WHERE course_id = ${course_id};
              `;

            response.body = JSON.stringify({
              message: "Course and related records deleted successfully.",
            });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /instructor/course_messages_rows":
        // Course-wide chat messages (B5) for the in-app Chat History table.
        // Ownership is checked against the authorizer email (an instructor may
        // only read their own course's messages). Paginated (limit/offset) with
        // a total count, so the browser never loads a whole course's log at once
        // — the complete export stays on the async CSV path (course_messages).
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          try {
            const { course_id } = event.queryStringParameters;
            const limit = Math.min(
              Math.max(parseInt(event.queryStringParameters.limit ?? "50", 10) || 50, 1),
              200
            );
            const offset = Math.max(parseInt(event.queryStringParameters.offset ?? "0", 10) || 0, 0);

            // Server-side sort. sort_by is resolved against a fixed whitelist of
            // (alias-qualified) columns and sort_dir is coerced to ASC/DESC, so the
            // ORDER BY fragment below is built entirely from server-controlled
            // constants — never raw client input — before it reaches .unsafe().
            // Default (no/unknown sort_by) is the User column ascending, matching
            // the Chat History mockup (Figma 376:2331). A m.time_sent DESC
            // tiebreaker keeps equal keys deterministically ordered across pages.
            const SORT_COLUMNS = {
              user_email: "u.user_email",
              module_name: "cm.module_name",
              concept_name: "cc.concept_name",
              session_id: "s.session_id",
              message_content: "m.message_content",
              time_sent: "m.time_sent",
            };
            const sortColumn = SORT_COLUMNS[event.queryStringParameters.sort_by] ?? SORT_COLUMNS.user_email;
            const sortDir =
              String(event.queryStringParameters.sort_dir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
            const orderClause =
              sortColumn === "m.time_sent"
                ? `${sortColumn} ${sortDir}`
                : `${sortColumn} ${sortDir}, m.time_sent DESC`;

            const owns = await instructorHasCourseAccess(userEmailAttribute, course_id);
            if (!owns) {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "You do not teach this course" });
              break;
            }

            const countRows = await sqlConnection`
                SELECT COUNT(*)::int AS total
                FROM "Messages" m
                JOIN "Sessions" s ON m.session_id = s.session_id
                JOIN "Student_Modules" sm ON s.student_module_id = sm.student_module_id
                JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
                WHERE e.course_id = ${course_id};
              `;
            const total = countRows[0]?.total ?? 0;

            const messages = await sqlConnection`
                SELECT u.user_email,
                       cm.module_name, cm.module_number,
                       cc.concept_name, cc.concept_number,
                       s.session_id, s.session_name,
                       m.student_sent, m.message_content, m.time_sent
                FROM "Messages" m
                JOIN "Sessions" s ON m.session_id = s.session_id
                JOIN "Student_Modules" sm ON s.student_module_id = sm.student_module_id
                JOIN "Course_Modules" cm ON sm.course_module_id = cm.module_id
                JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
                JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
                JOIN "Users" u ON e.user_id = u.user_id
                WHERE e.course_id = ${course_id}
                ORDER BY ${sqlConnection.unsafe(orderClause)}
                LIMIT ${limit} OFFSET ${offset};
              `;

            response.body = JSON.stringify({ messages, total, limit, offset });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /instructor/analytics":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const courseId = event.queryStringParameters.course_id;

          try {
            // OPT-4: Run 3 queries in parallel (queries 3+4 combined into scoreData)
            const [messageCreations, moduleAccesses, scoreData] = await Promise.all([
              sqlConnection`
                SELECT cm.module_id, cm.module_name, COUNT(m.message_id) AS message_count, cm.module_number, cc.concept_number
                FROM "Course_Modules" cm
                JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
                LEFT JOIN "Student_Modules" sm ON cm.module_id = sm.course_module_id
                LEFT JOIN "Sessions" s ON sm.student_module_id = s.student_module_id
                LEFT JOIN "Messages" m ON s.session_id = m.session_id
                LEFT JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
                LEFT JOIN "Users" u ON e.user_id = u.user_id
                WHERE cc.course_id = ${courseId}
                AND 'student' = ANY(u.roles)
                GROUP BY cm.module_id, cm.module_name, cm.module_number, cc.concept_number
                ORDER BY cc.concept_number ASC, cm.module_number ASC;
              `,
              sqlConnection`
                SELECT cm.module_id, COUNT(uel.log_id) AS access_count
                FROM "Course_Modules" cm
                JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
                LEFT JOIN "User_Engagement_Log" uel ON cm.module_id = uel.module_id
                LEFT JOIN "Enrolments" e ON uel.enrolment_id = e.enrolment_id
                LEFT JOIN "Users" u ON e.user_id = u.user_id
                WHERE cc.course_id = ${courseId}
                AND uel.engagement_type = 'module access'
                AND 'student' = ANY(u.roles)
                GROUP BY cm.module_id;
              `,
              sqlConnection`
                SELECT cm.module_id,
                  AVG(sm.module_score) AS average_score,
                  CASE
                    WHEN COUNT(sm.student_module_id) = 0 THEN 0
                    ELSE COUNT(CASE WHEN sm.module_score = 100 THEN 1 END) * 100.0 / COUNT(sm.student_module_id)
                  END AS perfect_score_percentage
                FROM "Course_Modules" cm
                JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
                LEFT JOIN "Student_Modules" sm ON cm.module_id = sm.course_module_id
                LEFT JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
                LEFT JOIN "Users" u ON e.user_id = u.user_id
                WHERE cc.course_id = ${courseId}
                AND 'student' = ANY(u.roles)
                GROUP BY cm.module_id;
              `,
            ]);

            const analyticsData = messageCreations.map((module) => {
              const accesses = moduleAccesses.find((ma) => ma.module_id === module.module_id) || {};
              const scores = scoreData.find((s) => s.module_id === module.module_id) || {};

              return {
                module_id: module.module_id,
                module_name: module.module_name,
                concept_number: module.concept_number,
                module_number: module.module_number,
                message_count: module.message_count || 0,
                access_count: accesses.access_count || 0,
                average_score: parseFloat(scores.average_score) || 0,
                perfect_score_percentage: parseFloat(scores.perfect_score_percentage) || 0,
              };
            });

            response.statusCode = 200;
            response.body = JSON.stringify(analyticsData);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "POST /instructor/create_concept":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.concept_number
        ) {
          const courseId = event.queryStringParameters.course_id;
          const conceptNumber = event.queryStringParameters.concept_number;
          const { concept_name } = JSON.parse(event.body);

          if (!concept_name) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "concept_name is required",
            });
            break;
          }

          try {
            // Check if a concept with the same name already exists for the given course
            const existingConcept = await sqlConnection`
                  SELECT * FROM "Course_Concepts"
                  WHERE course_id = ${courseId}
                  AND concept_name = ${concept_name};
                `;

            if (existingConcept.length > 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "A concept with this name already exists in the course.",
              });
              break;
            }

            // Insert the new concept into the Course_Concepts table using uuid_generate_v4() for concept_id
            await sqlConnection`
                  INSERT INTO "Course_Concepts" (
                    "concept_id", "course_id", "concept_number", "concept_name"
                  ) VALUES (
                    uuid_generate_v4(), ${courseId}, ${conceptNumber}, ${concept_name}
                  );
                `;

            response.statusCode = 201;
            response.body = JSON.stringify({
              message: "Concept created successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "course_id and concept_number are required",
          });
        }
        break;
      case "PUT /instructor/edit_concept":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.concept_id &&
          event.queryStringParameters.concept_number
        ) {
          const conceptId = event.queryStringParameters.concept_id;
          const conceptNumber = event.queryStringParameters.concept_number;
          const { concept_name } = JSON.parse(event.body);

          try {
            // Check if another concept with the same name already exists
            const existingConcept = await sqlConnection`
                SELECT * FROM "Course_Concepts"
                WHERE concept_name = ${concept_name}
                AND concept_id != ${conceptId};
              `;

            if (existingConcept.length > 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "A concept with this name already exists.",
              });
              break;
            }

            // Update the concept's name and number
            const result = await sqlConnection`
                UPDATE "Course_Concepts"
                SET
                  concept_name = ${concept_name},
                  concept_number = ${conceptNumber}
                WHERE
                  concept_id = ${conceptId}
                RETURNING *;
              `;

            if (result.length > 0) {
              response.statusCode = 200;
              response.body = JSON.stringify(result[0]);
            } else {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Concept not found" });
            }
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "concept_id and concept_number are required",
          });
        }
        break;
      case "PUT /instructor/update_metadata":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id &&
          event.queryStringParameters.filename &&
          event.queryStringParameters.filetype
        ) {
          const moduleId = event.queryStringParameters.module_id;
          const filename = event.queryStringParameters.filename;
          const filetype = event.queryStringParameters.filetype;
          const { metadata } = JSON.parse(event.body);

          try {
            // Query to find the file with the given module_id and filename
            const existingFile = await sqlConnection`
                      SELECT * FROM "Module_Files"
                      WHERE module_id = ${moduleId}
                      AND filename = ${filename}
                      AND filetype = ${filetype};
                  `;

            if (existingFile.length === 0) {
              const newMeta = metadata && typeof metadata === 'string' && metadata.trim()
                ? JSON.stringify({ description: metadata })
                : null;
              const result = await sqlConnection`
                INSERT INTO "Module_Files" (module_id, filename, filetype, metadata)
                VALUES (${moduleId}, ${filename}, ${filetype}, ${newMeta}::jsonb)
                RETURNING *;
              `;
              response.body = JSON.stringify({
                message: "File metadata added successfully",
              });
            }

            // Merge description into existing metadata (preserve topic_extraction and other keys)
            // metadata column is TEXT — may contain JSON or plain text from legacy rows
            const description = metadata || "";
            const result = await sqlConnection`
                      UPDATE "Module_Files"
                      SET metadata = (
                        COALESCE(
                          CASE
                            WHEN metadata IS NOT NULL AND metadata ~ '^\s*\{' THEN metadata::jsonb
                            ELSE '{}'::jsonb
                          END,
                          '{}'::jsonb
                        ) || jsonb_build_object('description', ${description}::text)
                      )::text
                      WHERE module_id = ${moduleId}
                      AND filename = ${filename}
                      AND filetype = ${filetype}
                      RETURNING *;
                  `;

            if (result.length > 0) {
              response.statusCode = 200;
              response.body = JSON.stringify(result[0]);
            } else {
              response.statusCode = 500;
              response.body = JSON.stringify({
                error: "Failed to update metadata.",
              });
            }
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "module_id and filename are required",
          });
        }
        break;
      case "POST /instructor/create_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.concept_id &&
          event.queryStringParameters.module_name &&
          event.queryStringParameters.module_number &&
          event.queryStringParameters.instructor_email
        ) {
          const {
            course_id,
            concept_id,
            module_name,
            module_number,
            instructor_email,
          } = event.queryStringParameters;
          const { module_prompt, key_topics } = JSON.parse(event.body || "{}");

          try {
            // Check if a module with the same name already exists
            const existingModule = await sqlConnection`
                    SELECT * FROM "Course_Modules"
                    WHERE concept_id = ${concept_id}
                    AND module_name = ${module_name};
                  `;

            if (existingModule.length > 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error:
                  "A module with this name already exists in the given concept.",
              });
              break;
            }

            // Insert new module into Course_Modules table
            const keyTopicsJson = key_topics ? JSON.stringify(key_topics) : null;
            const newModule = await sqlConnection`
                    INSERT INTO "Course_Modules" (module_id, concept_id, module_name, module_number, module_prompt, key_topics)
                    VALUES (uuid_generate_v4(), ${concept_id}, ${module_name}, ${module_number}, ${module_prompt}, ${keyTopicsJson})
                    RETURNING *;
                  `;

            // Insert into User Engagement Log
            await sqlConnection`
                  INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
                  VALUES (uuid_generate_v4(), (SELECT user_id FROM "Users" WHERE user_email = ${instructor_email}), ${course_id}, ${newModule[0].module_id}, null, CURRENT_TIMESTAMP, 'instructor_created_module')
              `;

            // Find all student enrolments for the given course_id
            const enrolments = await sqlConnection`
                    SELECT enrolment_id FROM "Enrolments"
                    WHERE course_id = ${course_id};
                  `;

            // Create Student_Module entries for each enrolment
            await Promise.all(
              enrolments.map(async (enrolment) => {
                await sqlConnection`
                      INSERT INTO "Student_Modules" (student_module_id, course_module_id, enrolment_id, module_score)
                      VALUES (uuid_generate_v4(), ${newModule[0].module_id}, ${enrolment.enrolment_id}, 0);
                    `;
              })
            );

            response.statusCode = 201;
            response.body = JSON.stringify(newModule[0]);
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "course_id, concept_id, module_name, module_number, or instructor_email is missing",
          });
        }
        break;
      case "PUT /instructor/reorder_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id &&
          event.queryStringParameters.module_number &&
          event.queryStringParameters.instructor_email
        ) {
          const { module_id, module_number, instructor_email } =
            event.queryStringParameters;
          const { module_name } = JSON.parse(event.body || "{}");

          if (module_name) {
            try {
              // Update the module in the Course_Modules table
              await sqlConnection`
                    UPDATE "Course_Modules"
                    SET module_name = ${module_name}, module_number = ${module_number}
                    WHERE module_id = ${module_id};
                  `;

              // Insert into User Engagement Log
              await sqlConnection`
                    INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
                    VALUES (uuid_generate_v4(), (SELECT user_id FROM "Users" WHERE user_email = ${instructor_email}), NULL, ${module_id}, NULL, CURRENT_TIMESTAMP, 'instructor_edited_module');
                  `;

              response.statusCode = 200;
              response.body = JSON.stringify({
                message: "Module updated successfully",
              });
            } catch (err) {
              response.statusCode = 500;
              console.error(err);
              response.body = JSON.stringify({
                error: "Internal server error",
              });
            }
          } else {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "module_name is required in the body",
            });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "module_id, module_number, or instructor_email is missing in query string parameters",
          });
        }
        break;
      case "PUT /instructor/edit_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id &&
          event.queryStringParameters.instructor_email &&
          event.queryStringParameters.concept_id
        ) {
          const { module_id, instructor_email, concept_id } =
            event.queryStringParameters;
          const { module_name, module_prompt, conflict_metadata, key_topics } = JSON.parse(event.body || "{}");

          if (module_name) {
            try {
              // Check if another module with the same name already exists under the same concept
              const existingModule = await sqlConnection`
                    SELECT * FROM "Course_Modules"
                    WHERE concept_id = ${concept_id}
                    AND module_name = ${module_name}
                    AND module_id != ${module_id};
                  `;

              if (existingModule.length > 0) {
                response.statusCode = 400;
                response.body = JSON.stringify({
                  error:
                    "A module with this name already exists under the same concept.",
                });
                break;
              }

              // Update the module in the Course_Modules table
              const keyTopicsJson = key_topics ? JSON.stringify(key_topics) : null;
              await sqlConnection`
                    UPDATE "Course_Modules"
                    SET module_name = ${module_name}, concept_id = ${concept_id}, module_prompt = ${module_prompt}, conflict_metadata = ${conflict_metadata ? JSON.stringify(conflict_metadata) : null}, key_topics = ${keyTopicsJson}
                    WHERE module_id = ${module_id};
                  `;

              // Insert into User Engagement Log
              await sqlConnection`
                    INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
                    VALUES (uuid_generate_v4(), (SELECT user_id FROM "Users" WHERE user_email = ${instructor_email}), NULL, ${module_id}, NULL, CURRENT_TIMESTAMP, 'instructor_edited_module');
                  `;

              response.statusCode = 200;
              response.body = JSON.stringify({
                message: "Module updated successfully",
              });
            } catch (err) {
              response.statusCode = 500;
              console.error(err);
              response.body = JSON.stringify({
                error: "Internal server error",
              });
            }
          } else {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "module_name is required in the body",
            });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "module_id, instructor_email, or concept_id is missing in query string parameters",
          });
        }
        break;
      case "PUT /instructor/prompt":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.instructor_email &&
          event.body
        ) {
          try {
            const { course_id, instructor_email } = event.queryStringParameters;
            const { prompt, llm_model_id, conflict_metadata } = JSON.parse(event.body);

            // Retrieve the current system prompt
            const currentPromptResult = await sqlConnection`
                      SELECT system_prompt
                      FROM "Courses"
                      WHERE course_id = ${course_id};
                    `;

            if (currentPromptResult.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Course not found" });
              break;
            }

            const oldPrompt = currentPromptResult[0].system_prompt;

            // Update system prompt, llm_model_id, and conflict_metadata for the course
            const updatedCourse = await sqlConnection`
                      UPDATE "Courses"
                      SET system_prompt = ${prompt}, llm_model_id = ${llm_model_id}, conflict_metadata = ${conflict_metadata ? JSON.stringify(conflict_metadata) : null}
                      WHERE course_id = ${course_id}
                      RETURNING *;
                    `;

            // Log override event if saving with known conflicts
            if (conflict_metadata && conflict_metadata.has_conflicts) {
              console.log(JSON.stringify({
                level: "INFO",
                service: "instructor-function",
                event: "validation_override",
                instructor_email,
                course_id,
                conflict_count: conflict_metadata.conflicts?.length || 0,
                conflict_types: conflict_metadata.conflicts?.map(c => c.type) || [],
                timestamp: new Date().toISOString(),
              }));
            }

            // Insert into User Engagement Log with old prompt in engagement_details
            await sqlConnection`
                      INSERT INTO "User_Engagement_Log" (
                        log_id,
                        user_id,
                        course_id,
                        module_id,
                        enrolment_id,
                        timestamp,
                        engagement_type,
                        engagement_details
                      )
                      VALUES (
                        uuid_generate_v4(),
                        (SELECT user_id FROM "Users" WHERE user_email = ${instructor_email}),
                        ${course_id},
                        null,
                        null,
                        CURRENT_TIMESTAMP,
                        'instructor_updated_prompt',
                        ${oldPrompt}
                      );
                    `;

            response.body = JSON.stringify(updatedCourse[0]);
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body =
            "course_id, instructor_email, or request body is missing";
        }
        break;
      case "GET /instructor/view_students":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const { course_id } = event.queryStringParameters;

          try {
            // Query to get all students enrolled in the given course
            const enrolledStudents = await sqlConnection`
                    SELECT u.user_email, u.username, u.first_name, u.last_name
                    FROM "Enrolments" e
                    JOIN "Users" u ON e.user_id = u.user_id  -- Change to use user_id
                    WHERE e.course_id = ${course_id} AND e.enrolment_type = 'student';
                  `;

            response.statusCode = 200;
            response.body = JSON.stringify(enrolledStudents);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "DELETE /instructor/delete_student":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.instructor_email &&
          event.queryStringParameters.user_email
        ) {
          const { course_id, instructor_email, user_email } =
            event.queryStringParameters;

          try {
            // Step 1: Get the user ID from the user email
            const userResult = await sqlConnection`
                  SELECT user_id
                  FROM "Users"
                  WHERE user_email = ${user_email}
                  LIMIT 1;
              `;

            const userId = userResult[0]?.user_id;

            if (!userId) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "User not found",
              });
              break;
            }

            // Step 2: Delete the student from the course enrolments
            const deleteResult = await sqlConnection`
                  DELETE FROM "Enrolments"
                  WHERE course_id = ${course_id}
                    AND user_id = ${userId}  -- Use user_id instead of user_email
                    AND enrolment_type = 'student'
                  RETURNING *;
              `;

            if (deleteResult.length > 0) {
              response.statusCode = 200; // Set status to 200 on successful deletion
              response.body = JSON.stringify(deleteResult[0]);

              // Step 3: Insert into User Engagement Log
              await sqlConnection`
                    INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
                    VALUES (uuid_generate_v4(), ${userId}, ${course_id}, null, null, CURRENT_TIMESTAMP, 'instructor_deleted_student')
                `;
            } else {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "Student not found in the course",
              });
            }
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "course_id, user_email, and instructor_email are required",
          });
        }
        break;
      case "GET /instructor/view_modules":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const { course_id } = event.queryStringParameters;

          try {
            // Query to get all modules for the given course
            const courseModules = await sqlConnection`
        SELECT cm.module_id, cm.module_name, cm.module_number, cm.module_prompt, cm.generated_topics, cm.key_topics, cc.concept_name, cc.concept_number
        FROM "Course_Modules" cm
        JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
        WHERE cc.course_id = ${course_id}
        ORDER BY cc.concept_number ASC, cm.module_number ASC;
      `;

            response.statusCode = 200;
            response.body = JSON.stringify(courseModules);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /instructor/view_concepts":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const courseId = event.queryStringParameters.course_id;

          try {
            // Query to get all concepts for the given course
            const concepts = await sqlConnection`
                SELECT concept_id, concept_name, concept_number
                FROM "Course_Concepts"
                WHERE course_id = ${courseId}
                ORDER BY concept_number ASC;
              `;

            response.statusCode = 200;
            response.body = JSON.stringify(concepts);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "DELETE /instructor/delete_concept":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.concept_id
        ) {
          const conceptId = event.queryStringParameters.concept_id;

          try {
            // Delete the concept from the Course_Concepts table
            await sqlConnection`
                DELETE FROM "Course_Concepts"
                WHERE concept_id = ${conceptId};
              `;

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: "Concept deleted successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "concept_id is required" });
        }
        break;
      case "DELETE /instructor/delete_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id
        ) {
          const moduleId = event.queryStringParameters.module_id;

          try {
            // Delete the module from the Course_Modules table
            await sqlConnection`
                DELETE FROM "Course_Modules"
                WHERE module_id = ${moduleId};
              `;

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: "Module deleted successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "module_id is required" });
        }
        break;
      case "GET /instructor/get_prompt":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          try {
            const { course_id } = event.queryStringParameters;

            // Retrieve the system prompt, llm_model_id, and conflict_metadata from the Courses table
            const coursePrompt = await sqlConnection`
                    SELECT system_prompt, llm_model_id, conflict_metadata 
                    FROM "Courses"
                    WHERE course_id = ${course_id};
                  `;

            if (coursePrompt.length > 0) {
              response.statusCode = 200;
              response.body = JSON.stringify(coursePrompt[0]);
            } else {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Course not found" });
            }
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "course_id is missing";
        }
        break;
      case "GET /instructor/view_student_messages":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.student_email &&
          event.queryStringParameters.course_id
        ) {
          const studentEmail = event.queryStringParameters.student_email;
          const courseId = event.queryStringParameters.course_id;

          try {
            // Step 1: Get the user ID from the user email
            const userResult = await sqlConnection`
                  SELECT user_id
                  FROM "Users"
                  WHERE user_email = ${studentEmail}
                  LIMIT 1;
              `;

            const userId = userResult[0]?.user_id;

            if (!userId) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "User not found",
              });
              break;
            }

            // Step 2: Query to get the student's messages for a specific course
            const messages = await sqlConnection`
                  SELECT m.message_content, m.time_sent, m.student_sent
                  FROM "Messages" m
                  JOIN "Sessions" s ON m.session_id = s.session_id
                  JOIN "Student_Modules" sm ON s.student_module_id = sm.student_module_id
                  JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
                  WHERE e.user_id = ${userId}  -- Use user_id instead of user_email
                  AND e.course_id = ${courseId}
                  ORDER BY m.time_sent;
              `;

            response.statusCode = 200;
            response.body = JSON.stringify(messages);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "student_email and course_id are required",
          });
        }
        break;
      case "PUT /instructor/generate_access_code":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const courseId = event.queryStringParameters.course_id;

          try {
            // course_access_code is unique across all courses
            // (ux_courses_access_code). A freshly generated code should never
            // collide, but if it does the UPDATE raises a 23505 naming that
            // index — regenerate and retry rather than 500. Bounded attempts; an
            // exhausted-retry collision falls through to the catch as a 500.
            const MAX_ACCESS_CODE_ATTEMPTS = 5;
            let newAccessCode;
            for (let attempt = 1; attempt <= MAX_ACCESS_CODE_ATTEMPTS; attempt++) {
              newAccessCode = generateAccessCode();
              try {
                await sqlConnection`
                  UPDATE "Courses"
                  SET course_access_code = ${newAccessCode}
                  WHERE course_id = ${courseId}
                  RETURNING *;
                `;
                break;
              } catch (err) {
                const isCodeCollision =
                  err.code === "23505" &&
                  err.constraint_name === "ux_courses_access_code";
                if (isCodeCollision && attempt < MAX_ACCESS_CODE_ATTEMPTS) continue;
                throw err;
              }
            }

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: "Access code generated successfully",
              access_code: newAccessCode,
            });
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /instructor/get_access_code":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const courseId = event.queryStringParameters.course_id;

          try {
            // Query to get the access code
            const accessCode = await sqlConnection`
        SELECT course_access_code
        FROM "Courses"
        WHERE course_id = ${courseId};
      `;

            response.statusCode = 200;
            response.body = JSON.stringify(accessCode[0]);
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /instructor/previous_prompts":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.instructor_email
        ) {
          try {
            const { course_id, instructor_email } = event.queryStringParameters;

            // Query to get all previous prompts for the given course and instructor
            const previousPrompts = await sqlConnection`
                    SELECT timestamp, engagement_details AS previous_prompt
                    FROM "User_Engagement_Log"
                    WHERE course_id = ${course_id}
                      AND engagement_type = 'instructor_updated_prompt'
                    ORDER BY timestamp DESC;
                  `;

            response.body = JSON.stringify(previousPrompts);
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body =
            "course_id or instructor_email query parameter is required";
        }
        break;
      case "GET /instructor/student_modules_messages":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.student_email &&
          event.queryStringParameters.course_id
        ) {
          const studentEmail = event.queryStringParameters.student_email;
          const courseId = event.queryStringParameters.course_id;

          try {
            // Step 1: Get the user ID from the student email
            const userResult = await sqlConnection`
                  SELECT user_id
                  FROM "Users"
                  WHERE user_email = ${studentEmail}
                  LIMIT 1;
              `;

            const userId = userResult[0]?.user_id;

            if (!userId) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "Student not found",
              });
              break;
            }

            // OPT-2: Single query for all modules, sessions, and messages (replaces N+1 pattern)
            const rows = await sqlConnection`
              SELECT cm.module_name, cm.module_number, cc.concept_number,
                     s.session_id, s.session_name,
                     m.student_sent, m.message_content, m.time_sent
              FROM "Student_Modules" sm
              JOIN "Course_Modules" cm ON sm.course_module_id = cm.module_id
              JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
              JOIN "Enrolments" e ON sm.enrolment_id = e.enrolment_id
              LEFT JOIN "Sessions" s ON s.student_module_id = sm.student_module_id
              LEFT JOIN "Messages" m ON m.session_id = s.session_id
              WHERE e.user_id = ${userId} AND e.course_id = ${courseId}
              ORDER BY cc.concept_number, cm.module_number, s.session_id, m.time_sent;
            `;

            // Group flat rows into the nested structure the frontend expects
            const result = {};
            for (const row of rows) {
              if (!result[row.module_name]) {
                result[row.module_name] = [];
              }
              if (!row.session_id) continue;

              const moduleArr = result[row.module_name];
              let session = moduleArr.find(s => s._sid === row.session_id);
              if (!session) {
                session = { _sid: row.session_id, sessionName: row.session_name, messages: [] };
                moduleArr.push(session);
              }
              if (row.message_content !== null) {
                session.messages.push({
                  student_sent: row.student_sent,
                  message_content: row.message_content,
                  time_sent: row.time_sent,
                });
              }
            }

            // Remove internal _sid before sending response
            for (const moduleName of Object.keys(result)) {
              result[moduleName] = result[moduleName].map(({ _sid, ...rest }) => rest);
            }

            response.body = JSON.stringify(result);
          } catch (err) {
            console.error(err);
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "student_email and course_id are required",
          });
        }
        break;
      case "GET /instructor/check_notifications_status":
        if (
            event.queryStringParameters != null &&
            event.queryStringParameters.instructor_email &&
            event.queryStringParameters.course_id
        ) {
            const { instructor_email, course_id } = event.queryStringParameters;
    
            try {
                // Query to check the completion status in the chatlogs_notifications table
                const notificationStatus = await sqlConnection`
                    SELECT completion, request_id
                    FROM "chatlogs_notifications"
                    WHERE instructor_email = ${instructor_email} AND course_id = ${course_id}
                    LIMIT 1;
                `;

                // if exists, true or false, button should not be enabled
                if (notificationStatus.length > 0) {
                    response.statusCode = 200;
                    response.body = JSON.stringify({
                      isEnabled: false,
                      completionStatus: notificationStatus[0].completion,
                      requestId: notificationStatus[0].request_id
                    });
                } else {
                  response.statusCode = 200;
                  response.body = JSON.stringify({
                    isEnabled: true,
                    completionStatus: null,
                    requestId: null
                  });
                }
            } catch (err) {
                response.statusCode = 500;
                console.error(err);
                response.body = JSON.stringify({ error: "Internal server error" });
            }
        } else {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "instructor_email and course_id are required." });
        }
        break;
      case "DELETE /instructor/remove_completed_notification":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.instructor_email &&
          event.queryStringParameters.course_id
        ) {
          const { instructor_email, course_id } = event.queryStringParameters;
      
          try {
            // Delete the row from the chatlogs_notifications table
            const deleteResult = await sqlConnection`
              DELETE FROM "chatlogs_notifications"
              WHERE instructor_email = ${instructor_email} AND course_id = ${course_id}
              RETURNING *;
            `;
      
            if (deleteResult.length > 0) {
              response.statusCode = 200;
              response.body = JSON.stringify({ message: "Notification removed successfully." });
            } else {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "No notification found for the given instructor and course." });
            }
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "instructor_email and course_id are required." });
        }
        break;
      case "GET /instructor/course_files":
        if (event.queryStringParameters?.course_id) {
          const { course_id } = event.queryStringParameters;
          try {
            const files = await sqlConnection`
              SELECT
                mf.file_id,
                mf.filename,
                mf.filetype,
                mf.module_id,
                cm.module_name
              FROM "Module_Files" mf
              JOIN "Course_Modules" cm ON mf.module_id = cm.module_id
              JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
              WHERE cc.course_id = ${course_id}
              ORDER BY cm.module_number ASC, mf.filename ASC;
            `;
            response.statusCode = 200;
            response.body = JSON.stringify(files);
          } catch (err) {
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /instructor/module_file_references":
        if (event.queryStringParameters?.module_id) {
          const { module_id } = event.queryStringParameters;
          try {
            const refs = await sqlConnection`
              SELECT referenced_file_id
              FROM "Module_File_References"
              WHERE source_module_id = ${module_id};
            `;
            response.statusCode = 200;
            response.body = JSON.stringify(refs.map(r => r.referenced_file_id));
          } catch (err) {
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "module_id is required" });
        }
        break;
      case "PUT /instructor/module_file_references":
        if (event.queryStringParameters?.module_id) {
          const { module_id } = event.queryStringParameters;
          const { referenced_file_ids } = JSON.parse(event.body || "{}");
          try {
            await sqlConnection`
              DELETE FROM "Module_File_References"
              WHERE source_module_id = ${module_id};
            `;
            if (referenced_file_ids?.length > 0) {
              await Promise.all(
                referenced_file_ids.map(file_id => sqlConnection`
                  INSERT INTO "Module_File_References" (source_module_id, referenced_file_id)
                  VALUES (${module_id}, ${file_id});
                `)
              );
            }
            response.statusCode = 200;
            response.body = JSON.stringify({ message: "Module file references updated successfully" });
          } catch (err) {
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "module_id is required" });
        }
        break;
      case "POST /instructor/validate_prompt":
        if (
          event.queryStringParameters?.course_id &&
          event.queryStringParameters?.instructor_email &&
          event.body
        ) {
          const { course_id, instructor_email } = event.queryStringParameters;
          const { prompt, scope, module_id } = JSON.parse(event.body || "{}");

          if (!scope || !["course", "module"].includes(scope)) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "scope must be 'course' or 'module'" });
            break;
          }

          if (scope === "module" && !module_id) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "module_id required for module scope" });
            break;
          }

          const startTime = Date.now();
          try {
            const conflictReport = await validatePrompt({
              prompt,
              scope,
              course_id,
              module_id,
              sqlConnection,
            });
            console.log(JSON.stringify({
              level: "INFO",
              service: "instructor-function",
              event: "validation_completed",
              course_id,
              scope,
              duration_ms: Date.now() - startTime,
              has_conflicts: conflictReport.has_conflicts,
              conflict_count: conflictReport.conflicts?.length || 0,
              timestamp: new Date().toISOString(),
            }));
            response.statusCode = 200;
            response.body = JSON.stringify(conflictReport);
          } catch (err) {
            console.log(JSON.stringify({
              level: "ERROR",
              service: "instructor-function",
              event: "validation_error",
              course_id,
              scope,
              duration_ms: Date.now() - startTime,
              error: err.message,
              timestamp: new Date().toISOString(),
            }));
            response.statusCode = 200;
            response.body = JSON.stringify({
              validation_status: "validation_failed",
              conflicts: [],
              summary: "Validation is temporarily unavailable. You may save your prompt without validation.",
              has_conflicts: false,
              validated_at: new Date().toISOString(),
              validation_scope: scope,
              model_version: process.env.VALIDATION_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "course_id, instructor_email, and request body are required",
          });
        }
        break;
      case "POST /instructor/generate_topics": {
        const moduleId = event.queryStringParameters?.module_id;
        const result = await generateModuleTopics(moduleId, sqlConnection);
        response.statusCode = result.statusCode;
        response.body = JSON.stringify(result.body);
        break;
      }
      case "GET /instructor/file_processing_statuses":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id
        ) {
          const moduleId = event.queryStringParameters.module_id;

          // Validate UUID format
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(moduleId)) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "module_id must be a valid UUID" });
            break;
          }

          try {
            const files = await sqlConnection`
              SELECT file_id, filename, processing_status, chunk_count, last_processed_at
              FROM "Module_Files"
              WHERE module_id = ${moduleId}
              ORDER BY filename ASC;
            `;

            response.body = JSON.stringify({ files });
          } catch (err) {
            response.statusCode = 500;
            console.error("Error fetching file processing statuses:", err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "module_id is required and must be a valid UUID" });
        }
        break;
      case "POST /instructor/reserve_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const { course_id } = event.queryStringParameters;
          const instructor_email = userEmailAttribute;

          try {
            // Verify instructor is enrolled in the course with instructor role
            const hasAccess = await instructorHasCourseAccess(instructor_email, course_id);

            if (!hasAccess) {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "Forbidden: not enrolled as instructor in this course" });
              break;
            }

            // Insert a draft module record with a server-generated UUID
            const draftModule = await sqlConnection`
              INSERT INTO "Course_Modules" (module_id, concept_id, module_name, module_number, status, created_at, updated_at)
              VALUES (uuid_generate_v4(), NULL, NULL, NULL, 'draft', NOW(), NOW())
              RETURNING module_id, status;
            `;

            response.statusCode = 201;
            response.body = JSON.stringify({
              module_id: draftModule[0].module_id,
              status: draftModule[0].status,
            });
          } catch (err) {
            response.statusCode = 500;
            console.error("Error reserving module:", err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "POST /instructor/finalize_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.concept_id &&
          event.queryStringParameters.module_name &&
          event.queryStringParameters.module_number
        ) {
          const {
            module_id,
            course_id,
            concept_id,
            module_name,
            module_number,
          } = event.queryStringParameters;
          const instructor_email = userEmailAttribute;
          const { module_prompt, key_topics } = JSON.parse(event.body || "{}");

          try {
            // Verify instructor enrollment
            const hasAccess = await instructorHasCourseAccess(instructor_email, course_id);

            if (!hasAccess) {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "Forbidden: not enrolled as instructor in this course" });
              break;
            }

            // Verify the module exists and is a draft
            const draftCheck = await sqlConnection`
              SELECT module_id, status FROM "Course_Modules"
              WHERE module_id = ${module_id} AND status = 'draft';
            `;

            if (draftCheck.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Draft module not found" });
              break;
            }

            // Check for duplicate module name within concept
            const duplicateCheck = await sqlConnection`
              SELECT module_id FROM "Course_Modules"
              WHERE concept_id = ${concept_id}
                AND module_name = ${module_name}
                AND status = 'active';
            `;

            if (duplicateCheck.length > 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "A module with this name already exists in the given concept." });
              break;
            }

            // Check all associated files are in a terminal processing state
            const processingFiles = await sqlConnection`
              SELECT file_id FROM "Module_Files"
              WHERE module_id = ${module_id}
                AND processing_status IN ('pending', 'processing');
            `;

            if (processingFiles.length > 0) {
              response.statusCode = 409;
              response.body = JSON.stringify({ error: "Files are still being processed." });
              break;
            }

            // Update the draft to active with all metadata
            const keyTopicsJson = key_topics ? JSON.stringify(key_topics) : null;
            const finalizedModule = await sqlConnection`
              UPDATE "Course_Modules"
              SET concept_id = ${concept_id},
                  module_name = ${module_name},
                  module_number = ${module_number},
                  module_prompt = ${module_prompt || null},
                  key_topics = ${keyTopicsJson},
                  status = 'active',
                  updated_at = NOW()
              WHERE module_id = ${module_id}
              RETURNING *;
            `;

            // Create Student_Modules for all enrolled students
            const enrolments = await sqlConnection`
              SELECT enrolment_id FROM "Enrolments"
              WHERE course_id = ${course_id};
            `;

            await Promise.all(
              enrolments.map(async (enrolment) => {
                await sqlConnection`
                  INSERT INTO "Student_Modules" (student_module_id, course_module_id, enrolment_id, module_score)
                  VALUES (uuid_generate_v4(), ${module_id}, ${enrolment.enrolment_id}, 0)
                  ON CONFLICT DO NOTHING;
                `;
              })
            );

            // Insert engagement log
            await sqlConnection`
              INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
              VALUES (
                uuid_generate_v4(),
                (SELECT user_id FROM "Users" WHERE user_email = ${instructor_email}),
                ${course_id},
                ${module_id},
                NULL,
                CURRENT_TIMESTAMP,
                'instructor_created_module'
              );
            `;

            response.statusCode = 200;
            response.body = JSON.stringify(finalizedModule[0]);
          } catch (err) {
            response.statusCode = 500;
            console.error("Error finalizing module:", err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "module_id, course_id, concept_id, module_name, and module_number are required",
          });
        }
        break;
      case "POST /instructor/cleanup_module":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.module_id &&
          event.queryStringParameters.course_id
        ) {
          const { module_id, course_id } = event.queryStringParameters;
          const instructor_email = userEmailAttribute;

          try {
            // Verify instructor enrollment
            const hasAccess = await instructorHasCourseAccess(instructor_email, course_id);

            if (!hasAccess) {
              response.statusCode = 403;
              response.body = JSON.stringify({ error: "Forbidden: not enrolled as instructor in this course" });
              break;
            }

            // Verify module status is draft or deleting (idempotent if already deleting)
            const moduleCheck = await sqlConnection`
              SELECT module_id, status FROM "Course_Modules"
              WHERE module_id = ${module_id};
            `;

            if (moduleCheck.length === 0) {
              // Already deleted — idempotent success
              response.statusCode = 200;
              response.body = JSON.stringify({ message: "Module cleaned up successfully" });
              break;
            }

            if (moduleCheck[0].status === 'active') {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: `Cannot cleanup module with status: active` });
              break;
            }

            // Step 1: Set status to 'deleting' to prevent new processing work
            await sqlConnection`
              UPDATE "Course_Modules"
              SET status = 'deleting', updated_at = NOW()
              WHERE module_id = ${module_id};
            `;

            // Step 2: Delete vector embeddings (idempotent — no error if collection missing)
            try {
              const collection = await sqlConnection`
                SELECT uuid FROM langchain_pg_collection WHERE name = ${module_id}::text;
              `;
              if (collection.length > 0) {
                await sqlConnection`
                  DELETE FROM langchain_pg_embedding WHERE collection_id = ${collection[0].uuid};
                `;
                await sqlConnection`
                  DELETE FROM langchain_pg_collection WHERE name = ${module_id}::text;
                `;
              }
            } catch (embeddingErr) {
              console.error("Error deleting embeddings (continuing):", embeddingErr);
            }

            // Step 3: Delete Module_Files records
            await sqlConnection`
              DELETE FROM "Module_Files" WHERE module_id = ${module_id};
            `;

            // Step 4: Delete S3 objects under the module prefix (idempotent)
            if (DATA_INGESTION_BUCKET) {
              try {
                const prefix = `${course_id}/${module_id}/`;
                let continuationToken;
                do {
                  const listParams = {
                    Bucket: DATA_INGESTION_BUCKET,
                    Prefix: prefix,
                    ...(continuationToken && { ContinuationToken: continuationToken }),
                  };
                  const listResult = await s3Client.send(new ListObjectsV2Command(listParams));
                  if (listResult.Contents && listResult.Contents.length > 0) {
                    await s3Client.send(new DeleteObjectsCommand({
                      Bucket: DATA_INGESTION_BUCKET,
                      Delete: {
                        Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })),
                        Quiet: true,
                      },
                    }));
                  }
                  continuationToken = listResult.NextContinuationToken;
                } while (continuationToken);
              } catch (s3Err) {
                console.error("Error deleting S3 objects (continuing):", s3Err);
              }
            }

            // Step 5: Delete the Course_Modules record
            await sqlConnection`
              DELETE FROM "Course_Modules" WHERE module_id = ${module_id};
            `;

            response.statusCode = 200;
            response.body = JSON.stringify({ message: "Module cleaned up successfully" });
          } catch (err) {
            response.statusCode = 500;
            console.error("Error cleaning up module:", err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "module_id and course_id are required" });
        }
        break;
      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    response.statusCode = 400;
    response.body = JSON.stringify(error.message);
  }
  console.log(response);

  return response;
};
