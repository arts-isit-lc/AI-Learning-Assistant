import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for GET /student/progress_summary — the batched per-course completion
 * summary for the student home grid (Option C: one request, aggregated in SQL,
 * instead of a course_page fetch per card).
 *
 * (a) OpenAPI contract test — the API definition is inlined via an AWS::Include
 *     macro, so the route isn't in the synthesized template; parse the YAML.
 * (b) Handler unit test — exercises the Node handler with a mocked `sql` tagged
 *     template. Deterministic: no DB / network.
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: GET /student/progress_summary", () => {
  const spec = parseYaml(
    fs.readFileSync(
      path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"),
      "utf8"
    )
  );
  const route = spec.paths["/student/progress_summary"];

  it("declares the path with GET + OPTIONS (CORS)", () => {
    expect(route).toBeDefined();
    expect(route.get).toBeDefined();
    expect(route.options).toBeDefined();
  });

  it("requires only the email query param (course-list scoped, not per-course)", () => {
    const params: Array<any> = route.get.parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.email).toBeDefined();
    expect(byName.email.in).toBe("query");
    expect(byName.email.required).toBe(true);
    expect(byName.course_id).toBeUndefined();
  });

  it("is secured by studentAuthorizer and proxies to studentFunction", () => {
    expect(route.get.security).toEqual([{ studentAuthorizer: [] }]);
    const integration = route.get["x-amazon-apigateway-integration"];
    expect(integration.type).toBe("aws_proxy");
    expect(JSON.stringify(integration.uri)).toContain("studentFunction.Arn");
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

jest.mock("../lambda/lib/accessControl.js", () => ({
  verifyStudentAccess: jest.fn(),
  verifyStudentOwnsSession: jest.fn(),
}));

// AWS SDK is provided by the Node runtime, not cdk/node_modules — mock virtually.
jest.mock(
  "@aws-sdk/client-s3",
  () => ({ S3Client: class {}, GetObjectCommand: class {} }),
  { virtual: true }
);
jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }), {
  virtual: true,
});
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), {
  virtual: true,
});
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({
    DynamoDBDocumentClient: { from: () => ({ send: jest.fn() }) },
    BatchGetCommand: class {},
  }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lambda/lib/studentFunction.js");

function makeEvent(
  queryStringParameters: Record<string, string> | null,
  authorizerEmail = "student@example.com"
) {
  return {
    httpMethod: "GET",
    resource: "/student/progress_summary",
    queryStringParameters,
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

describe("studentFunction — GET /student/progress_summary", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: maps the SQL aggregate to { course_id, percent, completed, total }", async () => {
    mockSql
      .queueResult([{ user_id: "u1" }]) // user lookup
      .queueResult([
        { course_id: "c1", total: 4, completed: 2 },
        { course_id: "c2", total: 3, completed: 3 },
        { course_id: "c3", total: 0, completed: 0 },
      ]);

    const res = await handler(makeEvent({ email: "student@example.com" }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      { course_id: "c1", total: 4, completed: 2, percent: 50 },
      { course_id: "c2", total: 3, completed: 3, percent: 100 },
      { course_id: "c3", total: 0, completed: 0, percent: 0 }, // guards divide-by-zero
    ]);
    // user lookup + aggregate = two queries
    expect(mockSql.calls).toHaveLength(2);
  });

  it("400: when the email query param is missing (no DB access)", async () => {
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("404: unknown user (stops after the user lookup)", async () => {
    mockSql.queueResult([]); // user lookup empty
    const res = await handler(makeEvent({ email: "student@example.com" }));
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(1);
  });

  it("401: query email does not match the authorizer identity (no DB access)", async () => {
    const res = await handler(
      makeEvent({ email: "other@example.com" }, "student@example.com")
    );
    expect(res.statusCode).toBe(401);
    expect(mockSql.calls).toHaveLength(0);
  });
});
