/**
 * Handler unit tests for the two Cognito triggers that own "Users" row creation.
 *
 * Context: a Confirmed Cognito user could end up with NO "Users" row because the
 * only insert was a best-effort, error-swallowed client call (POST
 * /student/create_user) that fired solely on the confirm->auto-sign-in path.
 * Row creation now happens server-side:
 *   - addStudentOnSignUp (PostConfirmation): authoritative idempotent upsert.
 *   - adjustUserRoles   (PostAuthentication): self-heal net on next sign-in.
 *
 * These tests mock the `postgres` tagged template and the Cognito SDK so they are
 * deterministic: no DB, no AWS, no network.
 */

// ---------------------------------------------------------------------------
// Fake `sql` tagged template (same shape as student-session-start.test.ts)
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

// Cognito SDK is provided by the Lambda Node runtime, not cdk/node_modules — mock
// virtually. list-groups is distinguished from add/remove by the absence of a
// GroupName on the command input.
let mockGroups: string[] = [];
const mockCognitoSend = jest.fn(async (cmd: any) => {
  if (cmd && cmd.input && cmd.input.GroupName === undefined) {
    return { Groups: mockGroups.map((g) => ({ GroupName: g })) };
  }
  return {};
});

jest.mock(
  "@aws-sdk/client-cognito-identity-provider",
  () => ({
    CognitoIdentityProviderClient: class {
      send = mockCognitoSend;
    },
    AdminAddUserToGroupCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    AdminRemoveUserFromGroupCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    AdminListGroupsForUserCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: postConfirmationHandler } = require("../lambda/lib/addStudentOnSignUp.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: postAuthHandler } = require("../lambda/lib/adjustUserRoles.js");

function confirmationEvent(attrs: Record<string, string> = {}) {
  return {
    userName: "cognito-user-name",
    userPoolId: "ca-central-1_TEST",
    request: {
      userAttributes: {
        email: "nehasen@student.ubc.ca",
        ...attrs,
      },
    },
  } as any;
}

const INSERT_ROW = 'INSERT INTO "Users"';
const SELECT_ROLES = 'SELECT roles FROM "Users"';

beforeEach(() => {
  mockSql.reset();
  (global as any).sqlConnection = mockSql;
  mockGroups = [];
  mockCognitoSend.mockClear();
});

// ---------------------------------------------------------------------------
// PostConfirmation: addStudentOnSignUp
// ---------------------------------------------------------------------------
describe("addStudentOnSignUp (PostConfirmation) — authoritative row creation", () => {
  it("inserts a student row (idempotent) and assigns the student group for a new self-signup", async () => {
    mockSql.queueResult([]); // SELECT roles -> no existing row
    mockSql.queueResult([]); // INSERT

    const event = confirmationEvent({ given_name: "Neha", family_name: "Sen" });
    const res = await postConfirmationHandler(event);

    // returns the event so confirmation always succeeds
    expect(res).toBe(event);

    // SELECT then idempotent INSERT
    expect(mockSql.calls).toHaveLength(2);
    expect(mockSql.calls[0]).toContain(SELECT_ROLES);
    expect(mockSql.calls[1]).toContain(INSERT_ROW);
    expect(mockSql.calls[1]).toContain("ON CONFLICT (user_email) DO NOTHING");
    // values: user_email, username(=email), first, last, preferred(=first), role
    expect(mockSql.values[1]).toEqual([
      "nehasen@student.ubc.ca",
      "nehasen@student.ubc.ca",
      "Neha",
      "Sen",
      "Neha",
      "student",
    ]);

    // Cognito group assignment to "student"
    const addCall = mockCognitoSend.mock.calls.find(
      ([c]) => c.input && c.input.GroupName !== undefined
    );
    expect(addCall).toBeDefined();
    expect(addCall![0].input.GroupName).toBe("student");
  });

  it("preserves an existing (admin-provisioned) instructor row and assigns the instructor group", async () => {
    mockSql.queueResult([{ roles: ["instructor"] }]); // existing row
    mockSql.queueResult([]); // INSERT (no-op via ON CONFLICT)

    const event = confirmationEvent({ given_name: "Ins", family_name: "Tructor" });
    await postConfirmationHandler(event);

    // The INSERT carries the instructor role but is guarded by ON CONFLICT so it
    // never clobbers the existing row.
    expect(mockSql.calls[1]).toContain("ON CONFLICT (user_email) DO NOTHING");
    expect(mockSql.values[1][5]).toBe("instructor");

    const addCall = mockCognitoSend.mock.calls.find(
      ([c]) => c.input && c.input.GroupName !== undefined
    );
    expect(addCall![0].input.GroupName).toBe("instructor");
  });

  it("creates the row with NULL names when name attributes are absent", async () => {
    mockSql.queueResult([]); // SELECT
    mockSql.queueResult([]); // INSERT

    await postConfirmationHandler(confirmationEvent()); // no given/family name

    expect(mockSql.values[1]).toEqual([
      "nehasen@student.ubc.ca",
      "nehasen@student.ubc.ca",
      null,
      null,
      null,
      "student",
    ]);
  });

  it("still returns the event and still attempts group assignment when the DB write fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockSql.queueError(new Error("db down")); // SELECT throws

    const event = confirmationEvent();
    const res = await postConfirmationHandler(event);

    expect(res).toBe(event); // confirmation not broken
    expect(spy).toHaveBeenCalled();
    // group assignment (default student) still attempted despite DB failure
    const addCall = mockCognitoSend.mock.calls.find(
      ([c]) => c.input && c.input.GroupName !== undefined
    );
    expect(addCall![0].input.GroupName).toBe("student");
    spy.mockRestore();
  });

  it("still returns the event when Cognito group assignment fails", async () => {
    mockSql.queueResult([]); // SELECT
    mockSql.queueResult([]); // INSERT
    mockCognitoSend.mockRejectedValueOnce(new Error("cognito down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    const event = confirmationEvent();
    const res = await postConfirmationHandler(event);

    expect(res).toBe(event);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PostAuthentication: adjustUserRoles self-heal net
// ---------------------------------------------------------------------------
describe("adjustUserRoles (PostAuthentication) — self-heal net", () => {
  it("creates a missing row on next sign-in, seeding the role from the Cognito student group", async () => {
    mockGroups = ["student"];
    mockSql.queueResult([]); // SELECT roles -> no row

    const event = confirmationEvent({ given_name: "Neha", family_name: "Sen" });
    const res = await postAuthHandler(event);

    expect(res).toBe(event);
    // list groups (SELECT) then the self-heal INSERT
    expect(mockSql.calls[0]).toContain(SELECT_ROLES);
    expect(mockSql.calls[1]).toContain(INSERT_ROW);
    expect(mockSql.calls[1]).toContain("ON CONFLICT (user_email) DO NOTHING");
    expect(mockSql.values[1]).toEqual([
      "nehasen@student.ubc.ca",
      "nehasen@student.ubc.ca",
      "Neha",
      "Sen",
      "Neha",
      "student",
    ]);
    // never reads a role from client input; never mutates Cognito groups here
    const groupMutation = mockCognitoSend.mock.calls.find(
      ([c]) => c.input && c.input.GroupName !== undefined
    );
    expect(groupMutation).toBeUndefined();
  });

  it("seeds the admin role when Cognito says the (missing-row) user is an admin", async () => {
    mockGroups = ["admin", "student"];
    mockSql.queueResult([]); // no row

    await postAuthHandler(confirmationEvent());

    expect(mockSql.values[1][5]).toBe("admin");
  });

  it("defaults to student when the user is in no known role group", async () => {
    mockGroups = [];
    mockSql.queueResult([]); // no row

    await postAuthHandler(confirmationEvent());

    expect(mockSql.values[1][5]).toBe("student");
  });

  it("does NOT insert when a row already exists (matching roles => no-op)", async () => {
    mockGroups = ["student"];
    mockSql.queueResult([{ roles: ["student"] }]); // existing row

    await postAuthHandler(confirmationEvent());

    // only the SELECT ran; no self-heal INSERT
    const inserts = mockSql.calls.filter((c) => c.includes(INSERT_ROW));
    expect(inserts).toHaveLength(0);
  });
});
