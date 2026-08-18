import * as fs from "fs";
import * as path from "path";

/**
 * Tests for the centralized per-course authorization gate in instructorFunction.
 *
 * Every course-scoped instructor route now resolves the caller's access to the
 * target course BEFORE dispatching — via course_id directly, or by resolving the
 * course from concept_id / module_id — and 403s unless the caller holds an
 * ACTIVE instructor enrolment (Enrolments.access_enabled not toggled off by an
 * admin). This closes the gap where routes trusted only the authorizer email and
 * took the id from params, and it makes the admin "Access" toggle actually block
 * the instructor across the board (the original bug).
 *
 * Draft modules are the one wrinkle: a module reserved (reserve_module) but not
 * yet finalized has concept_id = NULL and no course linkage, so module-scoped
 * checks must still let the in-flight creation calls through — asserted below.
 *
 * (a) Static check: the route map covers the routes we expect and excludes the
 *     ones guarded inline / not course-scoped.
 * (b) Handler unit test with a mocked `sql` tagged template. Deterministic.
 */

// ---------------------------------------------------------------------------
// (a) Route-map coverage (source-level guard against silent regressions)
// ---------------------------------------------------------------------------
describe("instructorFunction — course-scoped route map", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "lambda", "lib", "instructorFunction.js"),
    "utf8"
  );
  const mapBlock = src.slice(
    src.indexOf("const INSTRUCTOR_COURSE_SCOPED_ROUTES"),
    src.indexOf("exports.handler")
  );

  it.each([
    ["GET /instructor/view_students", "course_id"],
    ["PUT /instructor/prompt", "course_id"],
    ["DELETE /instructor/delete_student", "course_id"],
    ["PUT /instructor/edit_concept", "concept_id"],
    ["DELETE /instructor/delete_concept", "concept_id"],
    ["PUT /instructor/edit_module", "module_id"],
    ["DELETE /instructor/delete_module", "module_id"],
    ["POST /instructor/generate_topics", "module_id"],
    ["GET /instructor/file_processing_statuses", "module_id"],
  ])("gates %s on %s", (route, idParam) => {
    expect(mapBlock).toContain(`"${route}": "${idParam}"`);
  });

  it("does NOT centrally re-gate routes that are guarded inline or not course-scoped", () => {
    // These are handled elsewhere; double-gating would change tested behavior.
    expect(mapBlock).not.toContain('"POST /instructor/updateCourseAccess"');
    expect(mapBlock).not.toContain('"DELETE /instructor/delete_course"');
    expect(mapBlock).not.toContain('"GET /instructor/course_messages_rows"');
    expect(mapBlock).not.toContain('"POST /instructor/reserve_module"');
    expect(mapBlock).not.toContain('"GET /instructor/courses"');
    expect(mapBlock).not.toContain('"GET /instructor/student_course"');
  });
});

// ---------------------------------------------------------------------------
// (b) Handler unit test
// ---------------------------------------------------------------------------

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

jest.mock("../lambda/lib/lib.js", () => ({
  initializeConnection: jest.fn(async () => {
    (global as any).sqlConnection = mockSql;
  }),
}));
jest.mock("../lambda/lib/validatePrompt.js", () => ({ validatePrompt: jest.fn() }));
jest.mock("../lambda/lib/generateTopics.js", () => ({
  generateModuleTopics: jest.fn(async () => ({ statusCode: 200, body: { topics: [] } })),
}));
jest.mock(
  "@aws-sdk/client-s3",
  () => ({
    S3Client: class {},
    ListObjectsV2Command: class {},
    DeleteObjectsCommand: class {},
  }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lambda/lib/instructorFunction.js");

function makeEvent(
  httpMethod: string,
  resource: string,
  queryStringParameters: Record<string, string> | null,
  body: any = null,
  authorizerEmail = "instructor@example.com"
) {
  return {
    httpMethod,
    resource,
    queryStringParameters,
    body: body == null ? null : JSON.stringify(body),
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

const ACCESS_OK = [{ ok: 1 }]; // any non-empty row → instructorHas*Access true
const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("instructorFunction — centralized access gate (course_id routes)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: GET /instructor/view_students runs when the instructor has active access", async () => {
    mockSql.queueResult(ACCESS_OK).queueResult([{ user_email: "s@x.com" }]);
    const res = await handler(
      makeEvent("GET", "/instructor/view_students", { course_id: "c1" })
    );
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls).toHaveLength(2); // access gate + student list
    expect(mockSql.calls[0]).toContain("access_enabled"); // gate honors the toggle
  });

  it("403: access toggled off (gate returns no row) blocks before the route query runs", async () => {
    mockSql.queueResult([]); // gate denies
    const res = await handler(
      makeEvent("GET", "/instructor/view_students", { course_id: "c1" })
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/do not teach/i);
    expect(mockSql.calls).toHaveLength(1); // only the gate; no student list leaked
  });

  it("400: missing course_id skips the gate and hits the route's own validation", async () => {
    const res = await handler(makeEvent("GET", "/instructor/view_students", null));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
});

describe("instructorFunction — centralized access gate (concept_id routes)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("403: DELETE /instructor/delete_concept blocked when access resolves empty", async () => {
    mockSql.queueResult([]); // concept→course access gate denies
    const res = await handler(
      makeEvent("DELETE", "/instructor/delete_concept", { concept_id: "con1" })
    );
    expect(res.statusCode).toBe(403);
    expect(mockSql.calls).toHaveLength(1); // no DELETE runs
    expect(mockSql.calls[0]).toContain("Course_Concepts");
    expect(mockSql.calls[0]).toContain("access_enabled");
  });

  it("200: DELETE /instructor/delete_concept runs when access resolves", async () => {
    mockSql.queueResult(ACCESS_OK).queueResult([]);
    const res = await handler(
      makeEvent("DELETE", "/instructor/delete_concept", { concept_id: "con1" })
    );
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls).toHaveLength(2); // gate + DELETE
  });
});

describe("instructorFunction — centralized access gate (module_id routes)", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("403: DELETE /instructor/delete_module blocked for a finalized module in another's course", async () => {
    mockSql.queueResult([{ is_draft: false, has_access: false }]);
    const res = await handler(
      makeEvent("DELETE", "/instructor/delete_module", { module_id: VALID_UUID })
    );
    expect(res.statusCode).toBe(403);
    expect(mockSql.calls).toHaveLength(1); // no DELETE runs
  });

  it("200: DELETE /instructor/delete_module runs for a module in the instructor's course", async () => {
    mockSql.queueResult([{ is_draft: false, has_access: true }]).queueResult([]);
    const res = await handler(
      makeEvent("DELETE", "/instructor/delete_module", { module_id: VALID_UUID })
    );
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls).toHaveLength(2); // gate + DELETE
  });

  it("draft tolerance: file_processing_statuses passes on a draft module (concept_id NULL, no access row)", async () => {
    // A draft reserved during module creation has no course linkage yet; the
    // gate must let the in-flight upload polling through even though has_access
    // is false. Regression guard: a naive course-from-module join would 403 here
    // and break module creation.
    mockSql.queueResult([{ is_draft: true, has_access: false }]).queueResult([]);
    const res = await handler(
      makeEvent("GET", "/instructor/file_processing_statuses", { module_id: VALID_UUID })
    );
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls).toHaveLength(2); // gate + file status query
  });
});
