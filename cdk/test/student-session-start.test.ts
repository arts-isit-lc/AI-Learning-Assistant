import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for POST /student/session_start — the once-per-browser-session login
 * analytics beacon. Device type / OS / browser are parsed server-side from the
 * User-Agent header (coarse buckets) and written as a 'login' row in
 * User_Engagement_Log; identity comes from the authorizer, never a query string.
 *
 * (a) OpenAPI contract test — the API definition is inlined into the SpecRestApi
 *     via an AWS::Include macro, so the route is NOT visible in the synthesized
 *     CloudFormation template; parse the YAML directly.
 * (b) Handler unit test — exercises the Node handler with a mocked `sql` tagged
 *     template. Deterministic: no DB / no AWS / no network.
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: POST /student/session_start", () => {
  const spec = parseYaml(
    fs.readFileSync(
      path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"),
      "utf8"
    )
  );
  const route = spec.paths["/student/session_start"];

  it("declares the path with POST + OPTIONS (CORS)", () => {
    expect(route).toBeDefined();
    expect(route.post).toBeDefined();
    expect(route.options).toBeDefined();
  });

  it("takes no query params (identity from authorizer, device from User-Agent)", () => {
    expect(route.post.parameters).toBeUndefined();
  });

  it("is secured by studentAuthorizer and proxies to studentFunction", () => {
    expect(route.post.security).toEqual([{ studentAuthorizer: [] }]);
    const integration = route.post["x-amazon-apigateway-integration"];
    expect(integration.type).toBe("aws_proxy");
    expect(integration.httpMethod).toBe("POST");
    expect(JSON.stringify(integration.uri)).toContain("studentFunction.Arn");
  });
});

// ---------------------------------------------------------------------------
// (b) Handler unit test
// ---------------------------------------------------------------------------

type FakeSql = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  queueResult: (rows: any[]) => FakeSql;
  queueError: (err: Error) => FakeSql;
  calls: string[];
  values: any[][];
  reset: () => void;
};

function makeFakeSql(): FakeSql {
  const queue: any[] = [];
  const calls: string[] = [];
  const values: any[][] = [];
  const fn = ((strings: TemplateStringsArray, ...vals: any[]) => {
    calls.push(strings.join("?"));
    values.push(vals);
    const next = queue.length ? queue.shift() : [];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as any[]);
  }) as FakeSql;
  fn.queueResult = (rows: any[]) => {
    queue.push(rows);
    return fn;
  };
  fn.queueError = (err: Error) => {
    queue.push(err);
    return fn;
  };
  fn.calls = calls;
  fn.values = values;
  fn.reset = () => {
    queue.length = 0;
    calls.length = 0;
    values.length = 0;
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

// A real Windows/Chrome desktop UA — classifier should bucket it deterministically.
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function makeEvent(authorizerEmail?: string, userAgent?: string) {
  return {
    httpMethod: "POST",
    resource: "/student/session_start",
    queryStringParameters: null,
    headers: userAgent === undefined ? {} : { "User-Agent": userAgent },
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

describe("studentFunction — POST /student/session_start", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: writes a 'login' row with the parsed device buckets for a known user", async () => {
    mockSql.queueResult([{ user_id: "u1" }]); // Users lookup
    mockSql.queueResult([]); // INSERT

    const res = await handler(makeEvent("student@example.com", WINDOWS_CHROME));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      device_type: "desktop",
      os_name: "Windows",
      browser_name: "Chrome",
    });
    // user lookup + insert
    expect(mockSql.calls).toHaveLength(2);
    expect(mockSql.calls[1]).toContain('INSERT INTO "User_Engagement_Log"');
    expect(mockSql.calls[1]).toContain("'login'");
    // interpolated values on the INSERT: user_id + the three coarse buckets
    expect(mockSql.values[1]).toEqual(["u1", "desktop", "Windows", "Chrome"]);
  });

  it("derives identity from the authorizer, not a query string (no impersonation)", async () => {
    mockSql.queueResult([{ user_id: "u1" }]);
    mockSql.queueResult([]);

    await handler(makeEvent("real@example.com", WINDOWS_CHROME));

    // The Users lookup is scoped by the authorizer email.
    expect(mockSql.values[0]).toEqual(["real@example.com"]);
  });

  it("200 no-op: unknown user is not inserted (best-effort)", async () => {
    mockSql.queueResult([]); // Users lookup empty

    const res = await handler(makeEvent("ghost@example.com", WINDOWS_CHROME));

    expect(res.statusCode).toBe(200);
    // only the lookup ran; no INSERT
    expect(mockSql.calls).toHaveLength(1);
  });

  it("401: missing authorizer identity, and never touches the DB", async () => {
    const res = await handler(makeEvent(undefined, WINDOWS_CHROME));
    expect(res.statusCode).toBe(401);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("best-effort: a DB failure is swallowed (200), never surfaced as 5xx", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockSql.queueError(new Error("db down")); // Users lookup throws

    const res = await handler(makeEvent("student@example.com", WINDOWS_CHROME));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still records (unknown buckets) when the User-Agent header is absent", async () => {
    mockSql.queueResult([{ user_id: "u1" }]);
    mockSql.queueResult([]);

    const res = await handler(makeEvent("student@example.com", undefined));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      device_type: "desktop",
      os_name: "unknown",
      browser_name: "unknown",
    });
    expect(mockSql.values[1]).toEqual(["u1", "desktop", "unknown", "unknown"]);
  });
});
