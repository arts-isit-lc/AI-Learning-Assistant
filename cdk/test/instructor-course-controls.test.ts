import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for the instructor course-control routes (Configuration header):
 *   POST   /instructor/updateCourseAccess  — Active/Inactive toggle
 *   DELETE /instructor/delete_course        — delete a course the instructor teaches
 *
 * Both are ownership-scoped: the instructor must have an `enrolment_type='instructor'`
 * enrolment in the course (checked against the trusted authorizer email), unlike the
 * unscoped admin equivalents.
 *
 * (a) OpenAPI contract test (route inlined via AWS::Include → parse the YAML).
 * (b) Handler unit test with a mocked `sql` tagged template. Deterministic.
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: instructor course controls", () => {
  const spec = parseYaml(
    fs.readFileSync(path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"), "utf8")
  );

  it("declares POST /instructor/updateCourseAccess (course_id + access), instructor-secured", () => {
    const route = spec.paths["/instructor/updateCourseAccess"];
    expect(route?.post).toBeDefined();
    expect(route.options).toBeDefined();
    const byName = Object.fromEntries(route.post.parameters.map((p: any) => [p.name, p]));
    expect(byName.course_id?.required).toBe(true);
    expect(byName.access?.required).toBe(true);
    expect(route.post.security).toEqual([{ instructorAuthorizer: [] }]);
    expect(JSON.stringify(route.post["x-amazon-apigateway-integration"].uri)).toContain(
      "instructorFunction.Arn"
    );
  });

  it("declares DELETE /instructor/delete_course (course_id), instructor-secured", () => {
    const route = spec.paths["/instructor/delete_course"];
    expect(route?.delete).toBeDefined();
    expect(route.options).toBeDefined();
    const byName = Object.fromEntries(route.delete.parameters.map((p: any) => [p.name, p]));
    expect(byName.course_id?.required).toBe(true);
    expect(route.delete.security).toEqual([{ instructorAuthorizer: [] }]);
    expect(JSON.stringify(route.delete["x-amazon-apigateway-integration"].uri)).toContain(
      "instructorFunction.Arn"
    );
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
jest.mock("../lambda/lib/generateTopics.js", () => ({ generateModuleTopics: jest.fn() }));
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
  authorizerEmail = "instructor@example.com"
) {
  return {
    httpMethod,
    resource,
    queryStringParameters,
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

const OWNS = [{ owns: 1 }];

describe("instructorFunction — POST /instructor/updateCourseAccess", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: flips course_student_access for a course the instructor owns", async () => {
    mockSql.queueResult(OWNS).queueResult([{ course_id: "c1", course_student_access: false }]);
    const res = await handler(
      makeEvent("POST", "/instructor/updateCourseAccess", { course_id: "c1", access: "false" })
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).course_student_access).toBe(false);
    expect(mockSql.calls).toHaveLength(2); // ownership + update
  });

  it("403: instructor does not teach the course (no UPDATE runs)", async () => {
    mockSql.queueResult([]); // ownership empty
    const res = await handler(
      makeEvent("POST", "/instructor/updateCourseAccess", { course_id: "c1", access: "true" })
    );
    expect(res.statusCode).toBe(403);
    expect(mockSql.calls).toHaveLength(1); // only the ownership check
  });

  it("400: missing course_id / access", async () => {
    const res = await handler(makeEvent("POST", "/instructor/updateCourseAccess", { course_id: "c1" }))
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
});

describe("instructorFunction — DELETE /instructor/delete_course", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: deletes a course the instructor owns (cascade)", async () => {
    mockSql.queueResult(OWNS).queueResult([]);
    const res = await handler(makeEvent("DELETE", "/instructor/delete_course", { course_id: "c1" }));
    expect(res.statusCode).toBe(200);
    expect(mockSql.calls).toHaveLength(2); // ownership + delete
  });

  it("403: instructor does not teach the course (no DELETE runs)", async () => {
    mockSql.queueResult([]); // ownership empty
    const res = await handler(makeEvent("DELETE", "/instructor/delete_course", { course_id: "c1" }));
    expect(res.statusCode).toBe(403);
    expect(mockSql.calls).toHaveLength(1);
  });

  it("400: missing course_id", async () => {
    const res = await handler(makeEvent("DELETE", "/instructor/delete_course", null));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
});
