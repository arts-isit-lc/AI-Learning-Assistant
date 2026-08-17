/**
 * Unit tests for the pure duplicate_course file-copy helpers. No AWS / DB /
 * network — the side-effecting bits (S3 copy fn, sleep) are injected.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildFileKey,
  resolveSourceKey,
  copyWithRetry,
  runWithConcurrency,
  remapReferences,
} = require("../lambda/adminFunction/duplicateHelpers.js");

const noSleep = () => Promise.resolve();

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
