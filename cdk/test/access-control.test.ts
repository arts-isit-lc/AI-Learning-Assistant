/**
 * Unit tests for the student Lambda access-control helpers (H2/H3 IDOR guards).
 *
 * accessControl.js is dependency-free (each helper takes the `sqlConn` tagged
 * template as an argument), so it imports cleanly here without the AWS SDK /
 * postgres runtime deps and needs no Docker.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  verifyStudentAccess,
  verifyStudentOwnsSession,
} = require("../lambda/lib/accessControl.js");

/** Build a mock `postgres` tagged-template that returns `rows` and records the
 * interpolated values of each call (so we can assert query scoping). */
function mockSql(rows: any[], record?: { values: any[][] }) {
  return (_strings: TemplateStringsArray, ...values: any[]) => {
    if (record) record.values.push(values);
    return Promise.resolve(rows);
  };
}

describe("verifyStudentOwnsSession (H2)", () => {
  it("returns true when the ownership chain resolves a row", async () => {
    const owns = await verifyStudentOwnsSession(mockSql([{ "?column?": 1 }]), "a@b.com", "sess-1");
    expect(owns).toBe(true);
  });

  it("returns false when no row matches (caller is not the owner)", async () => {
    const owns = await verifyStudentOwnsSession(mockSql([]), "attacker@b.com", "sess-1");
    expect(owns).toBe(false);
  });

  it("scopes the lookup by BOTH session_id and caller email", async () => {
    const rec = { values: [] as any[][] };
    await verifyStudentOwnsSession(mockSql([], rec), "a@b.com", "sess-1");
    // SQL interpolates session_id first, then email.
    expect(rec.values[0]).toEqual(["sess-1", "a@b.com"]);
  });
});

describe("verifyStudentAccess (H3 / files / file_url)", () => {
  it("returns the enrolment_id when the student is enrolled", async () => {
    const id = await verifyStudentAccess(mockSql([{ enrolment_id: "enr-9" }]), "a@b.com", "course-1", "mod-1");
    expect(id).toBe("enr-9");
  });

  it("returns null when the student is not enrolled", async () => {
    const id = await verifyStudentAccess(mockSql([]), "a@b.com", "course-1", "mod-1");
    expect(id).toBeNull();
  });

  it("scopes the lookup by email, module_id, and course_id together", async () => {
    const rec = { values: [] as any[][] };
    await verifyStudentAccess(mockSql([], rec), "a@b.com", "course-1", "mod-1");
    // SQL interpolates email, then module_id, then course_id.
    expect(rec.values[0]).toEqual(["a@b.com", "mod-1", "course-1"]);
  });
});
