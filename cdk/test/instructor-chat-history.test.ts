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
  unsafe: (fragment: string) => any;
  queueResult: (rows: any[]) => FakeSql;
  calls: string[];
  reset: () => void;
};

function makeFakeSql(): FakeSql {
  const queue: any[][] = [];
  const calls: string[] = [];
  // Faithfully models postgres.js: a tagged-template call builds a *lazy* query
  // that only executes — recording a call and consuming a queued result — when
  // it is awaited. Nested fragments (the free-text `searchClause`, or an empty
  // sql``) are built but not awaited on their own; they're interpolated into an
  // outer query and execute as part of that single awaited round-trip. So they
  // must NOT count as a separate query nor consume a queued result. (The earlier
  // eager fake counted every invocation, over-counting once the search/sort
  // feature introduced fragments + sql.unsafe.)
  const fn = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    return {
      then(resolve: (v: any[]) => void, reject: (e: any) => void) {
        calls.push(text);
        const rows = queue.length ? (queue.shift() as any[]) : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
  }) as unknown as FakeSql;
  // sql.unsafe(fragment) — used for the server-controlled ORDER BY clause. In the
  // fake it returns an inert marker; interpolated values are ignored (only the
  // static string parts are recorded), so it just needs to exist and not throw.
  fn.unsafe = (fragment: string) => ({ __unsafe: fragment });
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

  it("200: free-text search adds a filter fragment, not an extra executed query", async () => {
    // The search clause is a nested (lazy) sql fragment interpolated into the
    // count + rows queries — it must not count as a separate round-trip, so the
    // filtered page still runs exactly ownership + count + rows.
    mockSql
      .queueResult(OWNS)
      .queueResult([{ total: 1 }])
      .queueResult([{ user_email: "stu@x.com", module_name: "vectors", message_content: "join" }]);
    const res = await handler(makeEvent({ course_id: "c1", search: "join" }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.messages).toHaveLength(1);
    expect(mockSql.calls).toHaveLength(3); // ownership + count + rows (fragment not counted)
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
