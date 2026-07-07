/**
 * Unit tests for the prompt conflict validator's deterministic pieces.
 *
 * These lock in:
 *  - the LLM prompt actually DEFINES the conflict types (the regression that
 *    caused BEHAVIORAL_INCOMPATIBILITY / HIERARCHY_VIOLATION to never fire), and
 *    that a mandatory interaction mode is no longer dumped in the "ignore" list;
 *  - the rule engine still deterministically flags hard contradictions;
 *  - the response schema accepts all four conflict types and rejects bad input.
 *
 * The LLM's actual classification behavior is non-deterministic and requires a
 * live Bedrock call, so it is verified manually, not here.
 *
 * validatePrompt.js pulls in the AWS SDK at module load; those packages are not
 * dependencies of the CDK app, so we register virtual mocks before requiring it.
 */

jest.mock(
  "@aws-sdk/client-bedrock-runtime",
  () => ({ BedrockRuntimeClient: class {}, InvokeModelCommand: class {} }),
  { virtual: true }
);
jest.mock(
  "@aws-sdk/client-ssm",
  () => ({ SSMClient: class {}, GetParameterCommand: class {} }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vp: any = require("../lambda/lib/validatePrompt.js");

describe("buildLLMPrompt guidance", () => {
  const input = vp.buildCanonicalInput("course prompt text", "", [], "course");
  const prompt: string = vp.buildLLMPrompt(input);

  it("defines each of the three LLM-classified conflict types (not just lists them)", () => {
    expect(prompt).toMatch(/BEHAVIORAL_INCOMPATIBILITY:/);
    expect(prompt).toMatch(/CONSTRAINT_COLLISION:/);
    expect(prompt).toMatch(/HIERARCHY_VIOLATION:/);
  });

  it("no longer unconditionally ignores Socratic/directive pedagogy", () => {
    expect(prompt).not.toContain("Pedagogical approach (Socratic, directive, scaffolded)");
    expect(prompt.toLowerCase()).toContain("interaction mode");
  });

  it("keeps the explicit override -> HIERARCHY_VIOLATION trigger", () => {
    expect(prompt).toMatch(/Ignore\/override the system prompt/i);
  });

  it("notes that hard contradictions are detected separately by the rule engine", () => {
    expect(prompt.toLowerCase()).toContain("rule engine");
  });

  it("instructs that silence / same-mode usage is NOT a conflict (precision guard)", () => {
    // Guards against the false positive where a course prompt that engages via
    // questions was flagged as behaviorally incompatible with the Socratic rule.
    expect(prompt).toMatch(/NOT conflicts/i);
    expect(prompt.toLowerCase()).toContain("silence");
    expect(prompt.toLowerCase()).toContain("both use questions");
    // The over-eager wording that emboldened false positives must be gone.
    expect(prompt).not.toContain("do not stay silent on a real conflict out of caution");
  });
});

describe("detectHardContradictions (deterministic rule engine)", () => {
  it("flags always-summarize (course) vs avoid-summaries (system) as HARD_CONTRADICTION", () => {
    const input = vp.buildCanonicalInput(
      "Always provide a summary of the reading.",
      "",
      [],
      "course"
    );
    const conflicts = vp.detectHardContradictions(input);
    const summaryConflict = conflicts.find((c: any) =>
      c.explanation.includes("provide_summary")
    );
    expect(summaryConflict).toBeDefined();
    expect(summaryConflict.type).toBe("HARD_CONTRADICTION");
    expect(summaryConflict.prompt_a_source).toBe("system_level_prompt");
    expect(summaryConflict.prompt_b_source).toBe("course_prompt");
  });

  it("returns no hard contradictions for a compatible course prompt", () => {
    const input = vp.buildCanonicalInput(
      "Encourage students and be supportive of their progress.",
      "",
      [],
      "course"
    );
    expect(vp.detectHardContradictions(input)).toHaveLength(0);
  });
});

describe("validateSchema", () => {
  const base = {
    confidence: 0.9,
    prompt_a_source: "system_level_prompt",
    prompt_b_source: "course_prompt",
    prompt_a_text: "a",
    prompt_b_text: "b",
    dominant_source: "system_level_prompt",
    explanation: "why",
  };

  it("accepts every valid conflict type", () => {
    const types = [
      "HARD_CONTRADICTION",
      "BEHAVIORAL_INCOMPATIBILITY",
      "CONSTRAINT_COLLISION",
      "HIERARCHY_VIOLATION",
    ];
    for (const type of types) {
      expect(() =>
        vp.validateSchema({ conflicts: [{ ...base, type }] })
      ).not.toThrow();
    }
  });

  it("rejects an unknown conflict type", () => {
    expect(() =>
      vp.validateSchema({ conflicts: [{ ...base, type: "NOT_A_TYPE" }] })
    ).toThrow(/Invalid conflict type/);
  });

  it("rejects an out-of-range confidence score", () => {
    expect(() =>
      vp.validateSchema({
        conflicts: [{ ...base, type: "CONSTRAINT_COLLISION", confidence: 1.5 }],
      })
    ).toThrow(/confidence/i);
  });

  it("rejects a response whose conflicts field is not an array", () => {
    expect(() => vp.validateSchema({ conflicts: "nope" })).toThrow(/conflicts/i);
  });
});
