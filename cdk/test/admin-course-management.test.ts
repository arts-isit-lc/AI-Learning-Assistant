import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for the admin course-management backend tracks:
 *   - B4: per-instructor OCELIA access flag (Enrolments.access_enabled)
 *         → GET reads (courseInstructors / instructorCourses) return the flag,
 *           POST /admin/updateInstructorAccess writes it.
 *   - B2: POST /admin/duplicate_course (clones the course + concept/module outline).
 *   - Supporting: DELETE /admin/unenroll_instructor (single-pair removal).
 *
 * (a) OpenAPI contract tests — routes are inlined into the SpecRestApi via an
 *     AWS::Include macro, so they are NOT visible to Template.fromStack(); we
 *     parse the OpenAPI YAML directly and assert path/verb/params/security/uri.
 * (b) Handler unit tests — exercise adminFunction.js with a mocked `sql` tagged
 *     template (deterministic; no DB, no AWS creds, no network).
 * (c) Migration guard — asserts the idempotent access_enabled column migration
 *     is present in initializer.py.
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract tests
// ---------------------------------------------------------------------------
describe("OpenAPI contract: admin course-management routes", () => {
  const spec = parseYaml(
    fs.readFileSync(path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"), "utf8")
  );

  const adminUri =
    'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${adminFunction.Arn}/invocations';

  it("POST /admin/updateInstructorAccess: query params + adminAuthorizer + adminFunction proxy", () => {
    const route = spec.paths["/admin/updateInstructorAccess"];
    expect(route).toBeDefined();
    expect(route.post).toBeDefined();
    expect(route.options).toBeDefined();

    const byName = Object.fromEntries(route.post.parameters.map((p: any) => [p.name, p]));
    for (const name of ["course_id", "instructor_email", "access"]) {
      expect(byName[name]).toBeDefined();
      expect(byName[name].in).toBe("query");
      expect(byName[name].required).toBe(true);
    }
    expect(route.post.security).toEqual([{ adminAuthorizer: [] }]);
    const integration = route.post["x-amazon-apigateway-integration"];
    expect(integration.type).toBe("aws_proxy");
    expect(integration.uri["Fn::Sub"]).toBe(adminUri);
  });

  it("POST /admin/duplicate_course: source + course fields (query) + system_prompt (body) + adminAuthorizer", () => {
    const route = spec.paths["/admin/duplicate_course"];
    expect(route).toBeDefined();
    expect(route.post).toBeDefined();
    expect(route.options).toBeDefined();

    const byName = Object.fromEntries(route.post.parameters.map((p: any) => [p.name, p]));
    for (const name of [
      "source_course_id",
      "course_name",
      "course_department",
      "course_number",
      "course_access_code",
      "course_student_access",
    ]) {
      expect(byName[name]).toBeDefined();
      expect(byName[name].in).toBe("query");
      expect(byName[name].required).toBe(true);
    }
    // system_prompt travels in the JSON body (like create_course).
    expect(
      route.post.requestBody.content["application/json"].schema.properties.system_prompt
    ).toBeDefined();
    expect(route.post.security).toEqual([{ adminAuthorizer: [] }]);
    expect(route.post["x-amazon-apigateway-integration"].uri["Fn::Sub"]).toBe(adminUri);
  });

  it("POST /admin/duplicate_course: optional `term` query param (source term kept when omitted)", () => {
    const route = spec.paths["/admin/duplicate_course"];
    const byName = Object.fromEntries(route.post.parameters.map((p: any) => [p.name, p]));
    expect(byName["term"]).toBeDefined();
    expect(byName["term"].in).toBe("query");
    // Optional, unlike create_course's required term — omitting it preserves the
    // source course's term server-side (COALESCE).
    expect(byName["term"].required).toBe(false);
    expect(byName["term"].schema.type).toBe("string");
  });

  it("POST /admin/create_course: required `term` query param (+ course fields, system_prompt body, adminAuthorizer)", () => {
    const route = spec.paths["/admin/create_course"];
    expect(route).toBeDefined();
    expect(route.post).toBeDefined();
    expect(route.options).toBeDefined();

    const byName = Object.fromEntries(route.post.parameters.map((p: any) => [p.name, p]));
    for (const name of [
      "course_name",
      "course_department",
      "course_number",
      "course_access_code",
      "course_student_access",
      "term",
    ]) {
      expect(byName[name]).toBeDefined();
      expect(byName[name].in).toBe("query");
      expect(byName[name].required).toBe(true);
    }
    expect(byName["term"].schema.type).toBe("string");
    // section is an OPTIONAL free-text query param, unlike the required term.
    expect(byName["section"]).toBeDefined();
    expect(byName["section"].in).toBe("query");
    expect(byName["section"].required).toBe(false);
    expect(byName["section"].schema.type).toBe("string");
    // system_prompt still travels in the JSON body.
    expect(
      route.post.requestBody.content["application/json"].schema.properties.system_prompt
    ).toBeDefined();
    expect(route.post.security).toEqual([{ adminAuthorizer: [] }]);
    expect(route.post["x-amazon-apigateway-integration"].uri["Fn::Sub"]).toBe(adminUri);
  });

  it("POST /admin/create_course: declares a 409 conflict response (identity uniqueness)", () => {
    const route = spec.paths["/admin/create_course"];
    expect(route.post.responses["409"]).toBeDefined();
  });

  it("POST /admin/duplicate_course: optional `section` query param (source section kept when omitted)", () => {
    const route = spec.paths["/admin/duplicate_course"];
    const byName = Object.fromEntries(route.post.parameters.map((p: any) => [p.name, p]));
    expect(byName["section"]).toBeDefined();
    expect(byName["section"].in).toBe("query");
    // Optional, like duplicate's term — omitting it preserves the source's section.
    expect(byName["section"].required).toBe(false);
    expect(byName["section"].schema.type).toBe("string");
  });

  it("POST /admin/duplicate_course: declares a 409 conflict response (identity uniqueness)", () => {
    const route = spec.paths["/admin/duplicate_course"];
    expect(route.post.responses["409"]).toBeDefined();
  });

  it("DELETE /admin/unenroll_instructor: course_id + instructor_email (query) + adminAuthorizer", () => {
    const route = spec.paths["/admin/unenroll_instructor"];
    expect(route).toBeDefined();
    expect(route.delete).toBeDefined();
    expect(route.options).toBeDefined();

    const byName = Object.fromEntries(route.delete.parameters.map((p: any) => [p.name, p]));
    for (const name of ["course_id", "instructor_email"]) {
      expect(byName[name]).toBeDefined();
      expect(byName[name].in).toBe("query");
      expect(byName[name].required).toBe(true);
    }
    expect(route.delete.security).toEqual([{ adminAuthorizer: [] }]);
    expect(route.delete["x-amazon-apigateway-integration"].uri["Fn::Sub"]).toBe(adminUri);
  });
});

// ---------------------------------------------------------------------------
// (c) Migration guard
// ---------------------------------------------------------------------------
describe("initializer.py migration: Enrolments.access_enabled", () => {
  const initializer = fs.readFileSync(
    path.join(__dirname, "..", "lambda", "initializer", "initializer.py"),
    "utf8"
  );

  it("declares access_enabled in the Enrolments CREATE TABLE (NOT NULL DEFAULT true)", () => {
    expect(initializer).toContain('"access_enabled" boolean NOT NULL DEFAULT true');
  });

  it("adds an idempotent ADD COLUMN IF NOT EXISTS migration for existing databases", () => {
    expect(initializer).toContain(
      'ALTER TABLE "Enrolments" ADD COLUMN IF NOT EXISTS "access_enabled" boolean NOT NULL DEFAULT true;'
    );
  });
});

describe("initializer.py migration: Courses.term", () => {
  const initializer = fs.readFileSync(
    path.join(__dirname, "..", "lambda", "initializer", "initializer.py"),
    "utf8"
  );

  it("declares term in the Courses CREATE TABLE (varchar)", () => {
    expect(initializer).toContain('"term" varchar');
  });

  it("adds an idempotent nullable ADD COLUMN IF NOT EXISTS migration for existing databases", () => {
    expect(initializer).toContain('ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "term" varchar;');
  });
});

describe("initializer.py migration: Courses.section (nullable)", () => {
  const initializer = fs.readFileSync(
    path.join(__dirname, "..", "lambda", "initializer", "initializer.py"),
    "utf8"
  );

  it("declares section in the Courses CREATE TABLE (varchar)", () => {
    expect(initializer).toContain('"section" varchar');
  });

  it("adds an idempotent nullable ADD COLUMN IF NOT EXISTS migration for existing databases", () => {
    expect(initializer).toContain('ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "section" varchar;');
  });
});

describe("initializer.py migration: Courses identity unique index", () => {
  const initializer = fs.readFileSync(
    path.join(__dirname, "..", "lambda", "initializer", "initializer.py"),
    "utf8"
  );

  it("declares a unique index ux_courses_identity on Courses (idempotent)", () => {
    expect(initializer).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_identity");
    expect(initializer).toContain('ON "Courses" (');
  });

  it("normalizes text fields (lower + btrim) and matches course_number exactly", () => {
    expect(initializer).toContain("lower(btrim(course_name))");
    expect(initializer).toContain("lower(btrim(course_department))");
    // course_number is integer — compared exactly (no lower/btrim wrapping it).
    expect(initializer).toMatch(/lower\(btrim\(course_department\)\),\s*course_number,/);
  });

  it("coalesces nullable term & section to '' so 'no term/section' is one identity", () => {
    // A plain unique index treats NULLs as distinct; coalescing to '' makes two
    // courses that both lack a term/section collide (the intended behavior).
    expect(initializer).toContain("lower(btrim(coalesce(term, '')))");
    expect(initializer).toContain("lower(btrim(coalesce(section, '')))");
  });

  it("builds the index after the term & section ADD COLUMN backfills (columns must exist first)", () => {
    const termMigration = initializer.indexOf(
      'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "term" varchar'
    );
    const sectionMigration = initializer.indexOf(
      'ALTER TABLE "Courses" ADD COLUMN IF NOT EXISTS "section" varchar'
    );
    const indexPos = initializer.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_identity");
    expect(termMigration).toBeGreaterThan(-1);
    expect(sectionMigration).toBeGreaterThan(-1);
    expect(indexPos).toBeGreaterThan(termMigration);
    expect(indexPos).toBeGreaterThan(sectionMigration);
  });
});

// ---------------------------------------------------------------------------
// (b) Handler unit tests
// ---------------------------------------------------------------------------

/** A fake `sql` tagged template that queues per-call results and records the
 * SQL text of each call. Named `mockSql` so it can be referenced inside the
 * jest.mock factory (jest allows out-of-scope vars prefixed with `mock`). */
type FakeSql = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  queueResult: (rows: any[]) => FakeSql;
  queueError: (err: any) => FakeSql;
  calls: string[];
  reset: () => void;
};

function makeFakeSql(): FakeSql {
  // Each queued item is either a rows result or an error to reject with (used to
  // simulate a Postgres unique_violation, code 23505, on the identity index).
  const queue: Array<{ rows: any[] } | { error: any }> = [];
  const calls: string[] = [];
  const fn = ((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    const next = queue.shift();
    if (next && "error" in next) return Promise.reject(next.error);
    return Promise.resolve(next ? next.rows : []);
  }) as FakeSql;
  fn.queueResult = (rows: any[]) => {
    queue.push({ rows });
    return fn;
  };
  fn.queueError = (err: any) => {
    queue.push({ error: err });
    return fn;
  };
  fn.calls = calls;
  fn.reset = () => {
    queue.length = 0;
    calls.length = 0;
  };
  return fn;
}

const mockSql = makeFakeSql();

jest.mock("../lambda/adminFunction/libadmin.js", () => ({
  initializeConnection: jest.fn(async () => {
    (global as any).sqlConnectionTableCreator = mockSql;
  }),
}));

// duplicate_course copies files via @aws-sdk/client-s3. The SDK is provided by
// the Lambda runtime (not a repo dependency), so it is not resolvable in tests
// — mock it virtually. `mockS3Send` lets individual tests make CopyObject
// succeed or fail. Prefixed `mock*` so jest allows it inside the factory.
const mockS3Send = jest.fn();
jest.mock(
  "@aws-sdk/client-s3",
  () => ({
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    CopyObjectCommand: jest.fn((input) => ({ __type: "CopyObjectCommand", input })),
  }),
  { virtual: true }
);

// Ensure the handler's module-level capture picks up the mock at require time.
(global as any).sqlConnectionTableCreator = mockSql;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lambda/adminFunction/adminFunction.js");

function makeEvent(
  httpMethod: string,
  resource: string,
  queryStringParameters: Record<string, string> | null,
  body: string | null = null
) {
  return {
    httpMethod,
    resource,
    queryStringParameters,
    body,
    requestContext: { authorizer: { email: "admin@example.com" } },
  } as any;
}

describe("adminFunction — POST /admin/updateInstructorAccess (B4 write)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnectionTableCreator = mockSql;
  });

  it("200: flips access_enabled on the instructor's enrolment (scoped to Enrolments)", async () => {
    mockSql
      .queueResult([{ user_id: "u1" }]) // user lookup
      .queueResult([{ enrolment_id: "e1", access_enabled: false }]); // update RETURNING

    const res = await handler(
      makeEvent("POST", "/admin/updateInstructorAccess", {
        course_id: "course-1",
        instructor_email: "ada@x.com",
        access: "false",
      })
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).access_enabled).toBe(false);
    const updateSql = mockSql.calls[1];
    expect(updateSql).toContain('UPDATE "Enrolments"');
    expect(updateSql).toContain("access_enabled");
    expect(updateSql).toContain("enrolment_type = 'instructor'");
  });

  it("404: when the instructor email is unknown (stops after the user lookup)", async () => {
    mockSql.queueResult([]); // empty user lookup
    const res = await handler(
      makeEvent("POST", "/admin/updateInstructorAccess", {
        course_id: "course-1",
        instructor_email: "nobody@x.com",
        access: "true",
      })
    );
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(1);
  });

  it("404: when the instructor is not enrolled in the course (empty update)", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult([]); // user found, update matched nothing
    const res = await handler(
      makeEvent("POST", "/admin/updateInstructorAccess", {
        course_id: "course-1",
        instructor_email: "ada@x.com",
        access: "true",
      })
    );
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(2);
  });

  it("400: when a required query param is missing (no DB access)", async () => {
    const res = await handler(
      makeEvent("POST", "/admin/updateInstructorAccess", {
        course_id: "course-1",
        instructor_email: "ada@x.com",
      }) // no access
    );
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
});

describe("adminFunction — GET reads return access_enabled (B4 read)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnectionTableCreator = mockSql;
  });

  it("courseInstructors: selects and returns e.access_enabled", async () => {
    mockSql.queueResult([
      { user_email: "ada@x.com", first_name: "Ada", last_name: "L", access_enabled: true },
    ]);
    const res = await handler(
      makeEvent("GET", "/admin/courseInstructors", { course_id: "course-1" })
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)[0].access_enabled).toBe(true);
    expect(mockSql.calls[0]).toContain("access_enabled");
  });

  it("instructorCourses: selects and returns e.access_enabled", async () => {
    mockSql.queueResult([
      { course_id: "c1", course_name: "Intro", course_department: "GEOG", course_number: 250, access_enabled: false },
    ]);
    const res = await handler(
      makeEvent("GET", "/admin/instructorCourses", { instructor_email: "ada@x.com" })
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)[0].access_enabled).toBe(false);
    expect(mockSql.calls[0]).toContain("access_enabled");
  });
});

describe("adminFunction — DELETE /admin/unenroll_instructor", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnectionTableCreator = mockSql;
  });

  it("200: deletes only this instructor's enrolment in this course", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult([]); // user lookup, delete
    const res = await handler(
      makeEvent("DELETE", "/admin/unenroll_instructor", {
        course_id: "course-1",
        instructor_email: "ada@x.com",
      })
    );
    expect(res.statusCode).toBe(200);
    const deleteSql = mockSql.calls[1];
    expect(deleteSql).toContain('DELETE FROM "Enrolments"');
    expect(deleteSql).toContain("enrolment_type = 'instructor'");
  });

  it("404: when the instructor email is unknown", async () => {
    mockSql.queueResult([]);
    const res = await handler(
      makeEvent("DELETE", "/admin/unenroll_instructor", {
        course_id: "course-1",
        instructor_email: "nobody@x.com",
      })
    );
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(1);
  });

  it("400: when a required query param is missing (no DB access)", async () => {
    const res = await handler(
      makeEvent("DELETE", "/admin/unenroll_instructor", { course_id: "course-1" })
    );
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
});

describe("adminFunction — POST /admin/duplicate_course (B2)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnectionTableCreator = mockSql;
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({}); // CopyObject succeeds by default
  });

  const VALID_QS = {
    source_course_id: "src-1",
    course_name: "Intro Geography (copy)",
    course_department: "GEOG",
    course_number: "250",
    course_access_code: "ABCD-EFGH-IJKL-MNOP",
    course_student_access: "true",
  };
  const BODY = JSON.stringify({ system_prompt: "You are a tutor." });

  // Queue the DB results for a course with ONE concept -> ONE module -> ONE
  // file -> ONE cross-module reference, in the handler's call order.
  const queueOneOfEach = () => {
    mockSql
      .queueResult([{ course_id: "new-course", course_name: "Intro Geography (copy)" }]) // 1 INSERT Courses RETURNING *
      .queueResult([{ concept_id: "c1", concept_name: "Basics", concept_number: 1 }]) // 2 source concepts
      .queueResult([{ concept_id: "new-c1" }]) // 3 INSERT concept RETURNING
      .queueResult([{ module_id: "m1" }]) // 4 SELECT source module_ids for concept
      .queueResult([{ module_id: "new-m1" }]) // 5 INSERT...SELECT module RETURNING module_id
      .queueResult([
        { file_id: "f1", module_id: "m1", filetype: "pdf", filepath: "courses/src-1/m1/f1.pdf", filename: "lecture" },
      ]) // 6 SELECT source files
      .queueResult([]) // 7 INSERT...SELECT Module_Files
      .queueResult([{ source_module_id: "m1", referenced_file_id: "f1" }]) // 8 SELECT references
      .queueResult([]); // 9 INSERT reference
  };

  it("200: clones the course, module outline, files (S3 copy) and cross-module references", async () => {
    queueOneOfEach();

    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.course_id).toBe("new-course");
    // Best-effort file-copy summary: one file copied, none failed, one ref copied.
    expect(body.file_copy).toEqual({ copied: 1, failed: [], references_copied: 1 });

    const joined = mockSql.calls.join(" ; ");
    expect(joined).toContain('INSERT INTO "Courses"');
    expect(joined).toContain('FROM "Courses"'); // INSERT...SELECT copies llm_model_id
    expect(joined).toContain('INSERT INTO "Course_Concepts"');
    // Module clone: per-module INSERT...SELECT with RETURNING (to map old->new id),
    // jsonb kept in-DB, active-only.
    const moduleInsert = mockSql.calls[4];
    expect(moduleInsert).toContain('INSERT INTO "Course_Modules"');
    expect(moduleInsert).toContain("key_topics");
    expect(moduleInsert).toContain("RETURNING module_id");
    // Files: raw S3 object copied, then a Module_Files row inserted (pending) via
    // INSERT...SELECT so metadata jsonb is copied in-DB.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(joined).toContain('INSERT INTO "Module_Files"');
    expect(joined).toContain("'pending'");
    // Cross-module references remapped onto the new module + new file.
    expect(joined).toContain('INSERT INTO "Module_File_References"');
  });

  it("200: a file that fails to copy after retries is skipped and reported (best-effort)", async () => {
    mockS3Send.mockRejectedValue(new Error("s3 down")); // all CopyObject attempts fail
    mockSql
      .queueResult([{ course_id: "new-course" }]) // 1 INSERT Courses
      .queueResult([{ concept_id: "c1", concept_name: "Basics", concept_number: 1 }]) // 2 concepts
      .queueResult([{ concept_id: "new-c1" }]) // 3 INSERT concept
      .queueResult([{ module_id: "m1" }]) // 4 SELECT module_ids
      .queueResult([{ module_id: "new-m1" }]) // 5 INSERT module
      .queueResult([
        { file_id: "f1", module_id: "m1", filetype: "pdf", filepath: "courses/src-1/m1/f1.pdf", filename: "lecture" },
      ]) // 6 SELECT files
      // NO Module_Files insert (copy failed) -> next call is the references SELECT
      .queueResult([{ source_module_id: "m1", referenced_file_id: "f1" }]); // 7 SELECT references

    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.file_copy.copied).toBe(0);
    expect(body.file_copy.failed).toEqual([{ file_id: "f1", filename: "lecture", filetype: "pdf" }]);
    // Reference is skipped because its target file was not copied.
    expect(body.file_copy.references_copied).toBe(0);
    // 3 CopyObject attempts, then give up; no Module_Files / reference inserts.
    expect(mockS3Send).toHaveBeenCalledTimes(3);
    const joined = mockSql.calls.join(" ; ");
    expect(joined).not.toContain('INSERT INTO "Module_Files"');
    expect(joined).not.toContain('INSERT INTO "Module_File_References"');
  });

  it("404: when the source course does not exist (INSERT...SELECT returns no row)", async () => {
    mockSql.queueResult([]); // empty INSERT...SELECT
    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(1); // stops before cloning concepts
  });

  it("200: a course with no concepts clones just the course row", async () => {
    mockSql
      .queueResult([{ course_id: "new-course" }]) // course insert
      .queueResult([]); // no concepts
    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls).toHaveLength(2);
  });

  it("400: when source_course_id is missing (no DB access)", async () => {
    const { source_course_id, ...rest } = VALID_QS;
    const res = await handler(makeEvent("POST", "/admin/duplicate_course", rest, BODY));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("400: when the JSON body is missing (no DB access)", async () => {
    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, null));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("200: threads an optional term through the course INSERT via COALESCE(term, source)", async () => {
    mockSql
      .queueResult([{ course_id: "new-course" }]) // INSERT...SELECT Courses RETURNING *
      .queueResult([]); // no concepts (stops after the course row)
    const res = await handler(
      makeEvent(
        "POST",
        "/admin/duplicate_course",
        { ...VALID_QS, term: "2026 Winter Term 2" },
        BODY
      )
    );
    expect(res.statusCode).toBe(200);
    const courseInsert = mockSql.calls[0];
    expect(courseInsert).toContain('INSERT INTO "Courses"');
    // The edited term overrides the source's; omitting it (as the course-detail
    // dialog does) binds NULL so COALESCE keeps the source term.
    expect(courseInsert).toContain("COALESCE(?, term)");
  });

  it("200: omitting term still succeeds (source term preserved) — no COALESCE param error", async () => {
    mockSql.queueResult([{ course_id: "new-course" }]).queueResult([]);
    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls[0]).toContain("COALESCE(?, term)");
  });

  it("200: threads the optional section through the INSERT...SELECT via COALESCE(section, source)", async () => {
    mockSql
      .queueResult([{ course_id: "new-course" }]) // INSERT...SELECT Courses RETURNING *
      .queueResult([]); // no concepts (stops after the course row)
    const res = await handler(
      makeEvent("POST", "/admin/duplicate_course", { ...VALID_QS, section: "002" }, BODY)
    );
    expect(res.statusCode).toBe(200);
    const courseInsert = mockSql.calls[0];
    expect(courseInsert).toContain('INSERT INTO "Courses"');
    expect(courseInsert).toContain("section");
    // An edited section overrides the source's; omitting it (the course-detail
    // dialog) binds NULL so COALESCE keeps the source section.
    expect(courseInsert).toContain("COALESCE(?, section)");
  });

  it("409: maps a unique_violation (23505) on the duplicate INSERT to a conflict", async () => {
    mockSql.queueError({ code: "23505" }); // INSERT...SELECT trips ux_courses_identity
    const res = await handler(makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/already exists/i);
    // The failed INSERT...SELECT is the only call — no concept/module cloning.
    expect(mockSql.calls).toHaveLength(1);
  });
});

describe("adminFunction — POST /admin/create_course (term)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnectionTableCreator = mockSql;
  });

  const VALID_QS = {
    course_name: "Intro Geography",
    course_department: "GEOG",
    course_number: "250",
    course_access_code: "ABCD-EFGH-IJKL-MNOP",
    course_student_access: "true",
    term: "2026 Winter Term 2",
  };
  const BODY = JSON.stringify({ system_prompt: "You are a tutor." });

  it("200: inserts the course with the term column in the INSERT", async () => {
    mockSql
      .queueResult([]) // uniqueness pre-check: no existing course
      .queueResult([{ course_id: "new-course", term: "2026 Winter Term 2" }]); // INSERT
    const res = await handler(makeEvent("POST", "/admin/create_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).course_id).toBe("new-course");
    // calls[0] is the identity pre-check SELECT; the INSERT is calls[1].
    const insertSql = mockSql.calls[1];
    expect(insertSql).toContain('INSERT INTO "Courses"');
    expect(insertSql).toContain("term");
  });

  it("400: when the required term query param is missing (no DB access)", async () => {
    const { term, ...rest } = VALID_QS;
    const res = await handler(makeEvent("POST", "/admin/create_course", rest, BODY));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("200: includes the optional section column in the INSERT when provided", async () => {
    mockSql
      .queueResult([]) // uniqueness pre-check: no existing course
      .queueResult([{ course_id: "new-course", section: "001" }]); // INSERT
    const res = await handler(
      makeEvent("POST", "/admin/create_course", { ...VALID_QS, section: "001" }, BODY)
    );
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls[1]).toContain("section");
  });

  it("200: section is OPTIONAL — creates the course even when section is omitted", async () => {
    mockSql
      .queueResult([]) // uniqueness pre-check: no existing course
      .queueResult([{ course_id: "new-course" }]); // INSERT
    const res = await handler(makeEvent("POST", "/admin/create_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).course_id).toBe("new-course");
    // The column is still in the INSERT (bound to NULL when omitted).
    expect(mockSql.calls[1]).toContain("section");
  });

  it("409: rejects a duplicate identity via the pre-check (no INSERT attempted)", async () => {
    mockSql.queueResult([{ course_id: "existing" }]); // pre-check finds a clash
    const res = await handler(makeEvent("POST", "/admin/create_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/already exists/i);
    // Only the identity pre-check ran; the INSERT was never reached.
    expect(mockSql.calls).toHaveLength(1);
    expect(mockSql.calls[0]).toContain('SELECT course_id FROM "Courses"');
  });

  it("409: maps a unique_violation (23505) on INSERT to a conflict (race backstop)", async () => {
    mockSql
      .queueResult([]) // pre-check: no clash (lost the race to a concurrent insert)
      .queueError({ code: "23505" }); // INSERT trips ux_courses_identity
    const res = await handler(makeEvent("POST", "/admin/create_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/already exists/i);
    expect(mockSql.calls).toHaveLength(2);
  });
});
