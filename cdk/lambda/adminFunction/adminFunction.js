/**
 * Admin Lambda — Route index:
 *   GET    /admin/instructors
 *   GET    /admin/courses
 *   POST   /admin/enroll_instructor
 *   POST   /admin/create_course
 *   GET    /admin/courseInstructors
 *   GET    /admin/instructorCourses
 *   POST   /admin/updateCourseAccess
 *   POST   /admin/updateInstructorAccess
 *   POST   /admin/duplicate_course
 *   DELETE /admin/delete_instructor_enrolments
 *   DELETE /admin/delete_course_instructor_enrolments
 *   DELETE /admin/unenroll_instructor
 *   DELETE /admin/delete_course
 *   POST   /admin/elevate_instructor
 *   POST   /admin/lower_instructor
 */
const { initializeConnection } = require("./libadmin.js");
const {
  computeRolesAfterElevation,
  computeRolesAfterDemotion,
} = require("./roleHelpers.js");

let { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;

// SQL conneciton from global variable at libadmin.js
let sqlConnectionTableCreator = global.sqlConnectionTableCreator;

exports.handler = async (event) => {
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
  if (!sqlConnectionTableCreator) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnectionTableCreator = global.sqlConnectionTableCreator;
  }

  // Function to format student full names (lowercase and spaces replaced with "_")
  const formatNames = (name) => {
    return name.toLowerCase().replace(/\s+/g, "_");
  };

  let data;
  try {
    const pathData = event.httpMethod + " " + event.resource;
    switch (pathData) {
      case "GET /admin/instructors":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.instructor_email
        ) {
          const { instructor_email } = event.queryStringParameters;

          // SQL query to fetch all users who are instructors
          const instructors = await sqlConnectionTableCreator`
                SELECT user_email, first_name, last_name
                FROM "Users"
                WHERE roles @> ARRAY['instructor']::varchar[]
                ORDER BY last_name ASC;
              `;

          response.body = JSON.stringify(instructors);

          // // Insert into User Engagement Log
          // await sqlConnectionTableCreator`
          //       INSERT INTO "User_Engagement_Log" (log_id, user_email, course_id, module_id, enrolment_id, timestamp, engagement_type)
          //       VALUES (uuid_generate_v4(), ${instructor_email}, null, null, null, CURRENT_TIMESTAMP, 'admin_viewed_instructors')
          //     `;
        } else {
          response.statusCode = 400;
          response.body = "instructor_email is required";
        }
        break;
      case "GET /admin/courses":
        try {
          // Query all courses from Courses table
          const courses = await sqlConnectionTableCreator`
                    SELECT *
                    FROM "Courses"
                    ORDER BY course_department ASC, course_number ASC;
                `;

          response.body = JSON.stringify(courses);
        } catch (err) {
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      case "POST /admin/enroll_instructor":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.instructor_email
        ) {
          try {
            const { course_id, instructor_email } = event.queryStringParameters;

            // Retrieve user_id from Users table
            const userResult = await sqlConnectionTableCreator`
                SELECT user_id
                FROM "Users"
                WHERE user_email = ${instructor_email};
              `;

            const user_id = userResult[0]?.user_id;

            if (!user_id) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "Instructor email not found",
              });
              break;
            }

            // Insert enrollment into Enrolments table with current timestamp
            const enrollment = await sqlConnectionTableCreator`
                INSERT INTO "Enrolments" (enrolment_id, course_id, user_id, enrolment_type, time_enroled)
                VALUES (uuid_generate_v4(), ${course_id}, ${user_id}, 'instructor', CURRENT_TIMESTAMP)
                ON CONFLICT (course_id, user_id) 
                DO UPDATE SET 
                    enrolment_id = EXCLUDED.enrolment_id,
                    enrolment_type = EXCLUDED.enrolment_type,
                    time_enroled = EXCLUDED.time_enroled
                RETURNING enrolment_id;
              `;

            const enrolment_id = enrollment[0]?.enrolment_id;
            console.log(enrolment_id);

            if (enrolment_id) {
              // Retrieve all module IDs for the course
              const modulesResult = await sqlConnectionTableCreator`
                  SELECT module_id
                  FROM "Course_Modules"
                  WHERE concept_id IN (
                      SELECT concept_id
                      FROM "Course_Concepts"
                      WHERE course_id = ${course_id}
                  );
                `;
              console.log(modulesResult);

              // Insert a record into Student_Modules for each module
              const studentModuleInsertions = modulesResult.map((module) => {
                return sqlConnectionTableCreator`
                    INSERT INTO "Student_Modules" (student_module_id, course_module_id, enrolment_id, module_score, last_accessed, module_context_embedding)
                    VALUES (uuid_generate_v4(), ${module.module_id}, ${enrolment_id}, 0, NULL, NULL);
                  `;
              });

              // Execute all insertions
              await Promise.all(studentModuleInsertions);
              console.log(studentModuleInsertions);
            }

            response.body = JSON.stringify({
              message: "Instructor enrolled and modules created successfully.",
            });

            // Optionally insert into User Engagement Log (uncomment if needed)
            // await sqlConnectionTableCreator`
            //   INSERT INTO "User_Engagement_Log" (log_id, user_id, course_id, module_id, enrolment_id, timestamp, engagement_type)
            //   VALUES (uuid_generate_v4(), ${user_id}, ${course_id}, null, ${enrolment_id}, CURRENT_TIMESTAMP, 'enrollment_created');
            // `;
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "course_id and instructor_email are required";
        }
        break;
      case "POST /admin/create_course":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_name &&
          event.queryStringParameters.course_department &&
          event.queryStringParameters.course_number &&
          event.queryStringParameters.course_access_code &&
          event.queryStringParameters.course_student_access &&
          event.body
        ) {
          try {
            console.log("course creation start");
            const {
              course_name,
              course_department,
              course_number,
              course_access_code,
              course_student_access,
            } = event.queryStringParameters;

            const { system_prompt } = JSON.parse(event.body);

            // Insert new course into Courses table
            const newCourse = await sqlConnectionTableCreator`         
                  INSERT INTO "Courses" (
                      course_id,
                      course_name,
                      course_department,
                      course_number,
                      course_access_code,
                      course_student_access,
                      system_prompt
                  )
                  VALUES (
                      uuid_generate_v4(),
                      ${course_name},
                      ${course_department},
                      ${course_number},
                      ${course_access_code},
                      ${course_student_access.toLowerCase() === "true"},
                      ${system_prompt}
                  )
                  RETURNING *;
              `;

            console.log(newCourse);
            response.body = JSON.stringify(newCourse[0]);
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "Missing required parameters";
        }
        break;
      case "POST /admin/duplicate_course":
        // Duplicate a course (backend track B2). Clones the Courses row (with the
        // provided, editable fields + the source's llm_model_id) AND the
        // Course_Concepts -> Course_Modules OUTLINE (metadata only). It does NOT
        // copy Module_Files, pgvector embeddings, enrolments, sessions, or any
        // student progress — the new modules start empty, ready for materials.
        // Only 'active' modules are cloned (skips 'draft'/'deleting'). jsonb
        // columns (key_topics, generated_topics) are copied via INSERT ... SELECT
        // so they never round-trip through JS.
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.source_course_id &&
          event.queryStringParameters.course_name &&
          event.queryStringParameters.course_department &&
          event.queryStringParameters.course_number &&
          event.queryStringParameters.course_access_code &&
          event.queryStringParameters.course_student_access &&
          event.body
        ) {
          try {
            const {
              source_course_id,
              course_name,
              course_department,
              course_number,
              course_access_code,
              course_student_access,
            } = event.queryStringParameters;

            const { system_prompt } = JSON.parse(event.body);

            // 1. Create the new course. INSERT ... SELECT copies llm_model_id
            //    from the source without a round-trip and yields no row when the
            //    source course_id doesn't exist (-> 404).
            const newCourse = await sqlConnectionTableCreator`
                INSERT INTO "Courses" (
                    course_id,
                    course_name,
                    course_department,
                    course_number,
                    course_access_code,
                    course_student_access,
                    system_prompt,
                    llm_model_id
                )
                SELECT
                    uuid_generate_v4(),
                    ${course_name},
                    ${course_department},
                    ${course_number},
                    ${course_access_code},
                    ${course_student_access.toLowerCase() === "true"},
                    ${system_prompt},
                    llm_model_id
                FROM "Courses"
                WHERE course_id = ${source_course_id}
                RETURNING *;
              `;

            if (newCourse.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "Source course not found",
              });
              break;
            }

            const newCourseId = newCourse[0].course_id;

            // 2. Clone the concept -> module outline. Each source concept gets a
            //    fresh id; its active modules are copied under the new concept.
            const concepts = await sqlConnectionTableCreator`
                SELECT concept_id, concept_name, concept_number
                FROM "Course_Concepts"
                WHERE course_id = ${source_course_id};
              `;

            for (const concept of concepts) {
              const newConcept = await sqlConnectionTableCreator`
                  INSERT INTO "Course_Concepts" (concept_id, course_id, concept_name, concept_number)
                  VALUES (uuid_generate_v4(), ${newCourseId}, ${concept.concept_name}, ${concept.concept_number})
                  RETURNING concept_id;
                `;
              const newConceptId = newConcept[0].concept_id;

              await sqlConnectionTableCreator`
                  INSERT INTO "Course_Modules" (
                      module_id, concept_id, module_name, module_number,
                      module_prompt, key_topics, generated_topics,
                      status, created_at, updated_at
                  )
                  SELECT
                      uuid_generate_v4(), ${newConceptId}, module_name, module_number,
                      module_prompt, key_topics, generated_topics,
                      'active', NOW(), NOW()
                  FROM "Course_Modules"
                  WHERE concept_id = ${concept.concept_id} AND status = 'active';
                `;
            }

            response.body = JSON.stringify(newCourse[0]);
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "source_course_id, course_name, course_department, course_number, course_access_code, course_student_access and a JSON body are required",
          });
        }
        break;
      case "GET /admin/courseInstructors":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          const { course_id } = event.queryStringParameters;

          // SQL query to fetch all instructors for a given course. Includes the
          // per-instructor OCELIA access flag (B4) so the detail pane can render
          // each instructor's access toggle.
          const instructors = await sqlConnectionTableCreator`
              SELECT u.user_email, u.first_name, u.last_name, e.access_enabled
              FROM "Enrolments" e
              JOIN "Users" u ON e.user_id = u.user_id
              WHERE e.course_id = ${course_id} AND e.enrolment_type = 'instructor';
            `;

          response.body = JSON.stringify(instructors);
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "course_id is required" });
        }
        break;
      case "GET /admin/instructorCourses":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.instructor_email
        ) {
          const { instructor_email } = event.queryStringParameters;

          // SQL query to fetch all courses for a given instructor. Includes the
          // per-instructor OCELIA access flag (B4) so the detail pane can render
          // each course's access toggle.
          const courses = await sqlConnectionTableCreator`
              SELECT c.course_id, c.course_name, c.course_department, c.course_number, e.access_enabled
              FROM "Enrolments" e
              JOIN "Courses" c ON e.course_id = c.course_id
              JOIN "Users" u ON e.user_id = u.user_id
              WHERE u.user_email = ${instructor_email} AND e.enrolment_type = 'instructor';
            `;

          response.body = JSON.stringify(courses);
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "instructor_email is required",
          });
        }
        break;
      case "POST /admin/updateCourseAccess":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.access
        ) {
          const { course_id, access } = event.queryStringParameters;
          const accessBool = access.toLowerCase() === "true";

          // SQL query to update course access
          await sqlConnectionTableCreator`
                    UPDATE "Courses"
                    SET course_student_access = ${accessBool}
                    WHERE course_id = ${course_id};
                  `;

          response.body = JSON.stringify({
            message: "Course access updated successfully.",
          });
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "course_id and access query parameters are required",
          });
        }
        break;
      case "POST /admin/updateInstructorAccess":
        // Flip the per-instructor OCELIA access flag (B4) on one instructor's
        // enrolment in one course. Scoped to enrolment_type='instructor' so it
        // never touches a student enrolment, and it leaves every other
        // instructor's flag on the course untouched.
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.instructor_email &&
          event.queryStringParameters.access
        ) {
          try {
            const { course_id, instructor_email, access } =
              event.queryStringParameters;
            const accessBool = access.toLowerCase() === "true";

            // Resolve the instructor's user_id from their email.
            const userResult = await sqlConnectionTableCreator`
                SELECT user_id
                FROM "Users"
                WHERE user_email = ${instructor_email};
              `;
            const user_id = userResult[0]?.user_id;

            if (!user_id) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "Instructor email not found",
              });
              break;
            }

            const updated = await sqlConnectionTableCreator`
                UPDATE "Enrolments"
                SET access_enabled = ${accessBool}
                WHERE course_id = ${course_id}
                  AND user_id = ${user_id}
                  AND enrolment_type = 'instructor'
                RETURNING enrolment_id, access_enabled;
              `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "Instructor is not enrolled in this course",
              });
              break;
            }

            response.body = JSON.stringify({
              message: "Instructor access updated successfully.",
              access_enabled: updated[0].access_enabled,
            });
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "course_id, instructor_email and access query parameters are required",
          });
        }
        break;
      case "DELETE /admin/delete_instructor_enrolments":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.instructor_email
        ) {
          try {
            const { instructor_email } = event.queryStringParameters;

            // Retrieve the user's ID
            const userResult = await sqlConnectionTableCreator`
                        SELECT user_id 
                        FROM "Users"
                        WHERE user_email = ${instructor_email};
                    `;

            const userId = userResult[0]?.user_id;

            if (!userId) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Instructor not found" });
              return;
            }

            // Delete all enrolments for the instructor
            await sqlConnectionTableCreator`
                        DELETE FROM "Enrolments"
                        WHERE user_id = ${userId} AND enrolment_type = 'instructor';
                    `;

            response.body = JSON.stringify({
              message: "Instructor enrolments deleted successfully.",
            });
          } catch (err) {
            await sqlConnectionTableCreator.rollback();
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "instructor_email query parameter is required";
        }
        break;
      case "DELETE /admin/delete_course_instructor_enrolments":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          try {
            const { course_id } = event.queryStringParameters;

            // Delete all enrolments for the course where enrolment_type is 'instructor'
            await sqlConnectionTableCreator`
                      DELETE FROM "Enrolments"
                      WHERE course_id = ${course_id} AND enrolment_type = 'instructor';
                  `;

            response.body = JSON.stringify({
              message: "Course instructor enrolments deleted successfully.",
            });
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "course_id query parameter is required";
        }
        break;
      case "DELETE /admin/unenroll_instructor":
        // Remove ONE instructor's enrolment from ONE course (single pair) —
        // unlike delete_course_instructor_enrolments (all instructors on a
        // course) and delete_instructor_enrolments (all courses for an
        // instructor). Used by the detail-pane per-row Remove so other
        // instructors' access flags are left untouched. The FK cascade cleans up
        // this enrolment's Student_Modules.
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id &&
          event.queryStringParameters.instructor_email
        ) {
          try {
            const { course_id, instructor_email } = event.queryStringParameters;

            const userResult = await sqlConnectionTableCreator`
                SELECT user_id
                FROM "Users"
                WHERE user_email = ${instructor_email};
              `;
            const user_id = userResult[0]?.user_id;

            if (!user_id) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "Instructor email not found",
              });
              break;
            }

            await sqlConnectionTableCreator`
                DELETE FROM "Enrolments"
                WHERE course_id = ${course_id}
                  AND user_id = ${user_id}
                  AND enrolment_type = 'instructor';
              `;

            response.body = JSON.stringify({
              message: "Instructor unenrolled from course successfully.",
            });
          } catch (err) {
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "course_id and instructor_email query parameters are required",
          });
        }
        break;
      case "DELETE /admin/delete_course":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.course_id
        ) {
          try {
            const { course_id } = event.queryStringParameters;

            // // Drop the table whose name is the course_id
            // await sqlConnectionTableCreator`
            //   DROP TABLE IF EXISTS ${sqlConnectionTableCreator(course_id)};
            // `;

            // Delete the course, related records will be automatically deleted due to cascading
            await sqlConnectionTableCreator`
                      DELETE FROM "Courses"
                      WHERE course_id = ${course_id};
                  `;

            response.body = JSON.stringify({
              message: "Course and related records deleted successfully.",
            });
          } catch (err) {
            await sqlConnection.rollback();
            response.statusCode = 500;
            console.log(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "course_id query parameter is required";
        }
        break;
      case "POST /admin/elevate_instructor":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.email
        ) {
          const instructorEmail = event.queryStringParameters.email;

          try {
            // Check if the user exists
            const existingUser = await sqlConnectionTableCreator`
                          SELECT * FROM "Users"
                          WHERE user_email = ${instructorEmail};
                      `;

            if (existingUser.length > 0) {
              const userRoles = existingUser[0].roles;

              // Add the instructor role additively: an admin keeps admin and
              // also becomes an instructor; a student is converted; an existing
              // instructor is a no-op.
              const newRoles = computeRolesAfterElevation(userRoles);

              if (newRoles === null) {
                response.statusCode = 200;
                response.body = JSON.stringify({
                  message: "No changes made. User is already an instructor.",
                });
                break;
              }

              await sqlConnectionTableCreator`
                              UPDATE "Users"
                              SET roles = ${newRoles}
                              WHERE user_email = ${instructorEmail};
                          `;

              response.statusCode = 200;
              response.body = JSON.stringify({
                message: "User role updated to instructor.",
              });
              break;
            } else {
              // Create a new user with the role 'instructor'
              await sqlConnectionTableCreator`
                              INSERT INTO "Users" (user_email, roles)
                              VALUES (${instructorEmail}, ARRAY['instructor']);
                          `;

              response.statusCode = 201;
              response.body = JSON.stringify({
                message: "New user created and elevated to instructor.",
              });
            }
          } catch (err) {
            response.statusCode = 500;
            console.error(err);
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Email is required" });
        }
        break;
      case "POST /admin/lower_instructor":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.email
        ) {
          try {
            const userEmail = event.queryStringParameters.email;

            // Fetch the roles for the user
            const userRoleData = await sqlConnectionTableCreator`
                    SELECT roles, user_id
                    FROM "Users"
                    WHERE user_email = ${userEmail};
                  `;

            const userRoles = userRoleData[0]?.roles;
            const userId = userRoleData[0]?.user_id;

            if (!userRoles || !userRoles.includes("instructor")) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "User is not an instructor or doesn't exist",
              });
              break;
            }

            // Remove the instructor role while preserving any other roles
            // (an admin stays an admin); fall back to student only if that
            // would otherwise leave the user with no roles.
            const updatedRoles = computeRolesAfterDemotion(userRoles);

            // Update the roles in the database
            await sqlConnectionTableCreator`
                    UPDATE "Users"
                    SET roles = ${updatedRoles}
                    WHERE user_email = ${userEmail};
                  `;

            // Delete all enrolments where the enrolment type is instructor
            await sqlConnectionTableCreator`
                    DELETE FROM "Enrolments"
                    WHERE user_id = ${userId} AND enrolment_type = 'instructor';
                  `;

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: `Instructor role removed for ${userEmail} and all instructor enrolments deleted.`,
            });
          } catch (err) {
            console.log(err);
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "email query parameter is missing",
          });
        }
        break;

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    response.statusCode = 400;
    console.log(error);
    response.body = JSON.stringify(error.message);
  }
  console.log(response);
  return response;
};
