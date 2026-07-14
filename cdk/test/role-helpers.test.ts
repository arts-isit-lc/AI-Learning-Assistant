/**
 * Unit tests for the admin Lambda role-transition helpers.
 *
 * roleHelpers.js is dependency-free (pure array logic), so it imports cleanly
 * without the AWS SDK / postgres runtime deps and needs no Docker.
 *
 * These encode the "admins can also be instructors" behaviour: elevation is
 * additive (an admin keeps admin), and demotion no longer forces an admin down
 * to student.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  computeRolesAfterElevation,
  computeRolesAfterDemotion,
} = require("../lambda/adminFunction/roleHelpers.js");

describe("computeRolesAfterElevation", () => {
  it("adds instructor to an admin while preserving admin (the reported bug)", () => {
    // Previously this was a no-op, so an admin never appeared in the list.
    expect(computeRolesAfterElevation(["admin"])).toEqual(["admin", "instructor"]);
  });

  it("converts a plain student into an instructor", () => {
    expect(computeRolesAfterElevation(["student"])).toEqual(["instructor"]);
  });

  it("returns null when the user is already an instructor (idempotent no-op)", () => {
    expect(computeRolesAfterElevation(["instructor"])).toBeNull();
    expect(computeRolesAfterElevation(["admin", "instructor"])).toBeNull();
  });

  it("adds instructor when the user has no roles yet", () => {
    expect(computeRolesAfterElevation([])).toEqual(["instructor"]);
    expect(computeRolesAfterElevation(null)).toEqual(["instructor"]);
    expect(computeRolesAfterElevation(undefined)).toEqual(["instructor"]);
  });

  it("keeps admin and drops the learner role for an admin+student", () => {
    expect(computeRolesAfterElevation(["admin", "student"])).toEqual([
      "admin",
      "instructor",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = ["admin"];
    computeRolesAfterElevation(input);
    expect(input).toEqual(["admin"]);
  });
});

describe("computeRolesAfterDemotion", () => {
  it("removes instructor but keeps admin (no forced student)", () => {
    expect(computeRolesAfterDemotion(["admin", "instructor"])).toEqual(["admin"]);
  });

  it("falls back to student when instructor was the only role", () => {
    expect(computeRolesAfterDemotion(["instructor"])).toEqual(["student"]);
  });

  it("preserves an existing student role without duplicating it", () => {
    expect(computeRolesAfterDemotion(["student", "instructor"])).toEqual(["student"]);
  });

  it("leaves a user without the instructor role unchanged", () => {
    expect(computeRolesAfterDemotion(["admin"])).toEqual(["admin"]);
  });

  it("falls back to student for empty/nullish input", () => {
    expect(computeRolesAfterDemotion([])).toEqual(["student"]);
    expect(computeRolesAfterDemotion(null)).toEqual(["student"]);
  });
});
