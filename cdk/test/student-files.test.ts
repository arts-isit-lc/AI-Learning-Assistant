import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for GET /student/files — the endpoint that backs the student chatbot
 * "Module materials" accordion.
 *
 * (a) OpenAPI contract test — parses the OpenAPI YAML (inlined into the
 *     SpecRestApi via an AWS::Include macro, so not visible to
 *     Template.fromStack()) and asserts route/verb/params/security.
 *
 * (b) Handler unit test — exercises studentFunction.js with a mocked `sql`
 *     tagged template + mocked deps. Deterministic: no DB, no AWS creds, no
 *     network.
 *
 * Regression (cross-module-file-referencing): files a module references from
 * OTHER modules (Module_File_References) never appeared in the accordion because
 * the list query selected only the module's own Module_Files rows. The query now
 * UNIONs the referenced files (resolved back through Module_Files by file_id).
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: GET /student/files", () => {
  const spec = parseYaml(
    fs.readFileSync(
      path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"),
      "utf8"
    )
  );
  const route = spec.paths["/student/files"];

  it("declares the path with GET + OPTIONS (CORS)", () => {
    expect(route).toBeDefined();
    expect(route.get).toBeDefined();
    expect(route.options).toBeDefined();
  });

  it("requires course_id and module_id as query params", () => {
    const params: Array<any> = route.get.parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    for (const name of ["course_id", "module_id"]) {
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

type FakeSql = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  queueResult: (rows: any[]) => FakeSql;
  calls: string[];
  values: any[][];
  reset: () => void;
};

function makeFakeSql(): FakeSql {
  const queue: any[][] = [];
  const calls: string[] = [];
  const values: any[][] = [];
  const fn = ((strings: TemplateStringsArray, ...vals: any[]) => {
    calls.push(strings.join("?"));
    values.push(vals);
    return Promise.resolve(queue.length ? (queue.shift() as any[]) : []);
  }) as FakeSql;
  fn.queueResult = (rows: any[]) => {
    queue.push(rows);
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

// The Node 22 Lambda runtime provides the AWS SDK; not installed under
// cdk/node_modules, so mock virtually to let the handler module load.
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
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), {
  virtual: true,
});
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({
    DynamoDBDocumentClient: { from: () => ({ send: jest.fn() }) },
    BatchGetCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyStudentAccess } = require("../lambda/lib/accessControl.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lambda/lib/studentFunction.js");

function makeEvent(
  queryStringParameters: Record<string, string> | null,
  authorizerEmail = "student@example.com"
) {
  return {
    httpMethod: "GET",
    resource: "/student/files",
    queryStringParameters,
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

const VALID_QS = { course_id: "course-1", module_id: "module-1" };

describe("studentFunction — GET /student/files", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
    (verifyStudentAccess as jest.Mock).mockReset();
  });

  it("200: returns the module's own files UNIONed with cross-module referenced files", async () => {
    (verifyStudentAccess as jest.Mock).mockResolvedValue("enr-1");
    // The DB does the UNION; the handler returns whatever the single query
    // yields. Simulate the union result: one own file + one referenced file.
    mockSql.queueResult([
      { file_id: "own-1", filename: "Lecture 1", filetype: "pdf", time_uploaded: "2026-01-02T00:00:00.000Z" },
      { file_id: "ref-1", filename: "Shared Notes", filetype: "pdf", time_uploaded: "2026-01-01T00:00:00.000Z" },
    ]);

    const res = await handler(makeEvent(VALID_QS));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.map((f: any) => f.file_id);
    expect(ids).toContain("own-1");
    expect(ids).toContain("ref-1");

    // The list query must union in the cross-module reference table, resolving
    // referenced files back through Module_Files. This is the regression guard:
    // before the fix it selected only Module_Files WHERE module_id = ?.
    const listSql = mockSql.calls[0];
    expect(listSql).toContain('"Module_Files"');
    expect(listSql).toContain("UNION");
    expect(listSql).toContain('"Module_File_References"');
    expect(listSql).toContain("referenced_file_id");
    expect(listSql).toContain("source_module_id");

    // The module_id is bound to both the own-files predicate and the
    // reference-source predicate (2 interpolations, same value).
    const boundValues = mockSql.values[0];
    expect(boundValues).toEqual(["module-1", "module-1"]);

    // Read-only.
    const allSql = mockSql.calls.join(" ; ").toUpperCase();
    expect(allSql).not.toContain("INSERT");
    expect(allSql).not.toContain("UPDATE");
    expect(allSql).not.toContain("DELETE");
  });

  it("403: when the student is not enrolled in the course (no list query runs)", async () => {
    (verifyStudentAccess as jest.Mock).mockResolvedValue(null);

    const res = await handler(makeEvent(VALID_QS));

    expect(res.statusCode).toBe(403);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("400: when a required query param is missing (no access check, no query)", async () => {
    const res = await handler(makeEvent({ course_id: "course-1" })); // no module_id

    expect(res.statusCode).toBe(400);
    expect((verifyStudentAccess as jest.Mock)).not.toHaveBeenCalled();
    expect(mockSql.calls).toHaveLength(0);
  });
});
