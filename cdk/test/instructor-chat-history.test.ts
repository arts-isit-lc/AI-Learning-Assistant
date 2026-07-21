import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for GET /instructor/course_messages_rows (B5) — the course-wide chat
 * message rows behind the in-app Chat History table. Ownership-scoped (the
 * instructor must teach the course, checked against the trusted authorizer
 * email) and paginated (limit/offset + total).
 *
 * (a) OpenAPI contract test (route inlined via AWS::Include → parse the YAML).
 * (b) Handler unit test with a mocked `sql` tagged template. Deterministic.
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: instructor course_messages_rows", () => {
  const spec = parseYaml(
    fs.readFileSync(path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"), "utf8")
  );

  it("declares GET /instructor/course_messages_rows (course_id required), instructor-secured", () => {
    const route = spec.paths["/instructor/course_messages_rows"];
    expect(route?.get).toBeDefined();
    expect(route.options).toBeDefined();
    const byName = Object.fromEntries(route.get.parameters.map((p: any) => [p.name, p]));
    expect(byName.course_id?.required).toBe(true);
    expect(byName.limit).toBeDefined();
    expect(byName.offset).toBeDefined();
    expect(route.get.security).toEqual([{ instructorAuthorizer: [] }]);
    expect(JSON.stringify(route.get["x-amazon-apigateway-integration"].uri)).toContain(
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
  queryStringParameters: Record<string, string> | null,
  authorizerEmail = "instructor@example.com"
) {
  return {
    httpMethod: "GET",
    resource: "/instructor/course_messages_rows",
    queryStringParameters,
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

const OWNS = [{ owns: 1 }];

describe("instructorFunction — GET /instructor/course_messages_rows", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: returns a paginated page of messages for a course the instructor owns", async () => {
    mockSql
      .queueResult(OWNS)
      .queueResult([{ total: 2 }])
      .queueResult([
        { user_email: "stu@x.com", module_name: "vectors", message_content: "hi" },
        { user_email: "stu@x.com", module_name: "vectors", message_content: "there" },
      ]);
    const res = await handler(makeEvent({ course_id: "c1" }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.messages).toHaveLength(2);
    expect(mockSql.calls).toHaveLength(3); // ownership + count + rows
  });

  it("403: instructor does not teach the course (no count/rows query runs)", async () => {
    mockSql.queueResult([]); // ownership empty
    const res = await handler(makeEvent({ course_id: "c1" }));
    expect(res.statusCode).toBe(403);
    expect(mockSql.calls).toHaveLength(1); // only the ownership check
  });

  it("400: missing course_id", async () => {
    const res = await handler(makeEvent(null));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });
})
