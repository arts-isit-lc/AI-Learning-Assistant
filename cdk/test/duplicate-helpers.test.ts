/**
 * Unit tests for the pure duplicate_course file-copy helpers. No AWS / DB /
 * network — the side-effecting bits (S3 copy fn, sleep) are injected.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ACCESS_CODE_UNIQUE_INDEX,
  generateAccessCode,
  isAccessCodeConflict,
  insertWithUniqueAccessCode,
  buildFileKey,
  resolveSourceKey,
  copyWithRetry,
  runWithConcurrency,
  remapReferences,
} = require("../lambda/adminFunction/duplicateHelpers.js");

const noSleep = () => Promise.resolve();

// A Postgres unique-violation as porsager/postgres surfaces it: SQLSTATE on
// `code` and the violated index on `constraint_name`.
const pgUniqueError = (constraint: string) =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: constraint,
  });

describe("generateAccessCode", () => {
  it("produces a XXXX-XXXX-XXXX-XXXX code from the expected alphabet", () => {
    expect(generateAccessCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

describe("isAccessCodeConflict", () => {
  it("is true only for a 23505 on the access-code index", () => {
    expect(isAccessCodeConflict(pgUniqueError(ACCESS_CODE_UNIQUE_INDEX))).toBe(true);
  });

  it("is false for a 23505 on the identity index (that maps to a 409, not a retry)", () => {
    expect(isAccessCodeConflict(pgUniqueError("ux_courses_identity"))).toBe(false);
  });

  it("is false for a non-unique-violation error and for null", () => {
    expect(isAccessCodeConflict(Object.assign(new Error("boom"), { code: "42P01" }))).toBe(false);
    expect(isAccessCodeConflict(null)).toBe(false);
  });
});

describe("insertWithUniqueAccessCode", () => {
  it("returns the insert result and keeps the supplied code when there's no collision", async () => {
    const runInsert = jest.fn().mockResolvedValue([{ course_id: "c1" }]);
    const generate = jest.fn(() => "NEW-CODE");
    const result = await insertWithUniqueAccessCode(runInsert, "GIVEN-CODE", { generate });
    expect(result).toEqual([{ course_id: "c1" }]);
    expect(runInsert).toHaveBeenCalledTimes(1);
    expect(runInsert).toHaveBeenCalledWith("GIVEN-CODE");
    expect(generate).not.toHaveBeenCalled();
  });

  it("regenerates the code and retries on an access-code collision, then succeeds", async () => {
    const runInsert = jest
      .fn()
      .mockRejectedValueOnce(pgUniqueError(ACCESS_CODE_UNIQUE_INDEX))
      .mockResolvedValue([{ course_id: "c2" }]);
    const generate = jest.fn(() => "REGEN-1");
    const result = await insertWithUniqueAccessCode(runInsert, "GIVEN-CODE", { generate });
    expect(result).toEqual([{ course_id: "c2" }]);
    expect(runInsert).toHaveBeenNthCalledWith(1, "GIVEN-CODE");
    expect(runInsert).toHaveBeenNthCalledWith(2, "REGEN-1");
  });

  it("rethrows an identity collision immediately without regenerating", async () => {
    const identityErr = pgUniqueError("ux_courses_identity");
    const runInsert = jest.fn().mockRejectedValue(identityErr);
    const generate = jest.fn();
    await expect(
      insertWithUniqueAccessCode(runInsert, "GIVEN-CODE", { generate })
    ).rejects.toBe(identityErr);
    expect(runInsert).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("throws the last collision after exhausting all attempts", async () => {
    const runInsert = jest.fn().mockRejectedValue(pgUniqueError(ACCESS_CODE_UNIQUE_INDEX));
    const generate = jest.fn(() => "REGEN");
    await expect(
      insertWithUniqueAccessCode(runInsert, "GIVEN-CODE", { attempts: 3, generate })
    ).rejects.toMatchObject({ code: "23505", constraint_name: ACCESS_CODE_UNIQUE_INDEX });
    expect(runInsert).toHaveBeenCalledTimes(3);
  });
});

describe("buildFileKey", () => {
  it("builds the canonical courses/{course}/{module}/{file}.{ext} key", () => {
    expect(buildFileKey("c1", "m1", "f1", "pdf")).toBe("courses/c1/m1/f1.pdf");
  });
});

describe("resolveSourceKey", () => {
  it("prefers the persisted filepath when present", () => {
    const row = { filepath: "courses/src/m/f.pdf", module_id: "m", file_id: "f", filetype: "pdf" };
    expect(resolveSourceKey(row, "src")).toBe("courses/src/m/f.pdf");
  });

  it("reconstructs the key from ids when filepath is absent (legacy row)", () => {
    const row = { filepath: null, module_id: "m9", file_id: "f9", filetype: "docx" };
    expect(resolveSourceKey(row, "src-course")).toBe("courses/src-course/m9/f9.docx");
  });
});

describe("copyWithRetry", () => {
  it("returns the result on the first successful attempt", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(copyWithRetry(fn, { attempts: 3, sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on a later attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    await expect(copyWithRetry(fn, { attempts: 3, sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after exhausting all attempts", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(copyWithRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("runWithConcurrency", () => {
  it("processes every item", async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    await runWithConcurrency(items, async (n: number) => { seen.push(n); }, 2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency limit", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency(
      items,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      3
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("handles an empty list without error", async () => {
    const worker = jest.fn();
    await runWithConcurrency([], worker, 4);
    expect(worker).not.toHaveBeenCalled();
  });
});

describe("remapReferences", () => {
  const moduleMap = new Map([["m1", "new-m1"], ["m2", "new-m2"]]);
  const fileMap = new Map([["f1", "new-f1"], ["f2", "new-f2"]]);

  it("remaps references whose module AND file were both duplicated", () => {
    const rows = [{ source_module_id: "m1", referenced_file_id: "f2" }];
    const { mapped, skipped } = remapReferences(rows, moduleMap, fileMap);
    expect(mapped).toEqual([{ source_module_id: "new-m1", referenced_file_id: "new-f2" }]);
    expect(skipped).toEqual([]);
  });

  it("skips a reference whose target file was not copied (outside course or copy failed)", () => {
    const rows = [{ source_module_id: "m1", referenced_file_id: "f-external" }];
    const { mapped, skipped } = remapReferences(rows, moduleMap, fileMap);
    expect(mapped).toEqual([]);
    expect(skipped).toEqual([{ source_module_id: "m1", referenced_file_id: "f-external" }]);
  });

  it("skips a reference whose source module is not in the new course", () => {
    const rows = [{ source_module_id: "m-external", referenced_file_id: "f1" }];
    const { mapped, skipped } = remapReferences(rows, moduleMap, fileMap);
    expect(mapped).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it("partitions a mixed batch into mapped + skipped", () => {
    const rows = [
      { source_module_id: "m1", referenced_file_id: "f1" }, // ok
      { source_module_id: "m2", referenced_file_id: "f-external" }, // skip (file)
      { source_module_id: "m-external", referenced_file_id: "f2" }, // skip (module)
    ];
    const { mapped, skipped } = remapReferences(rows, moduleMap, fileMap);
    expect(mapped).toEqual([{ source_module_id: "new-m1", referenced_file_id: "new-f1" }]);
    expect(skipped).toHaveLength(2);
  });
});
