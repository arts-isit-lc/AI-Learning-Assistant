import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for the GET /student/module_progress feature.
 *
 * (a) OpenAPI contract test — the API definition is inlined into the SpecRestApi
 *     via an AWS::Include macro, so the route is NOT visible in the synthesized
 *     CloudFormation template (a Template.fromStack() assertion cannot see it).
 *     Instead we parse the OpenAPI YAML directly and assert the route/verb/
 *     params/security.
 *
 * (b) Handler unit test — exercises the studentFunction.js Node handler with a
 *     mocked `sql` tagged template and mocked deps, so it is deterministic (no
 *     DB, no AWS creds, no network). Uses the existing Jest runner; a .test.ts
 *     can require() the CommonJS handler (only .tsx? is transformed).
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: GET /student/module_progress", () => {
  const spec = parseYaml(
    fs.readFileSync(
      path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"),
      "utf8"
    )
  );
  const route = spec.paths["/student/module_progress"];

  it("declares the path with GET + OPTIONS (CORS)", () => {
    expect(route).toBeDefined();
    expect(route.get).toBeDefined();
    expect(route.options).toBeDefined();
  });

  it("requires email, course_id and module_id as query params", () => {
    const params: Array<any> = route.get.parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    for (const name of ["email", "course_id", "module_id"]) {
      expect(byName[name]).toBeDefined();
      expect(byName[name].in).toBe("query");
      expect(byName[name].required).toBe(true);
    }
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

/** A fake `sql` tagged template that queues per-call results and records the
 * SQL text of each call (for read-only / scoping assertions). Named `mockSql`
 * so it may be referenced inside the jest.mock factory (jest allows out-of-scope
 * vars prefixed with `mock`). */
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

// The Node 22 Lambda runtime provides the AWS SDK; it is not installed under
// cdk/node_modules, so mock it virtually to let the handler module load.
jest.mock(
  "@aws-sdk/client-s3",
  () => ({ S3Client: class {}, GetObjectCommand: class {} }),
  { virtual: true }
);
jest.mock(
  "@aws-sdk/s3-request-presigner",
  () => ({ getSignedUrl: jest.fn() }),
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
    resource: "/student/module_progress",
    queryStringParameters,
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

const VALID_QS = {
  email: "student@example.com",
  course_id: "course-1",
  module_id: "module-1",
};

describe("studentFunction — GET /student/module_progress", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: returns the module progress snapshot (course-scoped, read-only, no embedding)", async () => {
    mockSql
      .queueResult([{ user_id: "u1" }]) // user lookup
      .queueResult([
        {
          module_id: "module-1",
          module_name: "Intro",
          module_number: 1,
          concept_id: "c1",
          concept_name: "Basics",
          student_module_id: "sm1",
          module_score: 100,
          last_accessed: "2026-01-01T00:00:00.000Z",
        },
      ]); // main query

    const res = await handler(makeEvent(VALID_QS));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      module_id: "module-1",
      module_name: "Intro",
      module_score: 100,
    });
    expect(body).not.toHaveProperty("module_context_embedding");

    // The main query enforces enrolment + course scope and omits the embedding.
    const mainSql = mockSql.calls[1];
    expect(mainSql).toContain('"Enrolments"');
    expect(mainSql).toContain('"Course_Concepts".course_id');
    expect(mainSql).not.toContain("module_context_embedding");

    // Read-only: no writes anywhere.
    const allSql = mockSql.calls.join(" ; ").toUpperCase();
    expect(allSql).not.toContain("INSERT");
    expect(allSql).not.toContain("UPDATE");
  });

  it("400: when a required query param is missing (no DB access)", async () => {
    const res = await handler(
      makeEvent({ email: "student@example.com", course_id: "course-1" }) // no module_id
    );
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("404: when the user is unknown (stops after the user lookup)", async () => {
    mockSql.queueResult([]); // empty user lookup
    const res = await handler(makeEvent(VALID_QS));
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(1);
  });

  it("404: when not enrolled / module not in course (empty main query)", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult([]); // user found, main empty
    const res = await handler(makeEvent(VALID_QS));
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(2);
  });

  it("401: when the query email does not match the authorizer identity", async () => {
    const res = await handler(
      makeEvent({ ...VALID_QS, email: "someone-else@example.com" }, "student@example.com")
    );
    expect(res.statusCode).toBe(401);
    expect(mockSql.calls).toHaveLength(0);
  });
});
