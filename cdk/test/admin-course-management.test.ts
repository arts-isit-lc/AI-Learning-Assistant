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
    // system_prompt still travels in the JSON body.
    expect(
      route.post.requestBody.content["application/json"].schema.properties.system_prompt
    ).toBeDefined();
    expect(route.post.security).toEqual([{ adminAuthorizer: [] }]);
    expect(route.post["x-amazon-apigateway-integration"].uri["Fn::Sub"]).toBe(adminUri);
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

// ---------------------------------------------------------------------------
// (b) Handler unit tests
// ---------------------------------------------------------------------------

/** A fake `sql` tagged template that queues per-call results and records the
 * SQL text of each call. Named `mockSql` so it can be referenced inside the
 * jest.mock factory (jest allows out-of-scope vars prefixed with `mock`). */
type FakeSql = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  queueResult: (rows: any[]) => FakeSql;
  calls: string[];
  reset: () => void;
};

function makeFakeSql(): FakeSql {
  const queue: any[][] = [];
  const calls: string[] = [];
  const fn = ((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve(queue.length ? (queue.shift() as any[]) : []);
  }) as FakeSql;
  fn.queueResult = (rows: any[]) => {
    queue.push(rows);
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

  it("200: creates the course, then clones the concept/module outline (metadata only)", async () => {
    mockSql
      .queueResult([{ course_id: "new-course", course_name: "Intro Geography (copy)" }]) // INSERT...SELECT Courses RETURNING *
      .queueResult([{ concept_id: "c1", concept_name: "Basics", concept_number: 1 }]) // source concepts
      .queueResult([{ concept_id: "new-c1" }]) // INSERT concept RETURNING
      .queueResult([]); // INSERT...SELECT modules

    const res = await handler(
      makeEvent("POST", "/admin/duplicate_course", VALID_QS, BODY)
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).course_id).toBe("new-course");

    const joined = mockSql.calls.join(" ; ");
    expect(joined).toContain('INSERT INTO "Courses"');
    expect(joined).toContain('FROM "Courses"'); // INSERT...SELECT copies llm_model_id
    expect(joined).toContain('FROM "Course_Concepts"');
    expect(joined).toContain('INSERT INTO "Course_Concepts"');
    // The module clone is an INSERT ... SELECT keeping jsonb (key_topics /
    // generated_topics) in the DB, scoped to active modules only.
    const moduleInsert = mockSql.calls[3];
    expect(moduleInsert).toContain('INSERT INTO "Course_Modules"');
    expect(moduleInsert).toContain("key_topics");
    expect(moduleInsert).toContain("status = 'active'");
    expect(moduleInsert).toContain("'active'");
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
    mockSql.queueResult([{ course_id: "new-course", term: "2026 Winter Term 2" }]);
    const res = await handler(makeEvent("POST", "/admin/create_course", VALID_QS, BODY));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).course_id).toBe("new-course");
    const insertSql = mockSql.calls[0];
    expect(insertSql).toContain('INSERT INTO "Courses"');
    expect(insertSql).toContain("term");
  });

  it("400: when the required term query param is missing (no DB access)", async () => {
    const { term, ...rest } = VALID_QS;
    const res = await handler(makeEvent("POST", "/admin/create_course", rest, BODY));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
});
