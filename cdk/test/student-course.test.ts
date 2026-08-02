/**
 * Tests for GET /student/course — the enrolled-course list that feeds the
 * student course header (Figma 143:1427).
 *
 * Focus: each course now carries an `instructors` array (name + email),
 * aggregated in SQL from the instructor enrolments, alongside the course's
 * term/section. Handler unit test with a mocked `sql` tagged template — no DB,
 * no DynamoDB, no network.
 *
 * studentFunction.js is shared with routes whose code path imports the AWS SDK
 * at module load, so those are virtual-mocked (the runtime provides them);
 * /student/course never calls them.
 */

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

process.env.SESSION_STATE_TABLE = "test-session-state-table";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lambda/lib/studentFunction.js");

// The handler 401s when the query `email` differs from the authorizer email, so
// the authorizer email tracks the query email here (that mismatch guard is
// shared handler behavior, exercised elsewhere — not under test in this file).
function makeEvent(queryStringParameters: Record<string, string> | null) {
  return {
    httpMethod: "GET",
    resource: "/student/course",
    queryStringParameters,
    requestContext: {
      authorizer: { email: queryStringParameters?.email ?? "student@example.com" },
    },
  } as any;
}

// One enrolled course with its server-aggregated instructor list + term/section.
const COURSE_ROWS = [
  {
    course_id: "course-1",
    course_department: "GEOG",
    course_number: "412",
    course_name: "Water Management",
    term: "2025 Winter Term 2",
    section: "101",
    course_student_access: true,
    instructors: [
      { first_name: "Ada", last_name: "Lovelace", user_email: "ada@ubc.ca" },
      { first_name: "Alan", last_name: "Turing", user_email: "alan@ubc.ca" },
    ],
  },
];

describe("studentFunction — GET /student/course", () => {
  beforeEach(() => {
    mockSql.reset();
    (global as any).sqlConnection = mockSql;
  });

  it("200: returns each course with its aggregated instructor list + term/section", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult(COURSE_ROWS);

    const res = await handler(makeEvent({ email: "student@example.com" }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].instructors).toEqual([
      { first_name: "Ada", last_name: "Lovelace", user_email: "ada@ubc.ca" },
      { first_name: "Alan", last_name: "Turing", user_email: "alan@ubc.ca" },
    ]);
    expect(body[0].term).toBe("2025 Winter Term 2");
    expect(body[0].section).toBe("101");
  });

  it("aggregates instructors from instructor enrolments only (SQL contract)", async () => {
    mockSql.queueResult([{ user_id: "u1" }]).queueResult(COURSE_ROWS);

    await handler(makeEvent({ email: "student@example.com" }));

    const courseQuery = mockSql.calls.find((q) => q.includes("json_agg"));
    expect(courseQuery).toBeDefined();
    expect(courseQuery).toContain("enrolment_type = 'instructor'");
    // Still scoped to courses the student may see.
    expect(courseQuery).toContain("course_student_access = TRUE");
  });

  it("400 when the email query param is missing", async () => {
    const res = await handler(makeEvent(null));
    expect(res.statusCode).toBe(400);
    expect(mockSql.calls).toHaveLength(0);
  });

  it("404 when the student email has no matching user", async () => {
    mockSql.queueResult([]); // user lookup returns nothing

    const res = await handler(makeEvent({ email: "ghost@example.com" }));

    expect(res.statusCode).toBe(404);
    // No course query ran after the failed user lookup.
    expect(mockSql.calls.some((q) => q.includes("json_agg"))).toBe(false);
  });
})
