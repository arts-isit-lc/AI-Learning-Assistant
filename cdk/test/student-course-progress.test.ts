import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Tests for GET /student/course_progress (course-wide progress).
 *
 * (a) OpenAPI contract test — the API definition is inlined via an AWS::Include
 *     macro, so the route is not visible in the synthesized template; parse the
 *     YAML directly.
 * (b) Handler unit test — exercises the Node handler with a mocked `sql` tagged
 *     template (Postgres join) and a virtual-mocked DynamoDB DocumentClient
 *     (BatchGetCommand). Deterministic: no DB / DynamoDB / network.
 */

// ---------------------------------------------------------------------------
// (a) OpenAPI contract test
// ---------------------------------------------------------------------------
describe("OpenAPI contract: GET /student/course_progress", () => {
  const spec = parseYaml(
    fs.readFileSync(
      path.join(__dirname, "..", "OpenAPI_Swagger_Definition.yaml"),
      "utf8"
    )
  );
  const route = spec.paths["/student/course_progress"];

  it("declares the path with GET + OPTIONS (CORS)", () => {
    expect(route).toBeDefined();
    expect(route.get).toBeDefined();
    expect(route.options).toBeDefined();
  });

  it("requires email and course_id query params", () => {
    const params: Array<any> = route.get.parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    for (const name of ["email", "course_id"]) {
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

const TABLE = "test-session-state-table";

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

// Records BatchGetCommand inputs; returns queued responses (or throws `error`).
const mockDdb = {
  calls: [] as any[],
  responses: [] as any[],
  error: null as any,
  reset() {
    this.calls = [];
    this.responses = [];
    this.error = null;
  },
  send(cmd: any) {
    if (this.error) return Promise.reject(this.error);
    this.calls.push(cmd.input);
    return Promise.resolve(this.responses.length ? this.responses.shift() : { Responses: {} });
  },
};

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
    DynamoDBDocumentClient: { from: () => ({ send: (cmd: any) => mockDdb.send(cmd) }) },
    BatchGetCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true }
);

// Table name must be set before the handler module loads (it reads process.env).
process.env.SESSION_STATE_TABLE = TABLE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lambda/lib/studentFunction.js");

function makeEvent(
  queryStringParameters: Record<string, string> | null,
  authorizerEmail = "student@example.com"
) {
  return {
    httpMethod: "GET",
    resource: "/student/course_progress",
    queryStringParameters,
    requestContext: { authorizer: { email: authorizerEmail } },
  } as any;
}

const VALID_QS = { email: "student@example.com", course_id: "course-1" };

// Module Alpha with two sessions that both cover "recursion"; module Beta with none.
const JOIN_ROWS = [
  { module_id: "mA", module_name: "Alpha", module_number: 1, generated_topics: ["recursion", "trees"], concept_name: "Foundations", student_module_id: "smA", module_score: 100, last_accessed: "2026-01-02T00:00:00Z", session_id: "sA1", session_name: "chat1" },
  { module_id: "mA", module_name: "Alpha", module_number: 1, generated_topics: ["recursion", "trees"], concept_name: "Foundations", student_module_id: "smA", module_score: 100, last_accessed: "2026-01-02T00:00:00Z", session_id: "sA2", session_name: "chat2" },
  { module_id: "mB", module_name: "Beta", module_number: 2, generated_topics: ["sorting"], concept_name: "Foundations", student_module_id: "smB", module_score: 0, last_accessed: null, session_id: null, session_name: null },
];

const STATE_ITEMS = [
  { session_id: "sA1", stage: "comprehension", engagement_score: "0.4", interactions: 3, concepts_discussed: ["recursion"], concepts_demonstrated: ["recursion"], module_concepts: ["recursion", "trees"], concept_progress: { recursion: { level: "discussed", exposures: 3, demonstrations: 1 } }, hint_level: 2, hint_count: 3, last_mode: "hint_scaffold" },
  { session_id: "sA2", stage: "application", engagement_score: "0.6", interactions: 2, concepts_discussed: ["trees"], concepts_demonstrated: [], module_concepts: ["recursion", "trees"], concept_progress: { recursion: { level: "demonstrated", exposures: 2, demonstrations: 2 } }, hint_level: 1, hint_count: 1, last_mode: "assess" },
];

describe("studentFunction — GET /student/course_progress", () => {
  beforeEach(() => {
    mockSql.reset();
    mockDdb.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: aggregates modules and merges concept progress across sessions", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult(JOIN_ROWS);
    mockDdb.responses.push({ Responses: { [TABLE]: STATE_ITEMS } });

    const res = await handler(makeEvent(VALID_QS));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.modules).toHaveLength(2);

    const alpha = body.modules.find((m: any) => m.module_id === "mA");
    const beta = body.modules.find((m: any) => m.module_id === "mB");

    // Cross-session concept merge (AC-8): summed, not overwritten.
    expect(alpha.session_count).toBe(2);
    expect(alpha.missing_sessions).toBe(0);
    expect(alpha.sessions).toHaveLength(2);
    const recursion = alpha.derived_summary.concept_mastery.recursion;
    expect(recursion.exposures).toBe(5);
    expect(recursion.demonstrations).toBe(3);
    expect(recursion.mastery_ratio).toBeCloseTo(0.6, 5);
    expect(recursion.level).toBe("demonstrated");

    expect(alpha.derived_summary.coverage).toBeCloseTo(1, 5);
    expect(alpha.derived_summary.stage_max).toBe("application");
    expect(alpha.derived_summary.engagement_max).toBeCloseTo(0.6, 5);
    expect(alpha.derived_summary.interactions_total).toBe(5);
    expect(alpha.derived_summary.concepts_demonstrated).toEqual(["recursion"]);

    // Socratic hint escalation (debug view): cumulative count, peak level, and
    // the most-recently-accessed session's mode (sA2 is the later session).
    expect(alpha.derived_summary.hint_count_total).toBe(4);
    expect(alpha.derived_summary.hint_level_max).toBe(2);
    expect(alpha.derived_summary.last_mode).toBe("assess");

    // Module with no sessions: present, empty derived summary.
    expect(beta.session_count).toBe(0);
    expect(beta.sessions).toEqual([]);
    expect(beta.derived_summary.concept_mastery).toEqual({});
    expect(beta.derived_summary.coverage).toBe(0);
    expect(beta.derived_summary.stage_max).toBe("prior_knowledge");
    expect(beta.derived_summary.hint_count_total).toBe(0);
    expect(beta.derived_summary.hint_level_max).toBe(0);
    expect(beta.derived_summary.last_mode).toBe("");

    // Course summary + read accounting.
    expect(body.summary.modules_total).toBe(2);
    expect(body.summary.modules_complete).toBe(1);
    expect(body.summary.average_module_score).toBe(50);
    expect(body.summary.requested_sessions).toBe(2);
    expect(body.summary.returned_sessions).toBe(2);
    expect(body.summary.missing_sessions).toBe(0);
    expect(body.summary.state_read_error).toBe(false);
  });

  it("reads DynamoDB ONLY for the joined session_ids (scoping) and never writes", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult(JOIN_ROWS);
    mockDdb.responses.push({ Responses: { [TABLE]: STATE_ITEMS } });

    await handler(makeEvent(VALID_QS));

    // Exactly the two session_ids from the join were requested — nothing else.
    expect(mockDdb.calls).toHaveLength(1);
    expect(mockDdb.calls[0].RequestItems[TABLE].Keys).toEqual([
      { session_id: "sA1" },
      { session_id: "sA2" },
    ]);
    // Read-only: every DynamoDB call is a BatchGet (RequestItems shape) — no writes.
    expect(mockDdb.calls.every((c: any) => c.RequestItems)).toBe(true);
  });

  it("400: when a required query param is missing (no DB access)", async () => {
    const res = await handler(makeEvent({ email: "student@example.com" })); // no course_id
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
    expect(mockDdb.calls).toHaveLength(0);
  });

  it("404: unknown user (stops after the user lookup)", async () => {
    mockSql.queueResult([]);
    const res = await handler(makeEvent(VALID_QS));
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(1);
    expect(mockDdb.calls).toHaveLength(0);
  });

  it("404: not enrolled / no active modules (empty join)", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult([]);
    const res = await handler(makeEvent(VALID_QS));
    expect(res.statusCode).toBe(404);
    expect(mockSql.calls).toHaveLength(2);
  });

  it("401: query email does not match the authorizer identity", async () => {
    const res = await handler(
      makeEvent({ ...VALID_QS, email: "other@example.com" }, "student@example.com")
    );
    expect(res.statusCode).toBe(401);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("degrades (no 500) with state_read_error when the DynamoDB read hard-fails", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult(JOIN_ROWS);
    mockDdb.error = new Error("ProvisionedThroughputExceeded");

    const res = await handler(makeEvent(VALID_QS));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.summary.state_read_error).toBe(true);
    expect(body.summary.returned_sessions).toBe(0);
    const alpha = body.modules.find((m: any) => m.module_id === "mA");
    expect(alpha.sessions).toEqual([]);
    expect(alpha.missing_sessions).toBe(2); // both sessions unresolved
  });
});
